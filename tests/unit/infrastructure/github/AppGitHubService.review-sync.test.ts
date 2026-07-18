import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppGitHubService } from "@/infrastructure/github/AppGitHubService";

describe("AppGitHubService review sync", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("creates a pending review with diff-positioned comments", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 222 }), { status: 200 }),
    );

    const service = new AppGitHubService({
      getToken: vi.fn(async () => "app-token"),
    } as never);

    const result = await service.syncDraftReviewComments?.({
      repoFullName: "acme/repo",
      prNumber: 42,
      reviewerAccessToken: "reviewer-token",
      commitId: "abc123",
      comments: [
        {
          path: "src/lib/auth.ts",
          body: "Please add coverage here.",
          position: 3,
        },
      ],
    });

    expect(result).toEqual({
      pendingReviewId: 222,
      commentCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/pulls/42/reviews",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer reviewer-token",
        }),
      }),
    );
  });

  it("submits a pending review as a reviewer-authored comment review", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 222 }), { status: 200 }),
    );

    const service = new AppGitHubService({
      getToken: vi.fn(async () => "app-token"),
    } as never);

    const result = await service.submitPendingReview?.({
      repoFullName: "acme/repo",
      prNumber: 42,
      reviewerAccessToken: "reviewer-token",
      pendingReviewId: 222,
      body: "Submitting walkthrough review",
    });

    expect(result).toEqual({
      submittedReviewId: 222,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/pulls/42/reviews/222/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer reviewer-token",
        }),
      }),
    );
  });
});
