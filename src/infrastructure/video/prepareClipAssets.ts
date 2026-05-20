import fs from "node:fs/promises";
import path from "node:path";
import { Input, BufferSource, ALL_FORMATS } from "mediabunny";
import type { ClipAsset } from "@/interfaces/IClipAsset";
import { createLogger } from "@/lib/logger";
import { redactUrl } from "@/lib/url";

const logger = createLogger("prepareClipAssets");

export interface PrepareClipAssetsOptions {
  cacheDir: string;
  fps: number;
}

function isMockClipUrl(url: string): boolean {
  return url.startsWith("mock://");
}

function isCodeClip(clip: ClipAsset): boolean {
  return clip.sourceType === "code" || clip.clipUrl.startsWith("code://");
}

async function downloadClipToCache(clipUrl: string, outputPath: string): Promise<Buffer> {
  const response = await fetch(clipUrl);
  if (!response.ok) {
    throw new Error(`Failed to download clip from ${redactUrl(clipUrl)}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
  return buffer;
}

async function loadCachedClip(outputPath: string, clipUrl: string): Promise<Buffer> {
  try {
    return await fs.readFile(outputPath);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return downloadClipToCache(clipUrl, outputPath);
    }
    throw new Error(
      `Failed to read cached clip at ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

async function probeClipDurationFrames(
  clipBuffer: Buffer,
  fps: number,
): Promise<number> {
  const input = new Input({
    source: new BufferSource(new Uint8Array(clipBuffer.buffer, clipBuffer.byteOffset, clipBuffer.byteLength)),
    formats: ALL_FORMATS,
  });
  const durationInSeconds = await input.computeDuration();
  if (!durationInSeconds || durationInSeconds <= 0) {
    throw new Error(`Unable to determine clip duration (buffer size: ${clipBuffer.length} bytes, probe returned: ${durationInSeconds})`);
  }

  return Math.max(1, Math.floor(durationInSeconds * fps));
}

export async function prepareClipAssets(
  clips: ClipAsset[],
  options: PrepareClipAssetsOptions,
): Promise<ClipAsset[]> {
  const { cacheDir, fps } = options;
  await fs.mkdir(cacheDir, { recursive: true });

  return Promise.all(
    clips.map(async (clip) => {
      if (isCodeClip(clip)) {
        const durationFrames =
          clip.durationFrames ?? Math.max(1, Math.floor(clip.durationSeconds * fps));
        logger.debug("Code clip asset prepared (no download needed)", {
          sceneNumber: clip.sceneNumber,
          durationFrames,
        });
        return {
          ...clip,
          sourceType: "code" as const,
          durationFrames,
          durationSeconds: durationFrames / fps,
        };
      }

      if (isMockClipUrl(clip.clipUrl)) {
        const durationFrames = Math.max(1, Math.floor(clip.durationSeconds * fps));
        logger.debug("Synthetic mock clip asset prepared", {
          sceneNumber: clip.sceneNumber,
          durationFrames,
        });

        return { ...clip, durationFrames, durationSeconds: durationFrames / fps };
      }

      const clipPath = path.join(cacheDir, `scene-${clip.sceneNumber}-${clip.clipIndex}.mp4`);
      const clipBuffer = await loadCachedClip(clipPath, clip.clipUrl);
      logger.debug("Clip loaded", { sceneNumber: clip.sceneNumber, sizeBytes: clipBuffer.length });
      const durationFrames = await probeClipDurationFrames(clipBuffer, fps);
      logger.debug("Clip probed", { sceneNumber: clip.sceneNumber, durationFrames, durationSeconds: durationFrames / fps });

      return { ...clip, durationFrames, durationSeconds: durationFrames / fps };
    }),
  );
}
