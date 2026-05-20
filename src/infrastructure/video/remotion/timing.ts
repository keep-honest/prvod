import type { Scene, VideoScript } from "@/domain/entities/VideoScript";
import type { SceneTimelineEntry } from "@/interfaces/IClipAsset";
import type { WordTiming } from "@/interfaces/ITTSService";
import { sanitizeSpokenNarrationText } from "@/lib/narrationText";

export const AUDIO_END_PADDING_MS = 900;

/**
 * Constellation animation suffix (Phase 2).
 * After narration ends, every code-first scene plays a spring-based
 * shrink-to-node transition followed by an edge draw-in reveal.
 * These constants are consumed by both the Remotion components and the
 * VideoOrchestrator (which inflates scene durations so the animation has
 * time to play past the TTS track).
 */
export const SHRINK_ANIMATION_FRAMES = 45;
export const GRAPH_REVEAL_FRAMES = 30;
export const CONSTELLATION_SUFFIX_FRAMES =
  SHRINK_ANIMATION_FRAMES + GRAPH_REVEAL_FRAMES;

/**
 * Returns the number of frames that should be appended to a code-first scene
 * to accommodate the constellation animation. Overview/narrative scenes
 * without a `codeBroll[0]` do not participate in the graph and receive no
 * suffix.
 */
export function getConstellationSuffix(hasCodeBroll: boolean): number {
  return hasCodeBroll ? CONSTELLATION_SUFFIX_FRAMES : 0;
}

/**
 * Finale animation timing constants.
 * FINALE_STAGGER_FRAMES is imported by ConstellationGraph.tsx — single source of truth.
 */
/** Stagger delay between consecutive node spring-in entrances in the finale. */
export const FINALE_STAGGER_FRAMES = 8;
/**
 * Base frame budget after all stagger delays: spring settle (~40) + edge settle
 * delay (12) + edge draw (18) + drift ramp (30) + enjoyable drift (50).
 */
export const FINALE_BASE_FRAMES = 150;
/** Absolute minimum for the finale scene regardless of node count (8 s @ 30 fps). */
export const FINALE_ABSOLUTE_MIN_FRAMES = 240;

/**
 * Minimum durationInFrames required for the finaleReveal animation to look
 * complete for a graph with `nodeCount` nodes. Used by generateClips to
 * inflate the last scene so the drift phase is clearly visible.
 */
export function computeFinaleMinFrames(nodeCount: number): number {
  const staggerBudget = Math.max(0, nodeCount - 1) * FINALE_STAGGER_FRAMES;
  return Math.max(staggerBudget + FINALE_BASE_FRAMES, FINALE_ABSOLUTE_MIN_FRAMES);
}

function getSceneWordCounts(scenes: Scene[]): number[] {
  return scenes.map((scene) =>
    sanitizeSpokenNarrationText(scene.narration).split(/\s+/).filter(Boolean).length,
  );
}

export function getSceneNarrationDurationsMs(
  scenes: Scene[],
  wordTimings: WordTiming[],
): number[] {
  if (wordTimings.length === 0) {
    return scenes.map(() => 0);
  }

  const sceneWordCounts = getSceneWordCounts(scenes);
  const totalSceneWords = sceneWordCounts.reduce((sum, count) => sum + count, 0);

  if (totalSceneWords === 0) {
    return scenes.map(() => 0);
  }

  if (wordTimings.length === totalSceneWords) {
    let wordIndex = 0;
    return scenes.map((_, sceneIndex) => {
      const count = sceneWordCounts[sceneIndex];
      if (count === 0) {
        return 0;
      }

      const sceneWords = wordTimings.slice(wordIndex, wordIndex + count);
      wordIndex += count;
      if (sceneWords.length === 0) {
        return 0;
      }

      return Math.max(
        0,
        sceneWords[sceneWords.length - 1].endTimeMs - sceneWords[0].startTimeMs,
      );
    });
  }

  const audioSpanMs = Math.max(
    0,
    wordTimings[wordTimings.length - 1].endTimeMs - wordTimings[0].startTimeMs,
  );

  return sceneWordCounts.map((count) => {
    if (count === 0) {
      return 0;
    }

    return Math.round((count / totalSceneWords) * audioSpanMs);
  });
}

export function resolveSceneTimeline(
  script: VideoScript,
  wordTimings: WordTiming[],
  fps: number,
): VideoScript {
  const narrationDurationsMs = getSceneNarrationDurationsMs(script.scenes, wordTimings);

  const scenes = script.scenes.map((scene, index) => {
    const scriptFrames = Math.round(scene.durationSeconds * fps);
    const narrationFrames = Math.ceil((narrationDurationsMs[index] / 1000) * fps);
    const resolvedFrames = Math.max(scriptFrames, narrationFrames);
    const resolvedSeconds = Math.max(1, Math.ceil(resolvedFrames / fps));

    if (resolvedSeconds === scene.durationSeconds) {
      return scene;
    }

    return {
      ...scene,
      durationSeconds: resolvedSeconds,
    };
  });

  const totalDurationSeconds = scenes.reduce(
    (sum, scene) => sum + scene.durationSeconds,
    0,
  );

  const timingChanged =
    totalDurationSeconds !== script.totalDurationSeconds ||
    scenes.some((scene, index) => scene.durationSeconds !== script.scenes[index]?.durationSeconds);

  if (!timingChanged) {
    return script;
  }

  return {
    ...script,
    scenes,
    totalDurationSeconds,
  };
}

export function resolveClipRequestDurationSeconds(
  timelineDurationSeconds: number,
  validDurations?: readonly number[],
): number {
  if (!validDurations || validDurations.length === 0) {
    return Math.max(1, Math.ceil(timelineDurationSeconds));
  }

  const sortedDurations = [...validDurations].sort((a, b) => a - b);
  const minimumDurationSeconds = Math.max(1, Math.ceil(timelineDurationSeconds));

  return (
    sortedDurations.find((duration) => duration >= minimumDurationSeconds) ??
    sortedDurations[sortedDurations.length - 1]
  );
}

export function getRequiredTotalFrames(
  totalDurationSeconds: number,
  wordTimings: WordTiming[],
  fps: number,
  minimumFrames?: number,
): number {
  const scriptFrames = minimumFrames ?? Math.round(totalDurationSeconds * fps);
  const lastWordEndMs = wordTimings[wordTimings.length - 1]?.endTimeMs ?? 0;

  if (lastWordEndMs <= 0) {
    return scriptFrames;
  }

  const audioFrames = Math.ceil(((lastWordEndMs + AUDIO_END_PADDING_MS) / 1000) * fps);
  return Math.max(scriptFrames, audioFrames);
}

export function getSceneTimelineTotalFrames(sceneTimelineFrames: SceneTimelineEntry[]): number {
  return sceneTimelineFrames.reduce((sum, scene) => sum + scene.durationFrames, 0);
}
