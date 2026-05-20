/**
 * Edge derivation used by the review-page constellation graph.
 *
 * The review page wants semantic, Obsidian-style edges — not the proximity
 * clustering that the in-video Remotion/FFmpeg graph uses. This helper
 * composes the UML static analyzer (`deriveUmlEdges`) with test-pair matching
 * (`deriveTestPairEdges`) and returns a deduped edge list where the strongest
 * relationship per undirected scene pair wins.
 *
 * Precedence order (strongest → weakest):
 *   1. inheritance
 *   2. realization
 *   3. composition
 *   4. dependency
 *   5. test_pair
 *   6. association
 *
 * The in-video graph continues to use `deriveEdges()` in `graphRelationships.ts`
 * — it's unaffected by this module.
 */

import type { VideoScript } from "@/domain/entities/VideoScript";
import type { DerivedEdge } from "./graphRelationships";
import {
  deriveTestPairEdges,
  makeUndirectedPairKey,
} from "./graphRelationships";
import type { GraphEdgeRelationship, GraphNode } from "./types";
import { deriveUmlEdges } from "./umlRelationships";

/** Strongest → weakest; lower index wins dedup. */
const PRECEDENCE: readonly GraphEdgeRelationship[] = [
  "inheritance",
  "realization",
  "composition",
  "dependency",
  "test_pair",
  "association",
  "same_directory",
  "key_file_adjacency",
] as const;

const PRECEDENCE_INDEX = new Map<GraphEdgeRelationship, number>(
  PRECEDENCE.map((rel, i) => [rel, i]),
);

/**
 * Merge a list of derived edges, keeping the strongest relationship per
 * undirected scene pair. Exported for unit testing.
 */
export function mergeWithPrecedence(edges: DerivedEdge[]): DerivedEdge[] {
  const byKey = new Map<string, DerivedEdge>();
  for (const edge of edges) {
    const key = makeUndirectedPairKey(edge.sourceSceneNumber, edge.targetSceneNumber);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, edge);
      continue;
    }
    const existingRank = PRECEDENCE_INDEX.get(existing.relationship) ?? Infinity;
    const newRank = PRECEDENCE_INDEX.get(edge.relationship) ?? Infinity;
    if (newRank < existingRank) {
      byKey.set(key, edge);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Review-page edge derivation: UML relationships + test pairs, deduped by
 * precedence. Intentionally excludes `same_directory` and `key_file_adjacency`
 * — those are clustering signals for the in-video graph, not semantic.
 */
export function deriveReviewPageEdges(
  nodes: GraphNode[],
  script: VideoScript,
): DerivedEdge[] {
  if (nodes.length < 2) return [];
  const uml = deriveUmlEdges(nodes, script);
  const tests = deriveTestPairEdges(nodes);
  return mergeWithPrecedence([...uml, ...tests]);
}
