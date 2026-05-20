import React from "react";
import { AbsoluteFill } from "remotion";
import type { CodeBroll } from "@/domain/entities/VideoScript";
import type { GraphLayoutData, GraphNode } from "@/infrastructure/video/graph/types";
import {
  GRAPH_REVEAL_FRAMES,
  SHRINK_ANIMATION_FRAMES,
} from "@/infrastructure/video/remotion/timing";
import { AnimatedBackground } from "./AnimatedBackground";
import { ConstellationGraph } from "./ConstellationGraph";
import { ShrinkToNodeTransition } from "./ShrinkToNodeTransition";
import { AnimatedCodeCard } from "./AnimatedCodeCard";

/**
 * ConstellationScene — replaces CodeFirstScene when `graphLayout` is present.
 *
 * Phase A (narration): Code cards are rendered normally, captions play, and
 *   the constellation graph sits in the background at low opacity.
 *
 * Phase B (shrink, 45 frames / 1.5s): Narration is done. Code cards spring
 *   down to their target node positions. Multi-snippet scenes shrink all
 *   cards in parallel, each to its own graph node.
 *
 * Phase C (reveal, 30 frames / 1.0s): Edges incident to new nodes draw in
 *   via `evolvePath`. Then the scene's Sequence ends.
 *
 * Finale: when the scene has no codeBroll (closing/summary), the graph runs
 *   a staggered build-in animation (`finaleReveal`).
 */
export interface ConstellationSceneProps {
  sceneNumber: number;
  graphLayout: GraphLayoutData;
  /** All codeBroll entries for this scene. Empty array for narrative/finale scenes. */
  codeBrollItems: CodeBroll[];
  durationInFrames: number;
  /** When true, forces the finale constellation reveal regardless of codeBroll content. */
  isLastScene?: boolean;
}

/**
 * Compute start positions for parallel shrink when a scene has N code cards.
 * Single cards start from the viewport center (existing behavior). Two cards
 * start side-by-side. Three+ cards stack vertically.
 */
function getMultiCardStartPositions(
  count: number,
  index: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const cx = viewportWidth / 2;
  const cy = viewportHeight / 2;
  if (count <= 1) return { x: cx, y: cy };
  if (count === 2) {
    const offset = 360;
    return { x: cx + (index === 0 ? -offset : offset), y: cy };
  }
  // 3+ cards: distribute vertically
  const spacing = 200;
  const totalHeight = (count - 1) * spacing;
  return { x: cx, y: cy - totalHeight / 2 + index * spacing };
}

export const ConstellationScene: React.FC<ConstellationSceneProps> = ({
  sceneNumber,
  graphLayout,
  codeBrollItems,
  durationInFrames,
  isLastScene = false,
}) => {
  const shrinkFrames = SHRINK_ANIMATION_FRAMES;
  const revealFrames = GRAPH_REVEAL_FRAMES;
  const narrationFrames = Math.max(
    0,
    durationInFrames - shrinkFrames - revealFrames,
  );
  const revealStartFrame = narrationFrames + shrinkFrames;

  // Find ALL nodes this scene owns (multiple when the scene has multi-snippet codeBroll).
  const ownNodes = graphLayout.nodes.filter((n) => n.sceneNumber === sceneNumber);
  const hasOwnNodes = ownNodes.length > 0;

  // Match codeBroll items to their graph nodes by filePath.
  const matchedPairs: { codeBroll: CodeBroll; node: GraphNode; index: number }[] = [];
  codeBrollItems.forEach((item, index) => {
    const node = ownNodes.find((n) => n.filePath === item.filePath);
    if (node) matchedPairs.push({ codeBroll: item, node, index });
  });

  // Unmatched codeBroll items (revisits of previously-seen files).
  const unmatchedBroll = codeBrollItems.filter(
    (item) => !matchedPairs.some((p) => p.codeBroll === item),
  );

  return (
    <AbsoluteFill style={{ color: "#f0f0f0" }}>
      <AnimatedBackground />

      {/* Background graph — visible throughout the scene. Finale mode when
          this is the last scene (forced overview for constellation reveal). */}
      <ConstellationGraph
        graphLayout={graphLayout}
        currentSceneNumber={sceneNumber}
        revealStartFrame={hasOwnNodes && !isLastScene ? revealStartFrame : durationInFrames + 1}
        revealFrames={revealFrames}
        finaleReveal={isLastScene}
      />

      {/* Code cards — each shrinks to its matched graph node in parallel.
          Skipped on the finale scene so the constellation reveal is unobstructed. */}
      {!isLastScene && matchedPairs.map(({ codeBroll, node, index }) => {
        const startPos = matchedPairs.length > 1
          ? getMultiCardStartPositions(matchedPairs.length, index, graphLayout.viewportWidth, graphLayout.viewportHeight)
          : undefined;
        return (
          <ShrinkToNodeTransition
            key={node.nodeId}
            filePath={codeBroll.filePath}
            language={codeBroll.language}
            code={codeBroll.code}
            lineRange={codeBroll.lineRange}
            highlights={codeBroll.highlights}
            targetX={node.x}
            targetY={node.y}
            viewportWidth={graphLayout.viewportWidth}
            viewportHeight={graphLayout.viewportHeight}
            narrationFrames={narrationFrames}
            shrinkFrames={shrinkFrames}
            startX={startPos?.x}
            startY={startPos?.y}
          />
        );
      })}

      {/* Unmatched codeBroll (revisit of previously-seen files) — only shown when
          ALL items are unmatched (pure revisit scene). Mixed scenes intentionally
          drop unmatched items to avoid visual clutter alongside the shrink animation. */}
      {!isLastScene && unmatchedBroll.length > 0 && matchedPairs.length === 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            width: "100%",
            height: "100%",
            padding: "72px 84px",
          }}
        >
          <AnimatedCodeCard
            filePath={unmatchedBroll[0].filePath}
            language={unmatchedBroll[0].language}
            code={unmatchedBroll[0].code}
            lineRange={unmatchedBroll[0].lineRange}
            highlights={unmatchedBroll[0].highlights}
            durationInFrames={durationInFrames}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};
