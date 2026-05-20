import type { ReviewGraphData } from "./ReviewGraph";

export type ReviewVisibility = "public" | "private";
export type ReviewAutoplayMode = "auto_if_permitted" | "manual_ready_state";
export type ReviewPlaybackMode = "full_review" | "file_focus";

export interface ReviewCodeExcerpt {
  filePath: string;
  code: string;
  language: string;
  lineRange: [number, number] | null;
  highlights: number[];
}

export interface ReviewScene {
  sceneNumber: number;
  sceneType: string;
  startTimeMs: number;
  endTimeMs: number;
  narration: string;
  filePaths: string[];
  replayable: boolean;
  codeExcerpt: ReviewCodeExcerpt | null;
}

export interface ReviewFileEntry {
  filePath: string;
  sceneNumbers: number[];
  changeSummary?: string;
  primarySceneNumber?: number;
}

export interface ReviewPageModel {
  jobId: string;
  repoFullName: string;
  prNumber: number;
  /** "default" | "short" | "popcorn" — drives the review badge label. */
  durationMode: string;
  /** LLM-generated headline for the review page. */
  headline: string;
  visibility: ReviewVisibility;
  autoplayMode: ReviewAutoplayMode;
  videoUrl: string;
  durationSeconds: number;
  files: ReviewFileEntry[];
  scenes: ReviewScene[];
  /** Optional review graph (file relationships) used by Remotion video scenes. */
  reviewGraph?: ReviewGraphData;
}
