import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { WordTiming } from "@/interfaces/ITTSService";
import { restoreDotsInWordTimings, restoreDataFormatNamesInWordTimings } from "@/lib/narrationText";

const MAX_WORDS_PER_CUE = 6;
const MAX_CUE_GAP_MS = 450;

interface CaptionOverlayProps {
  wordTimings: WordTiming[];
  /** Milliseconds to shift captions. Positive = delay captions, negative = advance. */
  captionOffsetMs?: number;
}

interface CaptionCue {
  tokens: WordTiming[];
  startMs: number;
  endMs: number;
}

function endsSentence(word: string): boolean {
  return /[.!?]["')\]]*$/.test(word);
}

export function buildCaptionCues(wordTimings: WordTiming[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let currentCue: WordTiming[] = [];

  for (let i = 0; i < wordTimings.length; i += 1) {
    const token = wordTimings[i];
    const previous = currentCue[currentCue.length - 1];
    const gapMs = previous ? token.startTimeMs - previous.endTimeMs : 0;
    const shouldStartNewCue =
      currentCue.length > 0 &&
      (currentCue.length >= MAX_WORDS_PER_CUE ||
        endsSentence(previous.word) ||
        gapMs > MAX_CUE_GAP_MS);

    if (shouldStartNewCue) {
      cues.push({
        tokens: currentCue,
        startMs: currentCue[0].startTimeMs,
        endMs: currentCue[currentCue.length - 1].endTimeMs,
      });
      currentCue = [];
    }

    currentCue.push(token);
  }

  if (currentCue.length > 0) {
    cues.push({
      tokens: currentCue,
      startMs: currentCue[0].startTimeMs,
      endMs: currentCue[currentCue.length - 1].endTimeMs,
    });
  }

  return cues;
}

export function findActiveCaptionCue(
  cues: CaptionCue[],
  currentTimeMs: number,
): CaptionCue | null {
  return (
    cues.find(
      (cue) => currentTimeMs >= cue.startMs && currentTimeMs < cue.endMs,
    ) ?? null
  );
}

export function findHighlightedWordIndex(
  cue: CaptionCue,
  currentTimeMs: number,
): number {
  const activeIndex = cue.tokens.findIndex(
    (token) =>
      currentTimeMs >= token.startTimeMs && currentTimeMs < token.endTimeMs,
  );

  if (activeIndex >= 0) {
    return activeIndex;
  }

  return cue.tokens.reduce((lastStartedIndex, token, index) => {
    if (currentTimeMs >= token.startTimeMs) {
      return index;
    }
    return lastStartedIndex;
  }, -1);
}

/**
 * Renders word-timed captions at the bottom of the frame.
 */
export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
  wordTimings,
  captionOffsetMs = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // May be negative during early frames when captionOffsetMs > 0 (delay mode);
  // findActiveCaptionCue correctly returns null for negative times.
  const currentTimeMs = (frame / fps) * 1000 - captionOffsetMs;

  const cues = useMemo(
    () => buildCaptionCues(restoreDataFormatNamesInWordTimings(restoreDotsInWordTimings(wordTimings))),
    [wordTimings],
  );
  const activeCue = findActiveCaptionCue(cues, currentTimeMs);

  if (!activeCue) return null;

  const highlightedWordIndex = findHighlightedWordIndex(activeCue, currentTimeMs);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 80,
      }}
    >
      <div
        style={{
          background: "rgba(0, 0, 0, 0.7)",
          borderRadius: 8,
          padding: "10px 24px",
          maxWidth: "80%",
        }}
      >
        <span
          style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}
        >
          {activeCue.tokens.map((token, index) => {
            const hasStarted = currentTimeMs >= token.startTimeMs;
            const isActive = index === highlightedWordIndex;

            return (
              <span
                key={`${token.startTimeMs}-${token.word}`}
                style={{
                  visibility: hasStarted ? "visible" : "hidden",
                  fontFamily: "Inter, sans-serif",
                  fontWeight: isActive ? 700 : 600,
                  fontSize: 32,
                  lineHeight: 1.2,
                  color: isActive ? "#111111" : "#ffffff",
                  background: isActive ? "#ffd54f" : "transparent",
                  borderRadius: 6,
                  padding: isActive ? "2px 8px" : "2px 0",
                  textShadow: isActive ? "none" : "0 2px 8px rgba(0,0,0,0.8)",
                }}
              >
                {token.word}
              </span>
            );
          })}
        </span>
      </div>
    </AbsoluteFill>
  );
};
