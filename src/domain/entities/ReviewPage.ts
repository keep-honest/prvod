import type { ReviewGraphData } from "./ReviewGraph";
import type {
  ReviewDiffSnapshot,
  ReviewPin,
  SceneDiffAnchor,
} from "./ReviewDiffSnapshot";

export type ReviewVisibility = "public" | "private";
export type ReviewAccessPolicy = "open" | "github_authenticated";
export type ReviewAutoplayMode = "auto_if_permitted" | "manual_ready_state";
export type ReviewPlaybackMode = "full_review" | "file_focus";
export type ReviewSnapshotStatus = "current" | "outdated";

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
  anchorIds: string[];
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
  accessPolicy: ReviewAccessPolicy;
  autoplayMode: ReviewAutoplayMode;
  videoUrl: string;
  durationSeconds: number;
  snapshotStatus: ReviewSnapshotStatus;
  reviewedHeadSha: string;
  diffSnapshot: ReviewDiffSnapshot;
  sceneAnchors: SceneDiffAnchor[];
  pins: ReviewPin[];
  canSyncDrafts: boolean;
  reviewerKey: string | null;
  files: ReviewFileEntry[];
  scenes: ReviewScene[];
  /**
   * Interactive review graph for the review page's "Map" tab. Nodes represent
   * files, edges classify semantic relationships, and the viewport contains the
   * initial camera framing for the client-side renderer.
   */
  reviewGraph?: ReviewGraphData;
}
