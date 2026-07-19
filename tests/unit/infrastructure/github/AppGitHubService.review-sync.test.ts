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

  it("resync deletes the previous pending review BEFORE creating the new one", async () => {
    // GitHub cannot bulk-edit comments on a pending review, so a resync is
    // delete-then-recreate. Creating first would 422 (only one pending review
    // per reviewer per PR); deleting after would wipe the fresh review.
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // DELETE old review
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 333 }), { status: 200 }));

    const service = new AppGitHubService({
      getToken: vi.fn(async () => "app-token"),
    } as never);

    const result = await service.syncDraftReviewComments?.({
      repoFullName: "acme/repo",
      prNumber: 42,
      reviewerAccessToken: "reviewer-token",
      commitId: "abc123",
      pendingReviewId: 222,
      comments: [{ path: "src/lib/auth.ts", body: "Updated draft.", position: 3 }],
    });

    expect(result).toEqual({ pendingReviewId: 333, commentCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = fetchMock.mock.calls;
    expect(firstCall[0]).toBe("https://api.github.com/repos/acme/repo/pulls/42/reviews/222");
    expect(firstCall[1]).toMatchObject({ method: "DELETE" });
    expect(secondCall[0]).toBe("https://api.github.com/repos/acme/repo/pulls/42/reviews");
    expect(secondCall[1]).toMatchObject({ method: "POST" });
  });

  it("throws when the create-pending-review response has no numeric review id", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "not-a-number" }), { status: 200 }),
    );

    const service = new AppGitHubService({
      getToken: vi.fn(async () => "app-token"),
    } as never);

    await expect(
      service.syncDraftReviewComments?.({
        repoFullName: "acme/repo",
        prNumber: 42,
        reviewerAccessToken: "reviewer-token",
        commitId: "abc123",
        comments: [{ path: "src/lib/auth.ts", body: "Draft.", position: 3 }],
      }),
    ).rejects.toThrow("GitHub create pending review response missing review id");
  });

  it("throws when the submit-pending-review response has no numeric review id", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const service = new AppGitHubService({
      getToken: vi.fn(async () => "app-token"),
    } as never);

    await expect(
      service.submitPendingReview?.({
        repoFullName: "acme/repo",
        prNumber: 42,
        reviewerAccessToken: "reviewer-token",
        pendingReviewId: 222,
      }),
    ).rejects.toThrow("GitHub submit pending review response missing review id");
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
