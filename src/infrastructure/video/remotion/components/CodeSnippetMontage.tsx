import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { CodeBroll } from "@/domain/entities/VideoScript";
import { computeExitTransform } from "./AnimatedCodeCard";
import { CinematicCodeFrame } from "./CinematicCodeFrame";

const MAX_CARDS = 6;
const CARD_SCALE = 0.38;
const STAGGER_FRAMES = 6;

/** Compute the elliptical position for a card at a given index and frame. */
export function orbitPosition(
  index: number,
  total: number,
  frame: number,
  fps: number,
): { x: number; y: number } {
  if (total === 0) return { x: 0, y: 0 };
  const baseAngle = (index / total) * 2 * Math.PI;
  const rotationSpeed = 0.15; // radians per second
  const angle = baseAngle + (frame / fps) * rotationSpeed;
  const rx = 680;
  const ry = 260;
  return {
    x: rx * Math.cos(angle),
    y: ry * Math.sin(angle),
  };
}

/** Compute the entrance spring value for a staggered card. */
export function cardEntrance(
  frame: number,
  fps: number,
  index: number,
): number {
  const delay = index * STAGGER_FRAMES;
  const adjustedFrame = Math.max(0, frame - delay);
  return spring({ frame: adjustedFrame, fps, config: { damping: 14, mass: 0.7 } });
}

interface CodeSnippetMontageProps {
  snippets: CodeBroll[];
  durationInFrames: number;
}

export const CodeSnippetMontage: React.FC<CodeSnippetMontageProps> = ({
  snippets,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cards = snippets.slice(0, MAX_CARDS);
  const total = cards.length;

  const { opacity: exitOpacity } = computeExitTransform(frame, durationInFrames);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        opacity: exitOpacity,
      }}
    >
      {cards.map((snippet, index) => {
        const { x, y } = orbitPosition(index, total, frame, fps);
        const entrance = cardEntrance(frame, fps, index);
        const scale = interpolate(entrance, [0, 1], [0.3, CARD_SCALE]);
        const opacity = interpolate(entrance, [0, 1], [0, 0.85]);
        // Cards closer to the viewer (lower y) appear larger/brighter
        const depthScale = interpolate(y, [-260, 260], [0.85, 1.15], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const depthOpacity = interpolate(y, [-260, 260], [0.6, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={`montage-${index}-${snippet.filePath}`}
            style={{
              position: "absolute",
              left: "50%",
              top: "45%",
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale * depthScale})`,
              opacity: opacity * depthOpacity,
              zIndex: Math.round(y + 300),
              willChange: "transform, opacity",
              pointerEvents: "none",
            }}
          >
            <CinematicCodeFrame
              filePath={snippet.filePath}
              language={snippet.language}
              code={snippet.code}
              lineRange={snippet.lineRange}
              highlights={snippet.highlights}
              maxWidth={900}
              borderRadius={20}
            />
          </div>
        );
      })}

    </div>
  );
};
