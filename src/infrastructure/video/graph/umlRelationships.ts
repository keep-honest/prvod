/**
 * UML-style relationship extraction from video-script code snippets.
 *
 * This module takes a `VideoScript` whose scenes contain `codeBroll[0].code`
 * TypeScript/JavaScript snippets and produces UML-classified `DerivedEdge`s
 * between scene nodes. The relationships power the review-page constellation
 * graph — the in-video Remotion/FFmpeg graph still uses the legacy
 * `same_directory` / `key_file_adjacency` derivation.
 *
 * Design: regex-based static analysis using `String.matchAll`. Not
 * AST-accurate, but fast (no TS compiler dependency), runs purely in Node.js,
 * and handles the common cases for the vast majority of generated walkthroughs
 * (TypeScript/JavaScript repos).
 *
 * Relationship kinds produced (strongest first — wins deduplication when the
 * same scene pair is matched by multiple rules):
 *
 *   1. inheritance   — `class X extends Y`
 *   2. realization   — `class X implements I`
 *   3. composition   — class field typed as a known class/type
 *   4. dependency    — `import ... from "./Foo"` (relative imports resolved
 *                       against known node filePaths)
 *   5. association   — any other reference to a known symbol from a different
 *                       scene (method calls, parameter types, etc.)
 */

import type { VideoScript } from "@/domain/entities/VideoScript";
import type { DerivedEdge } from "./graphRelationships";
import { getBasename, getDirectory, makeUndirectedPairKey } from "./graphRelationships";
import type { GraphNode } from "./types";

type UmlRelationship =
  | "inheritance"
  | "realization"
  | "composition"
  | "dependency"
  | "association";

/** Strongest → weakest; lower index wins dedup. */
const PRECEDENCE: UmlRelationship[] = [
  "inheritance",
  "realization",
  "composition",
  "dependency",
  "association",
];

const PRECEDENCE_INDEX = new Map<UmlRelationship, number>(
  PRECEDENCE.map((rel, i) => [rel, i]),
);

const CLASS_DEF_RE = /\b(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
const INTERFACE_DEF_RE = /\b(?:export\s+)?interface\s+(\w+)/g;
const TYPE_DEF_RE = /\b(?:export\s+)?type\s+(\w+)\s*=/g;
const ENUM_DEF_RE = /\b(?:export\s+)?enum\s+(\w+)/g;
const FUNCTION_DEF_RE = /\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
const CONST_DEF_RE = /\b(?:export\s+)?const\s+(\w+)\s*(?::|=)/g;

/** `class X extends Y` — capture the superclass name. */
const EXTENDS_RE = /\bclass\s+\w+\s+extends\s+(\w+)/g;
/** `class X [extends Y] implements I1, I2` — capture the comma-joined list. */
const IMPLEMENTS_RE = /\bclass\s+\w+(?:\s+extends\s+\w+)?\s+implements\s+([\w,\s]+?)(?:\s*\{)/g;
/** `private readonly foo: Bar` or `public foo: Bar` — capture the type name. */
const FIELD_DECL_RE = /\b(?:private|public|protected|readonly)\s+(?:readonly\s+)?\w+\s*:\s*(\w+)/g;
/** `import ... from "./foo"` — capture the module specifier. */
const IMPORT_RE = /\bimport\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
/** `require("./foo")` — CommonJS-style dependency. */
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Tokenize a code snippet into candidate identifiers (≥2 chars, alphanumeric). */
const IDENTIFIER_RE = /\b([A-Za-z_]\w{1,})\b/g;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Pure function: derive UML-classified edges from a script's code snippets.
 *
 * - Builds a symbol index (first scene that defines each class/interface/
 *   type/function/const wins).
 * - Walks each scene's code and emits edges to other scenes' defined symbols
 *   via the strongest matching rule.
 * - Dedupes per undirected scene pair, keeping the strongest relationship.
 */
export function deriveUmlEdges(
  nodes: GraphNode[],
  script: VideoScript,
): DerivedEdge[] {
  if (nodes.length < 2) return [];

  // Map sceneNumber → file path from the node set (so we only resolve imports
  // against files actually participating in the graph).
  const sceneFilePath = new Map<number, string>();
  for (const node of nodes) {
    sceneFilePath.set(node.sceneNumber, node.filePath);
  }

  // Symbol index: symbolName → the scene that first defines it.
  const symbolDefinedBy = new Map<string, number>();
  // Scene codes, keyed by sceneNumber for the reference-extraction pass.
  const sceneCodes = new Map<number, string>();

  for (const scene of script.scenes) {
    const primary = scene.codeBroll[0];
    if (!primary?.code) continue;
    if (!sceneFilePath.has(scene.sceneNumber)) continue;
    sceneCodes.set(scene.sceneNumber, primary.code);

    const defRegexes = [
      CLASS_DEF_RE,
      INTERFACE_DEF_RE,
      TYPE_DEF_RE,
      ENUM_DEF_RE,
      FUNCTION_DEF_RE,
      CONST_DEF_RE,
    ];
    for (const re of defRegexes) {
      for (const match of primary.code.matchAll(re)) {
        const symbol = match[1];
        if (!symbol) continue;
        if (!symbolDefinedBy.has(symbol)) {
          symbolDefinedBy.set(symbol, scene.sceneNumber);
        }
      }
    }
  }

  // Edges are keyed by undirected scene pair. We track the current strongest
  // relationship per pair and replace it when a stronger match shows up.
  const edges = new Map<string, DerivedEdge>();
  const upsert = (source: number, target: number, rel: UmlRelationship) => {
    if (source === target) return;
    const key = makeUndirectedPairKey(source, target);
    const existing = edges.get(key);
    if (existing) {
      const existingRank = PRECEDENCE_INDEX.get(existing.relationship as UmlRelationship) ?? Infinity;
      const newRank = PRECEDENCE_INDEX.get(rel) ?? Infinity;
      if (newRank >= existingRank) return;
    }
    edges.set(key, {
      sourceSceneNumber: source,
      targetSceneNumber: target,
      relationship: rel,
    });
  };

  // Second pass: scan each scene's code for references to symbols defined
  // elsewhere, and emit the strongest matching relationship.
  for (const [sceneNumber, code] of sceneCodes) {
    // 1) Inheritance (class X extends Y)
    for (const match of code.matchAll(EXTENDS_RE)) {
      const superName = match[1];
      const defScene = symbolDefinedBy.get(superName);
      if (defScene !== undefined && defScene !== sceneNumber) {
        upsert(sceneNumber, defScene, "inheritance");
      }
    }

    // 2) Realization (class X implements I1, I2)
    for (const match of code.matchAll(IMPLEMENTS_RE)) {
      const list = match[1] ?? "";
      const interfaces = list.split(/\s*,\s*/).filter(Boolean);
      for (const iface of interfaces) {
        const defScene = symbolDefinedBy.get(iface);
        if (defScene !== undefined && defScene !== sceneNumber) {
          upsert(sceneNumber, defScene, "realization");
        }
      }
    }

    // 3) Composition (class field typed as a known class/type)
    for (const match of code.matchAll(FIELD_DECL_RE)) {
      const typeName = match[1];
      const defScene = symbolDefinedBy.get(typeName);
      if (defScene !== undefined && defScene !== sceneNumber) {
        upsert(sceneNumber, defScene, "composition");
      }
    }

    // 4) Dependency (import/require of another node file)
    const importerPath = sceneFilePath.get(sceneNumber);
    if (importerPath) {
      const importerRegexes = [IMPORT_RE, REQUIRE_RE];
      for (const re of importerRegexes) {
        for (const match of code.matchAll(re)) {
          const modSpec = match[1];
          if (!modSpec) continue;
          // Only resolve relative imports (skip npm packages and bare specifiers)
          if (!modSpec.startsWith(".")) continue;
          const resolvedScene = resolveRelativeImport(
            importerPath,
            modSpec,
            sceneFilePath,
          );
          if (resolvedScene !== undefined && resolvedScene !== sceneNumber) {
            upsert(sceneNumber, resolvedScene, "dependency");
          }
        }
      }
    }

    // 5) Association — catch-all: any identifier reference to a symbol
    //    defined in another scene that hasn't already been captured by a
    //    stronger relationship.
    for (const match of code.matchAll(IDENTIFIER_RE)) {
      const identifier = match[1];
      const defScene = symbolDefinedBy.get(identifier);
      if (defScene === undefined || defScene === sceneNumber) continue;
      // Only upsert — if a stronger relationship is already recorded for
      // this pair, `upsert` will keep the stronger one.
      upsert(sceneNumber, defScene, "association");
    }
  }

  return Array.from(edges.values());
}

// ── Import path resolution ────────────────────────────────────────────────

const CANDIDATE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

/**
 * Resolves a relative import specifier (`./Foo`, `../lib/Foo`) against the
 * importer's own file path, returning the scene number of the matched node
 * or `undefined` when no known node matches.
 *
 * Exported for unit testing.
 */
export function resolveRelativeImport(
  importerFilePath: string,
  moduleSpec: string,
  sceneFilePath: Map<number, string>,
): number | undefined {
  if (!moduleSpec.startsWith(".")) return undefined;

  const importerDir = getDirectory(importerFilePath);
  const joined = joinPosix(importerDir, moduleSpec);

  // Pre-index nodes by normalized filePath for O(1) lookup
  const filePathToScene = new Map<string, number>();
  for (const [scene, path] of sceneFilePath) {
    filePathToScene.set(normalizePosix(path), scene);
  }

  // Try the raw joined path and every candidate extension/suffix
  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = normalizePosix(joined + ext);
    const scene = filePathToScene.get(candidate);
    if (scene !== undefined) return scene;
  }

  // Also match on basename alone as a fallback (some diffs don't preserve
  // full paths). Only match if exactly one node has that basename.
  const candidateBase = getBasename(joined);
  const candidateBaseWithExt = CANDIDATE_EXTENSIONS
    .map((ext) => candidateBase + ext)
    .filter((s) => s.length > 0);
  const basenameMatches: number[] = [];
  for (const [scene, path] of sceneFilePath) {
    const base = getBasename(path);
    if (candidateBaseWithExt.includes(base)) {
      basenameMatches.push(scene);
    }
  }
  return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

/** POSIX-style path join that collapses `..` segments. */
function joinPosix(base: string, rel: string): string {
  const combined = base ? `${base}/${rel}` : rel;
  const parts = combined.split("/").filter((p) => p.length > 0 && p !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

/** Normalize backslashes → forward slashes. */
function normalizePosix(path: string): string {
  return path.replace(/\\/g, "/");
}
