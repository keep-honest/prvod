import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import os from "node:os";
import type { WebpackConfiguration } from "@remotion/bundler";
import { createLogger } from "@/lib/logger";
import type {
  IVideoCompositor,
  CompositionInput,
  CompositionResult,
} from "@/interfaces/IVideoCompositor";
import { parseCaptionOffsetMs } from "@/infrastructure/video/ffmpeg/parseCaptionOffsetMs";
import { isWordSyncedCodeEnabled } from "@/lib/featureFlags";
import { computeTotalFrames, downloadAsset, cleanupDirs } from "@/infrastructure/video/compositorUtils";
import { createBrowserLogForwarder } from "@/infrastructure/video/remotionBrowserLogs";
import {
  resolveRemotionRendererPort,
  withRemotionRendererLock,
} from "@/infrastructure/video/remotionRendererConfig";

const logger = createLogger("RemotionCompositor");

const FPS = 30;
const SRC_ALIAS_PATH = path.resolve(process.cwd(), "src");

/**
 * Minimum @remotion/renderer version that honours `chromiumOptions.enableMultiProcessOnLinux`.
 * Below this, the option is silently dropped and the renderer falls back to
 * single-process Chrome on Linux — a notable perf regression that would not
 * appear in any logs without the version probe in {@link logRemotionVersion}.
 */
const REMOTION_MULTI_PROCESS_MIN_VERSION = "4.0.42";

/** Cached bundle path — Remotion webpack bundling is expensive, do it once. */
let cachedBundlePath: string | null = null;
let remotionVersionLogged = false;

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10));
  const pb = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (Number.isNaN(av) || Number.isNaN(bv)) return 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

async function logRemotionVersionOnce(): Promise<void> {
  if (remotionVersionLogged) return;
  remotionVersionLogged = true;
  try {
    const pkg = (await import("@remotion/renderer/package.json", {
      with: { type: "json" },
    })) as { default?: { version?: string }; version?: string };
    const version = pkg.default?.version ?? pkg.version;
    if (typeof version !== "string") return;
    const meetsMultiProcessReq =
      compareSemver(version, REMOTION_MULTI_PROCESS_MIN_VERSION) >= 0;
    logger.info("@remotion/renderer version", {
      version,
      meetsMultiProcessReq,
      multiProcessMinVersion: REMOTION_MULTI_PROCESS_MIN_VERSION,
    });
    if (!meetsMultiProcessReq) {
      logger.warn(
        "@remotion/renderer is older than the multi-process-on-Linux requirement; " +
          "chromiumOptions.enableMultiProcessOnLinux will be ignored at runtime",
        { version, required: REMOTION_MULTI_PROCESS_MIN_VERSION },
      );
    }
  } catch (err) {
    logger.warn("Failed to probe @remotion/renderer version", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function addRemotionAliases(
  currentConfiguration: WebpackConfiguration,
): WebpackConfiguration {
  const existingAlias = currentConfiguration.resolve?.alias;
  const aliasObject =
    existingAlias && !Array.isArray(existingAlias) ? existingAlias : {};

  return {
    ...currentConfiguration,
    resolve: {
      ...currentConfiguration.resolve,
      alias: {
        ...aliasObject,
        "@": SRC_ALIAS_PATH,
      },
    },
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

/**
 * Starts a lightweight HTTP server that serves files from a name→path map.
 * Remotion renders in a headless browser that loads ALL media via HTTP,
 * so local files (clips, audio) must be served over HTTP.
 */
interface AssetServerHandle {
  port: number;
  close: () => Promise<void>;
  /**
   * Resolves the first stream error observed while serving an asset, if any.
   * Headers are already flushed by the time a stream error fires (we writeHead
   * a 200 before piping), so the only signal to upstream is forcibly destroying
   * the socket. Callers should still consult this flag after render to detect
   * silent corruption.
   */
  getStreamError: () => Error | null;
}

function startAssetServer(
  fileMap: Map<string, string>,
): Promise<AssetServerHandle> {
  return new Promise((resolve, reject) => {
    let firstStreamError: Error | null = null;

    const server = http.createServer((req, res) => {
      const fileName = path.basename(new URL(req.url ?? "/", "http://localhost").pathname);
      const filePath = fileMap.get(fileName);

      if (!filePath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      const stream = createReadStream(filePath);
      stream.on("error", (err) => {
        // The 200 status is already on the wire — Remotion would otherwise see
        // a truncated success and render with missing media. Capture the error
        // so the caller can fail the job, and forcibly drop the socket so the
        // headless browser treats this asset as a network failure rather than
        // a successful empty body.
        if (!firstStreamError) firstStreamError = err;
        logger.error("Asset stream error", { fileName, filePath, error: err.message });
        if (!res.writableEnded) {
          res.socket?.destroy(err);
        }
      });
      stream.pipe(res);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((closeResolve) => {
            // Force-close any keepalive sockets so close() does not hang.
            (server as http.Server & { closeAllConnections?: () => void })
              .closeAllConnections?.();
            server.close(() => closeResolve());
          }),
        getStreamError: () => firstStreamError,
      });
    });
  });
}

export class RemotionCompositor implements IVideoCompositor {
  constructor() {
    logger.info("RemotionCompositor initialized");
  }

  async compose(input: CompositionInput): Promise<CompositionResult> {
    const { script, clips, sceneTimelineFrames, audioIncluded, cacheDir, graphLayout } = input;

    // External-TTS clip durations preserve the scripted scene budget while covering narration,
    // so summing clip frames yields a safe render length.
    const totalFrames = computeTotalFrames(sceneTimelineFrames, clips);

    logger.info("Starting Remotion composition", {
      scenes: script.scenes.length,
      clips: clips.length,
      totalFrames,
      cacheDir: cacheDir ?? null,
    });

    // Lazy-import Remotion modules (they're heavy and SSR-unfriendly)
    const { bundle } = await import("@remotion/bundler");
    const { renderMedia, selectComposition } = await import("@remotion/renderer");
    await logRemotionVersionOnce();

    // Step 1: Determine clip directory
    const clipDir = cacheDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "remotion-clips-"));
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true });
    }
    logger.debug("Clip directory", { clipDir, persistent: !!cacheDir });

    // Render temp dir is always ephemeral
    const renderTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remotion-render-"));

    let assetServer: AssetServerHandle | null = null;

    try {
      // Step 2: Download AI clips (skip if cached)
      const clipPaths = await Promise.all(
        clips.map(async (clip) => {
          const durationFrames = clip.durationFrames ?? Math.round(clip.durationSeconds * FPS);

          if (clip.sourceType === "code" || clip.clipUrl.startsWith("code://")) {
            return {
              sceneNumber: clip.sceneNumber,
              clipIndex: clip.clipIndex,
              localPath: clip.clipUrl,
              sourceType: "code" as const,
              durationFrames,
            };
          }

          const clipFile = path.join(clipDir, `scene-${clip.sceneNumber}-${clip.clipIndex}.mp4`);
          await downloadAsset(clip.clipUrl, clipFile, `clip s${clip.sceneNumber}-c${clip.clipIndex}`);

          return {
            sceneNumber: clip.sceneNumber,
            clipIndex: clip.clipIndex,
            localPath: clipFile,
            sourceType: "video" as const,
            durationFrames,
          };
        }),
      );

      logger.info("All clips ready", { count: clipPaths.length });

      // Step 3: Serve local assets (clips + per-scene audio) via HTTP.
      // Remotion renders in a headless browser that fetches ALL media over HTTP.
      // file:// URLs and local paths don't work — Remotion explicitly rejects them.
      // We spin up a small server on a random port, register each file, and give
      // Remotion http://127.0.0.1:{port}/filename URLs instead.
      const fileMap = new Map<string, string>();
      for (const cp of clipPaths) {
        if (cp.sourceType !== "code") {
          fileMap.set(path.basename(cp.localPath), path.resolve(cp.localPath));
        }
      }

      // Register per-scene audio files if they're local (file:// from LocalStorageService)
      for (const entry of sceneTimelineFrames ?? []) {
        if (entry.audioSrc?.startsWith("file://")) {
          const audioPath = entry.audioSrc.replace("file://", "");
          fileMap.set(path.basename(audioPath), audioPath);
        }
      }

      assetServer = await startAssetServer(fileMap);
      const assetPort = assetServer.port;

      const servedClipPaths = clipPaths.map((cp) => ({
        sceneNumber: cp.sceneNumber,
        clipIndex: cp.clipIndex,
        localPath:
          cp.sourceType === "code"
            ? cp.localPath
            : `http://127.0.0.1:${assetPort}/${path.basename(cp.localPath)}`,
        sourceType: cp.sourceType,
        durationFrames: cp.durationFrames,
      }));

      // Translate per-scene file:// audio URLs → http://
      const servedSceneTimelineFrames = (sceneTimelineFrames ?? []).map((entry) => {
        if (entry.audioSrc?.startsWith("file://")) {
          const audioName = path.basename(entry.audioSrc.replace("file://", ""));
          return { ...entry, audioSrc: `http://127.0.0.1:${assetPort}/${audioName}` };
        }
        return entry;
      });

      logger.info("Asset server started", {
        port: assetServer.port,
        clips: servedClipPaths.length,
        perSceneAudio: servedSceneTimelineFrames.filter((e) => e.audioSrc).length,
      });

      // Step 4: Prepare composition input props before entering the Remotion lock.
      const rawCaptionOffset = process.env.CAPTION_OFFSET_MS;
      const { offsetMs: captionOffsetMs, warning: captionOffsetWarning } = parseCaptionOffsetMs(rawCaptionOffset);
      if (captionOffsetWarning) {
        logger.warn(captionOffsetWarning, { value: rawCaptionOffset });
      }
      logger.debug("Resolved caption offset", { rawEnvValue: rawCaptionOffset ?? "unset", captionOffsetMs });
      // WORD_SYNCED_CODE must be resolved HERE (server process) and threaded
      // through inputProps: Root.tsx executes inside the Remotion webpack
      // bundle (headless Chrome) where custom server env vars are not
      // injected — reading process.env.WORD_SYNCED_CODE there always yields
      // undefined and would silently render the legacy overlay.
      const wordSyncedCodeEnabled = isWordSyncedCodeEnabled();
      logger.debug("Resolved WORD_SYNCED_CODE flag for render", { wordSyncedCodeEnabled });
      const compositionInputProps = {
        script,
        clipPaths: servedClipPaths,
        sceneTimelineFrames: servedSceneTimelineFrames,
        audioIncluded: audioIncluded ?? false,
        wordSyncedCodeEnabled,
        ...(graphLayout ? { graphLayout } : {}),
        ...(Number.isFinite(captionOffsetMs) && captionOffsetMs !== 0
          ? { captionOffsetMs }
          : {}),
      };

      const outputPath = path.join(renderTmpDir, "output.mp4");

      // Enable multi-process Chrome on Linux per Remotion docs — without this,
      // headless Chrome runs single-process and renders are noticeably slower
      // on multi-core Linux hosts (Render production target).
      const chromiumOptions = { enableMultiProcessOnLinux: true } as const;

      // Forward structured warns/errors emitted INSIDE the render bundle
      // (headless Chrome) to server logs. The bundle's shared logger writes
      // JSON lines to the browser console, which Remotion only surfaces via
      // onBrowserLog — without this callback, resolver warns such as
      // WORD_TIMING_TOKEN_COUNT_MISMATCH never reach production logs.
      // One forwarder per render: dedupe by (errorTag, sceneNumber) spans
      // selectComposition + renderMedia, absorbing per-chunk remount repeats.
      const onBrowserLog = createBrowserLogForwarder((level, message, context) =>
        logger[level](message, context),
      );

      const videoBuffer = await withRemotionRendererLock(async () => {
        const rendererPort = resolveRemotionRendererPort();

        // Step 5: Bundle Remotion project and serialize the internal renderer server lifecycle.
        if (!cachedBundlePath) {
          logger.info("Bundling Remotion project (first render)");
          const entryPoint = path.resolve(
            process.cwd(),
            "src/infrastructure/video/remotion/Root.tsx",
          );
          cachedBundlePath = await bundle({
            entryPoint,
            webpackOverride: addRemotionAliases,
            onProgress: (progress: number) => {
              logger.debug("Bundle progress", { progress: Math.round(progress * 100) });
            },
          });
          logger.info("Remotion bundle complete", { bundlePath: cachedBundlePath });
        }

        const composition = await selectComposition({
          serveUrl: cachedBundlePath,
          id: "PRVideo",
          inputProps: compositionInputProps,
          port: rendererPort,
          chromiumOptions,
          onBrowserLog,
        });

        logger.info("Rendering video", {
          compositionId: composition.id,
          durationInFrames: totalFrames,
          outputPath,
          rendererPort,
        });

        await renderMedia({
          composition: { ...composition, durationInFrames: totalFrames },
          serveUrl: cachedBundlePath,
          codec: "h264",
          outputLocation: outputPath,
          inputProps: compositionInputProps,
          port: rendererPort,
          chromiumOptions,
          onBrowserLog,
          onProgress: ({ progress }) => {
            if (Math.round(progress * 100) % 25 === 0) {
              logger.debug("Render progress", { progress: Math.round(progress * 100) });
            }
          },
        });

        return fs.readFile(outputPath);
      });

      const assetStreamError = assetServer.getStreamError();
      if (assetStreamError) {
        throw new Error(
          `Asset stream error during render — output may be corrupted: ${assetStreamError.message}`,
        );
      }

      logger.info("Render complete", { sizeBytes: videoBuffer.length });

      return { videoBuffer };
    } finally {
      // Shut down asset server with a short timeout so a hung connection
      // cannot block compose() from returning indefinitely.
      if (assetServer) {
        try {
          await Promise.race([
            assetServer.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
          ]);
        } catch (err) {
          logger.warn("Asset server close failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        logger.debug("Asset server stopped");
      }

      await cleanupDirs(renderTmpDir, clipDir, cacheDir);
    }
  }
}
