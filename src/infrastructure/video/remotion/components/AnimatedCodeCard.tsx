import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import type { CodeLineRange } from "@/infrastructure/video/codeLineMapping";
import { CinematicCodeFrame } from "./CinematicCodeFrame";

interface AnimatedCodeCardProps {
  filePath: string;
  language: string;
  code: string;
  lineRange?: CodeLineRange;
  highlights?: number[];
  durationInFrames: number;
  /** Override for Phase 2: allows shrink animation to control these */
  maxWidth?: number;
  borderRadius?: number;
}

/**
 * Entrance animation values as pure functions of frame — exported for testing.
 */
export function computeEntranceTransform(
  frame: number,
  fps: number,
): { scale: number; opacity: number; translateY: number } {
  const springVal = spring({ frame, fps, config: { damping: 18, mass: 0.8 } });
  const scale = interpolate(springVal, [0, 1], [0.85, 1]);
  const translateY = interpolate(springVal, [0, 1], [40, 0]);
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { scale, opacity, translateY };
}

/**
 * Exit fade values — last 10 frames of the scene.
 */
export function computeExitTransform(
  frame: number,
  durationInFrames: number,
): { scale: number; opacity: number } {
  const exitStart = Math.max(0, durationInFrames - 10);
  const scale = interpolate(frame, [exitStart, durationInFrames], [1, 0.97], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [exitStart, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { scale, opacity };
}

/**
 * Ken Burns slow pan — translateX drift only, delayed until entrance settles.
 * Scale is always 1 to avoid multiplicative jitter with the entrance spring.
 */
export function computeKenBurnsTransform(
  frame: number,
  durationInFrames: number,
): { translateX: number; scale: number } {
  // Delay pan start until the entrance spring has settled (~25 frames)
  const settleFrame = Math.min(25, Math.floor(durationInFrames * 0.15));
  const kenBurnsFrame = Math.max(0, frame - settleFrame);
  const kenBurnsDuration = Math.max(1, durationInFrames - settleFrame);

  const translateX = interpolate(kenBurnsFrame, [0, kenBurnsDuration], [0, -4], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { translateX: Math.round(translateX), scale: 1 };
}

/**
 * Wraps CinematicCodeFrame with entrance spring, Ken Burns pan, and exit fade.
 * The code card animates into view, slowly drifts during narration, and fades out.
 */
export const AnimatedCodeCard: React.FC<AnimatedCodeCardProps> = ({
  filePath,
  language,
  code,
  lineRange = null,
  highlights = [],
  durationInFrames,
  maxWidth,
  borderRadius,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = computeEntranceTransform(frame, fps);
  const exit = computeExitTransform(frame, durationInFrames);
  const kenBurns = computeKenBurnsTransform(frame, durationInFrames);

  const combinedScale = Math.round(entrance.scale * exit.scale * 1000) / 1000;
  const combinedOpacity = entrance.opacity * exit.opacity;
  const combinedTranslateX = Math.round(kenBurns.translateX);
  const combinedTranslateY = Math.round(entrance.translateY);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          transform: `translate(${combinedTranslateX}px, ${combinedTranslateY}px) scale(${combinedScale})`,
          opacity: combinedOpacity,
          willChange: "transform, opacity",
        }}
      >
        <CinematicCodeFrame
          filePath={filePath}
          language={language}
          code={code}
          lineRange={lineRange}
          highlights={highlights}
          maxWidth={maxWidth}
          borderRadius={borderRadius}
        />
      </div>
    </div>
  );
};
