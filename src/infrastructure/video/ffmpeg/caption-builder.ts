/**
 * Generates ASS (Advanced SubStation Alpha) subtitle files for ffmpeg caption burn-in.
 *
 * Converts per-scene word-level timings (from Google TTS or model-native audio) into
 * a single `.ass` file with per-word reveal using `\alpha` + `\t` override tags.
 * Each cue is one Dialogue line (single subtitle block) with words progressively
 * revealed at their startTimeMs, matching Remotion's CaptionOverlay visibility logic.
 *
 * Flow: SceneTimelineEntry[] -> buildCaptionCues (shared) -> ASS dialogue lines
 *
 * @module caption-builder
 */
import type { SceneTimelineEntry } from "@/interfaces/IClipAsset";
import type { WordTiming } from "@/interfaces/ITTSService";
import { buildCaptionCues } from "@/infrastructure/video/remotion/components/CaptionOverlay";
import { restoreDotsInWordTimings, restoreDataFormatNamesInWordTimings } from "@/lib/narrationText";
import { createLogger } from "@/lib/logger";

const logger = createLogger("caption-builder");

const FPS = 30;

// ── ASS header template ─────────────────────────────────────────────

const ASS_HEADER = `[Script Info]
Title: prvod captions
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,32,&H00FFFFFF,&H004FD5FF,&H00000000,&HB2000000,-1,0,0,0,100,100,0,0,3,0,0,2,40,40,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Converts milliseconds to ASS timestamp format `H:MM:SS.cs` (centiseconds).
 * Negative values are clamped to 0.
 *
 * @param ms - Time in milliseconds
 * @returns Formatted ASS timestamp string
 */
export function msToASS(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalCs = Math.round(clamped / 10);
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Escapes characters that have special meaning in ASS dialogue text.
 * ASS uses `\n` for soft line break and `\N` for hard line break,
 * so literal backslashes must be doubled.
 */
function escapeAssText(word: string): string {
  return word.replace(/\\/g, "\\\\");
}

/**
 * Builds a single ASS text string for a caption cue with per-word reveal.
 *
 * All words must be in ONE Dialogue line so libass renders them as a single
 * horizontal phrase (separate Dialogue lines would stack vertically).
 * Words after the first start fully transparent (`\alpha&HFF&`) and become
 * visible at their `startTimeMs` via an instant `\t` transform.
 *
 * This matches Remotion's CaptionOverlay which uses `visibility: hidden`
 * until each token's startTimeMs is reached.
 *
 * @param tokens - Word timings for the cue (scene-relative startTimeMs/endTimeMs)
 * @param absOffsetMs - Combined scene + caption offset (sceneOffsetMs + captionOffsetMs)
 * @param dialogueStartMs - The effective dialogue start (max(0, rawStartMs)) — the
 *   actual ASS timestamp after msToASS clamping. \t offsets are relative to this.
 */
function buildPerWordRevealText(
  tokens: WordTiming[],
  absOffsetMs: number,
  dialogueStartMs: number,
): string {
  return tokens
    .map((token, i) => {
      const word = escapeAssText(token.word);
      // Compute this word's absolute time, then offset from dialogue start
      const wordAbsMs = token.startTimeMs + absOffsetMs;
      const offsetMs = wordAbsMs - dialogueStartMs;
      if (i === 0 || offsetMs <= 0) {
        // First word or words at/before dialogue start: visible immediately
        return word;
      }
      // Hidden initially, revealed at the word's offset from dialogue start.
      // \alpha&HFF& = fully transparent; \t(ms,ms,...) = instant transform.
      return `{\\alpha&HFF&\\t(${offsetMs},${offsetMs},\\alpha&H00&)}${word}`;
    })
    .join(" ");
}

// ── Main export ──────────────────────────────────────────────────────

/**
 * Generates a complete ASS subtitle document from per-scene word timings.
 *
 * Each scene's `wordTimings` are 0-based (relative to that scene's audio start).
 * This function accumulates frame offsets across the timeline to produce absolute
 * timestamps, then applies the user-configurable `captionOffsetMs` for fine-tuning
 * audio-visual sync.
 *
 * @param sceneTimeline - Ordered scene entries with optional word-level timings
 * @param captionOffsetMs - Global offset (positive = later, negative = earlier) from `CAPTION_OFFSET_MS` env var
 * @returns Complete ASS file content string, ready to write to disk
 */
export function generateCaptionASS(
  sceneTimeline: SceneTimelineEntry[],
  captionOffsetMs: number,
): string {
  const dialogueLines: string[] = [];

  // Accumulate in floating-point milliseconds to avoid integer-frame
  // quantization drift across scenes. When durationSeconds is set (from
  // ffprobe), it carries the precise probed duration — no rounding through
  // Math.round(seconds * FPS) / FPS. Over 7+ scenes this prevents the
  // ~330-467ms cumulative error that causes captions to bleed past scene cuts.
  let cumulativeMs = 0;

  for (const scene of sceneTimeline) {
    const sceneDurationMs = (scene.durationSeconds ?? scene.durationFrames / FPS) * 1000;

    if (!scene.wordTimings || scene.wordTimings.length === 0) {
      cumulativeMs += sceneDurationMs;
      continue;
    }

    const sceneOffsetMs = cumulativeMs;
    const sceneEndMs = cumulativeMs + sceneDurationMs;
    const cues = buildCaptionCues(
      restoreDataFormatNamesInWordTimings(restoreDotsInWordTimings(scene.wordTimings)),
    );

    logger.debug("Building ASS cues for scene", {
      sceneNumber: scene.sceneNumber,
      cueCount: cues.length,
      sceneOffsetMs,
    });

    // Emit one ASS dialogue line per cue — all words in a single Dialogue
    // so libass renders them as one horizontal phrase (separate Dialogue
    // lines would stack vertically). Per-word reveal is achieved via
    // \alpha + \t override tags that keep each word invisible until its
    // startTimeMs, matching Remotion's CaptionOverlay visibility logic.
    const absOffsetMs = sceneOffsetMs + captionOffsetMs;

    for (const cue of cues) {
      const rawStartMs = cue.startMs + absOffsetMs;
      const rawEndMs = cue.endMs + absOffsetMs;
      // Clamp end to scene boundary — Remotion auto-clips via <Sequence>
      const endMs = Math.min(rawEndMs, sceneEndMs);
      // Effective start after msToASS clamping (negative → 0)
      const effectiveStartMs = Math.max(0, rawStartMs);

      if (endMs <= 0 || endMs <= effectiveStartMs) continue;

      const text = buildPerWordRevealText(cue.tokens, absOffsetMs, effectiveStartMs);
      dialogueLines.push(
        `Dialogue: 0,${msToASS(rawStartMs)},${msToASS(endMs)},Default,,0,0,0,,${text}`,
      );
    }

    cumulativeMs += sceneDurationMs;
  }

  logger.debug("Generated ASS subtitle content", {
    totalDialogueLines: dialogueLines.length,
    totalScenes: sceneTimeline.length,
  });

  if (dialogueLines.length === 0) {
    return ASS_HEADER;
  }

  return `${ASS_HEADER}\n${dialogueLines.join("\n")}\n`;
}
