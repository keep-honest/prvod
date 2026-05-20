import fs from "node:fs/promises";
import type { PRContext } from "@/domain/entities/PRContext";
import type { DiffMetadataCorpus } from "@/domain/entities/DiffMetadataCorpus";
import {
  parseReviewGraphSource,
  type ReviewGraphSource,
} from "@/domain/entities/ReviewGraph";
import type { IJobRepository } from "@/interfaces/IJobRepository";
import type { IApiKeyRepository } from "@/interfaces/IApiKeyRepository";
import type { IGitHubService } from "@/interfaces/IGitHubService";
import type { IDiffSource } from "@/interfaces/IDiffSource";
import type { OversizedFileProcessor } from "@/domain/services/OversizedFileProcessor";
import {
  VideoOrchestrator,
  type OrchestratorDeps,
} from "@/domain/services/VideoOrchestrator";
import { DiffCorpusBuilder } from "@/domain/services/DiffCorpusBuilder";
import { createLogger } from "@/lib/logger";
import { createDiffJobTimeout } from "@/lib/diff-job-timeout";
import { DiffTooLargeError, DiffFetchTimeoutError, DiffParseError } from "@/lib/diff-errors";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { PromptPipelineV2Artifacts } from "@/domain/entities/PromptPipelineV2";
import {
  isModelPromptAdaptersV1Enabled,
  isPromptPipelineV2CompareV1Enabled,
  isPromptPipelineV2Enabled,
} from "@/lib/featureFlags";

interface FailureMetadata {
  errorCode: string | null;
  capabilityFailureReason: string | null;
  missingCapabilities: string[] | null;
}

interface SettlementContext {
  jobId: string;
  succeeded: boolean;
  /** True only when the job produced a final video (not scriptOnly/ttsOnly). */
  isFullVideo: boolean;
  apiKeyId?: string;
  logger: ReturnType<typeof createLogger>;
}

export class PipelineRunner {
  constructor(
    private deps: OrchestratorDeps,
    private jobRepository: IJobRepository,
    private apiKeyRepository?: IApiKeyRepository,
    private githubService?: IGitHubService,
    private diffSourceFactory?: (context: PRContext, installationId: number | undefined) => IDiffSource | undefined,
    private oversizedFileProcessor?: OversizedFileProcessor,
  ) {}

  async run(
    jobId: string,
    prContext: PRContext,
    options: {
      scriptOnly?: boolean;
      ttsOnly?: boolean;
      apiKeyId?: string;
    } = {},
  ): Promise<void> {
    const {
      scriptOnly = false,
      ttsOnly = false,
      apiKeyId,
    } = options;
    const logger = createLogger(jobId);
    logger.info("Pipeline started", {
      repo: prContext.repoFullName,
      pr: prContext.prNumber,
      scriptOnly,
      ttsOnly,
    });

    const existingJob = await this.jobRepository.findById(jobId);
    const installationId = existingJob?.githubInstallationId ?? undefined;

    const tempPath = prContext.diffSource.kind === "local_diff_file"
      ? prContext.diffSource.tempPath
      : undefined;
    const { signal, clear } = createDiffJobTimeout();

    let corpus: DiffMetadataCorpus | undefined;
    let jobSucceeded = false;
    try {
      await this.jobRepository.updateStatus(jobId, "processing", { currentStage: "analyzing" });

      if (this.diffSourceFactory) {
        const source = this.diffSourceFactory(prContext, installationId);
        if (source) {
          corpus = await new DiffCorpusBuilder().build(jobId, source, {
            signal,
            sourceType: prContext.diffSource.kind,
            oversizedProcessor: this.oversizedFileProcessor,
          });
        }
        if (this.deps.checkpointStore && corpus) {
          const existing = await this.deps.checkpointStore.load(jobId);
          await this.deps.checkpointStore.save({
            jobId,
            completedStep: existing?.completedStep ?? 0,
            prContext: existing?.prContext ?? prContext,
            diffCorpus: corpus,
          });
          logger.debug("diff.corpus.checkpointed", {
            totalFiles: Object.keys(corpus.files).length,
            segmentCount: corpus.segmentCount,
          });
        }
      }

      const orchestrator = new VideoOrchestrator({
        ...this.deps,
        onStageChange: (stage) => {
          this.jobRepository.updateProcessingStage(jobId, stage).catch((err) => {
            logger.warn("Failed to update pipeline stage", { jobId, stage, error: err instanceof Error ? err.message : String(err) });
          });
        },
      });

      if (scriptOnly) {
        const result = await orchestrator.executeScriptOnly(jobId, prContext, corpus);
        const metrics = await this.buildCompletionMetrics(jobId, result.script, prContext, installationId, result.promptPipelineV2);
        await this.jobRepository.updateStatus(jobId, "completed", {
          scriptJson: result.script,
          metricsJson: metrics,
        });
        await this.cleanupCheckpointAfterPreview(jobId, logger);
        logger.info("Script-only job completed", { scenes: result.script.scenes.length });
      } else if (ttsOnly) {
        const result = await orchestrator.executeTTSOnly(jobId, prContext, corpus);
        const metrics = await this.buildCompletionMetrics(jobId, result.script, prContext, installationId, result.promptPipelineV2);
        await this.jobRepository.updateStatus(jobId, "completed", {
          scriptJson: result.script,
          ttsAudioJson: result.perSceneAudio.map((audio) => ({
            sceneNumber: audio.sceneNumber,
            audioKey: audio.audioKey,
            wordTimings: audio.wordTimings,
            clipDurations: audio.clipDurations,
          })),
          metricsJson: metrics,
        });
        await this.cleanupCheckpointAfterPreview(jobId, logger);
        logger.info("TTS-only job completed", {
          scenes: result.script.scenes.length,
          audioFiles: result.perSceneAudio.filter((a) => a.audioUrl).length,
        });
      } else {
        const result = await orchestrator.execute(jobId, prContext, corpus);
        const metrics = await this.buildCompletionMetrics(jobId, result.script, prContext, installationId, result.promptPipelineV2);
        if (metrics && result.sceneTimelineFrames) {
          metrics.sceneTimeline = result.sceneTimelineFrames;
        }
        const durationMs = result.actualDurationMs ?? Math.round(result.script.totalDurationSeconds * 1000);
        await this.jobRepository.updateStatus(jobId, "completed", {
          videoUrl: result.videoUrl,
          objectKey: result.objectKey,
          scriptJson: result.script,
          durationMs,
          metricsJson: metrics,
        });
        logger.info("Video job completed", { videoUrl: result.videoUrl, durationMs });
      }
      jobSucceeded = true;
    } catch (error) {
      await this.handlePipelineError(jobId, error, logger, prContext);
    } finally {
      clear();
      if (tempPath) {
        await fs.unlink(tempPath).catch((err: unknown) => {
          logger.warn("diff.temp_file.cleanup_failed", {
            tempPath,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    await this.settle({
      jobId,
      succeeded: jobSucceeded,
      isFullVideo: jobSucceeded && !scriptOnly && !ttsOnly,
      apiKeyId,
      logger,
    });
  }

  async retry(jobId: string, options: { apiKeyId?: string } = {}): Promise<void> {
    const { apiKeyId } = options;
    const existingJob = await this.jobRepository.findById(jobId);
    const existingMetrics = existingJob?.metricsJson as Record<string, unknown> | null;
    const existingReviewGraphSource = parseReviewGraphSource(existingMetrics?.reviewGraphSource);
    const existingDurationMode = (existingMetrics?.durationMode as string) ?? undefined;
    const logger = createLogger(jobId);
    logger.info("Retrying job from checkpoint", { jobId });

    let retrySucceeded = false;
    try {
      await this.jobRepository.updateStatus(jobId, "processing", { currentStage: "analyzing" });
      const checkpoint = this.deps.checkpointStore
        ? await this.deps.checkpointStore.load(jobId)
        : null;
      const retryCorpus = checkpoint?.diffCorpus;
      if (retryCorpus) {
        logger.debug("diff.corpus.loaded_from_checkpoint", {
          totalFiles: Object.keys(retryCorpus.files).length,
          segmentCount: retryCorpus.segmentCount,
        });
      }
      const orchestrator = new VideoOrchestrator({
        ...this.deps,
        onStageChange: (stage) => {
          this.jobRepository.updateProcessingStage(jobId, stage).catch((err) => {
            logger.warn("Failed to update pipeline stage (retry)", { jobId, stage, error: err instanceof Error ? err.message : String(err) });
          });
        },
      });
      const result = await orchestrator.resume(jobId);
      let metrics = await this.buildCompletionMetrics(
        jobId, result.script, checkpoint?.prContext, existingJob?.githubInstallationId ?? undefined,
        result.promptPipelineV2, existingReviewGraphSource,
      );
      metrics = this.mergeMetricsField(metrics, "durationMode", existingDurationMode);
      metrics = this.mergeMetricsField(metrics, "sceneTimeline", result.sceneTimelineFrames);

      const durationMs = result.actualDurationMs ?? Math.round(result.script.totalDurationSeconds * 1000);
      await this.jobRepository.updateStatus(jobId, "completed", {
        videoUrl: result.videoUrl,
        objectKey: result.objectKey,
        scriptJson: result.script,
        durationMs,
        metricsJson: metrics,
      });
      logger.info("Retry completed", { videoUrl: result.videoUrl, durationMs });
      retrySucceeded = true;
    } catch (error) {
      let failureMetrics = this.buildFailureMetrics(this.extractFailureMetadata(error));
      failureMetrics = this.mergeMetricsField(failureMetrics, "durationMode", existingDurationMode);
      await this.handlePipelineError(jobId, error, logger, undefined, failureMetrics);
    }

    await this.settle({
      jobId,
      succeeded: retrySucceeded,
      isFullVideo: retrySucceeded,
      apiKeyId,
      logger,
    });
  }

  // ── Post-pipeline settlement ──────────────────────────────────────────

  private async settle(ctx: SettlementContext): Promise<void> {
    await this.settleApiKey(ctx);
  }

  /** One-time key lifecycle: consume on full video success, release otherwise. */
  private async settleApiKey(ctx: SettlementContext): Promise<void> {
    if (!ctx.apiKeyId || !this.apiKeyRepository) return;

    if (ctx.isFullVideo) {
      try {
        const consumed = await this.apiKeyRepository.consumeKey(ctx.apiKeyId);
        if (consumed) {
          ctx.logger.info("One-time key consumed after successful job", { apiKeyId: ctx.apiKeyId });
        } else {
          ctx.logger.error("One-time key consumption matched zero rows — key may have been revoked during job", { apiKeyId: ctx.apiKeyId });
        }
      } catch (err) {
        ctx.logger.error("Failed to consume one-time key after successful job — key may remain in_use", {
          apiKeyId: ctx.apiKeyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      try {
        const released = await this.apiKeyRepository.releaseFromJob(ctx.apiKeyId);
        const outcome = ctx.succeeded ? "preview" : "failed";
        if (released) {
          ctx.logger.info(`One-time key released after ${outcome} job`, { apiKeyId: ctx.apiKeyId });
        } else {
          ctx.logger.warn("One-time key release matched zero rows — key may have been revoked", { apiKeyId: ctx.apiKeyId });
        }
      } catch (err) {
        ctx.logger.error(`Failed to release one-time key after job ${ctx.succeeded ? "preview" : "failure"}`, {
          apiKeyId: ctx.apiKeyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Shared helpers ─────────────────────────────────────────────────

  private async buildCompletionMetrics(
    jobId: string,
    script: VideoScript,
    prContext: PRContext | undefined,
    installationId: number | undefined,
    promptPipelineV2?: PromptPipelineV2Artifacts,
    reviewGraphFallback?: ReviewGraphSource,
  ): Promise<Record<string, unknown> | null> {
    const reviewGraphSource = await this.captureReviewGraphSource(
      jobId, script, prContext, installationId, reviewGraphFallback,
    );
    return this.buildMetrics(script, prContext, promptPipelineV2, reviewGraphSource);
  }

  private mergeMetricsField(
    metrics: Record<string, unknown> | null,
    key: string,
    value: unknown,
  ): Record<string, unknown> | null {
    if (value === undefined) return metrics;
    if (metrics) { metrics[key] = value; return metrics; }
    return { [key]: value };
  }

  private async handlePipelineError(
    jobId: string,
    error: unknown,
    logger: ReturnType<typeof createLogger>,
    prContext?: PRContext,
    prebuiltMetrics?: Record<string, unknown> | null,
  ): Promise<void> {
    const msg = error instanceof Error ? error.message : "Unknown error";
    const failure = this.extractFailureMetadata(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const cause = error instanceof Error && error.cause instanceof Error
      ? { message: error.cause.message, stack: error.cause.stack }
      : error instanceof Error && error.cause != null
      ? String(error.cause)
      : undefined;
    logger.error("Job failed", {
      error: msg,
      errorCode: failure.errorCode,
      capabilityFailureReason: failure.capabilityFailureReason,
      missingCapabilities: failure.missingCapabilities,
      stack,
      cause,
    });
    await this.jobRepository
      .updateStatus(jobId, "failed", {
        errorCode: failure.errorCode,
        errorMessage: msg,
        metricsJson: prebuiltMetrics !== undefined
          ? prebuiltMetrics
          : this.buildFailureMetrics(failure, prContext),
      })
      .catch((dbErr) => {
      logger.error("Failed to mark job as failed — job may be stuck in processing", {
        jobId,
        originalError: msg,
        errorCode: failure.errorCode,
        dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    });
  }

  private getReviewGraphFilePaths(script: VideoScript): string[] {
    return [...new Set(
      script.scenes.flatMap((scene) =>
        scene.codeBroll
          .map((entry) => entry.filePath)
          .filter((filePath): filePath is string => Boolean(filePath)),
      ),
    )].sort();
  }

  private async captureReviewGraphSource(
    jobId: string,
    script: VideoScript,
    prContext: PRContext | undefined,
    installationId?: number,
    fallback?: ReviewGraphSource,
  ): Promise<ReviewGraphSource | undefined> {
    const filePaths = this.getReviewGraphFilePaths(script);
    if (filePaths.length < 2) {
      return fallback;
    }
    const repoFullName = prContext?.headRepoFullName ?? prContext?.repoFullName;
    const ref = prContext?.headSha || prContext?.headBranch;
    if (
      !this.githubService?.fetchRepositoryFiles
      || !repoFullName
      || !ref
      || !installationId
    ) {
      return fallback;
    }

    try {
      const files = await this.githubService.fetchRepositoryFiles(
        repoFullName,
        ref,
        filePaths,
        installationId,
      );
      if (Object.keys(files).length === 0) {
        return fallback;
      }
      return {
        version: 1,
        files,
      };
    } catch (error) {
      createLogger(jobId).warn("Failed to capture canonical review graph source — falling back to snippets", {
        repo: repoFullName,
        ref,
        installationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  private buildMetrics(
    script: VideoScript,
    prContext?: PRContext,
    promptPipelineV2?: PromptPipelineV2Artifacts,
    reviewGraphSource?: ReviewGraphSource,
  ): Record<string, unknown> | null {
    const modeMetadata = {
      ...(prContext?.durationMode && prContext.durationMode !== "default"
        ? { durationMode: prContext.durationMode }
        : {}),
      ...(prContext?.deepdive ? { deepdive: true } : {}),
    };

    void script;

    if (!promptPipelineV2 && !reviewGraphSource) {
      return Object.keys(modeMetadata).length > 0 ? modeMetadata : null;
    }

    return {
      rolloutFlags: {
        promptPipelineV2Enabled: isPromptPipelineV2Enabled(),
        modelPromptAdaptersV1Enabled: isModelPromptAdaptersV1Enabled(),
        promptPipelineV2CompareV1Enabled: isPromptPipelineV2CompareV1Enabled(),
      },
      ...(promptPipelineV2
        ? {
            promptPipeline: {
              version: "v2",
              llmFamily: promptPipelineV2.llmFamily,
              clusterCount: promptPipelineV2.coveragePlan.clusters.length,
              sceneIntentCount: promptPipelineV2.sceneOutline.scenes.length,
              ...(promptPipelineV2.coverageJudge
                ? { coverageJudge: promptPipelineV2.coverageJudge }
                : {}),
              ...(promptPipelineV2.narrationJudge
                ? { narrationJudge: promptPipelineV2.narrationJudge }
                : {}),
              ...(promptPipelineV2.coverageValidation
                ? { coverageValidation: promptPipelineV2.coverageValidation }
                : {}),
              ...(promptPipelineV2.sceneOutlineValidation
                ? { sceneOutlineValidation: promptPipelineV2.sceneOutlineValidation }
                : {}),
              ...(promptPipelineV2.scriptValidation
                ? { scriptValidation: promptPipelineV2.scriptValidation }
                : {}),
              ...(promptPipelineV2.rolloutComparison
                ? { rolloutComparison: promptPipelineV2.rolloutComparison }
                : {}),
            },
          }
        : { promptPipeline: { version: "v1" } }),
      ...modeMetadata,
      ...(reviewGraphSource ? { reviewGraphSource } : {}),
    };
  }

  private buildFailureMetrics(
    failure: FailureMetadata,
    prContext?: PRContext,
  ): Record<string, unknown> | null {
    const hasDurationMode = prContext?.durationMode && prContext.durationMode !== "default";
    const hasDeepdive = prContext?.deepdive === true;
    const durationMode = prContext?.durationMode;
    if (
      !failure.errorCode &&
      !failure.capabilityFailureReason &&
      !failure.missingCapabilities &&
      !hasDurationMode &&
      !hasDeepdive
    ) {
      return null;
    }

    return {
      errorCode: failure.errorCode,
      capabilityFailureReason: failure.capabilityFailureReason,
      missingCapabilities: failure.missingCapabilities,
      ...(hasDurationMode && durationMode ? { durationMode } : {}),
      ...(hasDeepdive ? { deepdive: true } : {}),
    };
  }

  private async cleanupCheckpointAfterPreview(jobId: string, logger: ReturnType<typeof createLogger>): Promise<void> {
    if (!this.deps.checkpointStore) return;
    try {
      await this.deps.checkpointStore.delete(jobId);
    } catch (err) {
      logger.warn("Failed to delete checkpoint after successful preview job", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private extractFailureMetadata(error: unknown): FailureMetadata {
    if (error instanceof DiffTooLargeError) {
      return { errorCode: "DIFF_TOO_LARGE", capabilityFailureReason: null, missingCapabilities: null };
    }

    if (error instanceof DiffFetchTimeoutError) {
      return { errorCode: "DIFF_FETCH_TIMEOUT", capabilityFailureReason: null, missingCapabilities: null };
    }

    if (error instanceof DiffParseError) {
      return { errorCode: "DIFF_PARSE_ERROR", capabilityFailureReason: null, missingCapabilities: null };
    }

    if (
      error instanceof Error &&
      (error as { code?: unknown }).code === "LLM_RATE_LIMITED_EXHAUSTED"
    ) {
      return {
        errorCode: "LLM_RATE_LIMITED_EXHAUSTED",
        capabilityFailureReason: null,
        missingCapabilities: null,
      };
    }

    if (
      error instanceof Error &&
      error.message.startsWith("Prompt Pipeline V2")
    ) {
      return {
        errorCode: "LLM_VALIDATION_EXHAUSTED",
        capabilityFailureReason: null,
        missingCapabilities: null,
      };
    }

    return {
      errorCode: null,
      capabilityFailureReason: null,
      missingCapabilities: null,
    };
  }
}
