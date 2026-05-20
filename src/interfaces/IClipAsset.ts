import type { WordTiming } from "./ITTSService";

export interface ClipAsset {
  sceneNumber: number;
  /** 0-based index within the scene (for multi-clip scenes). */
  clipIndex: number;
  clipUrl: string;
  sourceType?: "video" | "code";
  durationSeconds: number;
  durationFrames?: number;
}

export interface SceneTimelineEntry {
  sceneNumber: number;
  durationFrames: number;
  /**
   * Precise probed duration in seconds (float). Set by FFmpegCompositor after
   * ffprobe. Used by caption-builder and filter-graph-builder for timing that
   * avoids integer-frame quantization drift across scenes. Falls back to
   * `durationFrames / FPS` when absent (e.g. Remotion path, pre-probe).
   */
  durationSeconds?: number;
  /** Served URL to this scene's narration audio (external TTS path only). */
  audioSrc?: string;
  /** Per-scene word timings, 0-based from the start of this scene's audio. */
  wordTimings?: WordTiming[];
}
