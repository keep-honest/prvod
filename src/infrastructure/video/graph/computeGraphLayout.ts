/**
 * Pure function: VideoScript → GraphLayoutData.
 *
 * Runs a deterministic d3-force simulation to place nodes in the 1920×1080
 * canvas. Output is serialized into `inputProps` for Remotion or used by the
 * FFmpeg static graph PNG generator and the review page SVG.
 *
 * The function is intentionally free of side effects, global state, or RNG:
 * node seeding uses index-based trigonometry, and d3-force operates on the
 * provided arrays in place before the final snapshot is returned.
 *
 * Determinism note: d3-force's own jiggle and velocity decay are deterministic
 * given identical initial positions and parameters, so running the function
 * twice on the same input produces byte-equal output.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { Scene, VideoScript } from "@/domain/entities/VideoScript";
import { clamp } from "@/lib/math";
import { createLogger } from "@/lib/logger";
import type { DerivedEdge } from "./graphRelationships";
import { deriveEdges, getBasename, getDirectory } from "./graphRelationships";
import {
  DEFAULT_NODE_RADIUS,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  NODE_MARGIN,
  type GraphEdge,
  type GraphLayoutData,
  type GraphNode,
} from "./types";

const logger = createLogger("computeGraphLayout");

const SIMULATION_TICKS = 300;
const CHARGE_STRENGTH = -400;
const COLLIDE_RADIUS = 80;
const LINK_DISTANCE = 200;
const SEED_RING_RADIUS = 300;
const FALLBACK_ROW_Y_RATIO = 0.65;
const CLUSTER_THRESHOLD = 20;

interface SimNode extends SimulationNodeDatum {
  nodeId: string;
  sceneNumber: number;
  filePath: string;
  label: string;
  directory: string;
  radius: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: number | SimNode;
  target: number | SimNode;
}


/**
 * Builds the initial set of nodes from ALL codeBroll entries across all scenes.
 * Deduplicates by `filePath`: if the same file appears in multiple scenes or
 * in multiple codeBroll positions within a scene, only the first occurrence
 * produces a node. Multiple nodes CAN share the same `sceneNumber` when a
 * scene has multiple code snippets.
 */
function collectNodes(script: VideoScript): {
  sceneNumber: number;
  filePath: string;
}[] {
  const seen = new Set<string>();
  const entries: { sceneNumber: number; filePath: string }[] = [];

  for (const scene of script.scenes) {
    for (const broll of scene.codeBroll) {
      const filePath = broll.filePath;
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      entries.push({ sceneNumber: scene.sceneNumber, filePath });
    }
  }

  return entries;
}

/**
 * Returns the set of sceneNumbers that will own at least one constellation
 * graph node — i.e., scenes that contain the *first* occurrence of any
 * file path across the script. Iterates ALL codeBroll entries per scene.
 *
 * Mirrors the dedup logic in `collectNodes` but avoids running the full
 * d3-force simulation. Used by the orchestrator to decide which scenes get
 * the constellation animation tail in the Remotion path.
 */
export function getConstellationOwnerSceneNumbers(
  scenes: readonly Scene[],
): Set<number> {
  const seen = new Set<string>();
  const owners = new Set<number>();
  for (const scene of scenes) {
    for (const broll of scene.codeBroll) {
      const filePath = broll.filePath;
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      owners.add(scene.sceneNumber);
    }
  }
  return owners;
}

/**
 * Deterministically seeds each node on a circle around the canvas center.
 * The seed pattern ensures d3-force converges to the same layout every time.
 */
function seedNodes(
  entries: { sceneNumber: number; filePath: string }[],
  cx: number,
  cy: number,
): SimNode[] {
  const n = entries.length;
  return entries.map((entry, index) => {
    const angle = (index / n) * Math.PI * 2;
    return {
      nodeId: entry.filePath,
      sceneNumber: entry.sceneNumber,
      filePath: entry.filePath,
      label: getBasename(entry.filePath),
      directory: getDirectory(entry.filePath),
      radius: DEFAULT_NODE_RADIUS,
      x: cx + Math.cos(angle) * SEED_RING_RADIUS,
      y: cy + Math.sin(angle) * SEED_RING_RADIUS,
      vx: 0,
      vy: 0,
    };
  });
}

/** Horizontal row fallback for very small graphs (< 4 nodes). */
function layoutHorizontalRow(
  entries: { sceneNumber: number; filePath: string }[],
  viewportWidth: number,
  viewportHeight: number,
): GraphNode[] {
  const n = entries.length;
  if (n === 0) return [];

  const usableWidth = viewportWidth - NODE_MARGIN * 2;
  const y = viewportHeight * FALLBACK_ROW_Y_RATIO;
  return entries.map((entry, index) => {
    const t = n === 1 ? 0.5 : index / (n - 1);
    return {
      nodeId: entry.filePath,
      sceneNumber: entry.sceneNumber,
      filePath: entry.filePath,
      label: getBasename(entry.filePath),
      directory: getDirectory(entry.filePath),
      radius: DEFAULT_NODE_RADIUS,
      x: NODE_MARGIN + t * usableWidth,
      y,
    };
  });
}

/**
 * Cluster-aware seeding for > CLUSTER_THRESHOLD nodes. Each directory gets its
 * own mini-ring around a displaced center so the force simulation starts with
 * natural groupings.
 */
function seedClusteredNodes(
  entries: { sceneNumber: number; filePath: string }[],
  cx: number,
  cy: number,
): SimNode[] {
  const byDirectory = new Map<string, { sceneNumber: number; filePath: string }[]>();
  for (const entry of entries) {
    const dir = getDirectory(entry.filePath);
    const list = byDirectory.get(dir) ?? [];
    list.push(entry);
    byDirectory.set(dir, list);
  }

  const directories = Array.from(byDirectory.keys());
  const clusterCount = directories.length;
  const clusterRadius = SEED_RING_RADIUS * 1.2;

  const nodes: SimNode[] = [];
  directories.forEach((dir, clusterIndex) => {
    const clusterAngle = (clusterIndex / clusterCount) * Math.PI * 2;
    const clusterCx = cx + Math.cos(clusterAngle) * clusterRadius;
    const clusterCy = cy + Math.sin(clusterAngle) * clusterRadius;

    const clusterEntries = byDirectory.get(dir) ?? [];
    const localRadius = Math.min(
      140,
      80 + clusterEntries.length * 8,
    );

    clusterEntries.forEach((entry, localIndex) => {
      const localAngle =
        clusterEntries.length === 1
          ? 0
          : (localIndex / clusterEntries.length) * Math.PI * 2;
      nodes.push({
        nodeId: entry.filePath,
        sceneNumber: entry.sceneNumber,
        filePath: entry.filePath,
        label: getBasename(entry.filePath),
        directory: dir,
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

/**
 * Build a quadratic bezier (`Q` command) `d` string between two points with a
 * gentle perpendicular curve. Quadratic keeps the path compact (one control
 * point) and looks identical to a cubic at this curvature.
 */
function buildBezierPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  // Perpendicular offset so the bezier curves rather than crossing straight through.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.hypot(dx, dy);
  const curvature = Math.min(120, distance * 0.25);
  const nx = distance === 0 ? 0 : -dy / distance;
  const ny = distance === 0 ? 0 : dx / distance;
  const cpx = mx + nx * curvature;
  const cpy = my + ny * curvature;

  const r = (v: number) => Math.round(v * 100) / 100;
  return `M ${r(x1)} ${r(y1)} Q ${r(cpx)} ${r(cpy)} ${r(x2)} ${r(y2)}`;
}

/**
 * Main entry point. Converts the script into positioned graph data used by
 * both compositors and the review page. Safe to call multiple times — always
 * produces the same output for identical input.
 *
 * @throws if the viewport is non-finite or too small to accommodate the
 *         NODE_MARGIN on both axes. This is a programmer error (not a data
 *         error), so we fail closed rather than silently clamp into an
 *         inverted range.
 */
export function computeGraphLayout(
  script: VideoScript,
  options?: {
    viewportWidth?: number;
    viewportHeight?: number;
    /**
     * Override the edge-derivation function. Defaults to the legacy
     * `deriveEdges` which produces same_directory + key_file_adjacency
     * edges for the in-video (Remotion/FFmpeg) constellation. The review
     * page passes `deriveReviewPageEdges` for UML-classified edges.
     */
    edgeDerivation?: (nodes: GraphNode[], script: VideoScript) => DerivedEdge[];
  },
): GraphLayoutData {
  const deriveEdgesFn =
    options?.edgeDerivation ??
    ((nodes: GraphNode[], s: VideoScript) => deriveEdges(nodes, s.keyFiles));
  const viewportWidth = options?.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
  const viewportHeight = options?.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;

  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) {
    throw new Error(
      `computeGraphLayout: non-finite viewport ${viewportWidth}x${viewportHeight}`,
    );
  }
  if (
    viewportWidth < NODE_MARGIN * 2 + 1 ||
    viewportHeight < NODE_MARGIN * 2 + 1
  ) {
    throw new Error(
      `computeGraphLayout: viewport ${viewportWidth}x${viewportHeight} too small (need > ${NODE_MARGIN * 2}px on each axis)`,
    );
  }

  const cx = viewportWidth / 2;
  const cy = viewportHeight / 2;

  const entries = collectNodes(script);
  const scenesWithCodeBroll = script.scenes.filter(
    (s) => s.codeBroll.length > 0,
  ).length;
  const duplicatesDropped = Math.max(0, scenesWithCodeBroll - entries.length);

  logger.debug("computeGraphLayout start", {
    sceneCount: script.scenes.length,
    scenesWithCodeBroll,
    uniqueNodes: entries.length,
    duplicatesDropped,
    viewportWidth,
    viewportHeight,
  });

  // Alert on high dedup ratios — this is a strong signal of a script-writer
  // regression (same file emitted for every scene). Operators should see this.
  if (
    duplicatesDropped > 0 &&
    entries.length > 0 &&
    scenesWithCodeBroll >= 4 &&
    duplicatesDropped / scenesWithCodeBroll >= 0.5
  ) {
    logger.warn(
      "Constellation dedup dropped >=50% of scenes — possible script regression",
      {
        scenesWithCodeBroll,
        uniqueFilePaths: entries.length,
        droppedDuplicates: duplicatesDropped,
      },
    );
  }

  if (entries.length === 0) {
    return {
      nodes: [],
      edges: [],
      viewportWidth,
      viewportHeight,
    };
  }

  let placedNodes: GraphNode[];

  if (entries.length < 4) {
    placedNodes = layoutHorizontalRow(entries, viewportWidth, viewportHeight);
  } else {
    const simNodes =
      entries.length > CLUSTER_THRESHOLD
        ? seedClusteredNodes(entries, cx, cy)
        : seedNodes(entries, cx, cy);

    // Build link list using derived edges (so the link force pulls related
    // nodes together rather than a random arrangement).
    const nodePreview: GraphNode[] = simNodes.map((n) => ({
      nodeId: n.nodeId,
      sceneNumber: n.sceneNumber,
      filePath: n.filePath,
      label: n.label,
      directory: n.directory,
      radius: n.radius,
      x: n.x ?? 0,
      y: n.y ?? 0,
    }));
    const derived = deriveEdgesFn(nodePreview, script);
    const indexByNodeId = new Map(
      simNodes.map((n, i) => [n.nodeId, i]),
    );
    // Fallback for legacy edgeDerivation callbacks without nodeId
    const indexBySceneNumber = new Map(
      simNodes.map((n, i) => [n.sceneNumber, i]),
    );
    const links: SimLink[] = derived
      .map((edge) => {
        const s = edge.sourceNodeId
          ? indexByNodeId.get(edge.sourceNodeId)
          : indexBySceneNumber.get(edge.sourceSceneNumber);
        const t = edge.targetNodeId
          ? indexByNodeId.get(edge.targetNodeId)
          : indexBySceneNumber.get(edge.targetSceneNumber);
        return s === undefined || t === undefined
          ? null
          : ({ source: s, target: t } as SimLink);
      })
      .filter((v): v is SimLink => v !== null);

    const simulation = forceSimulation<SimNode>(simNodes)
      .force("center", forceCenter(cx, cy))
      .force("charge", forceManyBody<SimNode>().strength(CHARGE_STRENGTH))
      .force("collide", forceCollide<SimNode>(COLLIDE_RADIUS))
      .force(
        "link",
        forceLink<SimNode, SimLink>(links).distance(LINK_DISTANCE).strength(0.6),
      )
      .stop();

    // Synchronous tick — d3-force's stopped simulation runs deterministically
    // with no alpha decay randomness. We apply the fixed tick count.
    for (let i = 0; i < SIMULATION_TICKS; i++) {
      simulation.tick();
    }

    let nonFiniteCount = 0;
    for (const n of simNodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        nonFiniteCount++;
      }
    }
    if (nonFiniteCount > 0) {
      logger.warn(
        "Force simulation produced non-finite node positions; coerced to viewport center",
        {
          simNodeCount: simNodes.length,
          nonFiniteCount,
        },
      );
    }

    placedNodes = simNodes.map((n) => ({
      nodeId: n.nodeId,
      sceneNumber: n.sceneNumber,
      filePath: n.filePath,
      label: n.label,
      directory: n.directory,
      radius: n.radius,
      x: clamp(n.x ?? cx, NODE_MARGIN, viewportWidth - NODE_MARGIN),
      y: clamp(n.y ?? cy, NODE_MARGIN, viewportHeight - NODE_MARGIN),
    }));
  }

  // Derive the final edge list from the placed nodes (now that x/y are known)
  // and attach pre-computed bezier paths.
  const derivedEdges = deriveEdgesFn(placedNodes, script);
  const nodeByNodeId = new Map(
    placedNodes.map((n) => [n.nodeId, n]),
  );
  // Fallback for legacy edgeDerivation callbacks that don't set nodeId.
  // Note: with multi-file scenes, sceneNumber is NOT unique — last-write wins.
  // This is acceptable because legacy callers only run on single-file-per-scene scripts.
  const nodeBySceneNumber = new Map(
    placedNodes.map((n) => [n.sceneNumber, n]),
  );
  const edges: GraphEdge[] = derivedEdges.flatMap((edge) => {
    const source = edge.sourceNodeId
      ? nodeByNodeId.get(edge.sourceNodeId)
      : nodeBySceneNumber.get(edge.sourceSceneNumber);
    const target = edge.targetNodeId
      ? nodeByNodeId.get(edge.targetNodeId)
      : nodeBySceneNumber.get(edge.targetSceneNumber);
    if (!source || !target) return [];
    return [
      {
        sourceNodeId: source.nodeId,
        targetNodeId: target.nodeId,
        sourceSceneNumber: source.sceneNumber,
        targetSceneNumber: target.sceneNumber,
        relationship: edge.relationship,
        pathD: buildBezierPath(source.x, source.y, target.x, target.y),
      },
    ];
  });

  // Surface keyFiles that never made it into the graph (usually because the
  // script writer listed them but no scene used them in any codeBroll entry).
  if (script.keyFiles && script.keyFiles.length > 0) {
    const nodePaths = new Set(placedNodes.map((n) => n.filePath));
    const missingKeyFiles = script.keyFiles.filter((f) => !nodePaths.has(f));
    if (missingKeyFiles.length > 0) {
      logger.debug("Constellation: keyFiles not covered by graph nodes", {
        totalKeyFiles: script.keyFiles.length,
        missingCount: missingKeyFiles.length,
        missing: missingKeyFiles.slice(0, 10),
      });
    }
  }

  logger.info("computeGraphLayout complete", {
    nodes: placedNodes.length,
    edges: edges.length,
  });

  return {
    nodes: placedNodes,
    edges,
    viewportWidth,
    viewportHeight,
  };
}
