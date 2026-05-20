import type { PRContext } from "@/domain/entities/PRContext";

export interface DraftReviewCommentInput {
  path: string;
  body: string;
  position: number;
}

export interface SyncDraftReviewCommentsParams {
  repoFullName: string;
  prNumber: number;
  reviewerAccessToken: string;
  commitId: string;
  comments: DraftReviewCommentInput[];
  pendingReviewId?: number | null;
  summary?: string;
}

export interface SyncDraftReviewCommentsResult {
  pendingReviewId: number;
  commentCount: number;
}

export interface SubmitPendingReviewParams {
  repoFullName: string;
  prNumber: number;
  reviewerAccessToken: string;
  pendingReviewId: number;
  body?: string;
}

export interface DiscardPendingReviewParams {
  repoFullName: string;
  prNumber: number;
  reviewerAccessToken: string;
  pendingReviewId: number;
}

export interface IGitHubService {
  /**
   * Fetch full PR context from GitHub REST API.
   * Fetches PR metadata, unified diff, linked issues (up to 5), and milestone.
   *
   * @param installationId GitHub App installation ID
   */
  fetchPRContext(
    repoFullName: string,
    prNumber: number,
    installationId?: number,
  ): Promise<PRContext>;

  /**
   * Fetch canonical repository file contents from a specific ref.
   * Returns a partial map when some files are unavailable.
   */
  fetchRepositoryFiles?(
    repoFullName: string,
    ref: string,
    filePaths: string[],
    installationId?: number,
  ): Promise<Record<string, string>>;

  /**
   * Post a markdown comment on a pull request (or issue).
   *
   * @param installationId GitHub App installation ID
   */
  postComment(
    repoFullName: string,
    prNumber: number,
    body: string,
    installationId?: number,
  ): Promise<void>;

  syncDraftReviewComments?(
    params: SyncDraftReviewCommentsParams,
  ): Promise<SyncDraftReviewCommentsResult>;

  submitPendingReview?(
    params: SubmitPendingReviewParams,
  ): Promise<{ submittedReviewId: number }>;

  discardPendingReview?(
    params: DiscardPendingReviewParams,
  ): Promise<void>;
}
