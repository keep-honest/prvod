/**
 * Edge derivation for the constellation graph.
 *
 * Two relationship kinds are recognized:
 *
 * 1. `same_directory` — any two nodes whose `filePath` shares a parent
 *    directory (POSIX `dirname`). This clusters tightly-related files
 *    visually.
 * 2. `key_file_adjacency` — consecutive entries in `VideoScript.keyFiles`
 *    get an edge between the first node that represents each file. This
 *    preserves the script author's narrative ordering as a backbone.
 *
 * Edges are deduplicated so the same ordered pair never produces two edges;
 * a `same_directory` match wins over a `key_file_adjacency` match because
 * directory relationships are semantically stronger (tight coupling vs.
 * narrative adjacency).
 */

import type { GraphEdgeRelationship, GraphNode } from "./types";

export interface DerivedEdge {
  sourceSceneNumber: number;
  targetSceneNumber: number;
  /** Unique node identity of the source (filePath). Optional for backward compat. */
  sourceNodeId?: string;
  /** Unique node identity of the target (filePath). Optional for backward compat. */
  targetNodeId?: string;
  relationship: GraphEdgeRelationship;
}

/** POSIX-style dirname that treats "/" and "\\" as separators. */
export function getDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

/** Basename of a filePath (portion after the last `/` or `\\`). */
export function getBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

export function makeUndirectedPairKey(a: string | number, b: string | number): string {
  return `${a}` < `${b}` ? `${a}-${b}` : `${b}-${a}`;
}

// Internal alias kept for readability within this module.
const makeKey = makeUndirectedPairKey;

/** Regex matching common test-file basenames across TS/JS ecosystems. */
const TEST_BASENAME_RE = /^(.+?)\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Strips a `.test.*` or `.spec.*` suffix from a basename and returns the
 * implementation-file basename it corresponds to. Returns `null` when the
 * basename isn't a test file.
 *
 * Examples:
 *   `stripTestSuffix("Auth.test.ts")` → `"Auth.ts"`
 *   `stripTestSuffix("utils.spec.tsx")` → `"utils.tsx"`
 *   `stripTestSuffix("Auth.ts")` → `null`
 */
export function stripTestSuffix(basename: string): string | null {
  const match = basename.match(TEST_BASENAME_RE);
  return match ? `${match[1]}.${match[3]}` : null;
}

/** True iff the basename is recognised as a test file. */
export function isTestBasename(basename: string): boolean {
  return TEST_BASENAME_RE.test(basename);
}

/**
 * Derives `test_pair` relationships by grouping nodes whose basenames
 * normalize to the same implementation filename. Emits an edge when exactly
 * one file in the pair is a test and the other isn't. Used by the review-page
 * graph via `reviewPageRelationships.ts`.
 *
 * Precedence is left to the caller — this function only emits `test_pair`
 * edges and doesn't dedupe against stronger relationships.
 */
export function deriveTestPairEdges(nodes: GraphNode[]): DerivedEdge[] {
  if (nodes.length < 2) return [];

  const byNormalizedBasename = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const base = getBasename(node.filePath);
    const normalized = stripTestSuffix(base) ?? base;
    const group = byNormalizedBasename.get(normalized) ?? [];
    group.push(node);
    byNormalizedBasename.set(normalized, group);
  }

  const edges = new Map<string, DerivedEdge>();
  for (const group of byNormalizedBasename.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.filePath === b.filePath) continue;
        const aIsTest = isTestBasename(getBasename(a.filePath));
        const bIsTest = isTestBasename(getBasename(b.filePath));
        // Require exactly one test + one implementation
        if (aIsTest === bIsTest) continue;
        const key = makeKey(a.filePath, b.filePath);
        if (edges.has(key)) continue;
        edges.set(key, {
          sourceSceneNumber: a.sceneNumber,
          targetSceneNumber: b.sceneNumber,
          sourceNodeId: a.filePath,
          targetNodeId: b.filePath,
          relationship: "test_pair",
        });
      }
    }
  }
  return Array.from(edges.values());
}

/**
 * Derives the edge list from the set of placed graph nodes and the script's
 * `keyFiles` ordering. Returns an array with no duplicate (undirected) pairs.
 */
export function deriveEdges(
  nodes: GraphNode[],
  keyFiles: readonly string[] = [],
): DerivedEdge[] {
  if (nodes.length < 2) {
    return [];
  }

  const edges = new Map<string, DerivedEdge>();

  // 1) Same-directory edges — keyed by filePath (nodeId) to avoid collisions
  //    when multiple nodes share a sceneNumber (multi-snippet scenes).
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.directory && a.directory === b.directory) {
        const key = makeKey(a.filePath, b.filePath);
        edges.set(key, {
          sourceSceneNumber: a.sceneNumber,
          targetSceneNumber: b.sceneNumber,
          sourceNodeId: a.filePath,
          targetNodeId: b.filePath,
          relationship: "same_directory",
        });
      }
    }
  }

  // 2) keyFiles adjacency: walk consecutive pairs, attach edge between the
  //    first node representing each file. Skip self-edges (same filePath).
  if (keyFiles.length > 1) {
    const fileToNode = new Map<string, GraphNode>();
    for (const node of nodes) {
      if (!fileToNode.has(node.filePath)) {
        fileToNode.set(node.filePath, node);
      }
    }

    for (let i = 0; i < keyFiles.length - 1; i++) {
      const a = fileToNode.get(keyFiles[i]);
      const b = fileToNode.get(keyFiles[i + 1]);
      if (!a || !b) continue;
      if (a.filePath === b.filePath) continue;
      const key = makeKey(a.filePath, b.filePath);
      if (edges.has(key)) {
        // same_directory already covers this pair — keep the stronger relation
        continue;
      }
      edges.set(key, {
        sourceSceneNumber: a.sceneNumber,
        targetSceneNumber: b.sceneNumber,
        sourceNodeId: a.filePath,
        targetNodeId: b.filePath,
        relationship: "key_file_adjacency",
      });
    }
  }

  return Array.from(edges.values());
}
