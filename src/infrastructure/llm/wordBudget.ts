import type { DurationMode } from "@/domain/entities/PRContext";
import {
  DEFAULT_MODE_MAX_DURATION,
  MAX_SCRIPT_SCENES,
  MAX_VIDEO_DURATION_SECONDS,
  MIN_SCRIPT_SCENES,
  MIN_VIDEO_DURATION_SECONDS,
  POPCORN_MODE_MIN_DURATION,
  SHORT_MODE_MAX_DURATION,
} from "@/domain/entities/VideoScript";

export const NATURAL_SECONDS_PER_WORD = 0.4;
const MIN_TTS_SPEAKING_RATE = 0.25;
const MAX_TTS_SPEAKING_RATE = 4.0;

function roundToHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampSpeakingRate(rate: number): number {
  return Math.min(MAX_TTS_SPEAKING_RATE, Math.max(MIN_TTS_SPEAKING_RATE, rate));
}

export function parseTtsSpeedMultiplier(raw = process.env.TTS_SPEED_MULTIPLIER): number {
  const parsed = parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0;
}

export function computeTtsSpeakingRate(
  wordCount: number,
  targetDurationSeconds?: number,
  speedMultiplier = parseTtsSpeedMultiplier(),
): number {
  if (!targetDurationSeconds || targetDurationSeconds <= 0 || wordCount <= 0) {
    return clampSpeakingRate(speedMultiplier);
  }

  const naturalDurationSeconds = wordCount * NATURAL_SECONDS_PER_WORD;
  const rawRate = naturalDurationSeconds / targetDurationSeconds;
  const cappedRate = Math.min(rawRate, 1.0);
  return clampSpeakingRate(roundToHundredths(cappedRate * speedMultiplier));
}

export function computeActualNarrationDurationSeconds(
  wordCount: number,
  targetDurationSeconds: number,
  speedMultiplier = parseTtsSpeedMultiplier(),
): number {
  if (wordCount <= 0) return 0;
  return (wordCount * NATURAL_SECONDS_PER_WORD)
    / computeTtsSpeakingRate(wordCount, targetDurationSeconds, speedMultiplier);
}

export function computeMaxSpokenWordsForDuration(
  durationSeconds: number,
  speedMultiplier = parseTtsSpeedMultiplier(),
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;

  let low = 0;
  let high = Math.max(1, Math.ceil(durationSeconds * (MAX_TTS_SPEAKING_RATE / NATURAL_SECONDS_PER_WORD)));

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const actualDuration = computeActualNarrationDurationSeconds(
      mid,
      durationSeconds,
      speedMultiplier,
    );
    if (actualDuration <= durationSeconds + 1e-9) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

export function describeActualTtsTiming(speedMultiplier = parseTtsSpeedMultiplier()): string {
  return speedMultiplier === 1
    ? "actual TTS timing at the current speed settings"
    : `actual TTS timing with TTS_SPEED_MULTIPLIER=${speedMultiplier}`;
}

// ── Code-First Flexible Durations ────────────────────────────────────────────

interface DurationRange {
  minSeconds: number;
  maxSeconds: number;
}

function getDurationRangeForMode(durationMode?: DurationMode): DurationRange {
  switch (durationMode) {
    case "short":
      return { minSeconds: MIN_VIDEO_DURATION_SECONDS, maxSeconds: SHORT_MODE_MAX_DURATION };
    case "popcorn":
      return { minSeconds: POPCORN_MODE_MIN_DURATION, maxSeconds: MAX_VIDEO_DURATION_SECONDS };
    default:
      return { minSeconds: MIN_VIDEO_DURATION_SECONDS, maxSeconds: DEFAULT_MODE_MAX_DURATION };
  }
}

export interface TotalWordBudget {
  minWords: number;
  maxWords: number;
  recommendedPerScene: { min: number; max: number };
}

/**
 * Compute the total spoken-word budget for a code-first script based on
 * the duration mode's time range. Advisory per-scene range derived from
 * total budget / scene count bounds.
 */
export function computeTotalWordBudgetForMode(
  durationMode?: DurationMode,
  speedMultiplier = parseTtsSpeedMultiplier(),
): TotalWordBudget {
  const range = getDurationRangeForMode(durationMode);
  const wordsPerSecond = speedMultiplier / NATURAL_SECONDS_PER_WORD;
  const minWords = Math.ceil(range.minSeconds * wordsPerSecond);
  const maxWords = Math.floor(range.maxSeconds * wordsPerSecond);
  return {
    minWords,
    maxWords,
    recommendedPerScene: {
      min: Math.max(1, Math.floor(minWords / MAX_SCRIPT_SCENES)),
      max: Math.ceil(maxWords / MIN_SCRIPT_SCENES),
    },
  };
}

/**
 * Compute `durationSeconds` for a code-first scene from its narration
 * word count. TTS speaks at natural pace (adjusted by speed multiplier),
 * so duration = wordCount * secondsPerWord / speedMultiplier.
 */
export function computeDurationSecondsFromWordCount(
  wordCount: number,
  speedMultiplier = parseTtsSpeedMultiplier(),
): number {
  if (wordCount <= 0) return 1;
  return Math.max(1, Math.ceil(wordCount * NATURAL_SECONDS_PER_WORD / speedMultiplier));
}
