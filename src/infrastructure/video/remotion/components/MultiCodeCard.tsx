import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import type { CodeBroll } from "@/domain/entities/VideoScript";
import { computeExitTransform } from "./AnimatedCodeCard";
import { CinematicCodeFrame } from "./CinematicCodeFrame";

interface MultiCodeCardProps {
  items: CodeBroll[];
  durationInFrames: number;
}

/**
 * Renders 2+ code snippets side-by-side (for 2 items) or stacked (for 3+).
 * Each card gets a staggered entrance spring and shared exit fade.
 */
export const MultiCodeCard: React.FC<MultiCodeCardProps> = ({
  items,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { opacity: exitOpacity } = computeExitTransform(frame, durationInFrames);

  const isSideBySide = items.length === 2;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: isSideBySide ? "row" : "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        padding: "72px 48px",
        opacity: exitOpacity,
      }}
    >
      {items.map((item, index) => {
        const staggerDelay = index * 8;
        const staggeredFrame = Math.max(0, frame - staggerDelay);
        const springVal = spring({
          frame: staggeredFrame,
          fps,
          config: { damping: 18, mass: 0.8 },
        });
        const scale = interpolate(springVal, [0, 1], [0.9, 1]);
        const opacity = interpolate(staggeredFrame, [0, 12], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const translateY = Math.round(interpolate(springVal, [0, 1], [30, 0]));

        return (
          <div
            key={`${item.filePath}-${index}`}
            style={{
              flex: isSideBySide ? "1 1 0%" : "0 0 auto",
              maxWidth: isSideBySide ? "48%" : "100%",
              transform: `translateY(${translateY}px) scale(${Math.round(scale * 1000) / 1000})`,
              opacity,
              willChange: "transform, opacity",
            }}
          >
            <CinematicCodeFrame
              filePath={item.filePath}
              language={item.language}
              code={item.code}
              lineRange={item.lineRange}
              highlights={item.highlights}
              maxWidth={isSideBySide ? 880 : 1320}
              borderRadius={24}
            />
          </div>
        );
      })}
    </div>
  );
};
