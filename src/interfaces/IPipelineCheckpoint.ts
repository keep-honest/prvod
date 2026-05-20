import type { PRContext } from "@/domain/entities/PRContext";
import type { DiffMetadataCorpus } from "@/domain/entities/DiffMetadataCorpus";
import type { PromptPipelineV2Artifacts } from "@/domain/entities/PromptPipelineV2";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { ClipAsset } from "@/interfaces/IClipAsset";
import type { WordTiming } from "@/interfaces/ITTSService";

export interface PipelineCheckpoint {
  jobId: string;
  /** 0-8 — resume from completedStep + 1 */
  completedStep: number;
  prContext: PRContext;
  /** Persisted DiffMetadataCorpus for retry resume (spec 005 FR-009). */
  diffCorpus?: DiffMetadataCorpus;
  script?: VideoScript;
  /** Builtin TTS path: tracks audioIncluded flag. */
  audio?: {
    audioUrl: string;
    audioKey: string | null;
    wordTimings: WordTiming[];
    audioIncluded: boolean;
  };
  /** External TTS path: per-scene audio storage keys + word timings for resume. */
  perSceneAudio?: { sceneNumber: number; audioKey: string; wordTimings: WordTiming[]; clipDurations: number[] }[];
  clips?: ClipAsset[];
  promptPipelineV2?: PromptPipelineV2Artifacts;
  /** Audio keys from a pre-migration checkpoint that need cleanup on completion. */
  staleAudioKeys?: string[];
}

export interface IPipelineCheckpointStore {
  save(checkpoint: PipelineCheckpoint): Promise<void>;
  load(jobId: string): Promise<PipelineCheckpoint | null>;
  delete(jobId: string): Promise<void>;
}
