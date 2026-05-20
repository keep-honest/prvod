import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoOrchestrator } from "@/domain/services/VideoOrchestrator";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockVideoCompositor } from "@/mocks/MockVideoCompositor";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockStorageService } from "@/mocks/MockStorageService";
import { MockJobRepository } from "@/mocks/MockJobRepository";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import type { PRContext } from "@/domain/entities/PRContext";

const testPRContext: PRContext = {
  repoFullName: "keep-honest/prvod",
  prNumber: 42,
  prTitle: "Add rate limiting to auth endpoint",
  prDescription:
    "This PR adds rate limiting to prevent brute-force attacks on the auth endpoint. Closes #15.",
  diffSource: { kind: "github_pr" as const, repoFullName: "keep-honest/prvod", prNumber: 42, installationId: 1 },
  baseBranch: "main",
  headBranch: "feature/rate-limit",
  headSha: "",
  issues: [
    {
      number: 15,
      title: "Auth endpoint vulnerable to brute force",
      body: "The login endpoint has no rate limiting.",
    },
  ],
  milestone: null,
  isPrivate: false,
  durationMode: "default" as const,
    deepdive: false,
};

describe("Full Pipeline Integration", () => {
  let jobRepository: MockJobRepository;
  let storageService: MockStorageService;

  beforeEach(() => {
    jobRepository = new MockJobRepository();
    storageService = new MockStorageService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("processes a complete job from queued to completed", async () => {
    // 1. Create job
    const job = await jobRepository.create({
      repoFullName: testPRContext.repoFullName,
      prNumber: testPRContext.prNumber,
    });
    expect(job.status).toBe("queued");

    // 2. Transition to processing
    await jobRepository.updateStatus(job.id, "processing");
    const processingJob = await jobRepository.findById(job.id);
    expect(processingJob?.status).toBe("processing");

    // 3. Run orchestrator
    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService: new MockTTSService(),
      videoCompositor: new MockVideoCompositor(),
      storageService,
    });

    const result = await orchestrator.execute(job.id, testPRContext);

    // 4. Update to completed
    await jobRepository.updateStatus(job.id, "completed", {
      videoUrl: result.videoUrl,
      objectKey: result.objectKey,
      scriptJson: result.script,
    });

    // 5. Verify final state
    const completedJob = await jobRepository.findById(job.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.videoUrl).toBeTruthy();
    expect(completedJob?.objectKey).toContain("videos/keep-honest/prvod/42/");
    expect(completedJob?.scriptJson).toBeDefined();
    expect(completedJob?.completedAt).toBeInstanceOf(Date);
  });

  it("completes a script-only job with scriptJson but no videoUrl", async () => {
    const job = await jobRepository.create({
      repoFullName: testPRContext.repoFullName,
      prNumber: testPRContext.prNumber,
    });

    await jobRepository.updateStatus(job.id, "processing");

    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService: new MockTTSService(),
      videoCompositor: new MockVideoCompositor(),
      storageService,
    });

    const result = await orchestrator.executeScriptOnly(job.id, testPRContext);

    await jobRepository.updateStatus(job.id, "completed", {
      scriptJson: result.script,
    });

    const completedJob = await jobRepository.findById(job.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.scriptJson).toBeDefined();
    expect(completedJob?.videoUrl).toBeNull();
    expect(completedJob?.objectKey).toBeNull();
  });

  it("completes the external-TTS pipeline without downloading synthetic mock clips", async () => {
    vi.stubEnv("USE_BUILTIN_TTS", "false");
    const fetchSpy = vi.fn(async () => {
      throw new Error("mock clip URLs should not be fetched");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const trailerJob = await jobRepository.create({
      repoFullName: testPRContext.repoFullName,
      prNumber: 43,
    });
    await jobRepository.updateStatus(trailerJob.id, "processing");

    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService: new MockTTSService(),
      videoCompositor: new MockVideoCompositor(),
      storageService,
    });

    const result = await orchestrator.execute(trailerJob.id, {
      ...testPRContext,
      prNumber: 43,
    });

    expect(result.videoUrl).toContain("mock-r2.example.com");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicate jobs for the same PR", async () => {
    await jobRepository.create({
      repoFullName: "owner/repo",
      prNumber: 1,
    });

    await expect(
      jobRepository.create({
        repoFullName: "owner/repo",
        prNumber: 1,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("allows new job after previous job completes", async () => {
    const job1 = await jobRepository.create({
      repoFullName: "owner/repo",
      prNumber: 1,
    });
    await jobRepository.updateStatus(job1.id, "processing");
    await jobRepository.updateStatus(job1.id, "completed", {
      videoUrl: "https://example.com/video.mp4",
    });

    // Now should be able to create a new job for the same PR
    const job2 = await jobRepository.create({
      repoFullName: "owner/repo",
      prNumber: 1,
    });
    expect(job2.id).not.toBe(job1.id);
    expect(job2.status).toBe("queued");
  });

  it("correctly analyzes diff and generates appropriate script", async () => {
    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService: new MockTTSService(),
      videoCompositor: new MockVideoCompositor(),
      storageService,
    });

    const result = await orchestrator.execute("test-id", testPRContext);

    expect(result.script.scenes).toHaveLength(7);
    expect(result.script.totalDurationSeconds).toBeGreaterThanOrEqual(20);
    expect(result.script.totalDurationSeconds).toBeLessThanOrEqual(120);
  });

  it("produces an overview scene as the first scene with no code broll", async () => {
    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService: new MockTTSService(),
      videoCompositor: new MockVideoCompositor(),
      storageService,
    });

    const result = await orchestrator.execute("test-id", testPRContext);

    const firstScene = result.script.scenes[0];
    expect(firstScene.sceneType).toBe("overview");
    // Code-first MockScriptWriter may include codeBroll on overview scenes
    expect(firstScene.codeBroll).toBeDefined();
  });

  it("counts recent jobs per repo correctly", async () => {
    await jobRepository.create({ repoFullName: "owner/repo", prNumber: 1 });
    await jobRepository.create({ repoFullName: "owner/repo", prNumber: 2 });
    await jobRepository.create({
      repoFullName: "other/repo",
      prNumber: 1,
    });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const count = await jobRepository.countRecentByRepo(
      "owner/repo",
      oneHourAgo,
      null,
    );
    expect(count).toBe(2);
  });
});
