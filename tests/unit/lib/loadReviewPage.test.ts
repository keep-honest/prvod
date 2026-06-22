import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

function buildContainer(job: VideoJob | null): Container {
  const assembler = {
    build: vi.fn().mockResolvedValue({ jobId: job?.id ?? "", videoUrl: "x", scenes: [] }),
  };
  return {
    jobRepository: { findById: vi.fn().mockResolvedValue(job) },
    reviewPageAssembler: assembler,
  } as unknown as Container;
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
    vi.restoreAllMocks();
  });

  it("public repo: no token required, returns ok", async () => {
    const job = buildJob({ repoIsPrivate: false });
    const result = await loadReviewPage({ jobId: VALID_UUID, container: buildContainer(job) });
    expect(result.ok).toBe(true);
  });

  it("private repo + no token: returns 404 (does not reveal existence)", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const result = await loadReviewPage({ jobId: VALID_UUID, container: buildContainer(job) });
    expect(result).toMatchObject({ ok: false, status: 404, error: "NOT_FOUND" });
  });

  it("private repo + invalid token: returns 404", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: "garbage.notatoken",
      container: buildContainer(job),
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("private repo + token for wrong jobId: returns 404", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const token = signToken(
      { jobId: OTHER_UUID, type: "full", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container: buildContainer(job),
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("private repo + video-type token: returns 404 (full type required)", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const token = signToken(
      { jobId: VALID_UUID, type: "video", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container: buildContainer(job),
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("private repo + valid full token: returns ok", async () => {
    const job = buildJob({ repoIsPrivate: true });
    const token = signToken(
      { jobId: VALID_UUID, type: "full", exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_SECRET,
    );
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: token,
      container: buildContainer(job),
    });
    expect(result.ok).toBe(true);
  });

  it("private repo + missing SHARE_SIGNING_SECRET: returns 503", async () => {
    delete process.env.SHARE_SIGNING_SECRET;
    const job = buildJob({ repoIsPrivate: true });
    const result = await loadReviewPage({
      jobId: VALID_UUID,
      shareToken: "anything",
      container: buildContainer(job),
    });
    expect(result).toMatchObject({ ok: false, status: 503, error: "SERVICE_UNAVAILABLE" });
  });
});
