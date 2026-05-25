import path from "node:path";
import type { IDiffAnalyzer, DiffAnalysis } from "@/interfaces/IDiffAnalyzer";
import type { DiffMetadataCorpus } from "@/domain/entities/DiffMetadataCorpus";
import type { IScriptWriter } from "@/interfaces/IScriptWriter";
import type { ITTSService, WordTiming } from "@/interfaces/ITTSService";
import type { IVideoCompositor } from "@/interfaces/IVideoCompositor";
import type { IStorageService } from "@/interfaces/IStorageService";
import type { IPipelineCheckpointStore, PipelineCheckpoint } from "@/interfaces/IPipelineCheckpoint";
import type { ClipAsset, SceneTimelineEntry } from "@/interfaces/IClipAsset";
import type { PRContext } from "@/domain/entities/PRContext";
import type { PromptPipelineV2Artifacts } from "@/domain/entities/PromptPipelineV2";
import { ensureLastSceneOverview, type VideoScript, type Scene } from "@/domain/entities/VideoScript";
import { createLogger } from "@/lib/logger";
import type { IOutputValidator } from "@/interfaces/IPromptInjectionGuard";
import { computeClipCover } from "@/infrastructure/video/clipCover";
import { prepareClipAssets } from "@/infrastructure/video/prepareClipAssets";
import {
  computeGraphLayoutIfApplicable,
  shouldInflateForConstellation,
} from "@/domain/services/constellationPolicy";
import { getConstellationOwnerSceneNumbers } from "@/infrastructure/video/graph/computeGraphLayout";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import {
  CONSTELLATION_SUFFIX_FRAMES,
  computeFinaleMinFrames,
  getConstellationSuffix,
  resolveSceneTimeline,
} from "@/infrastructure/video/remotion/timing";
import { sanitizeSpokenNarrationText } from "@/lib/narrationText";
import { resolveAudioSrc } from "@/lib/storage/resolveAudioSrc";

const FPS = 30;
const DEFAULT_SIGNED_URL_EXPIRY_HOURS = 4;

function safeParseIntEnv(envValue: string | undefined, fallback: number): number {
  if (envValue == null) return fallback;
  const parsed = parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface PerSceneNarration {
  sceneNumber: number;
  audioBuffer: Buffer | null;
  wordTimings: WordTiming[];
  clipDurations: number[];
}

interface PerSceneAudio extends PerSceneNarration {
  audioKey: string | null;
  audioUrl?: string;
}

export interface OrchestratorResult {
  objectKey: string;
  videoUrl: string;
  script: VideoScript;
  promptPipelineV2?: PromptPipelineV2Artifacts;
  /** Per-scene probed timeline used for accurate seek timestamps on the review page. */
  sceneTimelineFrames?: Array<{ sceneNumber: number; durationFrames: number }>;
  /**
   * Actual rendered video duration in milliseconds, summed from the per-scene
   * clip timeline. Diverges from `script.totalDurationSeconds` when narration
   * runs faster than the LLM's per-scene `durationSeconds` estimate (the clip
   * cover trims to actual narration to eliminate dead air, while the resolved
   * script floors at the LLM's stated duration). Billing uses this value so
   * users are charged for the duration they actually receive.
   */
  actualDurationMs?: number;
}

export interface ScriptOnlyResult {
  script: VideoScript;
  analysis: DiffAnalysis;
  promptPipelineV2?: PromptPipelineV2Artifacts;
}

export interface TTSOnlyResult {
  script: VideoScript;
  promptPipelineV2?: PromptPipelineV2Artifacts;
  perSceneAudio: Array<{
    sceneNumber: number;
    audioKey: string | null;
    audioUrl: string | undefined;
    wordTimings: WordTiming[];
    clipDurations: number[];
  }>;
}

export type PipelineStage = "analyzing" | "scripting" | "generating_assets" | "composing" | "uploading";

export interface OrchestratorDeps {
  diffAnalyzer: IDiffAnalyzer;
  scriptWriter: IScriptWriter;
  ttsService: ITTSService;
  videoCompositor: IVideoCompositor;
  storageService: IStorageService;
  checkpointStore?: IPipelineCheckpointStore;
  outputValidator?: IOutputValidator;
  onStageChange?: (stage: PipelineStage) => void;
}

/**
 * Filters edges that reference unknown nodeIds from a graph layout.
 * Returns the original layout unchanged if all edges are valid (identity optimization).
 * Logs a structured error for each bad edge so layout regressions are Sentry-visible.
 * Exported for unit testing.
 */
export function sanitizeGraphLayout(
  layout: GraphLayoutData,
  logger: ReturnType<typeof createLogger>,
): GraphLayoutData {
  const nodeIds = new Set(layout.nodes.map((n) => n.nodeId));
  const cleanEdges: GraphLayoutData["edges"] = [];
  let hasBadEdge = false;
  for (const edge of layout.edges) {
    if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
      cleanEdges.push(edge);
    } else {
      hasBadEdge = true;
      logger.error("Graph layout edge references unknown nodeId — filtering before render", {
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        knownNodeIds: [...nodeIds],
      });
    }
  }
  if (!hasBadEdge) return layout;
  return { ...layout, edges: cleanEdges };
}

export class VideoOrchestrator {
  private deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** Steps 1+2: Analyze diff and generate script via LLM. Shared by execute, executeScriptOnly, and executeTTSOnly. */
  private async analyzeAndGenerateScript(
    jobId: string,
    context: PRContext,
    stepSuffix = "",
    corpus?: DiffMetadataCorpus,
  ): Promise<{ script: VideoScript; analysis: DiffAnalysis; promptPipelineV2?: PromptPipelineV2Artifacts }> {
    const logger = createLogger(jobId);
    const label = stepSuffix ? ` (${stepSuffix})` : "";

    this.deps.onStageChange?.("analyzing");
    const filesInDiff = corpus ? Object.keys(corpus.files).length : 0;
    logger.info(`Step 1: Analyzing diff${label}`, { filesInDiff });
    const analysis = corpus
      ? this.deps.diffAnalyzer.analyzeCorpus(Object.values(corpus.files))
      : this.deps.diffAnalyzer.analyzeCorpus([]);
    logger.info("Diff analysis complete", {
      totalFiles: analysis.totalFilesChanged,
      changeType: analysis.suggestedChangeType,
    });

    this.deps.onStageChange?.("scripting");
    logger.info(`Step 2: Generating video script${label}`);
    const scriptResult = await this.deps.scriptWriter.generateScript(
      context,
      analysis,
    );
    const { script, promptPipelineV2 } = scriptResult;
    logger.info(`Script generated${label}`, {
      scenes: script.scenes.length,
      duration: script.totalDurationSeconds,
      wordCount: script.totalWordCount,
    });

    return { script, analysis, promptPipelineV2 };
  }

  /** Steps 6-8: Compose final video, upload, sign URL, clean up audio keys, delete checkpoint. */
  private async composeUploadAndFinalize(
    jobId: string,
    context: PRContext,
    script: VideoScript,
    clips: ClipAsset[],
    sceneTimelineFrames: SceneTimelineEntry[],
    audioIncluded: boolean,
    audioKeys: string[],
    opts: { promptPipelineV2?: PromptPipelineV2Artifacts; cacheDir: string },
  ): Promise<OrchestratorResult> {
    const logger = createLogger(jobId);

    // Step 6: Compose final video
    this.deps.onStageChange?.("composing");
    logger.info("Step 6: Composing final video", { cacheDir: opts.cacheDir });
    // Ensure last scene is overview for constellation graph (defense-in-depth).
    script = ensureLastSceneOverview(script);

    const rawGraphLayout = computeGraphLayoutIfApplicable(script);
    const graphLayout = rawGraphLayout
      ? sanitizeGraphLayout(rawGraphLayout, logger)
      : undefined;
    if (graphLayout) {
      logger.info("Constellation graph layout computed", {
        nodes: graphLayout.nodes.length,
        edges: graphLayout.edges.length,
        suffixFramesPerCodeScene: shouldInflateForConstellation()
          ? CONSTELLATION_SUFFIX_FRAMES
          : 0,
      });
    } else {
      logger.warn("Constellation graph layout unavailable — last scene will render without graph overlay", {
        hasCodeBroll: script.scenes.some((s) => s.codeBroll.length > 0),
      });
    }
    const { videoBuffer } = await this.deps.videoCompositor.compose({
      script,
      clips,
      sceneTimelineFrames,
      audioIncluded,
      cacheDir: opts.cacheDir,
      ...(graphLayout ? { graphLayout } : {}),
    });
    logger.info("Video composed", { sizeBytes: videoBuffer.length });

    // Step 7: Upload composed video + script artifacts
    const videoKey = `videos/${context.repoFullName}/${context.prNumber}/${jobId}.mp4`;
    this.deps.onStageChange?.("uploading");
    logger.info("Step 7: Uploading final video", { key: videoKey });
    await Promise.all([
      this.deps.storageService.upload(videoKey, videoBuffer, "video/mp4"),
      this.storeScriptArtifacts(jobId, context, script, opts.promptPipelineV2).catch((err: unknown) => {
        logger.warn("Failed to store script artifacts (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ]);

    // Step 8: Generate signed URL, cleanup per-scene audio
    const expiryHours = safeParseIntEnv(process.env.SIGNED_URL_EXPIRY_HOURS, DEFAULT_SIGNED_URL_EXPIRY_HOURS);
    const videoUrl = await this.deps.storageService.getSignedUrl(videoKey, expiryHours * 3600);

    await Promise.all(audioKeys.map((key) =>
      this.deps.storageService.delete(key).catch((err: unknown) => {
        logger.warn("Failed to clean up audio file", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ));

    await this.deleteCheckpoint(jobId);
    const totalRenderedFrames = sceneTimelineFrames.reduce(
      (sum, e) => sum + e.durationFrames,
      0,
    );
    const actualDurationMs = Math.round((totalRenderedFrames / FPS) * 1000);
    logger.info("Pipeline complete", { videoKey, actualDurationMs });
    return {
      objectKey: videoKey,
      videoUrl,
      script,
      promptPipelineV2: opts.promptPipelineV2,
      sceneTimelineFrames: sceneTimelineFrames.map(e => ({ sceneNumber: e.sceneNumber, durationFrames: e.durationFrames })),
      actualDurationMs,
    };
  }

  /** Flatten per-scene audio into the checkpoint-compatible shape, filtering scenes without audio. */
  private flattenPerSceneAudioForCheckpoint(
    perSceneAudio: PerSceneAudio[],
  ): Array<{ sceneNumber: number; audioKey: string; wordTimings: WordTiming[]; clipDurations: number[] }> {
    return perSceneAudio.flatMap((a) =>
      a.audioKey
        ? [{ sceneNumber: a.sceneNumber, audioKey: a.audioKey, wordTimings: a.wordTimings, clipDurations: a.clipDurations }]
        : [],
    );
  }

  async execute(
    jobId: string,
    context: PRContext,
    corpus?: DiffMetadataCorpus,
  ): Promise<OrchestratorResult> {
    const logger = createLogger(jobId);
    const useBuiltinTTS = process.env.USE_BUILTIN_TTS === "true";
    const storageDir = process.env.LOCAL_STORAGE_DIR ?? ".local-storage";

    // Steps 1+2: Analyze diff + generate script
    const { script: baseScript, promptPipelineV2 } = await this.analyzeAndGenerateScript(jobId, context, "", corpus);
    let script = baseScript;
    await this.saveCheckpoint(jobId, {
      jobId, completedStep: 2, prContext: context, script, promptPipelineV2,
    });

    let audioIncluded = false;
    let clips: ClipAsset[];
    let sceneTimelineFrames: SceneTimelineEntry[] = [];
    const audioKeys: string[] = [];
    const cacheDir = path.join(storageDir, "cache", jobId, "clips");

    if (useBuiltinTTS) {
      logger.info("Builtin TTS enabled — skipping external TTS");
      const provisionalWordTimings = this.approximateWordTimings(
        this.buildSpokenNarration(script.scenes),
      );
      script = this.resolveSceneTimeline(script, provisionalWordTimings, jobId);
      audioIncluded = true;
      await this.saveCheckpoint(jobId, {
        jobId, completedStep: 4, prContext: context, script, promptPipelineV2,
        audio: { audioUrl: "", audioKey: null, wordTimings: [], audioIncluded },
      });

      this.deps.onStageChange?.("generating_assets");
      logger.info("Step 5: Building code-first scene assets", {
        sceneCount: script.scenes.length, builtinTTS: true,
      });
      clips = this.generateClips(script.scenes, jobId);
      logger.info("Code-first scene assets built", { clipCount: clips.length });
      sceneTimelineFrames = this.buildSceneTimelineFrames(clips);
      await this.saveCheckpoint(jobId, {
        jobId, completedStep: 5, prContext: context, script, promptPipelineV2,
        audio: { audioUrl: "", audioKey: null, wordTimings: [], audioIncluded },
        clips,
      });
    } else {
      // Step 3: Synthesize narration per scene to get actual durations
      const perSceneNarrations = await this.synthesizePerSceneNarration(jobId, context, script);

      // Step 4: Upload per-scene audio buffers
      const perSceneAudio = await this.uploadPerSceneAudio(jobId, context, perSceneNarrations);
      audioKeys.push(...(perSceneAudio.map((a) => a.audioKey).filter(Boolean) as string[]));
      await this.saveCheckpoint(jobId, {
        jobId, completedStep: 4, prContext: context, script, promptPipelineV2,
        perSceneAudio: this.flattenPerSceneAudioForCheckpoint(perSceneAudio),
      });

      // Step 5: Generate code-first scene assets sized to narration ceiling
      this.deps.onStageChange?.("generating_assets");
      logger.info("Step 5: Building code-first scene assets", {
        sceneCount: script.scenes.length, builtinTTS: false,
      });
      const perSceneClipDurations = new Map(
        perSceneNarrations.map((n) => [n.sceneNumber, n.clipDurations] as const),
      );
      const generatedClips = this.generateClips(
        script.scenes, jobId, perSceneClipDurations,
      );
      clips = await prepareClipAssets(generatedClips, { cacheDir, fps: FPS });
      logger.info("Code-first scene assets built and probed", { clipCount: clips.length });

      sceneTimelineFrames = this.buildSceneTimelineFrames(clips, perSceneAudio);
      await this.saveCheckpoint(jobId, {
        jobId, completedStep: 5, prContext: context, script, promptPipelineV2,
        perSceneAudio: this.flattenPerSceneAudioForCheckpoint(perSceneAudio),
        clips,
      });
    }

    // Steps 6-8: Compose, upload, sign, cleanup
    return this.composeUploadAndFinalize(
      jobId, context, script, clips, sceneTimelineFrames, audioIncluded, audioKeys,
      { promptPipelineV2, cacheDir },
    );
  }

  async resume(jobId: string): Promise<OrchestratorResult> {
    const logger = createLogger(jobId);
    const store = this.deps.checkpointStore;
    if (!store) throw new Error("Cannot resume without a checkpoint store");

    const checkpoint = await store.load(jobId);
    if (!checkpoint) throw new Error(`No checkpoint found for job ${jobId}`);

    logger.info("Resuming pipeline from checkpoint", {
      completedStep: checkpoint.completedStep,
    });

    const storageDir = process.env.LOCAL_STORAGE_DIR ?? ".local-storage";
    const context = checkpoint.prContext;
    const useBuiltinTTS = process.env.USE_BUILTIN_TTS === "true";
    const cacheDir = path.join(storageDir, "cache", jobId, "clips");

    let script = checkpoint.script;
    // Local tracking variables — avoid mutating the checkpoint object directly
    // so downstream reads are never coupled to mutation order.
    let resumeStep = checkpoint.completedStep;
    let resumeAudio = checkpoint.audio;
    let resumePerSceneAudio = checkpoint.perSceneAudio;
    let promptPipelineV2 = checkpoint.promptPipelineV2;
    let audioIncluded = resumeAudio?.audioIncluded ?? false;
    let clips = checkpoint.clips;
    let sceneTimelineFrames: SceneTimelineEntry[] = [];
    const audioKeys: string[] = [...(checkpoint.staleAudioKeys ?? [])];
    // Track stale audio keys across all checkpoint writes so they survive crashes.
    // Updated after migration (if new stale keys are discovered) and carried forward.
    let staleAudioKeysForCheckpoint: string[] | undefined = checkpoint.staleAudioKeys;

    if (!script) {
      logger.info("Resume: Re-generating script (missing from checkpoint)", {
        previousStep: resumeStep,
      });
      const resumeCorpus = checkpoint.diffCorpus;
      const analysis = resumeCorpus
        ? this.deps.diffAnalyzer.analyzeCorpus(Object.values(resumeCorpus.files))
        : this.deps.diffAnalyzer.analyzeCorpus([]);
      const result = await this.deps.scriptWriter.generateScript(
        context,
        analysis,
      );
      promptPipelineV2 = result.promptPipelineV2;
      script = result.script;
      // Collect stale audio keys for cleanup before discarding checkpoint data.
      if (resumeAudio?.audioKey) {
        audioKeys.push(resumeAudio.audioKey);
      }
      if (resumePerSceneAudio) {
        audioKeys.push(...resumePerSceneAudio.map((a) => a.audioKey).filter(Boolean));
      }
      resumeStep = 2;
      resumeAudio = undefined;
      resumePerSceneAudio = undefined;
      clips = undefined;
      audioIncluded = false;
      staleAudioKeysForCheckpoint = audioKeys.length > 0 ? [...audioKeys] : undefined;
      await this.saveCheckpoint(jobId, {
        jobId, completedStep: 2, prContext: context, script, promptPipelineV2,
        staleAudioKeys: staleAudioKeysForCheckpoint,
      });
    }
    // resumeStep < 5: no script alignment needed (code-first mode)

    if (useBuiltinTTS) {
      if (resumeStep < 4 || !resumeAudio) {
        const provisionalWordTimings = this.approximateWordTimings(
          this.buildSpokenNarration(script.scenes),
        );
        script = this.resolveSceneTimeline(script, provisionalWordTimings, jobId);
        audioIncluded = true;
        await this.saveCheckpoint(jobId, {
          jobId, completedStep: 4, prContext: context, script, promptPipelineV2,
          audio: { audioUrl: "", audioKey: null, wordTimings: [], audioIncluded },
          clips,
          staleAudioKeys: staleAudioKeysForCheckpoint,
        });
      }

      if (!clips || resumeStep < 5) {
        logger.info("Resume: Re-generating clips");
        clips = this.generateClips(script.scenes, jobId);
        await this.saveCheckpoint(jobId, {
          jobId, completedStep: 5, prContext: context, script, promptPipelineV2,
          audio: { audioUrl: "", audioKey: null, wordTimings: [], audioIncluded },
          clips,
          staleAudioKeys: staleAudioKeysForCheckpoint,
        });
      }
      sceneTimelineFrames = this.buildSceneTimelineFrames(clips);
    } else {
      let perSceneAudio: PerSceneAudio[];

      if (resumeStep < 4 || !resumePerSceneAudio) {
        logger.info("Resume: Re-synthesizing per-scene narration");
        const narrations = await this.synthesizePerSceneNarration(jobId, context, script);
        perSceneAudio = await this.uploadPerSceneAudio(jobId, context, narrations);
        await this.saveCheckpoint(jobId, {
          jobId, completedStep: 4, prContext: context, script, promptPipelineV2,
          perSceneAudio: this.flattenPerSceneAudioForCheckpoint(perSceneAudio),
          staleAudioKeys: staleAudioKeysForCheckpoint,
        });
      } else {
        // Re-sign stored audio keys (signed URLs may have expired)
        perSceneAudio = await Promise.all(
          resumePerSceneAudio.map(async (stored) => {
            const audioUrl = await resolveAudioSrc(this.deps.storageService,stored.audioKey, 3600);
            return {
              sceneNumber: stored.sceneNumber,
              audioBuffer: null,
              wordTimings: stored.wordTimings,
              clipDurations: stored.clipDurations,
              audioKey: stored.audioKey,
              audioUrl,
            };
          }),
        );
      }
      audioKeys.push(...(perSceneAudio.map((a) => a.audioKey).filter(Boolean) as string[]));

      if (!clips || resumeStep < 5 || clips.some((c) => !c.durationFrames)) {
        logger.info("Resume: Re-generating clips");
        const perSceneClipDurations = new Map(
          perSceneAudio
            .filter((a) => a.clipDurations.length > 0)
            .map((a) => [a.sceneNumber, a.clipDurations] as const),
        );
        const generatedClips = this.generateClips(
          script.scenes, jobId, perSceneClipDurations,
        );
        clips = await prepareClipAssets(generatedClips, { cacheDir, fps: FPS });
        await this.saveCheckpoint(jobId, {
          jobId, completedStep: 5, prContext: context, script, promptPipelineV2,
          perSceneAudio: this.flattenPerSceneAudioForCheckpoint(perSceneAudio),
          clips,
          staleAudioKeys: staleAudioKeysForCheckpoint,
        });
      } else {
        clips = await prepareClipAssets(clips, { cacheDir, fps: FPS });
      }

      sceneTimelineFrames = this.buildSceneTimelineFrames(clips, perSceneAudio);
    }

    if (!clips) throw new Error(`clips missing after resume for job ${jobId}`);

    // Steps 6-8: Compose, upload, sign, cleanup
    return this.composeUploadAndFinalize(
      jobId, context, script, clips, sceneTimelineFrames, audioIncluded, audioKeys,
      { promptPipelineV2, cacheDir },
    );
  }

  async executeScriptOnly(
    jobId: string,
    context: PRContext,
    corpus?: DiffMetadataCorpus,
  ): Promise<ScriptOnlyResult> {
    return this.analyzeAndGenerateScript(jobId, context, "script-only", corpus);
  }

  async executeTTSOnly(
    jobId: string,
    context: PRContext,
    corpus?: DiffMetadataCorpus,
  ): Promise<TTSOnlyResult> {
    const logger = createLogger(jobId);

    // Steps 1+2: Analyze diff + generate script
    const { script, promptPipelineV2 } = await this.analyzeAndGenerateScript(jobId, context, "tts-only", corpus);

    // Step 3: Synthesize per-scene narration
    const perSceneNarrations = await this.synthesizePerSceneNarration(jobId, context, script);

    // Step 4: Upload per-scene audio
    const perSceneAudio = await this.uploadPerSceneAudio(jobId, context, perSceneNarrations);

    logger.info("TTS-only pipeline complete", {
      scenes: script.scenes.length,
      audioFiles: perSceneAudio.filter((a) => a.audioUrl).length,
    });

    return {
      script,
      promptPipelineV2,
      perSceneAudio: perSceneAudio.map((a) => ({
        sceneNumber: a.sceneNumber,
        audioKey: a.audioKey,
        audioUrl: a.audioUrl,
        wordTimings: a.wordTimings,
        clipDurations: a.clipDurations,
      })),
    };
  }

  /**
   * Synthesize narration for each scene in parallel. Returns actual audio buffers +
   * 0-based word timings per scene, plus the minimum-cost set of clip durations
   * that covers the narration while respecting the model's valid durations.
   */
  private async synthesizePerSceneNarration(
    jobId: string,
    context: PRContext,
    script: VideoScript,
  ): Promise<PerSceneNarration[]> {
    const logger = createLogger(jobId);
    // Empty array is intentional for code-first mode: computeClipCover falls back to
    // Math.ceil(targetSeconds) when no valid durations are provided. This avoids snapping
    // to AI model-specific durations (e.g. [4,6,8]) for synthetic code-snippet clips.
    const validDurations: readonly number[] = [];
    logger.info("Step 3: Synthesizing per-scene narration", { sceneCount: script.scenes.length });

    return Promise.all(
      script.scenes.map(async (scene) => {
        const text = sanitizeSpokenNarrationText(scene.narration);
        if (!text.trim()) {
          const clipDurations = computeClipCover(scene.durationSeconds, validDurations).durations;
          return { sceneNumber: scene.sceneNumber, audioBuffer: null, wordTimings: [], clipDurations };
        }

        let audioBuffer: Buffer;
        let wordTimings: WordTiming[];
        let audioDurationSeconds: number;
        try {
          ({ audioBuffer, wordTimings, audioDurationSeconds } = await this.deps.ttsService.synthesize(text, undefined, {
            targetDurationSeconds: undefined,
          }));
        } catch (err) {
          throw new Error(
            `TTS synthesis failed for scene ${scene.sceneNumber}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        let narrationSeconds: number;
        if (audioDurationSeconds > 0) {
          narrationSeconds = audioDurationSeconds;
        } else {
          narrationSeconds = (wordTimings[wordTimings.length - 1]?.endTimeMs ?? 0) / 1000;
          logger.warn("Audio duration measurement unavailable — falling back to word-timing estimate", {
            sceneNumber: scene.sceneNumber,
            estimatedNarrationSeconds: narrationSeconds,
          });
        }
        // Use actual narration duration as the clip base — the LLM's durationSeconds is
        // an imprecise guess. The constellation suffix (CONSTELLATION_SUFFIX_FRAMES) is
        // added on top in generateClips, so trimming here eliminates dead air between
        // narration end and the shrink animation start.
        // Fall back to scene.durationSeconds when TTS returns zero (e.g., synthesizer
        // error, empty audio, or test doubles with no word timings).
        if (narrationSeconds <= 0) {
          logger.error("TTS synthesis returned zero duration — falling back to script durationSeconds", {
            sceneNumber: scene.sceneNumber,
            fallbackSeconds: scene.durationSeconds,
            audioDurationSeconds,
            wordTimingsCount: wordTimings.length,
          });
        }
        const requestedSceneSeconds = narrationSeconds > 0 ? narrationSeconds : scene.durationSeconds;
        const { durations: clipDurations, totalSeconds } = computeClipCover(requestedSceneSeconds, validDurations);

        logger.debug("Scene narration synthesized", {
          sceneNumber: scene.sceneNumber,
          audioDurationSeconds,
          narrationSeconds: narrationSeconds.toFixed(2),
          requestedSceneSeconds,
          clipDurations,
          totalClipSeconds: totalSeconds,
        });

        return { sceneNumber: scene.sceneNumber, audioBuffer, wordTimings, clipDurations };
      }),
    );
  }

  /** Upload per-scene audio buffers and return signed URLs for Remotion. */
  private async uploadPerSceneAudio(
    jobId: string,
    context: PRContext,
    narrations: PerSceneNarration[],
  ): Promise<PerSceneAudio[]> {
    const logger = createLogger(jobId);
    logger.info("Step 4: Uploading per-scene audio", { sceneCount: narrations.length });

    return Promise.all(
      narrations.map(async (narration) => {
        if (!narration.audioBuffer || narration.audioBuffer.length === 0) {
          return { ...narration, audioKey: null, audioUrl: undefined };
        }
        const audioKey = `audio/${context.repoFullName}/${context.prNumber}/${jobId}/scene-${narration.sceneNumber}.ogg`;
        await this.deps.storageService.upload(audioKey, narration.audioBuffer, "audio/ogg");
        const audioUrl = await resolveAudioSrc(this.deps.storageService,audioKey, 3600);
        logger.debug("Scene audio uploaded", { sceneNumber: narration.sceneNumber, audioKey });
        return { ...narration, audioKey, audioUrl };
      }),
    );
  }

  /**
   * Builds code-first clip assets for all scenes. Each scene produces a single
   * synthetic clip whose duration is derived from the narration ceiling (if
   * available) or the scene's own durationSeconds.
   */
  private generateClips(
    scenes: Scene[],
    jobId: string,
    perSceneClipDurations?: Map<number, number[]>,
  ): ClipAsset[] {
    const logger = createLogger(jobId);
    const inflateForConstellation = shouldInflateForConstellation();
    // Only scenes that own at least one graph node get the constellation
    // animation tail. Scenes that re-use previously-seen filePaths render
    // as AnimatedCodeCard inside ConstellationScene with no shrink, so the
    // 75 extra frames would produce dead hold time. Multi-snippet scenes
    // with new files DO get the suffix — all cards shrink in parallel
    // within the same 45-frame window. Narrative bridges (no codeBroll)
    // have no constellation participation at all.
    const ownerSceneNumbers = inflateForConstellation
      ? getConstellationOwnerSceneNumbers(scenes)
      : new Set<number>();

    // Count unique file nodes (one per unique filePath) for finale minimum calculation.
    const nodeCount = inflateForConstellation
      ? new Set(scenes.flatMap((s) => s.codeBroll.map((c) => c.filePath))).size
      : 0;

    logger.debug("Building code-first clip assets", {
      sceneCount: scenes.length,
      inflateForConstellation,
      ownerSceneCount: ownerSceneNumbers.size,
      nodeCount,
    });

    return scenes.map((scene, sceneIndex) => {
      const coveredDurationSeconds =
        perSceneClipDurations?.get(scene.sceneNumber)?.reduce(
          (sum, duration) => sum + duration,
          0,
        ) ?? scene.durationSeconds;
      const baseFrames = Math.max(1, Math.round(coveredDurationSeconds * FPS));
      const hasCodeBroll = scene.codeBroll.length > 0;
      const isFirstScene = sceneIndex === 0;
      // Root.tsx never renders ConstellationScene for isFirstScene, so it must not receive
      // finale inflation. nodeCount > 0 guards all-narrative scripts with no graph nodes.
      const isLastScene =
        inflateForConstellation &&
        nodeCount > 0 &&
        !isFirstScene &&
        sceneIndex === scenes.length - 1;
      const isOwner = ownerSceneNumbers.has(scene.sceneNumber);
      const suffixFrames =
        inflateForConstellation && hasCodeBroll && isOwner && !isFirstScene
          ? getConstellationSuffix(true)
          : 0;

      // The last scene runs finaleReveal from frame 0 — no shrink suffix needed.
      // Inflate to ensure all node springs, edge draws, and drift are fully visible.
      const totalFrames = isLastScene
        ? Math.max(baseFrames, computeFinaleMinFrames(nodeCount))
        : baseFrames + suffixFrames;
      return {
        sceneNumber: scene.sceneNumber,
        clipIndex: 0,
        clipUrl: `code://scene/${scene.sceneNumber}`,
        sourceType: "code" as const,
        durationSeconds: totalFrames / FPS,
        durationFrames: totalFrames,
      };
    });
  }

  /** Approximates word-level timings at ~150 WPM (400ms per word). Used for builtin TTS path. */
  private approximateWordTimings(text: string): WordTiming[] {
    const words = sanitizeSpokenNarrationText(text).split(/\s+/).filter(Boolean);
    const msPerWord = 400;
    return words.map((word, i) => ({
      word,
      startTimeMs: i * msPerWord,
      endTimeMs: (i + 1) * msPerWord,
    }));
  }

  private buildSpokenNarration(scenes: Scene[]): string {
    return scenes
      .map((scene) => sanitizeSpokenNarrationText(scene.narration))
      .filter(Boolean)
      .join(" ");
  }

  /** Build SceneTimelineEntry[] from probed clips, grouping by scene and summing frames. */
  private buildSceneTimelineFrames(
    clips: ClipAsset[],
    perSceneAudio?: PerSceneAudio[],
  ): SceneTimelineEntry[] {
    const audioMap = perSceneAudio
      ? new Map(perSceneAudio.map((a) => [a.sceneNumber, a]))
      : undefined;

    // Group clips by sceneNumber, preserving order
    const sceneGroups = new Map<number, ClipAsset[]>();
    for (const clip of clips) {
      const group = sceneGroups.get(clip.sceneNumber);
      if (group) {
        group.push(clip);
      } else {
        sceneGroups.set(clip.sceneNumber, [clip]);
      }
    }

    return [...sceneGroups.entries()].map(([sceneNumber, sceneClips]) => {
      const audio = audioMap?.get(sceneNumber);
      const durationFrames = sceneClips.reduce(
        (sum, c) => sum + (c.durationFrames ?? Math.max(1, Math.round(c.durationSeconds * FPS))),
        0,
      );
      return {
        sceneNumber,
        durationFrames,
        ...(audio?.audioUrl ? { audioSrc: audio.audioUrl } : {}),
        ...(audio?.wordTimings?.length ? { wordTimings: audio.wordTimings } : {}),
      };
    });
  }

  private resolveSceneTimeline(
    script: VideoScript,
    wordTimings: WordTiming[],
    jobId: string,
  ): VideoScript {
    if (wordTimings.length > 0) {
      const totalSceneWords = script.scenes.reduce((sum, scene) => {
        return sum + sanitizeSpokenNarrationText(scene.narration).split(/\s+/).filter(Boolean).length;
      }, 0);
      if (wordTimings.length !== totalSceneWords) {
        createLogger(jobId).warn("Word timing count mismatch — using proportional distribution for scene durations", {
          wordTimingsCount: wordTimings.length,
          totalSceneWords,
        });
      }
    }
    const resolvedScript = resolveSceneTimeline(script, wordTimings, FPS);

    if (resolvedScript !== script) {
      createLogger(jobId).info("Scene timing resolved to fit narration", {
        originalTotalDurationSeconds: script.totalDurationSeconds,
        resolvedTotalDurationSeconds: resolvedScript.totalDurationSeconds,
      });
    }

    return resolvedScript;
  }

  private async saveCheckpoint(jobId: string, checkpoint: PipelineCheckpoint): Promise<void> {
    if (this.deps.checkpointStore) {
      await this.deps.checkpointStore.save(checkpoint);
    }
  }

  private async deleteCheckpoint(jobId: string): Promise<void> {
    if (this.deps.checkpointStore) {
      try {
        await this.deps.checkpointStore.delete(jobId);
      } catch (err: unknown) {
        createLogger(jobId).warn("Failed to delete checkpoint after successful pipeline", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private buildNarrationText(script: VideoScript): string {
    return script.scenes
      .map((scene) => {
        const header = `--- Scene ${scene.sceneNumber} (${scene.sceneType}) [${scene.durationSeconds}s] ---`;
        return `${header}\n${scene.narration}`;
      })
      .join("\n\n");
  }

  private async storeScriptArtifacts(
    jobId: string,
    context: PRContext,
    script: VideoScript,
    promptPipelineV2?: PromptPipelineV2Artifacts,
  ): Promise<void> {
    const logger = createLogger(jobId);
    const artifactPrefix = `scripts/${context.repoFullName}/${context.prNumber}/${jobId}`;
    const scriptJsonKey = `${artifactPrefix}/script.json`;
    const narrationTxtKey = `${artifactPrefix}/narration.txt`;
    const promptPipelineV2Key = `${artifactPrefix}/prompt-pipeline-v2.json`;

    await Promise.all([
      this.deps.storageService.upload(
        scriptJsonKey,
        Buffer.from(JSON.stringify(script, null, 2), "utf-8"),
        "application/json",
      ),
      this.deps.storageService.upload(
        narrationTxtKey,
        Buffer.from(this.buildNarrationText(script), "utf-8"),
        "text/plain",
      ),
      ...(promptPipelineV2
        ? [
            this.deps.storageService.upload(
              promptPipelineV2Key,
              Buffer.from(JSON.stringify(promptPipelineV2, null, 2), "utf-8"),
              "application/json",
            ),
          ]
        : []),
    ]);
    logger.info("Script artifacts stored", {
      scriptJsonKey,
      narrationTxtKey,
      ...(promptPipelineV2 ? { promptPipelineV2Key } : {}),
    });
  }

}
