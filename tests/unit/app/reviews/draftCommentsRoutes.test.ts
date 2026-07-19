import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ReviewPageModel } from "@/domain/entities/ReviewPage";
import {
  makeReviewDiffSnapshot,
  makeSceneDiffAnchors,
} from "../../../integration/helpers/reviewWorkspaceFixtures";

// The routes import auth() (NextAuth boots at module scope), the DI container,
// and loadReviewPage. Mock all three so the route logic runs in isolation —
// same isolation approach as tests/unit/lib/loadReviewPage.test.ts.
vi.mock("@/lib/reviewAuth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/config/container", () => ({
  getContainer: vi.fn(),
}));
vi.mock("@/lib/reviews/loadReviewPage", () => ({
  loadReviewPage: vi.fn(),
}));

import { auth } from "@/lib/reviewAuth";
import { getContainer } from "@/config/container";
import { loadReviewPage } from "@/lib/reviews/loadReviewPage";
import { POST as syncPost } from "@/app/api/reviews/[jobId]/draft-comments/sync/route";
import { POST as submitPost } from "@/app/api/reviews/[jobId]/draft-comments/submit/route";

const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";

const authMock = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const getContainerMock = vi.mocked(getContainer);
const loadReviewPageMock = vi.mocked(loadReviewPage);

function makePayload(overrides: Partial<ReviewPageModel> = {}): ReviewPageModel {
  return {
    jobId: JOB_ID,
    repoFullName: "acme/repo",
    prNumber: 42,
    durationMode: "default",
    headline: "Test PR",
    visibility: "public",
    accessPolicy: "open",
    autoplayMode: "auto_if_permitted",
    videoUrl: "https://example.com/video.mp4",
    durationSeconds: 30,
    snapshotStatus: "current",
    reviewedHeadSha: "reviewed-head-sha-123",
    diffSnapshot: makeReviewDiffSnapshot(),
    sceneAnchors: makeSceneDiffAnchors(),
    pins: [],
    canSyncDrafts: true,
    reviewerKey: "octocat",
    files: [],
    scenes: [],
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "gho_token",
    user: { githubLogin: "octocat", githubId: 1 },
    expires: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function makeGithubService(overrides: Record<string, unknown> = {}) {
  return {
    syncDraftReviewComments: vi.fn().mockResolvedValue({ pendingReviewId: 900, commentCount: 1 }),
    discardPendingReview: vi.fn().mockResolvedValue(undefined),
    submitPendingReview: vi.fn().mockResolvedValue({ submittedReviewId: 901 }),
    ...overrides,
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/reviews/${JOB_ID}/draft-comments/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const routeContext = { params: Promise.resolve({ jobId: JOB_ID }) };

describe("draft-comments sync route", () => {
  let githubService: ReturnType<typeof makeGithubService>;

  beforeEach(() => {
    vi.clearAllMocks();
    githubService = makeGithubService();
    authMock.mockResolvedValue(makeSession());
    loadReviewPageMock.mockResolvedValue({ ok: true, payload: makePayload() });
    getContainerMock.mockResolvedValue({ githubService } as never);
  });

  it("propagates loadReviewPage failures (404 fail-closed ordering before everything else)", async () => {
    loadReviewPageMock.mockResolvedValue({
      ok: false,
      status: 404,
      error: "NOT_FOUND",
      message: "Review page not found",
    });

    const res = await syncPost(makeRequest({ drafts: [] }), routeContext);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "NOT_FOUND" });
    expect(githubService.syncDraftReviewComments).not.toHaveBeenCalled();
  });

  it("gates on 409 OUTDATED_WALKTHROUGH before auth checks", async () => {
    loadReviewPageMock.mockResolvedValue({
      ok: true,
      payload: makePayload({ snapshotStatus: "outdated", canSyncDrafts: false }),
    });
    authMock.mockResolvedValue(null);

    const res = await syncPost(makeRequest({ drafts: [] }), routeContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "OUTDATED_WALKTHROUGH" });
  });

  it("returns 403 when the viewer cannot sync drafts (before the 401 login check)", async () => {
    loadReviewPageMock.mockResolvedValue({
      ok: true,
      payload: makePayload({ canSyncDrafts: false }),
    });
    // Session with no login AND no sync capability: the 403 capability gate
    // must win — 401 is only for capable sessions missing identity.
    authMock.mockResolvedValue(makeSession({ user: {} }));

    const res = await syncPost(makeRequest({ drafts: [] }), routeContext);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "AUTH_FORBIDDEN" });
  });

  it("returns 401 when the session has sync capability but no GitHub login", async () => {
    authMock.mockResolvedValue(makeSession({ user: {} }));

    const res = await syncPost(makeRequest({ drafts: [] }), routeContext);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "AUTH_REQUIRED" });
  });

  it("returns 503 when the container lacks syncDraftReviewComments", async () => {
    getContainerMock.mockResolvedValue({
      githubService: makeGithubService({ syncDraftReviewComments: undefined }),
    } as never);

    const res = await syncPost(makeRequest({ drafts: [] }), routeContext);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "SERVICE_UNAVAILABLE" });
  });

  it("returns 400 for a non-JSON body", async () => {
    const res = await syncPost(makeRequest("{not json"), routeContext);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("returns 400 for a schema-invalid body", async () => {
    const res = await syncPost(makeRequest({ drafts: "not-an-array" }), routeContext);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("syncs mappable drafts and returns skippedDraftIds for unmappable ones", async () => {
    const res = await syncPost(
      makeRequest({
        drafts: [
          // Mappable: exact anchor from the fixture.
          { localDraftId: "d-exact", body: "Check this", anchorIds: ["anchor-scene-2-page"], pinIds: [] },
          // Unmappable: no anchor, no explicit position.
          { localDraftId: "d-orphan", body: "General thought", anchorIds: [], pinIds: [] },
        ],
      }),
      routeContext,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      pendingReviewId: 900,
      commentCount: 1,
      syncedDraftIds: ["d-exact"],
      skippedDraftIds: ["d-orphan"],
    });
    expect(githubService.syncDraftReviewComments).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: "acme/repo",
        prNumber: 42,
        reviewerAccessToken: "gho_token",
        commitId: "reviewed-head-sha-123",
        comments: [
          expect.objectContaining({ path: "src/app/page.tsx", body: "Check this" }),
        ],
      }),
    );
  });

  it("discard-only path: drafts [] + pendingReviewId discards the orphaned review", async () => {
    const res = await syncPost(
      makeRequest({ drafts: [], pendingReviewId: 777 }),
      routeContext,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pendingReviewId: null,
      commentCount: 0,
      syncedDraftIds: [],
      skippedDraftIds: [],
      discardedPendingReviewId: 777,
    });
    expect(githubService.discardPendingReview).toHaveBeenCalledWith({
      repoFullName: "acme/repo",
      prNumber: 42,
      reviewerAccessToken: "gho_token",
      pendingReviewId: 777,
    });
    expect(githubService.syncDraftReviewComments).not.toHaveBeenCalled();
  });

  it("discard-only path returns 503 when discardPendingReview is unavailable", async () => {
    getContainerMock.mockResolvedValue({
      githubService: makeGithubService({ discardPendingReview: undefined }),
    } as never);

    const res = await syncPost(
      makeRequest({ drafts: [], pendingReviewId: 777 }),
      routeContext,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "SERVICE_UNAVAILABLE" });
  });

  it("returns 500 INTERNAL_ERROR when the GitHub sync call throws", async () => {
    githubService.syncDraftReviewComments.mockRejectedValue(new Error("GitHub down"));

    const res = await syncPost(
      makeRequest({
        drafts: [{ localDraftId: "d1", body: "x", anchorIds: ["anchor-scene-2-page"], pinIds: [] }],
      }),
      routeContext,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "INTERNAL_ERROR" });
  });
});

describe("draft-comments submit route", () => {
  let githubService: ReturnType<typeof makeGithubService>;

  beforeEach(() => {
    vi.clearAllMocks();
    githubService = makeGithubService();
    authMock.mockResolvedValue(makeSession());
    loadReviewPageMock.mockResolvedValue({ ok: true, payload: makePayload() });
    getContainerMock.mockResolvedValue({ githubService } as never);
  });

  it("gates on 409 OUTDATED_WALKTHROUGH", async () => {
    loadReviewPageMock.mockResolvedValue({
      ok: true,
      payload: makePayload({ snapshotStatus: "outdated" }),
    });

    const res = await submitPost(makeRequest({ pendingReviewId: 900 }), routeContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "OUTDATED_WALKTHROUGH" });
    expect(githubService.submitPendingReview).not.toHaveBeenCalled();
  });

  it("returns 403 when the viewer cannot sync drafts", async () => {
    loadReviewPageMock.mockResolvedValue({
      ok: true,
      payload: makePayload({ canSyncDrafts: false }),
    });

    const res = await submitPost(makeRequest({ pendingReviewId: 900 }), routeContext);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "AUTH_FORBIDDEN" });
  });

  it("returns 401 when the session has capability but no GitHub login", async () => {
    authMock.mockResolvedValue(makeSession({ user: {} }));

    const res = await submitPost(makeRequest({ pendingReviewId: 900 }), routeContext);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "AUTH_REQUIRED" });
  });

  it("returns 503 when the container lacks submitPendingReview", async () => {
    getContainerMock.mockResolvedValue({
      githubService: makeGithubService({ submitPendingReview: undefined }),
    } as never);

    const res = await submitPost(makeRequest({ pendingReviewId: 900 }), routeContext);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "SERVICE_UNAVAILABLE" });
  });

  it("returns 400 for a schema-invalid body (missing pendingReviewId)", async () => {
    const res = await submitPost(makeRequest({}), routeContext);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("submits the pending review and returns the submitted id", async () => {
    const res = await submitPost(
      makeRequest({ pendingReviewId: 900, body: "Overall summary" }),
      routeContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ submittedReviewId: 901 });
    expect(githubService.submitPendingReview).toHaveBeenCalledWith({
      repoFullName: "acme/repo",
      prNumber: 42,
      reviewerAccessToken: "gho_token",
      pendingReviewId: 900,
      body: "Overall summary",
    });
  });

  it("returns 500 INTERNAL_ERROR when the GitHub submit call throws", async () => {
    githubService.submitPendingReview.mockRejectedValue(new Error("GitHub down"));

    const res = await submitPost(makeRequest({ pendingReviewId: 900 }), routeContext);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "INTERNAL_ERROR" });
  });
});
