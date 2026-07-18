import type { VideoJob } from "@/domain/entities/VideoJob";
import { parseReviewGraphSource } from "@/domain/entities/ReviewGraph";
import type {
  ReviewDiffFile,
  ReviewDiffSnapshot,
  ReviewPin,
  SceneDiffAnchor,
} from "@/domain/entities/ReviewDiffSnapshot";
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

  /**
   * Build a ReviewPageModel from a completed job, its script, and the actual scene timeline.
   *
   * The `sceneTimeline` parameter provides probed per-scene durations (in milliseconds).
   * This is the **only** source of timing truth — the assembler never reads
   * `scene.durationSeconds` from the script to avoid integer-rounding drift.
   */
  async build(
    job: VideoJob,
    script: VideoScript,
    sceneTimeline: ReadonlyArray<SceneTimelineInput>,
    options?: {
      snapshotStatus?: "current" | "outdated";
      canSyncDrafts?: boolean;
      reviewerKey?: string | null;
    },
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
    const diffSnapshot = this.readDiffSnapshot(metricsData);
    const diffFileMap = new Map(diffSnapshot.files.map((f) => [f.filePath, f]));
    const sceneAnchors = this.readSceneAnchors(metricsData);
    const pins = this.readPins(metricsData);
    const anchorIdsByScene = new Map<number, string[]>();
    for (const anchor of sceneAnchors) {
      const existing = anchorIdsByScene.get(anchor.sceneNumber) ?? [];
      existing.push(anchor.anchorId);
      anchorIdsByScene.set(anchor.sceneNumber, existing);
    }

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
        anchorIds: anchorIdsByScene.get(scene.sceneNumber) ?? [],
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
          changeSummary: this.buildFileChangeSummary(diffFileMap, filePath),
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

    // Compute the interactive UML constellation graph for the review page.
    // Best-effort: any failure in the regex-based UML analyzer should not
    // block the review page from rendering the rest of the model.
    const reviewGraph = buildReviewGraphData(script, job.id, reviewGraphSource);

    return {
      jobId: job.id,
      repoFullName: job.repoFullName,
      prNumber: job.prNumber,
      durationMode,
      headline: script.headline ?? script.summary,
      visibility,
      accessPolicy: visibility === "private" ? "github_authenticated" : "open",
      autoplayMode: "auto_if_permitted",
      videoUrl,
      durationSeconds: totalDurationMs / 1000,
      snapshotStatus: options?.snapshotStatus ?? "current",
      reviewedHeadSha: diffSnapshot.headSha,
      diffSnapshot,
      sceneAnchors,
      pins,
      canSyncDrafts: options?.canSyncDrafts ?? false,
      reviewerKey: options?.reviewerKey ?? null,
      files: orderedFilePaths
        .map((filePath) => fileMap.get(filePath))
        .filter((entry): entry is ReviewFileEntry => Boolean(entry)),
      scenes,
      ...(reviewGraph ? { reviewGraph } : {}),
    };
  }

  private readDiffSnapshot(metricsData: Record<string, unknown> | null): ReviewDiffSnapshot {
    const raw = metricsData?.reviewDiffSnapshot;
    if (
      raw !== null &&
      typeof raw === "object" &&
      typeof (raw as Record<string, unknown>).headSha === "string" &&
      Array.isArray((raw as Record<string, unknown>).files)
    ) {
      return raw as ReviewDiffSnapshot;
    }

    return {
      headSha: "",
      headRepoFullName: "",
      capturedAt: new Date(0).toISOString(),
      totalFiles: 0,
      totalRenderableLines: 0,
      files: [],
    };
  }

  private readSceneAnchors(metricsData: Record<string, unknown> | null): SceneDiffAnchor[] {
    const raw = metricsData?.sceneDiffAnchors;
    return Array.isArray(raw) ? raw as SceneDiffAnchor[] : [];
  }

  private readPins(metricsData: Record<string, unknown> | null): ReviewPin[] {
    const raw = metricsData?.reviewPins;
    return Array.isArray(raw) ? raw as ReviewPin[] : [];
  }

  private buildFileChangeSummary(
    diffFileMap: Map<string, ReviewDiffFile>,
    filePath: string,
  ): string | undefined {
    const diffFile = diffFileMap.get(filePath);
    if (!diffFile) {
      return undefined;
    }

    let added = 0;
    let removed = 0;
    for (const hunk of diffFile.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") added++;
        else if (line.kind === "removed") removed++;
      }
    }

    return `${diffFile.changeType} / +${added}/-${removed}`;
  }
}
