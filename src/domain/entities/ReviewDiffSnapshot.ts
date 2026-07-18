export type ReviewDiffLineKind = "context" | "added" | "removed" | "meta";
export type ReviewDiffFileChangeType = "added" | "modified" | "deleted" | "renamed" | "mixed";
export type ReviewAnchorPrecision = "exact" | "overview";
export type ReviewPinCategory = "risk" | "test_gap" | "question" | "intent";

export interface ReviewDiffLine {
  lineId: string;
  kind: ReviewDiffLineKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
  position: number | null;
}

export interface ReviewDiffHunk {
  hunkId: string;
  header: string;
  lines: ReviewDiffLine[];
}

export interface ReviewDiffFile {
  filePath: string;
  changeType: ReviewDiffFileChangeType;
  oldPath: string | null;
  hunks: ReviewDiffHunk[];
}

export interface ReviewDiffSnapshot {
  headSha: string;
  headRepoFullName: string;
  capturedAt: string;
  files: ReviewDiffFile[];
  totalFiles: number;
  totalRenderableLines: number;
}

export interface SceneDiffAnchor {
  anchorId: string;
  sceneNumber: number;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  precision: ReviewAnchorPrecision;
  lineIds: string[];
}

export interface ReviewPin {
  pinId: string;
  category: ReviewPinCategory;
  sceneNumbers: number[];
  anchorIds: string[];
  filePaths: string[];
  prose: string;
  suggestedComment: string;
}

export interface PersistedReviewWorkspaceMetrics {
  reviewDiffSnapshot?: ReviewDiffSnapshot;
  sceneDiffAnchors?: SceneDiffAnchor[];
  reviewPins?: ReviewPin[];
}
