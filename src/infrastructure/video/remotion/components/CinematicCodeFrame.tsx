import React, { useEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";
import {
  getSnippetLineChangeKind,
  getSnippetLineNumbers,
  normalizeSnippetHighlights,
  type CodeLineRange,
} from "@/infrastructure/video/codeLineMapping";

interface CinematicCodeFrameProps {
  filePath: string;
  language: string;
  code: string;
  lineRange?: CodeLineRange;
  highlights?: number[];
  /** Override max-width for animation (default: 1320). */
  maxWidth?: number;
  /** Override border-radius for animation (default: 28). */
  borderRadius?: number;
}

/** Max visible lines before code is truncated with a fade. */
const MAX_VISIBLE_LINES = 19;
/** Height of the code grid area (1080 - scene padding - header - safety margin). */
const CODE_GRID_MAX_HEIGHT = 840;

interface TokenSpan {
  content: string;
  color: string;
}

/**
 * Tokenizes code with shiki (github-dark theme) and returns colored spans per line.
 * Falls back to plain white text if shiki fails or the language is unsupported.
 */
async function tokenizeCode(
  code: string,
  language: string,
): Promise<TokenSpan[][]> {
  try {
    const { codeToTokens } = await import("shiki");
    const result = await codeToTokens(code, {
      lang: language as Parameters<typeof codeToTokens>[1]["lang"],
      theme: "github-dark",
    });
    return result.tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.color ?? "#e6edf3",
      })),
    );
  } catch {
    return code.split("\n").map((line) => [{ content: line || " ", color: "#e6edf3" }]);
  }
}

/**
 * Renders a syntax-highlighted code frame with the github-dark color scheme.
 * Uses shiki for tokenization via Remotion's delayRender/continueRender pattern.
 * Matches the visual style of the FFmpeg code-overlay pipeline.
 */
export const CinematicCodeFrame: React.FC<CinematicCodeFrameProps> = ({
  filePath,
  language,
  code,
  lineRange = null,
  highlights = [],
  maxWidth = 1320,
  borderRadius = 28,
}) => {
  const [tokenLines, setTokenLines] = useState<TokenSpan[][] | null>(null);

  useEffect(() => {
    let handle: number;
    try {
      handle = delayRender("Loading syntax highlighting");
    } catch {
      // Not in Remotion context (SSR, tests) — skip async tokenization
      return;
    }
    let cancelled = false;
    tokenizeCode(code, language)
      .then((tokens) => {
        if (!cancelled) setTokenLines(tokens);
      })
      .finally(() => continueRender(handle));
    return () => { cancelled = true; };
  }, [code, language]);

  const lines = code.split("\n");
  const lineNumbers = getSnippetLineNumbers(lines.length, lineRange);
  const highlightedLines = new Set(
    normalizeSnippetHighlights({
      highlights,
      lineRange,
      lineCount: lines.length,
    }),
  );
  const isTruncated = lines.length > MAX_VISIBLE_LINES;

  return (
    <div
      style={{
        width: "100%",
        maxWidth,
        borderRadius,
        border: "1px solid rgba(255,255,255,0.14)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)), #0d1117",
        boxShadow: "0 40px 120px rgba(0,0,0,0.55)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 22px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.03)",
          fontFamily: "var(--font-display), sans-serif",
          color: "#f0f0f0",
        }}
      >
        <span>{filePath}</span>
        <span
          style={{
            fontSize: 18,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#8aa8ff",
          }}
        >
          {language}
        </span>
      </div>
      <div style={{ position: "relative" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "80px 1fr",
            fontFamily: "'Source Code Pro', 'Fira Code', var(--font-mono), monospace",
            fontSize: 26,
            lineHeight: 1.7,
            color: "#e6edf3",
            padding: "22px 0",
            maxHeight: CODE_GRID_MAX_HEIGHT,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              color: "#484f58",
              textAlign: "right",
              paddingRight: 18,
              userSelect: "none",
            }}
          >
            {lines.map((_, index) => (
              <div key={`line-${lineNumbers[index]}`}>{lineNumbers[index]}</div>
            ))}
          </div>
          <div style={{ paddingRight: 28 }}>
            {lines.map((line, index) => {
              const lineNumber = lineNumbers[index] ?? index + 1;
              const isHighlighted = highlightedLines.has(lineNumber);
              const isRemoved = getSnippetLineChangeKind(line) === "removed";
              const tokens = tokenLines?.[index];
              return (
                <div
                  key={`${lineNumber}`}
                  style={{
                    whiteSpace: "pre-wrap",
                    padding: "0 18px",
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
                  }}
                >
                  {tokens
                    ? tokens.map((token, ti) => (
                        <span key={ti} style={{ color: token.color }}>
                          {token.content}
                        </span>
                      ))
                    : lines[index] || " "}
                </div>
              );
            })}
          </div>
        </div>
        {isTruncated ? (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 80,
              background: "linear-gradient(transparent, #0d1117)",
              pointerEvents: "none",
            }}
          />
        ) : null}
      </div>
    </div>
  );
};
