/**
 * Shared utilities for FFmpegCompositor and RemotionCompositor.
 *
 * Consolidates duplicated logic: total-frames calculation, streaming asset
 * download (tmp + atomic rename), and temp-directory cleanup.
 *
 * @module compositorUtils
 */
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ClipAsset, SceneTimelineEntry } from "@/interfaces/IClipAsset";
import { getSceneTimelineTotalFrames } from "@/infrastructure/video/remotion/timing";
import { redactUrl } from "@/lib/url";
import { createLogger } from "@/lib/logger";

const logger = createLogger("compositorUtils");

const FPS = 30;

/**
 * Calculates the total render frame count.
 *
 * Prefers the scene-timeline sum when available (it accounts for TTS-inflated
 * durations). Falls back to summing per-clip durations.
 */
export function computeTotalFrames(
  sceneTimelineFrames: SceneTimelineEntry[] | undefined,
  clips: ClipAsset[],
): number {
  if (sceneTimelineFrames && sceneTimelineFrames.length > 0) {
    return getSceneTimelineTotalFrames(sceneTimelineFrames);
  }
  return clips.reduce(
    (sum, clip) => sum + (clip.durationFrames ?? Math.round(clip.durationSeconds * FPS)),
    0,
  );
}

/**
 * Downloads a remote asset to a local file path via streaming.
 *
 * Writes to a `.tmp` file first, then atomically renames on success.
 * Skips if `destPath` already exists (cached from a previous attempt).
 */
export async function downloadAsset(
  url: string,
  destPath: string,
  label: string,
): Promise<void> {
  if (existsSync(destPath)) {
    logger.debug("Asset already cached, skipping download", { label, destPath });
    return;
  }

  logger.debug("Downloading asset", { label, url: redactUrl(url) });
  const tmpFile = `${destPath}.tmp`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error(`No response body for ${label}`);
    }

    const contentLength = response.headers.get("content-length");
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(tmpFile),
    );

    const stat = await fs.stat(tmpFile);
    if (contentLength) {
      const expected = parseInt(contentLength, 10);
      if (!isNaN(expected) && stat.size !== expected) {
        throw new Error(
          `Download truncated for ${label}: got ${stat.size} bytes, expected ${expected}`,
        );
      }
    }

    await fs.rename(tmpFile, destPath);
    logger.info("Asset downloaded", { label, sizeBytes: stat.size });
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
}

/**
 * Cleans up the render temp directory and optionally the clip directory.
 *
 * The render dir is always ephemeral. The clip dir is only removed when no
 * `cacheDir` was provided (i.e. it was auto-created in `os.tmpdir()`).
 */
export async function cleanupDirs(
  renderTmpDir: string,
  clipDir: string,
  cacheDir: string | undefined,
): Promise<void> {
  await fs.rm(renderTmpDir, { recursive: true, force: true }).catch((err) => {
    logger.warn("Failed to clean up render temp directory", {
      renderTmpDir,
      error: String(err),
    });
  });

  if (!cacheDir) {
    await fs.rm(clipDir, { recursive: true, force: true }).catch((err) => {
      logger.warn("Failed to clean up clip directory", { clipDir, error: String(err) });
    });
  } else {
    logger.debug("Preserving cached clip directory for potential retries", { clipDir });
  }
}
