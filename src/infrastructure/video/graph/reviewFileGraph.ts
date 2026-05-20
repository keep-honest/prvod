import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import tsconfig from "../../../../tsconfig.json";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { GraphEdgeRelationship } from "@/domain/entities/ReviewGraph";
import { clamp } from "@/lib/math";
import {
  getBasename,
  getDirectory,
  isTestBasename,
  stripTestSuffix,
} from "./graphRelationships";
import {
  DEFAULT_NODE_RADIUS,
  NODE_MARGIN,
} from "./types";

const SIMULATION_TICKS = 300;
const CHARGE_STRENGTH = -400;
const COLLIDE_RADIUS = 80;
const LINK_DISTANCE = 200;
const SEED_RING_RADIUS = 300;
const FALLBACK_ROW_Y_RATIO = 0.65;
const CLUSTER_THRESHOLD = 20;

const CLASS_DEF_RE = /\b(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
const INTERFACE_DEF_RE = /\b(?:export\s+)?interface\s+(\w+)/g;
const TYPE_DEF_RE = /\b(?:export\s+)?type\s+(\w+)\s*=/g;
const ENUM_DEF_RE = /\b(?:export\s+)?enum\s+(\w+)/g;
const FUNCTION_DEF_RE = /\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
const CONST_DEF_RE = /\b(?:export\s+)?const\s+(\w+)\s*(?::|=)/g;
const EXTENDS_RE = /\bclass\s+\w+\s+extends\s+(\w+)/g;
const IMPLEMENTS_RE = /\bclass\s+\w+(?:\s+extends\s+\w+)?\s+implements\s+([\w,\s]+?)(?:\s*\{)/g;
const FIELD_DECL_RE = /\b(?:private|public|protected|readonly)\s+(?:readonly\s+)?\w+\s*:\s*(\w+)/g;
const IMPORT_RE = /\bimport\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const IDENTIFIER_RE = /\b([A-Za-z_]\w{1,})\b/g;

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
  PRECEDENCE.map((rel, index) => [rel, index]),
);

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

interface TsconfigPathAlias {
  prefix: string;
  targetPrefix: string;
}

const TS_PATH_ALIASES = Object.entries(tsconfig.compilerOptions?.paths ?? {})
  .flatMap(([pattern, targets]) => {
    if (!pattern.includes("*")) return [];
    const [prefix] = pattern.split("*");
    return targets.flatMap((target) => {
      if (!target.includes("*")) return [];
      const [targetPrefix] = target.split("*");
      return [{
        prefix: normalizePosix(prefix),
        targetPrefix: normalizePosix(targetPrefix.replace(/^\.\//, "")),
      }] satisfies TsconfigPathAlias[];
    });
  })
  .sort((a, b) => b.prefix.length - a.prefix.length);

export type ReviewGraphCanonicalFiles = Record<string, string>;

export interface ReviewFileNodeSource {
  filePath: string;
  label: string;
  directory: string;
  sceneNumbers: number[];
  primarySceneNumber: number;
  mergedCode: string;
}

export interface ReviewFileDerivedEdge {
  sourceFilePath: string;
  targetFilePath: string;
  relationship: GraphEdgeRelationship;
}

export interface ReviewFileLayoutNode {
  filePath: string;
  label: string;
  directory: string;
  x: number;
  y: number;
}

export interface ReviewFileLayoutResult {
  nodes: ReviewFileLayoutNode[];
  edges: ReviewFileDerivedEdge[];
  viewportWidth: number;
  viewportHeight: number;
}

interface SimNode extends SimulationNodeDatum {
  filePath: string;
  label: string;
  directory: string;
  radius: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: number | SimNode;
  target: number | SimNode;
}


function makeFilePairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function normalizePosix(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function joinPosix(base: string, rel: string): string {
  return normalizePosix(`${base}/${rel}`);
}

function resolveRelativeImportToFilePath(
  importerFilePath: string,
  moduleSpec: string,
  normalizedFilePaths: Map<string, string>,
  knownFilePaths: readonly string[],
): string | undefined {
  if (!moduleSpec.startsWith(".")) return undefined;

  const importerDir = getDirectory(importerFilePath);
  const joined = joinPosix(importerDir, moduleSpec);

  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = normalizePosix(joined + ext);
    const resolved = normalizedFilePaths.get(candidate);
    if (resolved) return resolved;
  }

  const candidateBase = getBasename(joined);
  const candidateBaseWithExt = CANDIDATE_EXTENSIONS
    .map((ext) => candidateBase + ext)
    .filter((entry) => entry.length > 0);
  const basenameMatches = knownFilePaths.filter((filePath) =>
    candidateBaseWithExt.includes(getBasename(filePath)),
  );
  return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

function resolveAliasedImportToFilePath(
  moduleSpec: string,
  normalizedFilePaths: Map<string, string>,
): string | undefined {
  for (const alias of TS_PATH_ALIASES) {
    if (!moduleSpec.startsWith(alias.prefix)) continue;
    const suffix = moduleSpec.slice(alias.prefix.length);
    const joined = joinPosix(alias.targetPrefix, suffix);
    for (const ext of CANDIDATE_EXTENSIONS) {
      const candidate = normalizePosix(joined + ext);
      const resolved = normalizedFilePaths.get(candidate);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function resolveImportToFilePath(
  importerFilePath: string,
  moduleSpec: string,
  normalizedFilePaths: Map<string, string>,
  knownFilePaths: readonly string[],
): string | undefined {
  if (moduleSpec.startsWith(".")) {
    return resolveRelativeImportToFilePath(
      importerFilePath,
      moduleSpec,
      normalizedFilePaths,
      knownFilePaths,
    );
  }
  return resolveAliasedImportToFilePath(moduleSpec, normalizedFilePaths);
}

export function collectReviewGraphFiles(
  script: VideoScript,
  canonicalFiles?: ReviewGraphCanonicalFiles,
): ReviewFileNodeSource[] {
  const byFilePath = new Map<string, {
    filePath: string;
    label: string;
    directory: string;
    sceneNumbers: Set<number>;
    snippets: Array<{ sceneNumber: number; order: number; code: string }>;
    seenSnippets: Set<string>;
  }>();

  for (const scene of script.scenes) {
    scene.codeBroll.forEach((entry, index) => {
      if (!entry.filePath) return;
      const existing = byFilePath.get(entry.filePath) ?? {
        filePath: entry.filePath,
        label: getBasename(entry.filePath),
        directory: getDirectory(entry.filePath),
        sceneNumbers: new Set<number>(),
        snippets: [],
        seenSnippets: new Set<string>(),
      };
      existing.sceneNumbers.add(scene.sceneNumber);
      const normalizedCode = entry.code.trim();
      if (normalizedCode && !existing.seenSnippets.has(normalizedCode)) {
        existing.seenSnippets.add(normalizedCode);
        existing.snippets.push({
          sceneNumber: scene.sceneNumber,
          order: index,
          code: normalizedCode,
        });
      }
      byFilePath.set(entry.filePath, existing);
    });
  }

  return [...byFilePath.values()]
    .map((entry) => {
      const sceneNumbers = [...entry.sceneNumbers].sort((a, b) => a - b);
      const snippets = [...entry.snippets]
        .sort((a, b) => a.sceneNumber - b.sceneNumber || a.order - b.order)
        .map((snippet) => snippet.code);
      const canonicalCode = canonicalFiles?.[entry.filePath]?.trim();
      return {
        filePath: entry.filePath,
        label: entry.label,
        directory: entry.directory,
        sceneNumbers,
        primarySceneNumber: sceneNumbers[0] ?? 0,
        mergedCode: canonicalCode && canonicalCode.length > 0
          ? canonicalCode
          : snippets.join("\n\n"),
      };
    })
    .sort(
      (a, b) =>
        a.primarySceneNumber - b.primarySceneNumber
        || a.filePath.localeCompare(b.filePath),
    );
}

function deriveReviewTestPairEdges(nodes: ReviewFileNodeSource[]): ReviewFileDerivedEdge[] {
  if (nodes.length < 2) return [];

  const byNormalizedBasename = new Map<string, ReviewFileNodeSource[]>();
  for (const node of nodes) {
    const base = getBasename(node.filePath);
    const normalized = stripTestSuffix(base) ?? base;
    const group = byNormalizedBasename.get(normalized) ?? [];
    group.push(node);
    byNormalizedBasename.set(normalized, group);
  }

  const edges = new Map<string, ReviewFileDerivedEdge>();
  for (const group of byNormalizedBasename.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const aIsTest = isTestBasename(getBasename(a.filePath));
        const bIsTest = isTestBasename(getBasename(b.filePath));
        if (aIsTest === bIsTest) continue;
        const key = makeFilePairKey(a.filePath, b.filePath);
        if (edges.has(key)) continue;
        edges.set(key, {
          sourceFilePath: a.filePath,
          targetFilePath: b.filePath,
          relationship: "test_pair",
        });
      }
    }
  }

  return [...edges.values()];
}

export function deriveReviewFileEdges(nodes: ReviewFileNodeSource[]): ReviewFileDerivedEdge[] {
  if (nodes.length < 2) return [];

  const filePaths = nodes.map((node) => node.filePath);
  const normalizedFilePaths = new Map(
    filePaths.map((filePath) => [normalizePosix(filePath), filePath] as const),
  );
  const symbolDefinedBy = new Map<string, string>();
  const codeByFilePath = new Map<string, string>();

  for (const node of nodes) {
    if (!node.mergedCode) continue;
    codeByFilePath.set(node.filePath, node.mergedCode);
    const defRegexes = [
      CLASS_DEF_RE,
      INTERFACE_DEF_RE,
      TYPE_DEF_RE,
      ENUM_DEF_RE,
      FUNCTION_DEF_RE,
      CONST_DEF_RE,
    ];
    for (const regex of defRegexes) {
      for (const match of node.mergedCode.matchAll(regex)) {
        const symbol = match[1];
        if (!symbolDefinedBy.has(symbol)) {
          symbolDefinedBy.set(symbol, node.filePath);
        }
      }
    }
  }

  const edges = new Map<string, ReviewFileDerivedEdge>();
  const upsert = (sourceFilePath: string, targetFilePath: string, relationship: GraphEdgeRelationship) => {
    if (sourceFilePath === targetFilePath) return;
    const key = makeFilePairKey(sourceFilePath, targetFilePath);
    const existing = edges.get(key);
    if (existing) {
      const existingRank = PRECEDENCE_INDEX.get(existing.relationship) ?? Infinity;
      const nextRank = PRECEDENCE_INDEX.get(relationship) ?? Infinity;
      if (nextRank >= existingRank) return;
    }
    edges.set(key, {
      sourceFilePath,
      targetFilePath,
      relationship,
    });
  };

  for (const node of nodes) {
    const code = codeByFilePath.get(node.filePath);
    if (!code) continue;

    for (const match of code.matchAll(EXTENDS_RE)) {
      const target = symbolDefinedBy.get(match[1]);
      if (target) {
        upsert(node.filePath, target, "inheritance");
      }
    }

    for (const match of code.matchAll(IMPLEMENTS_RE)) {
      const interfaces = (match[1] ?? "").split(/\s*,\s*/).filter(Boolean);
      for (const iface of interfaces) {
        const target = symbolDefinedBy.get(iface);
        if (target) {
          upsert(node.filePath, target, "realization");
        }
      }
    }

    for (const match of code.matchAll(FIELD_DECL_RE)) {
      const target = symbolDefinedBy.get(match[1]);
      if (target) {
        upsert(node.filePath, target, "composition");
      }
    }

    for (const regex of [IMPORT_RE, REQUIRE_RE]) {
      for (const match of code.matchAll(regex)) {
        const moduleSpec = match[1];
        if (!moduleSpec) continue;
        const target = resolveImportToFilePath(
          node.filePath,
          moduleSpec,
          normalizedFilePaths,
          filePaths,
        );
        if (target) {
          upsert(node.filePath, target, "dependency");
        }
      }
    }

    for (const match of code.matchAll(IDENTIFIER_RE)) {
      const target = symbolDefinedBy.get(match[1]);
      if (target) {
        upsert(node.filePath, target, "association");
      }
    }
  }

  for (const edge of deriveReviewTestPairEdges(nodes)) {
    upsert(edge.sourceFilePath, edge.targetFilePath, edge.relationship);
  }

  return [...edges.values()].sort(
    (a, b) =>
      a.sourceFilePath.localeCompare(b.sourceFilePath)
      || a.targetFilePath.localeCompare(b.targetFilePath)
      || (PRECEDENCE_INDEX.get(a.relationship) ?? Infinity) - (PRECEDENCE_INDEX.get(b.relationship) ?? Infinity),
  );
}

function seedNodes(
  entries: ReviewFileNodeSource[],
  cx: number,
  cy: number,
): SimNode[] {
  const count = entries.length;
  return entries.map((entry, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      filePath: entry.filePath,
      label: entry.label,
      directory: entry.directory,
      radius: DEFAULT_NODE_RADIUS,
      x: cx + Math.cos(angle) * SEED_RING_RADIUS,
      y: cy + Math.sin(angle) * SEED_RING_RADIUS,
      vx: 0,
      vy: 0,
    };
  });
}

function seedClusteredNodes(
  entries: ReviewFileNodeSource[],
  cx: number,
  cy: number,
): SimNode[] {
  const byDirectory = new Map<string, ReviewFileNodeSource[]>();
  for (const entry of entries) {
    const list = byDirectory.get(entry.directory) ?? [];
    list.push(entry);
    byDirectory.set(entry.directory, list);
  }

  const directories = [...byDirectory.keys()];
  const clusterRadius = SEED_RING_RADIUS * 1.2;
  const nodes: SimNode[] = [];

  directories.forEach((directory, clusterIndex) => {
    const clusterAngle = (clusterIndex / directories.length) * Math.PI * 2;
    const clusterCx = cx + Math.cos(clusterAngle) * clusterRadius;
    const clusterCy = cy + Math.sin(clusterAngle) * clusterRadius;
    const clusterEntries = byDirectory.get(directory) ?? [];
    const localRadius = Math.min(140, 80 + clusterEntries.length * 8);

    clusterEntries.forEach((entry, localIndex) => {
      const localAngle =
        clusterEntries.length === 1
          ? 0
          : (localIndex / clusterEntries.length) * Math.PI * 2;
      nodes.push({
        filePath: entry.filePath,
        label: entry.label,
        directory,
        radius: DEFAULT_NODE_RADIUS,
        x: clusterCx + Math.cos(localAngle) * localRadius,
        y: clusterCy + Math.sin(localAngle) * localRadius,
        vx: 0,
        vy: 0,
      });
    });
  });

  return nodes;
}

function layoutHorizontalRow(
  entries: ReviewFileNodeSource[],
  viewportWidth: number,
  viewportHeight: number,
): ReviewFileLayoutNode[] {
  const count = entries.length;
  if (count === 0) return [];

  const usableWidth = viewportWidth - NODE_MARGIN * 2;
  const y = viewportHeight * FALLBACK_ROW_Y_RATIO;
  return entries.map((entry, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    return {
      filePath: entry.filePath,
      label: entry.label,
      directory: entry.directory,
      x: NODE_MARGIN + t * usableWidth,
      y,
    };
  });
}

export function computeReviewFileLayout(
  files: ReviewFileNodeSource[],
  edges: ReviewFileDerivedEdge[],
  viewportWidth: number,
  viewportHeight: number,
): ReviewFileLayoutResult {
  if (files.length === 0) {
    return {
      nodes: [],
      edges: [],
      viewportWidth,
      viewportHeight,
    };
  }

  const cx = viewportWidth / 2;
  const cy = viewportHeight / 2;

  if (files.length < 4) {
    return {
      nodes: layoutHorizontalRow(files, viewportWidth, viewportHeight),
      edges,
      viewportWidth,
      viewportHeight,
    };
  }

  const simNodes =
    files.length > CLUSTER_THRESHOLD
      ? seedClusteredNodes(files, cx, cy)
      : seedNodes(files, cx, cy);

  const indexByFilePath = new Map(
    simNodes.map((node, index) => [node.filePath, index] as const),
  );
  const links: SimLink[] = edges.flatMap((edge) => {
    const source = indexByFilePath.get(edge.sourceFilePath);
    const target = indexByFilePath.get(edge.targetFilePath);
    if (source === undefined || target === undefined) {
      return [];
    }
    return [{ source, target } as SimLink];
  });

  const simulation = forceSimulation<SimNode>(simNodes)
    .force("center", forceCenter(cx, cy))
    .force("charge", forceManyBody<SimNode>().strength(CHARGE_STRENGTH))
    .force("collide", forceCollide<SimNode>(COLLIDE_RADIUS))
    .force(
      "link",
      forceLink<SimNode, SimLink>(links).distance(LINK_DISTANCE).strength(0.6),
    )
    .stop();

  for (let tick = 0; tick < SIMULATION_TICKS; tick++) {
    simulation.tick();
  }

  return {
    nodes: simNodes.map((node) => ({
      filePath: node.filePath,
      label: node.label,
      directory: node.directory,
      x: clamp(node.x ?? cx, NODE_MARGIN, viewportWidth - NODE_MARGIN),
      y: clamp(node.y ?? cy, NODE_MARGIN, viewportHeight - NODE_MARGIN),
    })),
    edges,
    viewportWidth,
    viewportHeight,
  };
}
