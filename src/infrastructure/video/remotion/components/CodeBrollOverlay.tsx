import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import type { CodeBroll } from "@/domain/entities/VideoScript";
import {
  getSnippetLineChangeKind,
  getSnippetLineNumbers,
  normalizeSnippetHighlights,
} from "@/infrastructure/video/codeLineMapping";

interface CodeBrollOverlayProps {
  codeBroll: CodeBroll;
  startFrame: number;
  durationFrames: number;
}

/**
 * Overlays syntax-highlighted code as a styled inset over the AI clip.
 * Fades in/out and displays highlighted lines.
 */
export const CodeBrollOverlay: React.FC<CodeBrollOverlayProps> = ({
  codeBroll,
  startFrame,
  durationFrames,
}) => {
  const frame = useCurrentFrame();
  const relativeFrame = frame - startFrame;

  if (relativeFrame < 0 || relativeFrame >= durationFrames) {
    return null;
  }

  const fadeInEnd = 15;
  const fadeOutStart = durationFrames - 15;

  const opacity = interpolate(
    relativeFrame,
    [0, fadeInEnd, fadeOutStart, durationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.ease },
  );

  const lines = codeBroll.code.split("\n");
  const lineNumbers = getSnippetLineNumbers(lines.length, codeBroll.lineRange);
  const highlightedLines = new Set(
    normalizeSnippetHighlights({
      highlights: codeBroll.highlights,
      lineRange: codeBroll.lineRange,
      lineCount: lines.length,
    }),
  );

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "flex-end",
        padding: "40px 60px",
        opacity,
      }}
    >
      <div
        style={{
          background: "rgba(13, 17, 23, 0.92)",
          borderRadius: 12,
          padding: "20px 24px",
          maxWidth: "70%",
          maxHeight: "50%",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            fontFamily: "'Source Code Pro', 'Fira Code', monospace",
            fontSize: 14,
            lineHeight: 1.6,
            color: "#e6edf3",
          }}
        >
          {/* File path header */}
          <div
            style={{
              fontSize: 11,
              color: "#8b949e",
              marginBottom: 8,
              fontFamily: "Inter, sans-serif",
            }}
          >
            {codeBroll.filePath} ({codeBroll.language})
          </div>

          {lines.map((line, i) => {
            const lineNum = lineNumbers[i] ?? i + 1;
            const isHighlighted = highlightedLines.has(lineNum);
            const isRemoved = getSnippetLineChangeKind(line) === "removed";

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  background: isRemoved
                    ? "rgba(248, 81, 73, 0.16)"
                    : isHighlighted
                      ? "rgba(56, 139, 253, 0.15)"
                      : "transparent",
                  borderLeft: isRemoved
                    ? "3px solid #f85149"
                    : isHighlighted
                      ? "3px solid #388bfd"
                    : "3px solid transparent",
                  padding: "1px 8px",
                }}
              >
                <span
                  style={{
                    color: "#484f58",
                    minWidth: 36,
                    textAlign: "right",
                    marginRight: 16,
                    userSelect: "none",
                  }}
                >
                  {lineNum}
                </span>
                <span style={{ whiteSpace: "pre" }}>{line}</span>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
