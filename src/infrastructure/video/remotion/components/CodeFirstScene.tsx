import React, { useRef } from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import type { CodeBroll } from "@/domain/entities/VideoScript";
import type { CodeLineRange } from "@/infrastructure/video/codeLineMapping";
import { AnimatedBackground } from "./AnimatedBackground";
import { AnimatedCodeCard, computeExitTransform } from "./AnimatedCodeCard";
import { CodeSnippetMontage } from "./CodeSnippetMontage";
import { MultiCodeCard } from "./MultiCodeCard";

interface CodeFirstSceneProps {
  sceneNumber: number;
  filePath?: string | null;
  language?: string | null;
  code?: string | null;
  lineRange?: CodeLineRange;
  highlights?: number[];
  durationInFrames?: number;
  upcomingSnippets?: CodeBroll[];
  /** Additional code snippets for side-by-side display (from codeBroll[1..n]) */
  additionalCodeBroll?: CodeBroll[];
}

export const CodeFirstScene: React.FC<CodeFirstSceneProps> = ({
  sceneNumber,
  filePath,
  language,
  code,
  lineRange = null,
  highlights = [],
  durationInFrames,
  upcomingSnippets = [],
  additionalCodeBroll = [],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const duration = durationInFrames ?? 150;
  const warnedRef = useRef(false);
  if (!durationInFrames && !warnedRef.current) {
    warnedRef.current = true;
    console.warn(`CodeFirstScene ${sceneNumber}: durationInFrames not provided, using fallback ${duration}`);
  }

  return (
    <AbsoluteFill style={{ color: "#f0f0f0" }}>
      <AnimatedBackground />

      {/* Scene badge — fades in with the scene */}
      <div
        style={{
          position: "absolute",
          top: 40,
          left: 48,
          display: "flex",
          gap: 16,
          alignItems: "center",
          fontFamily: "var(--font-display), sans-serif",
          opacity: interpolate(frame, [0, 15], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          transform: `translateY(${interpolate(
            spring({ frame, fps, config: { damping: 15, mass: 0.6 } }),
            [0, 1],
            [20, 0],
          )}px)`,
          zIndex: 10,
        }}
      >
        <div
          style={{
            borderRadius: 999,
            background: "rgba(59,109,255,0.18)",
            border: "1px solid rgba(59,109,255,0.4)",
            padding: "8px 14px",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontSize: 20,
          }}
        >
          Scene {sceneNumber}
        </div>
        <div style={{ color: "#9ea4b0", fontSize: 22 }}>
          Code-first walkthrough
        </div>
      </div>

      {/* Main content: animated code card or narrative bridge */}
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
        {filePath && code && additionalCodeBroll.length > 0 ? (
          <MultiCodeCard
            items={[
              { filePath, code, language: language ?? "text", highlights, lineRange },
              ...additionalCodeBroll,
            ]}
            durationInFrames={duration}
          />
        ) : filePath && code ? (
          <AnimatedCodeCard
            filePath={filePath}
            language={language ?? "text"}
            code={code}
            lineRange={lineRange}
            highlights={highlights}
            durationInFrames={duration}
          />
        ) : upcomingSnippets.length > 0 ? (
          <CodeSnippetMontage
            snippets={upcomingSnippets}
            durationInFrames={duration}
          />
        ) : (
          <NarrativeBridge
            frame={frame}
            fps={fps}
            durationInFrames={duration}
          />
        )}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Narrative bridge for scenes without code (overview, summary).
 * Gets the same entrance/exit animation treatment.
 */
const NarrativeBridge: React.FC<{
  frame: number;
  fps: number;
  durationInFrames: number;
}> = ({ frame, fps, durationInFrames }) => {
  const springVal = spring({ frame, fps, config: { damping: 12, mass: 0.8 } });
  const scale = interpolate(springVal, [0, 1], [0.9, 1]);
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const { opacity: exitOpacity } = computeExitTransform(frame, durationInFrames);

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 1180,
        borderRadius: 28,
        border: "1px solid rgba(255,255,255,0.1)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)), #101318",
        padding: "48px 56px",
        boxShadow: "0 40px 120px rgba(0,0,0,0.55)",
        transform: `scale(${scale})`,
        opacity: opacity * exitOpacity,
        willChange: "transform, opacity",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display), sans-serif",
          fontSize: 42,
        }}
      >
        Narrative bridge
      </div>
    </div>
  );
};
