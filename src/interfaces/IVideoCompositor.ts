import type { VideoScript } from "@/domain/entities/VideoScript";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import type { ClipAsset, SceneTimelineEntry } from "./IClipAsset";

export interface CompositionInput {
  script: VideoScript;
  /** Mixed asset list; code-first scenes may provide synthetic `code://` clip URLs. */
  clips: ClipAsset[];
  /**
   * Per-scene timeline entries. Each entry optionally carries `audioSrc` and
   * `wordTimings` (external TTS path) so Remotion can place narration inside
   * each scene's Sequence rather than using one global audio track.
   */
  sceneTimelineFrames: SceneTimelineEntry[];
  audioIncluded?: boolean;
  /** When set, download clips here (persistent) instead of a temp dir. */
  cacheDir?: string;
  /**
   * Pre-computed constellation graph layout. Remotion renders it as an
   * animated scene transition (shrink-to-node + edge draw-in). FFmpeg
   * renders it as a static PNG overlay on the final scene.
   */
  graphLayout?: GraphLayoutData;
}

export interface CompositionResult {
  videoBuffer: Buffer;
}

export interface IVideoCompositor {
  compose(input: CompositionInput): Promise<CompositionResult>;
}
