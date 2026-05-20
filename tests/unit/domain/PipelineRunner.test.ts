import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineRunner } from "@/domain/services/PipelineRunner";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockVideoCompositor } from "@/mocks/MockVideoCompositor";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockStorageService } from "@/mocks/MockStorageService";
import { MockJobRepository } from "@/mocks/MockJobRepository";
import { MockApiKeyRepository } from "@/mocks/MockApiKeyRepository";
import { MockGitHubService } from "@/mocks/MockGitHubService";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import { mockContext } from "../../fixtures/orchestrator";

describe("PipelineRunner", () => {
  let jobRepository: MockJobRepository;
  let runner: PipelineRunner;

  afterEach(() => {
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.MODEL_PROMPT_ADAPTERS_V1;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
  });

  beforeEach(() => {
    jobRepository = new MockJobRepository();
    runner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: new MockScriptWriter(),
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );
  });

  it("runs the full pipeline and marks job completed", async () => {
    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    await runner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.videoUrl).toBeDefined();
    expect(updated?.objectKey).toBeDefined();
    expect(updated?.scriptJson).toBeDefined();
  });

  it("runs script-only pipeline and marks job completed", async () => {
    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    await runner.run(job.id, mockContext, { scriptOnly: true });

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.scriptJson).toBeDefined();
    expect(updated?.videoUrl).toBeNull();
    // metricsJson may be null when no V2 pipeline or review graph is present
  });

  it("persists canonical review-graph source when GitHub file contents are available", async () => {
    const githubService = new MockGitHubService();
    githubService.repositoryFiles["src/domain/services/VideoOrchestrator.ts"] = "import type { PromptPipelineV2Artifacts } from '@/domain/entities/PromptPipelineV2';\nexport function orchestrate(artifacts: PromptPipelineV2Artifacts) { return artifacts; }";
    githubService.repositoryFiles["src/domain/entities/PromptPipelineV2.ts"] = "export type PromptPipelineV2Artifacts = { enabled: boolean };";

    const runnerWithGitHub = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: new MockScriptWriter(),
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
      undefined,
      githubService,
    );

    const job = await jobRepository.create({
      repoFullName: "owner/repo",
      prNumber: 42,
      githubInstallationId: 99,
    });

    await runnerWithGitHub.run(job.id, mockContext, { scriptOnly: true });

    const updated = await jobRepository.findById(job.id);
    const metrics = updated?.metricsJson as { reviewGraphSource?: { version: number; files: Record<string, string> } };
    expect(metrics.reviewGraphSource?.version).toBe(1);
    expect(metrics.reviewGraphSource?.files["src/domain/services/VideoOrchestrator.ts"]).toContain("PromptPipelineV2Artifacts");
  });

  it("fetches canonical review-graph files from the PR head repo and commit", async () => {
    const fetchRepositoryFiles = vi.fn().mockResolvedValue({
      "src/domain/services/VideoOrchestrator.ts": "export function orchestrate() {}",
      "src/domain/entities/PromptPipelineV2.ts": "export type PromptPipelineV2Artifacts = { enabled: boolean };",
    });

    const runnerWithGitHub = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: new MockScriptWriter(),
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
      undefined,
      {
        fetchPRContext: vi.fn(),
        fetchRepositoryFiles,
        postComment: vi.fn(),
      },
    );

    const job = await jobRepository.create({
      repoFullName: "owner/repo",
      prNumber: 42,
      githubInstallationId: 99,
    });

    await runnerWithGitHub.run(job.id, {
      ...mockContext,
      repoFullName: "base/repo",
      headRepoFullName: "fork/repo",
      headSha: "abcdef1234567890",
      headBranch: "feature/from-fork",
    }, { scriptOnly: true });

    expect(fetchRepositoryFiles).toHaveBeenCalledWith(
      "fork/repo",
      "abcdef1234567890",
      expect.any(Array),
      99,
    );
  });

  it("marks job as failed on orchestrator error", async () => {
    const failingRunner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: {
          generateScript: async () => { throw new Error("LLM exploded"); },
          retimeNarration: async () => ({ scenes: [] }),
        },
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    await failingRunner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toBe("LLM exploded");
  });

  it("never throws (safe for fire-and-forget)", async () => {
    const failingRunner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: {
          generateScript: async () => { throw new Error("Boom"); },
          retimeNarration: async () => ({ scenes: [] }),
        },
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    // Should not throw
    await expect(failingRunner.run(job.id, mockContext)).resolves.toBeUndefined();
  });

  it("runs tts-only pipeline and stores scriptJson + ttsAudioJson", async () => {
    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    await runner.run(job.id, mockContext, { ttsOnly: true });

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.scriptJson).toBeDefined();
    expect(updated?.ttsAudioJson).toBeDefined();
    expect(updated?.videoUrl).toBeNull();

    const ttsAudio = updated?.ttsAudioJson as Array<{
      sceneNumber: number;
      audioKey?: string | null;
    }>;
    expect(Array.isArray(ttsAudio)).toBe(true);
    expect(ttsAudio.length).toBeGreaterThan(0);
    expect(ttsAudio[0]).toHaveProperty("sceneNumber");
    expect(ttsAudio[0]).toHaveProperty("audioKey");
    expect(ttsAudio[0]).toHaveProperty("wordTimings");
    expect(ttsAudio[0]).toHaveProperty("clipDurations");
    expect(ttsAudio[0]).not.toHaveProperty("audioUrl");

    // metricsJson may be null when no V2 pipeline or review graph is present
  });

  it("marks job as failed when tts-only pipeline throws", async () => {
    const failingTTSRunner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: new MockScriptWriter(),
        ttsService: {
          synthesize: async () => { throw new Error("TTS service down"); },
        },

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    await failingTTSRunner.run(job.id, mockContext, { ttsOnly: true });

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toContain("TTS service down");
  });

  it("stores prompt pipeline metrics and rollout flags when V2 artifacts are present", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    process.env.MODEL_PROMPT_ADAPTERS_V1 = "true";
    process.env.PROMPT_PIPELINE_V2_COMPARE_V1 = "true";
    const runnerWithV2Artifacts = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: {
          generateScript: async (context, analysis) => {
            const base = await new MockScriptWriter().generateScript(context, analysis);
            return {
              ...base,
              promptPipelineV2: {
                enabled: true,
                llmFamily: "claude",
                coveragePlan: {
                  summary: "Plan",
                  selectedEvidencePolicy: "Cluster-selected evidence only.",
                  clusters: [{
                    clusterId: "c1",
                    title: "Auth middleware",
                    files: ["src/auth.ts"],
                    evidenceSnippets: [{
                      filePath: "src/auth.ts",
                      summary: "Adds a guard",
                      diffExcerpt: "checkRateLimit();",
                    }],
                    technicalMechanism: "Block repeated requests before auth logic runs",
                    impact: "Protects the endpoint from retries",
                    riskIfAbsent: "Duplicate requests overwhelm the auth path",
                    validationEvidence: ["auth tests"],
                    importanceRank: 1,
                  }],
                  ledger: [{ clusterId: "c1", disposition: "deep_dive", reason: "Primary change" }],
                  majorClusterIds: ["c1"],
                },
                sceneOutline: {
                  scenes: [{
                    sceneNumber: 1,
                    sceneType: "overview",
                    title: "Overview",
                    clusterIds: ["c1"],
                    evidenceFilePaths: ["src/auth.ts"],
                    whatChanged: "Adds a guard",
                    whyItMatters: "Protects the endpoint",
                    failureWithoutIt: "Retries pile up",
                    validation: "Auth tests cover the guard",
                    visualFocus: "A doorman intercepting repeat visitors",
                  }],
                },
                coverageJudge: {
                  passed: true,
                  issues: [],
                  missingMajorClusterIds: [],
                  weakEvidenceClusterIds: [],
                  allocationIssues: [],
                  scores: {
                    completeness: 9,
                    evidenceGrounding: 9,
                    allocationQuality: 9,
                  },
                },
                narrationJudge: {
                  passed: true,
                  issues: [],
                  scores: {
                    hookStrength: 8,
                    explanatoryClarity: 9,
                    evidenceGrounding: 9,
                    sceneDistinctness: 8,
                    themeFidelity: 8,
                    topClusterCoverage: 9,
                    jargonDensity: 4,
                    boredomRisk: 3,
                  },
                },
                rolloutComparison: {
                  enabled: true,
                  legacyMetrics: {
                    sceneCount: 7,
                    totalDurationSeconds: 48,
                    totalWordCount: 120,
                    keyFilesCount: 2,
                    tagCount: 1,
                  },
                  v2Metrics: {
                    sceneCount: 8,
                    totalDurationSeconds: 54,
                    totalWordCount: 150,
                    keyFilesCount: 1,
                    tagCount: 2,
                  },
                  deltas: {
                    sceneCount: 1,
                    totalDurationSeconds: 6,
                    totalWordCount: 30,
                    keyFilesCount: -1,
                    tagCount: 1,
                  },
                  legacySummary: "Legacy summary",
                  v2Summary: "Plan summary",
                },
              },
            };
          },
          retimeNarration: async () => ({ scenes: [] }),
        },
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    await runnerWithV2Artifacts.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    const metrics = updated?.metricsJson as Record<string, unknown>;
    expect(metrics.rolloutFlags).toEqual({
      promptPipelineV2Enabled: true,
      modelPromptAdaptersV1Enabled: true,
      promptPipelineV2CompareV1Enabled: true,
    });
    expect(metrics.promptPipeline).toMatchObject({
      version: "v2",
      llmFamily: "claude",
      clusterCount: 1,
      sceneIntentCount: 1,
      rolloutComparison: {
        enabled: true,
        legacySummary: "Legacy summary",
      },
    });
  });

  // ── One-time key lifecycle ──────────────────────────────────────────

  describe("one-time key lifecycle", () => {
    let apiKeyRepo: MockApiKeyRepository;

    beforeEach(() => {
      apiKeyRepo = new MockApiKeyRepository();
    });

    it("consumes one-time key on successful full video pipeline", async () => {
      await apiKeyRepo.create({
        keyId: "pk_trial",
        keyHash: "hash",
        name: "trial",
        isAdmin: false,
        scopes: ["jobs:create"],
        maxUses: 1,
      });
      await apiKeyRepo.claimForJob("pk_trial", "job-1");

      const keyRunner = new PipelineRunner(
        {
          diffAnalyzer: new HeuristicDiffAnalyzer(),
          scriptWriter: new MockScriptWriter(),
          ttsService: new MockTTSService(),
  
          videoCompositor: new MockVideoCompositor(),
          storageService: new MockStorageService(),
        },
        jobRepository,
        apiKeyRepo,
      );

      const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
      await keyRunner.run(job.id, mockContext, { apiKeyId: "pk_trial" });

      const updatedKey = await apiKeyRepo.findByKeyId("pk_trial");
      expect(updatedKey?.status).toBe("consumed");
      expect(updatedKey?.usesCount).toBe(1);
      expect(updatedKey?.consumedAt).toBeDefined();
    });

    it("releases one-time key on failed pipeline", async () => {
      await apiKeyRepo.create({
        keyId: "pk_trial",
        keyHash: "hash",
        name: "trial",
        isAdmin: false,
        scopes: ["jobs:create"],
        maxUses: 1,
      });
      await apiKeyRepo.claimForJob("pk_trial", "job-1");

      const failingRunner = new PipelineRunner(
        {
          diffAnalyzer: new HeuristicDiffAnalyzer(),
          scriptWriter: {
            generateScript: async () => { throw new Error("LLM exploded"); },
            retimeNarration: async () => ({ scenes: [] }),
          },
          ttsService: new MockTTSService(),
  
          videoCompositor: new MockVideoCompositor(),
          storageService: new MockStorageService(),
        },
        jobRepository,
        apiKeyRepo,
      );

      const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
      await failingRunner.run(job.id, mockContext, { apiKeyId: "pk_trial" });

      const updatedKey = await apiKeyRepo.findByKeyId("pk_trial");
      expect(updatedKey?.status).toBe("active");
      expect(updatedKey?.currentJobId).toBeNull();
    });

    it("does NOT consume key on scriptOnly success (key not claimed for partial runs)", async () => {
      await apiKeyRepo.create({
        keyId: "pk_trial",
        keyHash: "hash",
        name: "trial",
        isAdmin: false,
        scopes: ["jobs:create"],
        maxUses: 1,
      });
      // Key is NOT claimed for scriptOnly — the jobs route skips claim for partial runs.
      // PipelineRunner receives no apiKeyId, so it doesn't touch the key at all.
      const keyRunner = new PipelineRunner(
        {
          diffAnalyzer: new HeuristicDiffAnalyzer(),
          scriptWriter: new MockScriptWriter(),
          ttsService: new MockTTSService(),
  
          videoCompositor: new MockVideoCompositor(),
          storageService: new MockStorageService(),
        },
        jobRepository,
        apiKeyRepo,
      );

      const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
      // No apiKeyId passed — mirrors the jobs route behavior for scriptOnly
      await keyRunner.run(job.id, mockContext, { scriptOnly: true });

      const updatedKey = await apiKeyRepo.findByKeyId("pk_trial");
      expect(updatedKey?.status).toBe("active"); // untouched
      expect(updatedKey?.usesCount).toBe(0);
    });

    it("does not call consume/release when apiKeyId is undefined", async () => {
      const keyRunner = new PipelineRunner(
        {
          diffAnalyzer: new HeuristicDiffAnalyzer(),
          scriptWriter: new MockScriptWriter(),
          ttsService: new MockTTSService(),
  
          videoCompositor: new MockVideoCompositor(),
          storageService: new MockStorageService(),
        },
        jobRepository,
        apiKeyRepo,
      );

      const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
      await keyRunner.run(job.id, mockContext);

      // No keys should have been touched
      expect(apiKeyRepo.getKeys()).toHaveLength(0);
    });


  it("sets errorCode LLM_VALIDATION_EXHAUSTED for V2 validation failure", async () => {
    const failingRunner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: {
          generateScript: async () => {
            throw new Error("Prompt Pipeline V2 script validation failed: overview scene missing");
          },
          retimeNarration: async () => ({ scenes: [] }),
        },
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
    await failingRunner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBe("LLM_VALIDATION_EXHAUSTED");
  });

  it("sets errorCode LLM_VALIDATION_EXHAUSTED for V2 coverage validation failure", async () => {
    const failingRunner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: {
          generateScript: async () => {
            throw new Error("Prompt Pipeline V2 coverage validation failed: missing clusters");
          },
          retimeNarration: async () => ({ scenes: [] }),
        },
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
    await failingRunner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBe("LLM_VALIDATION_EXHAUSTED");
  });

  it("does not set LLM_VALIDATION_EXHAUSTED for unrelated errors", async () => {
    const failingRunner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: {
          generateScript: async () => { throw new Error("Network timeout"); },
          retimeNarration: async () => ({ scenes: [] }),
        },
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
    await failingRunner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBeNull();
  });

  it("sets errorCode LLM_RATE_LIMITED_EXHAUSTED when LlmRateLimitedError propagates", async () => {
    const { LlmRateLimitedError } = await import("@/infrastructure/llm/retryLlmCall");
    const failingRunner = new PipelineRunner(
      {
        diffAnalyzer: new HeuristicDiffAnalyzer(),
        scriptWriter: {
          generateScript: async () => {
            throw new LlmRateLimitedError(
              "LLM call \"coverage_judge\" failed after 5 attempts: 429 Too Many Requests",
              {
                label: "coverage_judge",
                attempts: 5,
                lastError: new Error("429 Too Many Requests"),
              },
            );
          },
          retimeNarration: async () => ({ scenes: [] }),
        },
        ttsService: new MockTTSService(),

        videoCompositor: new MockVideoCompositor(),
        storageService: new MockStorageService(),
      },
      jobRepository,
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
    await failingRunner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBe("LLM_RATE_LIMITED_EXHAUSTED");
  });
});
});
