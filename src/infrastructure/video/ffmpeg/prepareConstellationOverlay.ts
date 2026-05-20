/**
 * FFmpeg-path helper that prepares the constellation graph full-frame
 * overlay. Extracted from `FFmpegCompositor.compose()` so the orchestration
 * — failure policy, final-scene selection, and best-effort debug copy — can
 * be unit tested without spinning up the full compositor.
 *
 * Failure policy: the constellation graph is a cosmetic summary. If PNG
 * generation, disk write, or the debug copy fails, the helper returns
 * `undefined` and logs the error at the appropriate level. The FFmpeg render
 * proceeds WITHOUT the overlay rather than killing the entire job.
 */

import path from "node:path";
import type { PathLike, WriteFileOptions, MakeDirectoryOptions } from "node:fs";
import type { FullFrameOverlayEntry } from "@/infrastructure/video/ffmpeg/filter-graph-builder";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import type { VideoScript } from "@/domain/entities/VideoScript";
import { createLogger } from "@/lib/logger";

const logger = createLogger("prepareConstellationOverlay");

/** Minimal fs.promises surface used by the helper — enables test injection. */
export interface FsLike {
  writeFile(
    file: PathLike,
    data: Buffer,
    options?: WriteFileOptions,
  ): Promise<void>;
  mkdir(
    dir: PathLike,
    options?: MakeDirectoryOptions & { recursive: true },
  ): Promise<string | undefined>;
}

export interface PrepareConstellationOverlayOptions {
  graphLayout: GraphLayoutData | undefined;
  script: VideoScript;
  renderTmpDir: string;
  cacheDir?: string;
  /** Sharp-based PNG generator (injectable for tests). */
  generatePng: (layout: GraphLayoutData) => Promise<Buffer>;
  /** fs.promises or a stub (injectable for tests). */
  fs: FsLike;
  /** Fade-in duration in seconds (default: 0.6s). */
  fadeInSec?: number;
}

/**
 * Generates the constellation overlay PNG, writes it to disk, optionally
 * copies it into the cache debug directory, and returns the
 * `FullFrameOverlayEntry` that the filter graph builder expects.
 *
 * Returns `undefined` when:
 * - `graphLayout` is absent
 * - `graphLayout.nodes.length === 0`
 * - PNG generation or writing the primary output fails
 * - The script has no scenes (nothing to attach the overlay to)
 *
 * Never throws. All failures are logged and degrade to `undefined`.
 */
export async function prepareConstellationOverlay(
  opts: PrepareConstellationOverlayOptions,
): Promise<FullFrameOverlayEntry | undefined> {
  const { graphLayout, script, renderTmpDir, cacheDir, generatePng, fs } = opts;

  if (!graphLayout || graphLayout.nodes.length === 0) {
    return undefined;
  }

  const finalSceneNumber = script.scenes[script.scenes.length - 1]?.sceneNumber;
  if (finalSceneNumber === undefined) {
    logger.warn(
      "Cannot attach constellation overlay — script has no scenes",
    );
    return undefined;
  }

  try {
    const graphPngPath = path.join(renderTmpDir, "constellation-graph.png");
    const graphPngBuffer = await generatePng(graphLayout);
    await fs.writeFile(graphPngPath, graphPngBuffer);

    // Best-effort debug copy — failures here must not take down the overlay
    // attachment or the render.
    if (cacheDir) {
      const debugDir = path.join(cacheDir, "debug");
      const debugPngPath = path.join(debugDir, "constellation-graph.png");

      await fs
        .mkdir(debugDir, { recursive: true })
        .catch((err: unknown) => {
          logger.warn("Failed to create constellation debug directory", {
            debugDir,
            error: err instanceof Error ? err.message : String(err),
            code: (err as NodeJS.ErrnoException)?.code,
          });
        });

      await fs.writeFile(debugPngPath, graphPngBuffer).catch((err: unknown) => {
        logger.warn("Failed to write constellation debug PNG", {
          debugPath: debugPngPath,
          error: err instanceof Error ? err.message : String(err),
          code: (err as NodeJS.ErrnoException)?.code,
        });
      });
    }

    logger.info("Constellation graph overlay attached to final scene", {
      sceneNumber: finalSceneNumber,
      graphSizeBytes: graphPngBuffer.length,
    });

    return {
      sceneNumber: finalSceneNumber,
      pngPath: graphPngPath,
      fadeInSec: opts.fadeInSec ?? 0.6,
    };
  } catch (err) {
    logger.error(
      "Failed to generate constellation graph overlay; rendering video without summary graphic",
      {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        nodeCount: graphLayout.nodes.length,
        edgeCount: graphLayout.edges.length,
      },
    );
    return undefined;
  }
}
