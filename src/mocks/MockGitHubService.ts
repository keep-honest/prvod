import type {
  DiscardPendingReviewParams,
  IGitHubService,
  SubmitPendingReviewParams,
  SyncDraftReviewCommentsParams,
} from "@/interfaces/IGitHubService";
import type { PRContext } from "@/domain/entities/PRContext";

export interface PostedComment {
  repoFullName: string;
  prNumber: number;
  body: string;
}

export interface MockPendingReview {
  reviewId: number;
  repoFullName: string;
  prNumber: number;
  commitId: string;
  body: string;
  comments: Array<{
    path: string;
    position: number;
    body: string;
  }>;
  submitted: boolean;
}

export class MockGitHubService implements IGitHubService {
  readonly comments: PostedComment[] = [];
  readonly repositoryFiles: Record<string, string> = {};
  readonly pendingReviews: MockPendingReview[] = [];
  private nextPendingReviewId = 1000;

  async fetchPRContext(
    repoFullName: string,
    prNumber: number,
    installationId?: number,
  ): Promise<PRContext> {
    return {
      repoFullName,
      prNumber,
      prTitle: "Mock PR Title",
      prDescription: "Mock PR description with @prvod annotation",
      diffSource: {
        kind: "github_pr",
        repoFullName,
        prNumber,
        installationId: installationId ?? 1,
      },
      baseBranch: "main",
      headBranch: "feature/mock",
      headRepoFullName: repoFullName,
      headSha: "",
      issues: [],
      milestone: null,
      isPrivate: false,
      durationMode: "default" as const,
      deepdive: false,
    };
  }

  async postComment(
    repoFullName: string,
    prNumber: number,
    body: string,
    _installationId?: number,
  ): Promise<void> {
    this.comments.push({ repoFullName, prNumber, body });
  }

  async fetchRepositoryFiles(
    _repoFullName: string,
    _ref: string,
    filePaths: string[],
    _installationId?: number,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const filePath of filePaths) {
      if (filePath in this.repositoryFiles) {
        result[filePath] = this.repositoryFiles[filePath];
      }
    }
    return result;
  }

  async syncDraftReviewComments(
    params: SyncDraftReviewCommentsParams,
  ): Promise<{ pendingReviewId: number; commentCount: number }> {
    if (params.pendingReviewId) {
      const existingIndex = this.pendingReviews.findIndex(
        (review) => review.reviewId === params.pendingReviewId,
      );
      if (existingIndex >= 0) {
        this.pendingReviews.splice(existingIndex, 1);
      }
    }

    const reviewId = this.nextPendingReviewId++;
    this.pendingReviews.push({
      reviewId,
      repoFullName: params.repoFullName,
      prNumber: params.prNumber,
      commitId: params.commitId,
      body: params.summary ?? "",
      comments: params.comments.map((comment) => ({ ...comment })),
      submitted: false,
    });

    return {
      pendingReviewId: reviewId,
      commentCount: params.comments.length,
    };
  }

  async submitPendingReview(
    params: SubmitPendingReviewParams,
  ): Promise<{ submittedReviewId: number }> {
    const review = this.pendingReviews.find(
      (candidate) =>
        candidate.reviewId === params.pendingReviewId
        && candidate.repoFullName === params.repoFullName
        && candidate.prNumber === params.prNumber,
    );

    if (!review) {
      throw new Error(`Pending review ${params.pendingReviewId} not found`);
    }

    review.submitted = true;
    if (params.body) {
      review.body = params.body;
    }

    return { submittedReviewId: review.reviewId };
  }

  async discardPendingReview(params: DiscardPendingReviewParams): Promise<void> {
    const index = this.pendingReviews.findIndex(
      (candidate) =>
        candidate.reviewId === params.pendingReviewId
        && candidate.repoFullName === params.repoFullName
        && candidate.prNumber === params.prNumber,
    );
    if (index >= 0) {
      this.pendingReviews.splice(index, 1);
    }
  }

  /** Filter comments that are acknowledgement comments (contain the generation message) */
  getAcknowledgements(): PostedComment[] {
    return this.comments.filter(
      (c) => c.body.includes("Generating") && c.body.startsWith("### 🎬 PrVod"),
    );
  }

  /** Test helper: reset recorded comments */
  reset(): void {
    this.comments.length = 0;
    this.pendingReviews.length = 0;
  }
}
