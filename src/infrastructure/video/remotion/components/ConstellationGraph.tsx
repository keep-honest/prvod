import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { evolvePath } from "@remotion/paths";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import { FINALE_STAGGER_FRAMES } from "@/infrastructure/video/remotion/timing";

/**
 * Accumulating constellation graph — rendered once per scene, but knows the
 * current scene's active node so it can:
 *
 *   1. Show all nodes/edges that belong to earlier scenes as "settled".
 *   2. Reveal the current scene's node circle after the shrink phase completes.
 *   3. Animate any edges touching the current node via `evolvePath` during the
 *      reveal phase so relationships draw in from the active node.
 *
 * When `finaleReveal` is true (final scene), the graph runs a staggered build
 * animation: nodes spring in one by one in scene order, edges draw in as both
 * endpoints appear, then a subtle breathing oscillation keeps the visual alive.
 *
 * The SVG viewBox matches the canvas size (1920×1080) so node/edge coordinates
 * coming from `computeGraphLayout` can be used directly — no normalization.
 */
export interface ConstellationGraphProps {
  graphLayout: GraphLayoutData;
  /** Scene currently narrating. Nodes/edges for scenes > this are hidden. */
  currentSceneNumber: number;
  /** Frame at which the reveal phase begins (= narrationFrames + shrinkFrames). */
  revealStartFrame: number;
  /** Number of frames spent drawing edges in. */
  revealFrames: number;
  /** Background opacity for the graph during narration (0..1). */
  dormantOpacity?: number;
  /** When true, runs the staggered finale build animation instead of the
   *  standard incremental reveal. Used for the closing scene. */
  finaleReveal?: boolean;
}

const EDGE_BASE_COLOR = "rgba(84, 214, 255, 0.35)";
const EDGE_ACTIVE_COLOR = "rgba(84, 214, 255, 0.9)";
const NODE_BASE_FILL = "rgba(84, 214, 255, 0.22)";
const NODE_BASE_STROKE = "rgba(84, 214, 255, 0.55)";
const NODE_ACTIVE_FILL = "rgba(84, 214, 255, 0.6)";
const NODE_ACTIVE_STROKE = "rgba(84, 214, 255, 1)";
const LABEL_COLOR = "rgba(230, 237, 243, 0.88)";

/** Duration of each edge draw-in animation in the finale. */
const FINALE_EDGE_DRAW_FRAMES = 18;
/** Frames after the later endpoint settles before its edge starts drawing. */
const FINALE_EDGE_SETTLE_DELAY = 12;
/** Pixel radius of the Lissajous drift orbit in the finale. */
const FINALE_DRIFT_RADIUS = 16;

/**
 * Pure helper: returns draw-in progress for an edge in the current reveal
 * phase. Edges not touching the active node are fully drawn; edges touching
 * the active node animate from 0 to 1 over `revealFrames`. Exported for tests.
 */
export function computeEdgeReveal(args: {
  frame: number;
  revealStartFrame: number;
  revealFrames: number;
  isActiveEdge: boolean;
  isPlaced: boolean;
}): number {
  if (!args.isPlaced) return 0;
  if (!args.isActiveEdge) return 1;
  const local = args.frame - args.revealStartFrame;
  if (local <= 0) return 0;
  if (local >= args.revealFrames) return 1;
  return local / args.revealFrames;
}

/**
 * Pure helper: computes the finale edge draw-in progress for a given edge.
 * The edge starts drawing after both endpoint nodes have settled (their
 * staggered entrance springs have largely completed). Exported for tests.
 */
export function computeFinaleEdgeProgress(args: {
  frame: number;
  sourceIndex: number;
  targetIndex: number;
}): number {
  const sourceDelay = args.sourceIndex * FINALE_STAGGER_FRAMES;
  const targetDelay = args.targetIndex * FINALE_STAGGER_FRAMES;
  const edgeStartFrame = Math.max(sourceDelay, targetDelay) + FINALE_EDGE_SETTLE_DELAY;
  const local = args.frame - edgeStartFrame;
  if (local <= 0) return 0;
  if (local >= FINALE_EDGE_DRAW_FRAMES) return 1;
  return local / FINALE_EDGE_DRAW_FRAMES;
}

/**
 * Pure helper: computes the Lissajous positional drift for a node in the
 * finale. Returns (dx, dy) pixel offsets from the node's anchor position.
 * Uses two sine waves with different frequencies per axis, offset by the
 * node's index, producing organic non-repeating orbital motion. Exported
 * for tests.
 */
export function computeFinaleDrift(args: {
  frame: number;
  fps: number;
  nodeIndex: number;
  staggerDelay: number;
  settleFrames?: number;
  radius?: number;
}): { dx: number; dy: number } {
  const settleFrames = args.settleFrames ?? 25;
  const radius = args.radius ?? FINALE_DRIFT_RADIUS;
  if (args.fps <= 0) return { dx: 0, dy: 0 };
  const elapsed = args.frame - args.staggerDelay - settleFrames;
  if (elapsed <= 0) return { dx: 0, dy: 0 };

  // Ease the drift amplitude in over 30 frames so it doesn't pop
  const rampUp = Math.min(1, elapsed / 30);
  const t = elapsed / args.fps;
  // Each node gets unique frequency offsets from its index for desynchronization
  const phaseX = args.nodeIndex * 1.7;
  const phaseY = args.nodeIndex * 2.3;
  const freqX = 0.45 + (args.nodeIndex % 5) * 0.08;
  const freqY = 0.32 + (args.nodeIndex % 7) * 0.06;

  return {
    dx: Math.sin(t * freqX * Math.PI * 2 + phaseX) * radius * rampUp,
    dy: Math.sin(t * freqY * Math.PI * 2 + phaseY) * radius * rampUp,
  };
}

export const ConstellationGraph: React.FC<ConstellationGraphProps> = ({
  graphLayout,
  currentSceneNumber,
  revealStartFrame,
  revealFrames,
  dormantOpacity = 0.18,
  finaleReveal = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { nodes, edges, viewportWidth, viewportHeight } = graphLayout;

  // Build a scene-order index for staggered finale animation, keyed by nodeId.
  const sortedNodeIndices = useMemo(() => {
    const sorted = [...nodes].sort((a, b) => a.sceneNumber - b.sceneNumber);
    const map = new Map(sorted.map((n, i) => [n.nodeId, i]));
    for (const edge of edges) {
      if (!map.has(edge.sourceNodeId) || !map.has(edge.targetNodeId)) {
        console.error("[ConstellationGraph] edge references unknown nodeId", {
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          knownNodeIds: [...map.keys()],
        });
      }
    }
    return map;
  }, [nodes, edges]);

  // --- Standard mode: fade graph from dormant to full across reveal ---
  const phaseOpacity = finaleReveal
    ? 1
    : interpolate(
        frame,
        [0, revealStartFrame - 6, revealStartFrame],
        [dormantOpacity, dormantOpacity, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );

  // Active node pulse — gentle spring-driven scale bump right after shrink ends.
  // Not used in finale mode (finale nodes use their own entrance spring), so skip
  // the spring computation entirely to avoid per-frame waste.
  const activeNodeScale = finaleReveal
    ? 1
    : interpolate(
        spring({ frame: Math.max(0, frame - revealStartFrame), fps, config: { damping: 10, mass: 0.6 }, durationInFrames: 20 }),
        [0, 1],
        [0, 1.15],
      );

  return (
    <AbsoluteFill style={{ opacity: phaseOpacity }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${viewportWidth} ${viewportHeight}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ position: "absolute", inset: 0 }}
      >
        {/* --- Finale: compute drifted positions for all nodes --- */}
        {finaleReveal && (() => {
          // Pre-compute drifted positions so edges can follow nodes
          const driftByNodeId = new Map<string, { x: number; y: number; entrance: number }>();
          for (const node of nodes) {
            const nodeIndex = sortedNodeIndices.get(node.nodeId) ?? 0;
            const staggerDelay = nodeIndex * FINALE_STAGGER_FRAMES;
            const localFrame = Math.max(0, frame - staggerDelay);
            const entrance = spring({
              frame: localFrame,
              fps,
              config: { damping: 14, mass: 0.7 },
            });
            const drift = computeFinaleDrift({ frame, fps, nodeIndex, staggerDelay });
            driftByNodeId.set(node.nodeId, {
              x: node.x + drift.dx,
              y: node.y + drift.dy,
              entrance,
            });
          }

          return (
            <>
              {/* Finale edges — follow drifted node positions */}
              {edges.map((edge) => {
                const sourceIdx = sortedNodeIndices.get(edge.sourceNodeId);
                const targetIdx = sortedNodeIndices.get(edge.targetNodeId);
                if (sourceIdx === undefined || targetIdx === undefined) return null;
                const progress = computeFinaleEdgeProgress({
                  frame,
                  sourceIndex: sourceIdx,
                  targetIndex: targetIdx,
                });
                if (progress <= 0) return null;

                const src = driftByNodeId.get(edge.sourceNodeId);
                const tgt = driftByNodeId.get(edge.targetNodeId);
                if (!src || !tgt) return null;

                // Dynamic line path between drifted positions
                const dynamicPath = `M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`;
                let strokeDasharray: string | undefined;
                let strokeDashoffset: number | undefined;
                if (progress < 1) {
                  const evolved = evolvePath(progress, dynamicPath);
                  strokeDasharray = `${evolved.strokeDasharray}`;
                  strokeDashoffset = evolved.strokeDashoffset;
                }

                return (
                  <path
                    key={`${edge.sourceNodeId}-${edge.targetNodeId}`}
                    d={dynamicPath}
                    fill="none"
                    stroke={EDGE_BASE_COLOR}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeDasharray={strokeDasharray}
                    strokeDashoffset={strokeDashoffset}
                    opacity={interpolate(progress, [0, 0.3], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    })}
                  />
                );
              })}

              {/* Finale nodes — spring entrance + Lissajous drift */}
              {nodes.map((node) => {
                const drifted = driftByNodeId.get(node.nodeId);
                if (!drifted || drifted.entrance < 0.01) return null;

                const radius = node.radius * drifted.entrance;

                return (
                  <g key={`node-${node.nodeId}`} opacity={drifted.entrance}>
                    <circle
                      cx={drifted.x}
                      cy={drifted.y}
                      r={radius}
                      fill={NODE_BASE_FILL}
                      stroke={NODE_BASE_STROKE}
                      strokeWidth={2}
                    />
                    <text
                      x={drifted.x}
                      y={drifted.y + node.radius + 26}
                      fontFamily="var(--font-display), sans-serif"
                      fontSize={20}
                      fill={LABEL_COLOR}
                      textAnchor="middle"
                      opacity={interpolate(drifted.entrance, [0.5, 1], [0, 1], {
                        extrapolateLeft: "clamp",
                        extrapolateRight: "clamp",
                      })}
                    >
                      {node.label}
                    </text>
                  </g>
                );
              })}
            </>
          );
        })()}

        {/* Edges: drawn before nodes so circles sit on top */}
        {!finaleReveal && edges.map((edge) => {

          // --- Standard incremental reveal ---
          // Guard against orphaned edges (nodeId not in sortedNodeIndices) so they
          // are skipped rather than rendered with stale pathD coordinates.
          if (!sortedNodeIndices.has(edge.sourceNodeId) || !sortedNodeIndices.has(edge.targetNodeId)) return null;

          const sourcePlaced = edge.sourceSceneNumber <= currentSceneNumber;
          const targetPlaced = edge.targetSceneNumber <= currentSceneNumber;
          const isPlaced = sourcePlaced && targetPlaced;
          if (!isPlaced) return null;

          const isActiveEdge =
            edge.sourceSceneNumber === currentSceneNumber ||
            edge.targetSceneNumber === currentSceneNumber;

          const progress = computeEdgeReveal({
            frame,
            revealStartFrame,
            revealFrames,
            isActiveEdge,
            isPlaced,
          });

          let strokeDasharray: string | undefined;
          let strokeDashoffset: number | undefined;
          if (isActiveEdge && progress < 1) {
            const evolved = evolvePath(progress, edge.pathD);
            strokeDasharray = `${evolved.strokeDasharray}`;
            strokeDashoffset = evolved.strokeDashoffset;
          }

          return (
            <path
              key={`${edge.sourceNodeId}-${edge.targetNodeId}`}
              d={edge.pathD}
              fill="none"
              stroke={isActiveEdge ? EDGE_ACTIVE_COLOR : EDGE_BASE_COLOR}
              strokeWidth={isActiveEdge ? 2.5 : 1.5}
              strokeLinecap="round"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
            />
          );
        })}

        {/* Nodes — standard incremental reveal (finale handled above) */}
        {!finaleReveal && nodes.map((node) => {
          const isPlaced = node.sceneNumber < currentSceneNumber;
          const isActive = node.sceneNumber === currentSceneNumber;
          const isVisible = isPlaced || (isActive && frame >= revealStartFrame - 2);
          if (!isVisible) return null;

          const scale = isActive ? activeNodeScale : 1;
          const fill = isActive ? NODE_ACTIVE_FILL : NODE_BASE_FILL;
          const stroke = isActive ? NODE_ACTIVE_STROKE : NODE_BASE_STROKE;
          const radius = node.radius * scale;

          return (
            <g key={`node-${node.nodeId}`}>
              <circle
                cx={node.x}
                cy={node.y}
                r={radius}
                fill={fill}
                stroke={stroke}
                strokeWidth={isActive ? 3 : 2}
              />
              <text
                x={node.x}
                y={node.y + node.radius + 26}
                fontFamily="var(--font-display), sans-serif"
                fontSize={20}
                fill={LABEL_COLOR}
                textAnchor="middle"
              >
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
