import type { VideoJob } from "@/domain/entities/VideoJob";
import { parseReviewGraphSource } from "@/domain/entities/ReviewGraph";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type {
  ReviewFileEntry,
  ReviewPageModel,
  ReviewScene,
  ReviewVisibility,
} from "@/domain/entities/ReviewPage";
import type { IStorageService } from "@/interfaces/IStorageService";
import { buildReviewGraphData } from "@/infrastructure/video/graph/buildReviewGraphData";
import { normalizeStoredVideoUrl } from "@/lib/storage/normalizeStoredVideoUrl";

const SIGNED_URL_TTL_SECONDS = 4 * 3600; // 4 hours

/** Per-scene timing entry passed to the assembler. Timing comes from probed video data. */
export interface SceneTimelineInput {
  sceneNumber: number;
  durationMs: number;
}

function inferLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    default:
      return ext ?? "text";
  }
}

export class ReviewPageAssembler {
  constructor(private readonly storageService: IStorageService) {}

  async build(
    job: VideoJob,
    script: VideoScript,
    sceneTimeline: ReadonlyArray<SceneTimelineInput>,
  ): Promise<ReviewPageModel> {
    if (!job.videoUrl && !job.objectKey) {
      throw new Error("Review page requires a playable walkthrough asset");
    }

    const visibility: ReviewVisibility = job.repoIsPrivate ? "private" : "public";
    // Prefer re-signing from objectKey so legacy `file://` rows heal at
    // read time. Only fall back to the stored value when objectKey is
    // missing — and even then strip unplayable `file://` URLs.
    const videoUrl = job.objectKey
      ? await this.storageService.getSignedUrl(job.objectKey, SIGNED_URL_TTL_SECONDS)
      : normalizeStoredVideoUrl(job.videoUrl);

    if (!videoUrl) {
      throw new Error("Failed to resolve video URL for review page");
    }

    const timelineMap = new Map(sceneTimeline.map(e => [e.sceneNumber, e.durationMs]));
    const metricsData = job.metricsJson as Record<string, unknown> | null;

    let startTimeMs = 0;
    const scenes: ReviewScene[] = script.scenes.map((scene) => {
      const durationMs = timelineMap.get(scene.sceneNumber) ?? 0;
      const endTimeMs = startTimeMs + durationMs;
      const primaryBroll = scene.codeBroll[0];
      const built: ReviewScene = {
        sceneNumber: scene.sceneNumber,
        sceneType: scene.sceneType,
        startTimeMs,
        endTimeMs,
        narration: scene.narration,
        filePaths: scene.codeBroll.map((cb) => cb.filePath).filter(Boolean),
        replayable: scene.codeBroll.length > 0,
        codeExcerpt: primaryBroll
          ? {
              filePath: primaryBroll.filePath,
              code: primaryBroll.code,
              language: primaryBroll.language || inferLanguage(primaryBroll.filePath),
              lineRange: primaryBroll.lineRange,
              highlights: primaryBroll.highlights,
            }
          : null,
      };
      startTimeMs = endTimeMs;
      return built;
    });

    const totalDurationMs = sceneTimeline.reduce((sum, e) => sum + e.durationMs, 0);

    const fileMap = new Map<string, ReviewFileEntry>();
    for (const scene of scenes) {
      for (const filePath of scene.filePaths) {
        const existing = fileMap.get(filePath);
        if (existing) {
          if (!existing.sceneNumbers.includes(scene.sceneNumber)) {
            existing.sceneNumbers.push(scene.sceneNumber);
          }
          continue;
        }
        fileMap.set(filePath, {
          filePath,
          sceneNumbers: [scene.sceneNumber],
          primarySceneNumber: scene.sceneNumber,
        });
      }
    }

    const orderedFilePaths = Array.from(
      new Set([
        ...script.keyFiles.filter((filePath) => fileMap.has(filePath)),
        ...fileMap.keys(),
      ]),
    );

    const durationMode = (metricsData?.durationMode as string) ?? "default";
    const reviewGraphSource = parseReviewGraphSource(metricsData?.reviewGraphSource);

    const reviewGraph = buildReviewGraphData(script, job.id, reviewGraphSource);

    return {
      jobId: job.id,
      repoFullName: job.repoFullName,
      prNumber: job.prNumber,
      durationMode,
      headline: script.headline ?? script.summary,
      visibility,
      autoplayMode: "auto_if_permitted",
      videoUrl,
      durationSeconds: totalDurationMs / 1000,
      files: orderedFilePaths
        .map((filePath) => fileMap.get(filePath))
        .filter((entry): entry is ReviewFileEntry => Boolean(entry)),
      scenes,
      ...(reviewGraph ? { reviewGraph } : {}),
    };
  }
}
