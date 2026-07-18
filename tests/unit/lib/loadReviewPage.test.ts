import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock NextAuth before importing loadReviewPage — @/lib/reviewAuth calls
// NextAuth() at module scope, and the real next-auth package expects a
// Next.js server runtime that vitest's node environment does not provide.
vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));
vi.mock("next-auth/providers/github", () => ({
  default: vi.fn((config: unknown) => config),
}));

import type { Session } from "next-auth";
import { loadReviewPage } from "@/lib/reviews/loadReviewPage";
import { signToken } from "@/lib/shareToken";
import type { Container } from "@/config/container";
import type { VideoJob } from "@/domain/entities/VideoJob";
import type { VideoScript } from "@/domain/entities/VideoScript";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UUID = "11111111-1111-4111-8111-111111111111";
const TEST_SECRET = "test-secret-that-is-at-least-32-chars-long-ok";

function buildScript(): VideoScript {
  return {
    changeType: "feature",
    summary: "test",
    headline: "test",
    scenes: [
      { sceneNumber: 1, sceneType: "overview", narration: "Intro to changes.", durationSeconds: 8, codeBroll: [] },
      { sceneNumber: 2, sceneType: "code_walkthrough", narration: "Core implementation here.", durationSeconds: 8, codeBroll: [] },
      { sceneNumber: 3, sceneType: "summary", narration: "Wrap up summary.", durationSeconds: 8, codeBroll: [] },
    ],
    keyFiles: [],
    tags: [],
    totalDurationSeconds: 24,
    totalWordCount: 9,
  } as unknown as VideoScript;
}

function buildJob(overrides: Partial<VideoJob> = {}): VideoJob {
  return {
    id: VALID_UUID,
    repoFullName: "acme/widgets",
    prNumber: 1,
    status: "completed",
    videoUrl: "https://signed.example/v.mp4",
    objectKey: "videos/v.mp4",
    errorCode: null,
    errorMessage: null,
    scriptJson: buildScript(),
    ttsAudioJson: null,
    durationMs: null,
    metricsJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    installationRef: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    triggeredVia: "api",
    triggeredBy: null,
    deliveryId: null,
    apiKeyId: null,
    statusCommentPosted: false,
    scriptOnly: false,
    repoIsPrivate: false,
    currentStage: null,
    ...overrides,
  };
}

function buildContainer(job: VideoJob | null) {
  const build = vi.fn().mockResolvedValue({ jobId: job?.id ?? "", videoUrl: "x", scenes: [] });
  const container = {
    jobRepository: { findById: vi.fn().mockResolvedValue(job) },
    reviewPageAssembler: { build },
  } as unknown as Container;
  return { container, build };
}

function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: "gho_token",
    user: { githubLogin: "octocat", githubId: 1 },
    expires: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  } as Session;
}

function stubGitHubRepoFetch(status: number) {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("loadReviewPage share-token gating for private repos", () => {
  const ORIGINAL_SECRET = process.env.SHARE_SIGNING_SECRET;

  beforeEach(() => {
    process.env.SHARE_SIGNING_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.SHARE_SIGNING_SECRET;
    } else {
      process.env.SHARE_SIGNING_SECRET = ORIGINAL_SECRET;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("public repo: no token required, returns ok", async () => {
    const job = buildJob({ repoIsPrivate: false });
    const { container } = buildContainer(job);
    const result = await loadReviewPage({ jobId: VALID_UUID, container });
    expect(result.ok).toBe(true);
  });

  it("private repo + no token: returns 404 (does not reveal existence)", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const result = await loadReviewPage({ jobId: VALID_UUID, container });
    expect(result).toMatchObject({ ok: false, status: 404, error: "NOT_FOUND" });
  });

  it("private repo + invalid token: returns 404", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: "garbage.notatoken",
      container,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("private repo + token for wrong jobId: returns 404", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const token = signToken(
      { jobId: OTHER_UUID, type: "full", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("private repo + video-type token: returns 404 (full type required)", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const token = signToken(
      { jobId: VALID_UUID, type: "video", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("private repo + valid full token: returns ok", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const token = signToken(
      { jobId: VALID_UUID, type: "full", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container,
    });
    expect(result.ok).toBe(true);
  });

  it("private repo + missing SHARE_SIGNING_SECRET: returns 503", async () => {
    delete process.env.SHARE_SIGNING_SECRET;
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: "anything",
      container,
    });
    expect(result).toMatchObject({ ok: false, status: 503, error: "SERVICE_UNAVAILABLE" });
  });
});

describe("loadReviewPage GitHub session (commenting credential)", () => {
  const ORIGINAL_SECRET = process.env.SHARE_SIGNING_SECRET;

  beforeEach(() => {
    process.env.SHARE_SIGNING_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.SHARE_SIGNING_SECRET;
    } else {
      process.env.SHARE_SIGNING_SECRET = ORIGINAL_SECRET;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("anonymous viewer: assembler gets canSyncDrafts=false and reviewerKey=null", async () => {
    const job = buildJob({ repoIsPrivate: false });
    const { container, build } = buildContainer(job);
    const result = await loadReviewPage({ jobId: VALID_UUID, container });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledWith(
      job,
      expect.anything(),
      expect.anything(),
      { snapshotStatus: "current", canSyncDrafts: false, reviewerKey: null },
    );
  });

  it("public repo + session with accessToken: canSyncDrafts=true, reviewerKey set", async () => {
    const job = buildJob({ repoIsPrivate: false });
    const { container, build } = buildContainer(job);
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      container,
      session: buildSession(),
    });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledWith(
      job,
      expect.anything(),
      expect.anything(),
      { snapshotStatus: "current", canSyncDrafts: true, reviewerKey: "octocat" },
    );
  });

  it("private repo + no token + session GitHub confirms can view: returns ok with canSyncDrafts=true", async () => {
    stubGitHubRepoFetch(200);
    const job = buildJob({ repoIsPrivate: true });
    const { container, build } = buildContainer(job);
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      container,
      session: buildSession(),
    });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledWith(
      job,
      expect.anything(),
      expect.anything(),
      { snapshotStatus: "current", canSyncDrafts: true, reviewerKey: "octocat" },
    );
  });

  it("private repo + no token + session GitHub rejects: returns 404", async () => {
    stubGitHubRepoFetch(404);
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      container,
      session: buildSession(),
    });
    expect(result).toMatchObject({ ok: false, status: 404, error: "NOT_FOUND" });
  });

  it("private repo + no token + session missing accessToken: returns 401 re-auth", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const { container } = buildContainer(job);
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      container,
      session: buildSession({ accessToken: undefined }),
    });
    expect(result).toMatchObject({ ok: false, status: 401, error: "AUTH_REQUIRED" });
  });

  it("private repo + valid token + session missing accessToken: share token still grants viewing", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const { container, build } = buildContainer(job);
    const token = signToken(
      { jobId: VALID_UUID, type: "full", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container,
      session: buildSession({ accessToken: undefined }),
    });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledWith(
      job,
      expect.anything(),
      expect.anything(),
      { snapshotStatus: "current", canSyncDrafts: false, reviewerKey: "octocat" },
    );
  });

  it("private repo + valid token + session with repo access: canSyncDrafts=true without blocking viewing", async () => {
    stubGitHubRepoFetch(200);
    const job = buildJob({ repoIsPrivate: true });
    const { container, build } = buildContainer(job);
    const token = signToken(
      { jobId: VALID_UUID, type: "full", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container,
      session: buildSession(),
    });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledWith(
      job,
      expect.anything(),
      expect.anything(),
      { snapshotStatus: "current", canSyncDrafts: true, reviewerKey: "octocat" },
    );
  });

  it("marks snapshot outdated (fail closed) when freshness check fails, disabling sync", async () => {
    const job = buildJob({
      repoIsPrivate: false,
      githubInstallationId: 99,
      metricsJson: { reviewDiffSnapshot: { headSha: "reviewed-sha", files: [] } },
    });
    const { container, build } = buildContainer(job);
    (container as unknown as { githubService: unknown }).githubService = {
      fetchPRContext: vi.fn().mockRejectedValue(new Error("GitHub down")),
    };
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      container,
      session: buildSession(),
    });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledWith(
      job,
      expect.anything(),
      expect.anything(),
      { snapshotStatus: "outdated", canSyncDrafts: false, reviewerKey: "octocat" },
    );
  });

  it("marks snapshot outdated when the PR head moved past the reviewed sha", async () => {
    const job = buildJob({
      repoIsPrivate: false,
      githubInstallationId: 99,
      metricsJson: { reviewDiffSnapshot: { headSha: "reviewed-sha", files: [] } },
    });
    const { container, build } = buildContainer(job);
    (container as unknown as { githubService: unknown }).githubService = {
      fetchPRContext: vi.fn().mockResolvedValue({ headSha: "newer-sha" }),
    };
    const result = await loadReviewPage({ jobId: VALID_UUID, container });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledWith(
      job,
      expect.anything(),
      expect.anything(),
      { snapshotStatus: "outdated", canSyncDrafts: false, reviewerKey: null },
    );
  });
});
