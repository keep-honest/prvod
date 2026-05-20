import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { CodeLineRange } from "@/infrastructure/video/codeLineMapping";
import { CinematicCodeFrame } from "./CinematicCodeFrame";
import {
  computeEntranceTransform,
  computeKenBurnsTransform,
} from "./AnimatedCodeCard";

/**
 * ShrinkToNodeTransition renders the scene's code snippet and collapses it
 * into its constellation-graph node once narration ends.
 *
 * The component is phase-aware via the `narrationFrames` and
 * `shrinkFrames` props:
 *
 * - Frame 0..narrationFrames: the code frame sits at the canvas center, full
 *   size, with an entrance spring + Ken Burns pan reused from AnimatedCodeCard.
 * - Frame narrationFrames..narrationFrames+shrinkFrames: a spring animates
 *   scale 1.0 → SHRUNK_SCALE, position (center → target), borderRadius
 *   28 → 999, and opacity 1 → 0 near the end so it smoothly hands off to the
 *   ConstellationGraph's rendered node.
 * - Frame ≥ narrationFrames+shrinkFrames: fully invisible (graph takes over).
 *
 * All positioning happens in canvas space (0..viewportWidth × 0..viewportHeight)
 * via an AbsoluteFill coordinate system — this matches the ConstellationGraph
 * SVG's viewBox so the shrink lands exactly on top of the node circle.
 */
export interface ShrinkToNodeTransitionProps {
  filePath: string;
  language: string;
  code: string;
  lineRange?: CodeLineRange;
  highlights?: number[];
  /** Target node position in canvas coordinates. */
  targetX: number;
  targetY: number;
  /** Canvas viewport size — usually 1920x1080. */
  viewportWidth: number;
  viewportHeight: number;
  /** Frame at which narration ends and shrink begins. */
  narrationFrames: number;
  /** Number of frames spent on the shrink spring. */
  shrinkFrames: number;
  /** Optional start position override. Defaults to viewport center. */
  startX?: number;
  startY?: number;
}

/** The final scale ratio that lines the code frame up with the node circle. */
const SHRUNK_SCALE = 0.06;
/** Fade the code content during the last N frames of the shrink to hand off cleanly. */
const CONTENT_FADE_TRAIL_FRAMES = 8;

/**
 * Pure helper: given a progress value in [0, 1] along the shrink timeline,
 * returns the interpolated position, scale, and opacity for the code frame.
 * Exported for unit tests.
 */
export function computeShrinkTransform(
  progress: number,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
): { x: number; y: number; scale: number; borderRadius: number; contentOpacity: number } {
  const clamped = Math.max(0, Math.min(1, progress));
  const x = startX + (targetX - startX) * clamped;
  const y = startY + (targetY - startY) * clamped;
  const scale = 1 - (1 - SHRUNK_SCALE) * clamped;
  const borderRadius = 28 + (999 - 28) * clamped;
  const contentOpacity = clamped < 0.6 ? 1 : Math.max(0, 1 - (clamped - 0.6) / 0.4);
  return { x, y, scale, borderRadius, contentOpacity };
}

export const ShrinkToNodeTransition: React.FC<ShrinkToNodeTransitionProps> = ({
  filePath,
  language,
  code,
  lineRange = null,
  highlights = [],
  targetX,
  targetY,
  viewportWidth,
  viewportHeight,
  narrationFrames,
  shrinkFrames,
  startX: startXProp,
  startY: startYProp,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const centerX = startXProp ?? viewportWidth / 2;
  const centerY = startYProp ?? viewportHeight / 2;

  const shrinkEnd = narrationFrames + shrinkFrames;

  // Phase A: narration — reuse AnimatedCodeCard's entrance + Ken Burns helpers
  // to keep the motion language consistent with Phase 1.
  const entrance = computeEntranceTransform(frame, fps);
  const kenBurns = computeKenBurnsTransform(frame, narrationFrames);

  // Phase B: shrink — spring-driven progress that begins at narrationFrames.
  const shrinkLocalFrame = Math.max(0, frame - narrationFrames);
  const shrinkSpring = spring({
    frame: shrinkLocalFrame,
    fps,
    config: { damping: 18, mass: 0.9, stiffness: 120 },
    durationInFrames: shrinkFrames,
  });
  const shrinkProgress = frame < narrationFrames ? 0 : shrinkSpring;
  const transform = computeShrinkTransform(
    shrinkProgress,
    centerX,
    centerY,
    targetX,
    targetY,
  );

  // After the shrink finishes, the graph renders the node circle. Fade out
  // the code frame completely by then so there's no double-draw.
  const postShrinkOpacity = interpolate(
    frame,
    [shrinkEnd - CONTENT_FADE_TRAIL_FRAMES, shrinkEnd],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const combinedScale = transform.scale;
  const combinedOpacity = entrance.opacity * postShrinkOpacity;

  // The CinematicCodeFrame's natural width is ~1320px. When placed with
  // `left/top` at the target coordinates we offset by half its size so the
  // anchor is the center — then scale around that center.
  const naturalWidth = 1320;

  return (
    <div
      style={{
        position: "absolute",
        left: transform.x - naturalWidth / 2,
        top: transform.y - 400, // approximate vertical center of a code card
        width: naturalWidth,
        transform: `translate(${kenBurns.translateX}px, ${
          frame < narrationFrames ? Math.round(entrance.translateY) : 0
        }px) scale(${combinedScale})`,
        transformOrigin: "center center",
        opacity: combinedOpacity,
        willChange: "transform, opacity",
      }}
    >
      <div
        style={{
          borderRadius: transform.borderRadius,
          overflow: "hidden",
          opacity: transform.contentOpacity,
        }}
      >
        <CinematicCodeFrame
          filePath={filePath}
          language={language}
          code={code}
          lineRange={lineRange}
          highlights={highlights}
          borderRadius={transform.borderRadius}
        />
      </div>
    </div>
  );
};
