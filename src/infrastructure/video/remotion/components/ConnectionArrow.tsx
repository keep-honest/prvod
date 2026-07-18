import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { evolvePath } from "@remotion/paths";

interface ConnectionArrowProps {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Word start in ms — arrow begins drawing in. */
  startMs: number;
  /** Word end in ms — arrow begins fading out. */
  endMs: number;
}

const ARROW_COLOR = "#388bfd";
const STROKE_WIDTH = 3;
const ARROWHEAD_SIZE = 12;
const DRAW_IN_MS = 240;
const FADE_OUT_MS = 200;

/**
 * SVG arrow between two screen-space points with animated draw-in via
 * `evolvePath` (matches ConstellationGraph's edge reveal style). Uses a
 * quadratic Bezier with a perpendicular control offset so the line bows
 * cleanly away from the straight midline.
 */
export const ConnectionArrow: React.FC<ConnectionArrowProps> = ({
  from,
  to,
  startMs,
  endMs,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  if (currentMs < startMs - DRAW_IN_MS) return null;
  if (currentMs > endMs + FADE_OUT_MS) return null;

  // Perpendicular control point for the Bezier curve (10% of segment length).
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const segmentLen = Math.hypot(dx, dy) || 1;
  const perpX = -dy / segmentLen;
  const perpY = dx / segmentLen;
  const offset = Math.min(80, segmentLen * 0.1);
  const midX = (from.x + to.x) / 2 + perpX * offset;
  const midY = (from.y + to.y) / 2 + perpY * offset;

  const pathD = `M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`;

  // Draw-in progress: 0 → 1 over DRAW_IN_MS centered on startMs.
  const drawProgress = interpolate(
    currentMs,
    [startMs - DRAW_IN_MS, startMs],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) },
  );
  const { strokeDasharray, strokeDashoffset } = evolvePath(drawProgress, pathD);

  // Fade out anchored on endMs.
  const fadeOpacity = interpolate(
    currentMs,
    [endMs, endMs + FADE_OUT_MS],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.ease },
  );

  // Arrowhead at the endpoint (only visible once the draw is mostly complete).
  const arrowOpacity = interpolate(drawProgress, [0.8, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <svg
      width={width}
      height={height}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: fadeOpacity }}
    >
      <defs>
        <marker
          id="arrowhead-syncedcode"
          viewBox={`0 0 ${ARROWHEAD_SIZE} ${ARROWHEAD_SIZE}`}
          refX={ARROWHEAD_SIZE - 2}
          refY={ARROWHEAD_SIZE / 2}
          markerWidth={ARROWHEAD_SIZE / 2}
          markerHeight={ARROWHEAD_SIZE / 2}
          orient="auto-start-reverse"
        >
          <path
            d={`M 0 0 L ${ARROWHEAD_SIZE} ${ARROWHEAD_SIZE / 2} L 0 ${ARROWHEAD_SIZE} z`}
            fill={ARROW_COLOR}
            opacity={arrowOpacity}
          />
        </marker>
      </defs>
      <path
        d={pathD}
        fill="none"
        stroke={ARROW_COLOR}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={strokeDasharray}
        strokeDashoffset={strokeDashoffset}
        markerEnd="url(#arrowhead-syncedcode)"
      />
    </svg>
  );
};
