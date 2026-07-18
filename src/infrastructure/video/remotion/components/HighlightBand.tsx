import React from "react";
import { useVideoConfig, useCurrentFrame, interpolate, Easing } from "remotion";

interface HighlightBandProps {
  /** Absolute line numbers to highlight (matches `codeBroll.highlights` semantics). */
  lineNumbers: number[];
  /** Snippet's lineRange (used to translate absolute → relative line index). */
  cardLineRange: [number, number] | null;
  /** Total lines rendered in the card (for bounds). */
  cardLineCount: number;
  /** When the highlight should fade in (TTS word start). */
  startMs: number;
  /** When the highlight should fade out (TTS word end). */
  endMs: number;
  /** Pixel height of one rendered code line in the card. */
  lineHeightPx: number;
  /** Pixel offset from the card's top to the first line of code. */
  topPaddingPx: number;
  /** Pixel width of the highlight band (matches card body width). */
  widthPx: number;
}

/**
 * Animated highlight band painted over specific code lines in the active card.
 * Fades in 120ms before `startMs`, fades out 120ms after `endMs`. Multiple lines
 * collapse to a single contiguous band when they're adjacent.
 */
export const HighlightBand: React.FC<HighlightBandProps> = ({
  lineNumbers,
  cardLineRange,
  cardLineCount,
  startMs,
  endMs,
  lineHeightPx,
  topPaddingPx,
  widthPx,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  // Convert absolute line numbers to relative indices within the card.
  const baseLine = cardLineRange ? cardLineRange[0] : 1;
  const relativeIndices = lineNumbers
    .map((ln) => ln - baseLine)
    .filter((idx) => idx >= 0 && idx < cardLineCount);
  if (relativeIndices.length === 0) return null;

  // Collapse adjacent indices into contiguous bands [startIdx, endIdx].
  const sorted = [...new Set(relativeIndices)].sort((a, b) => a - b);
  const bands: Array<[number, number]> = [];
  let bandStart = sorted[0];
  let bandEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === bandEnd + 1) {
      bandEnd = sorted[i];
    } else {
      bands.push([bandStart, bandEnd]);
      bandStart = sorted[i];
      bandEnd = sorted[i];
    }
  }
  bands.push([bandStart, bandEnd]);

  // Fade in/out anchored on startMs/endMs (120ms ramps).
  const FADE_MS = 120;
  const opacity = interpolate(
    currentMs,
    [startMs - FADE_MS, startMs, endMs, endMs + FADE_MS],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.ease },
  );
  if (opacity <= 0) return null;

  return (
    <>
      {bands.map(([startIdx, endIdx], i) => {
        const top = topPaddingPx + startIdx * lineHeightPx;
        const height = (endIdx - startIdx + 1) * lineHeightPx;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              top,
              left: 0,
              width: widthPx,
              height,
              background: "rgba(56, 139, 253, 0.28)",
              borderLeft: "3px solid #388bfd",
              opacity,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
};
