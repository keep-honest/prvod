/**
 * Native FFmpeg video compositor — the default `VIDEO_COMPOSITOR=ffmpeg` backend.
 *
 * Replaces the Remotion compositor (which requires Chromium + React) with a single
 * `ffmpeg` process that scales, concatenates, mixes audio, burns ASS captions,
 * and composites code-overlay PNGs into one final MP4.
 *
 * Pipeline steps (mirrors {@link compose}):
 *  1. Download AI-generated clips to disk (cached across retries via `cacheDir`)
 *  2. Probe actual MP4 durations with ffprobe to correct timeline drift
 *  3. Download per-scene TTS audio files (external narration path)
 *  4. Generate ASS subtitle file from word-level timings
 *  5. Pre-render code overlay PNGs via shiki + sharp
 *  6. Build a single `filter_complex` graph (see {@link buildFilterGraph})
 *  7. Execute ffmpeg and return the output buffer
 *
 * @module FFmpegCompositor
 */
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { createLogger } from "@/lib/logger";
import type {
  IVideoCompositor,
  CompositionInput,
  CompositionResult,
} from "@/interfaces/IVideoCompositor";
import type { ClipAsset, SceneTimelineEntry } from "@/interfaces/IClipAsset";
import { parseCaptionOffsetMs } from "@/infrastructure/video/ffmpeg/parseCaptionOffsetMs";
import { computeTotalFrames, downloadAsset, cleanupDirs } from "@/infrastructure/video/compositorUtils";
import { generateCaptionASS } from "@/infrastructure/video/ffmpeg/caption-builder";
import { generateCodeOverlayPng } from "@/infrastructure/video/ffmpeg/code-overlay";
import { generateGraphOverlayPng } from "@/infrastructure/video/ffmpeg/generateGraphOverlayPng";
import { prepareConstellationOverlay } from "@/infrastructure/video/ffmpeg/prepareConstellationOverlay";
import {
  buildFilterGraph,
  clipKey,
  type CodeOverlayEntry,
} from "@/infrastructure/video/ffmpeg/filter-graph-builder";

const execFileAsync = promisify(execFile);
const logger = createLogger("FFmpegCompositor");

const FPS = 30;
/** ffmpeg render timeout: 10 minutes. */
const FFMPEG_TIMEOUT_MS = 600_000;

/**
 * Composes a final MP4 video from AI-generated clips, TTS audio, captions,
 * and code overlays using native ffmpeg (no browser/Chromium required).
 *
 * Implements {@link IVideoCompositor} as the lightweight alternative to
 * {@link RemotionCompositor}. Selected at runtime via `VIDEO_COMPOSITOR=ffmpeg`.
 */
export class FFmpegCompositor implements IVideoCompositor {
  constructor() {
    logger.info("FFmpegCompositor initialized");
  }

  /**
   * Orchestrates the full composition pipeline: download assets, probe durations,
   * generate caption/overlay assets, build a filter graph, and run ffmpeg.
   *
   * @param input - Scene script, clip URLs, timeline, and audio configuration
   * @returns Buffer containing the rendered MP4 video
   * @throws If any clip download fails, ffmpeg exits non-zero, or the render times out
   */
  async compose(input: CompositionInput): Promise<CompositionResult> {
    const { script, clips, sceneTimelineFrames, audioIncluded, cacheDir, graphLayout } = input;

    const totalFrames = computeTotalFrames(sceneTimelineFrames, clips);

    logger.info("Starting FFmpeg composition", {
      scenes: script.scenes.length,
      clips: clips.length,
      totalFrames,
      audioIncluded: audioIncluded ?? false,
      cacheDir: cacheDir ?? null,
    });

    // Work directories
    const clipDir = cacheDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "ffmpeg-clips-"));
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true });
    }
    const renderTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ffmpeg-render-"));

    try {
      // Step 1: Download clips to disk (skip synthetic code-first clips)
      const localClipPaths = new Map<string, string>();
      const videoClips = clips.filter(
        (clip) => clip.sourceType !== "code" && !clip.clipUrl.startsWith("code://"),
      );
      await Promise.all(
        videoClips.map(async (clip) => {
          const clipFile = path.join(clipDir, `scene-${clip.sceneNumber}-${clip.clipIndex}.mp4`);
          await downloadAsset(clip.clipUrl, clipFile, `clip s${clip.sceneNumber}-c${clip.clipIndex}`);
          localClipPaths.set(clipKey(clip.sceneNumber, clip.clipIndex), clipFile);
        }),
      );
      if (videoClips.length > 0) {
        logger.info("All video clips ready", { count: videoClips.length });
      }
      if (videoClips.length < clips.length) {
        logger.info("Code-first scenes will use solid-color background + code overlay PNGs", {
          codeScenes: clips.length - videoClips.length,
        });
      }

      // Step 1b: Probe actual clip durations and correct the timeline.
      // AI clip generators report approximate durations (e.g. 6s) but actual
      // MP4s differ (e.g. 6.12s). The cumulative drift breaks caption sync.
      const { correctedTimeline, probedClipDurations } = await this.correctTimelineFromProbe(
        sceneTimelineFrames ?? [],
        clips,
        localClipPaths,
      );

      // Step 1c: Probe which clips contain an audio stream.
      // When audioIncluded=false, models may still embed SFX/ambience via
      // productionAudio, but this is not guaranteed. We must check each clip
      // so the filter graph only references audio streams that actually exist.
      const clipsWithAudio = audioIncluded
        ? undefined // audioIncluded guarantees all clips have audio
        : await this.probeClipsAudioPresence(clips, localClipPaths);

      // Step 2: Download per-scene audio files (external TTS path)
      const localAudioPaths = new Map<number, string>();
      if (!audioIncluded) {
        await Promise.all(
          correctedTimeline
            .filter((entry): entry is typeof entry & { audioSrc: string } => !!entry.audioSrc)
            .map(async (entry) => {
              const audioFile = path.join(renderTmpDir, `scene-${entry.sceneNumber}-audio.ogg`);
              const src = entry.audioSrc;
              // Handle file:// URLs by copying the file directly
              if (src.startsWith("file://")) {
                const srcPath = src.replace("file://", "");
                await fs.copyFile(srcPath, audioFile);
              } else {
                await downloadAsset(src, audioFile, `audio s${entry.sceneNumber}`);
              }
              localAudioPaths.set(entry.sceneNumber, audioFile);
            }),
        );
        if (localAudioPaths.size > 0) {
          logger.info("Per-scene audio ready", { count: localAudioPaths.size });
        }
      }

      // Step 3: Generate ASS caption file
      const { offsetMs: captionOffsetMs, warning: captionOffsetWarning } =
        parseCaptionOffsetMs(process.env.CAPTION_OFFSET_MS);
      if (captionOffsetWarning) {
        logger.warn(captionOffsetWarning);
      }

      let captionAssPath: string | null = null;
      const hasWordTimings = correctedTimeline.some(
        (e) => e.wordTimings && e.wordTimings.length > 0,
      );
      if (hasWordTimings) {
        captionAssPath = path.join(renderTmpDir, "captions.ass");
        const assContent = generateCaptionASS(correctedTimeline, captionOffsetMs);
        await fs.writeFile(captionAssPath, assContent, "utf-8");
        logger.debug("Caption ASS file written", { path: captionAssPath });
      }

      // Step 4: Generate constellation graph overlay PNG (Phase 2) FIRST so we
      // know which scene owns the full-frame overlay before generating
      // per-scene code overlays. Delegates to a dedicated helper whose
      // failure policy is unit-tested independently of the compositor.
      const fullFrameOverlay = await prepareConstellationOverlay({
        graphLayout,
        script,
        renderTmpDir,
        cacheDir,
        generatePng: generateGraphOverlayPng,
        fs,
      });

      // Step 4b: Generate per-scene code overlay PNGs.
      // Skip the scene that owns the full-frame constellation overlay — the
      // graph is the sole visual for that scene (matches Remotion's
      // ConstellationScene behavior), so an extra code card would just sit
      // on top and the MP4 would never reach the graph-only end state.
      const codeOverlays: CodeOverlayEntry[] = [];
      for (const scene of script.scenes) {
        if (scene.codeBroll.length === 0) continue;
        if (fullFrameOverlay && scene.sceneNumber === fullFrameOverlay.sceneNumber) {
          logger.debug("Skipping code overlay PNG generation — scene owns full-frame graph", {
            sceneNumber: scene.sceneNumber,
          });
          continue;
        }

        const primaryBroll = scene.codeBroll[0];
        const pngPath = path.join(renderTmpDir, `code-overlay-s${scene.sceneNumber}.png`);
        const pngBuffer = await generateCodeOverlayPng(primaryBroll);
        await fs.writeFile(pngPath, pngBuffer);
        codeOverlays.push({ sceneNumber: scene.sceneNumber, pngPath });

        // Diagnostic: save overlay PNGs to persistent debug dir for inspection
        if (cacheDir) {
          const debugDir = path.join(cacheDir, "debug");
          await fs.mkdir(debugDir, { recursive: true });
          const debugPngPath = path.join(debugDir, `code-overlay-s${scene.sceneNumber}.png`);
          await fs.writeFile(debugPngPath, pngBuffer);
        }

        logger.debug("Code overlay generated", {
          sceneNumber: scene.sceneNumber,
          sizeBytes: pngBuffer.length,
          codeLength: primaryBroll.code.length,
          codePreview: primaryBroll.code.slice(0, 80),
        });
      }

      // Step 5: Build ffmpeg filter graph (only video clips — code-first scenes
      // are handled by the builder's solid-color + code overlay fallback)
      const { inputArgs, filterComplex, outputVideoLabel, outputAudioLabel } = buildFilterGraph({
        script,
        clips: videoClips,
        sceneTimelineFrames: correctedTimeline,
        audioIncluded: audioIncluded ?? false,
        captionAssPath,
        codeOverlays,
        fullFrameOverlay,
        localAudioPaths,
        localClipPaths,
        clipsWithAudio,
        probedClipDurations,
      });

      // Step 6: Execute ffmpeg
      const outputPath = path.join(renderTmpDir, "output.mp4");
      const ffmpegArgs = [
        "-y",
        ...inputArgs,
        "-filter_complex", filterComplex,
        "-map", `[${outputVideoLabel}]`,
        "-map", `[${outputAudioLabel}]`,
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-r", String(FPS),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outputPath,
      ];

      logger.info("Executing ffmpeg", {
        inputCount: inputArgs.filter((a) => a === "-i").length,
        outputPath,
      });
      logger.debug("ffmpeg args", { args: ffmpegArgs });

      const startTime = Date.now();
      try {
        const { stderr } = await execFileAsync("ffmpeg", ffmpegArgs, {
          timeout: FFMPEG_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (stderr) {
          logger.debug("ffmpeg stderr", { stderr: stderr.slice(-500) });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stderr = (err as { stderr?: string }).stderr ?? "";
        logger.error("ffmpeg failed", { error: msg, stderr: stderr.slice(-1000) });
        throw new Error(`ffmpeg render failed: ${msg}`);
      }

      const renderDuration = Date.now() - startTime;
      logger.info("ffmpeg render complete", { durationMs: renderDuration });

      // Step 7: Read output into buffer
      const videoBuffer = await fs.readFile(outputPath);
      logger.info("Composition complete", { sizeBytes: videoBuffer.length });

      return { videoBuffer };
    } finally {
      await cleanupDirs(renderTmpDir, clipDir, cacheDir);
    }
  }

  /**
   * Probes actual MP4 duration with ffprobe and corrects the timeline entries.
   * AI clip generators report approximate durations (e.g. 6s) but the real MP4
   * can be 6.12s. Over 7+ scenes the cumulative drift breaks caption sync.
   */
  private async correctTimelineFromProbe(
    timeline: SceneTimelineEntry[],
    clips: ClipAsset[],
    localClipPaths: Map<string, string>,
  ): Promise<{ correctedTimeline: SceneTimelineEntry[]; probedClipDurations: Map<string, number> }> {
    // Probe all clips in parallel
    const probedDurations = new Map<string, number>();
    await Promise.all(
      clips.map(async (clip) => {
        const key = clipKey(clip.sceneNumber, clip.clipIndex);
        const filePath = localClipPaths.get(key);
        if (!filePath) return;
        const actual = await this.probeClipDuration(filePath);
        if (actual !== null) {
          probedDurations.set(key, actual);
        }
      }),
    );

    // Only count clips that have local files (code-first clips are intentionally skipped)
    const probeableClipCount = clips.filter(
      (c) => localClipPaths.has(clipKey(c.sceneNumber, c.clipIndex)),
    ).length;

    if (probeableClipCount > 0 && probedDurations.size === 0) {
      logger.error("All ffprobe duration probes failed — timeline correction disabled, caption sync may drift", {
        totalClips: probeableClipCount,
      });
      return { correctedTimeline: timeline, probedClipDurations: probedDurations };
    }
    if (probedDurations.size < probeableClipCount) {
      logger.warn("Some ffprobe duration probes failed — using reported durations as fallback", {
        totalClips: probeableClipCount,
        probed: probedDurations.size,
        failed: probeableClipCount - probedDurations.size,
      });
    }

    // Group clips by scene
    const clipsByScene = new Map<number, ClipAsset[]>();
    for (const clip of clips) {
      const group = clipsByScene.get(clip.sceneNumber) ?? [];
      group.push(clip);
      clipsByScene.set(clip.sceneNumber, group);
    }

    const correctedTimeline = timeline.map((entry) => {
      const sceneClips = clipsByScene.get(entry.sceneNumber) ?? [];
      let hasAnyProbe = false;
      const probedTotal = sceneClips.reduce((sum, clip) => {
        const key = clipKey(clip.sceneNumber, clip.clipIndex);
        const probed = probedDurations.get(key);
        if (probed !== undefined) hasAnyProbe = true;
        return sum + (probed ?? clip.durationSeconds);
      }, 0);

      const correctedFrames = Math.max(1, Math.round(probedTotal * FPS));
      if (correctedFrames !== entry.durationFrames) {
        logger.debug("Corrected scene duration from probe", {
          sceneNumber: entry.sceneNumber,
          reportedFrames: entry.durationFrames,
          probedFrames: correctedFrames,
          driftMs: Math.round(((correctedFrames - entry.durationFrames) / FPS) * 1000),
        });
      }

      // Only set durationSeconds when at least one clip was successfully probed.
      // When all clips in a scene failed probing, probedTotal is just the sum of
      // AI-reported durations — no more precise than durationFrames / FPS.
      return {
        ...entry,
        durationFrames: correctedFrames,
        ...(hasAnyProbe ? { durationSeconds: probedTotal } : {}),
      };
    });

    return { correctedTimeline, probedClipDurations: probedDurations };
  }

  /** Probes actual duration of a local MP4 via ffprobe. Returns null on failure. */
  private async probeClipDuration(filePath: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ], { timeout: 10_000 });
      const parsed = parseFloat(stdout.trim());
      if (isNaN(parsed)) {
        logger.warn("ffprobe returned unparseable duration, using reported duration", {
          filePath,
          rawOutput: stdout.trim().slice(0, 200),
        });
        return null;
      }
      return parsed;
    } catch (err) {
      logger.warn("ffprobe failed, using reported duration", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Probes all clips to determine which ones contain an audio stream.
   * Returns a Set of clipKey strings for clips that have audio.
   */
  private async probeClipsAudioPresence(
    clips: ClipAsset[],
    localClipPaths: Map<string, string>,
  ): Promise<Set<string>> {
    const result = new Set<string>();
    await Promise.all(
      clips.map(async (clip) => {
        const key = clipKey(clip.sceneNumber, clip.clipIndex);
        const filePath = localClipPaths.get(key);
        if (!filePath) return;
        try {
          const { stdout } = await execFileAsync("ffprobe", [
            "-v", "quiet",
            "-select_streams", "a",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            filePath,
          ], { timeout: 10_000 });
          if (stdout.trim().length > 0) {
            result.add(key);
          }
        } catch (err) {
          logger.warn("ffprobe audio detection failed, assuming no audio", {
            clipKey: key,
            filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    // Only count clips with local files (code-first clips have no MP4 to probe)
    const probeableCount = clips.filter(
      (c) => localClipPaths.has(clipKey(c.sceneNumber, c.clipIndex)),
    ).length;
    if (result.size > 0) {
      logger.debug("Clips with audio tracks detected", {
        count: result.size,
        clips: [...result],
      });
    }
    if (probeableCount > 0 && result.size === 0) {
      logger.warn("No clips had detectable audio tracks — all scene audio will use TTS or silence", {
        totalClips: probeableCount,
      });
    }
    return result;
  }

}
