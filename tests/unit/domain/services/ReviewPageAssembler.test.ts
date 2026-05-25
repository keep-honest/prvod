import { describe, expect, it, vi } from "vitest";
import { ReviewPageAssembler } from "@/domain/services/ReviewPageAssembler";
import type { VideoJob } from "@/domain/entities/VideoJob";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { IStorageService } from "@/interfaces/IStorageService";

function buildStorage(getSignedUrl?: IStorageService["getSignedUrl"]): IStorageService {
  return {
    upload: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: getSignedUrl ?? vi.fn().mockResolvedValue("https://signed.example/x.mp4"),
  };
}

function buildJob(overrides: Partial<VideoJob>): VideoJob {
  return {
    id: "job-1",
    repoFullName: "acme/widgets",
    prNumber: 1,
    status: "completed",
    videoUrl: null,
    objectKey: null,
    errorCode: null,
    errorMessage: null,
    scriptJson: null,
    ttsAudioJson: null,
    durationMs: null,
    metricsJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    installationRef: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    triggeredVia: "api",
    triggeredBy: null,
    deliveryId: null,
    apiKeyId: null,
    statusCommentPosted: false,
    scriptOnly: false,
    repoIsPrivate: false,
    currentStage: null,
    ...overrides,
  };
}

function buildScript(): VideoScript {
  return {
    changeType: "feature",
    summary: "test",
    headline: "test",
    scenes: [
      {
        sceneNumber: 1,
        sceneType: "overview",
        narration: "Hello.",
        durationSeconds: 5,
        codeBroll: [],
      },
    ],
    keyFiles: [],
    tags: [],
    totalDurationSeconds: 5,
    totalWordCount: 1,
  } as unknown as VideoScript;
}

describe("ReviewPageAssembler videoUrl fallback", () => {
  it("re-signs via objectKey when present (ignores stored videoUrl)", async () => {
    const sign = vi.fn().mockResolvedValue("/api/local-storage/videos/x.mp4?exp=1&sig=ab");
    const assembler = new ReviewPageAssembler(buildStorage(sign));
    const job = buildJob({
      objectKey: "videos/x.mp4",
      videoUrl: "https://stale.example/x.mp4",
    });
    const result = await assembler.build(job, buildScript(), [{ sceneNumber: 1, durationMs: 5000 }]);
    expect(sign).toHaveBeenCalledWith("videos/x.mp4", expect.any(Number));
    expect(result.videoUrl).toBe("/api/local-storage/videos/x.mp4?exp=1&sig=ab");
  });

  it("falls back to stored videoUrl when objectKey is absent", async () => {
    const assembler = new ReviewPageAssembler(buildStorage());
    const job = buildJob({
      objectKey: null,
      videoUrl: "https://stored.example/x.mp4",
    });
    const result = await assembler.build(job, buildScript(), [{ sceneNumber: 1, durationMs: 5000 }]);
    expect(result.videoUrl).toBe("https://stored.example/x.mp4");
  });

  it("throws when stored URL is legacy file:// and no objectKey (normalize returns null)", async () => {
    const assembler = new ReviewPageAssembler(buildStorage());
    const job = buildJob({
      objectKey: null,
      videoUrl: "file:///abs/path/video.mp4",
    });
    await expect(
      assembler.build(job, buildScript(), [{ sceneNumber: 1, durationMs: 5000 }]),
    ).rejects.toThrow(/Failed to resolve video URL/);
  });

  it("throws when both objectKey and videoUrl are missing", async () => {
    const assembler = new ReviewPageAssembler(buildStorage());
    const job = buildJob({ objectKey: null, videoUrl: null });
    await expect(
      assembler.build(job, buildScript(), [{ sceneNumber: 1, durationMs: 5000 }]),
    ).rejects.toThrow(/playable walkthrough asset/);
  });

  it("propagates storage signing errors (no fallback to stored URL — page returns 500)", async () => {
    // Pin the asymmetry vs the watch page: the assembler does NOT swallow
    // signing failures into a fallback. A future change to "make it
    // consistent with the watch page" would be intentional, not accidental.
    const signErr = new Error("R2 503");
    const assembler = new ReviewPageAssembler(
      buildStorage(vi.fn().mockRejectedValue(signErr)),
    );
    const job = buildJob({
      objectKey: "videos/x.mp4",
      videoUrl: "https://stale.example/x.mp4",
    });
    await expect(
      assembler.build(job, buildScript(), [{ sceneNumber: 1, durationMs: 5000 }]),
    ).rejects.toBe(signErr);
  });
});
