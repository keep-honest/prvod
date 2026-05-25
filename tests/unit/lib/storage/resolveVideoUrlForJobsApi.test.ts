import { describe, expect, it, vi } from "vitest";
import { resolveVideoUrlForJobsApi } from "@/lib/storage/resolveVideoUrlForJobsApi";
import type { IStorageService } from "@/interfaces/IStorageService";

function buildLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildStorage(getSignedUrl?: IStorageService["getSignedUrl"]): IStorageService {
  return {
    upload: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: getSignedUrl ?? vi.fn().mockResolvedValue("/api/local-storage/videos/x.mp4?exp=1&sig=ab"),
  };
}

describe("resolveVideoUrlForJobsApi", () => {
  const COMMON = {
    expirySeconds: 60,
    jobId: "job-1",
  };

  it("re-signs via objectKey when status=completed and objectKey is present", async () => {
    const sign = vi.fn().mockResolvedValue("/api/local-storage/videos/fresh.mp4?exp=1&sig=ab");
    const logger = buildLogger();
    const result = await resolveVideoUrlForJobsApi({
      ...COMMON,
      storageService: buildStorage(sign),
      jobStatus: "completed",
      objectKey: "videos/fresh.mp4",
      storedVideoUrl: "https://stale.example/x.mp4",
      logger,
    });
    expect(sign).toHaveBeenCalledWith("videos/fresh.mp4", 60);
    expect(result).toEqual({ kind: "ok", videoUrl: "/api/local-storage/videos/fresh.mp4?exp=1&sig=ab" });
  });

  it("returns 503 SIGNING_UNAVAILABLE when re-sign fails AND no usable fallback", async () => {
    // The core regression-prevention test: without this branch, the
    // client cannot tell a transient backend problem from a missing asset.
    const signErr = new Error("R2 503");
    const logger = buildLogger();
    const result = await resolveVideoUrlForJobsApi({
      ...COMMON,
      storageService: buildStorage(vi.fn().mockRejectedValue(signErr)),
      jobStatus: "completed",
      objectKey: "videos/x.mp4",
      storedVideoUrl: "file:///abs/legacy.mp4", // legacy → normalize returns null
      logger,
    });
    expect(result).toEqual({ kind: "signing-unavailable", reason: "R2 503" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Signed URL refresh failed and no fallback available"),
      expect.objectContaining({ jobId: "job-1", error: "R2 503" }),
    );
  });

  it("falls back to stored URL on signing failure when fallback is usable; warns", async () => {
    const logger = buildLogger();
    const result = await resolveVideoUrlForJobsApi({
      ...COMMON,
      storageService: buildStorage(vi.fn().mockRejectedValue(new Error("transient"))),
      jobStatus: "completed",
      objectKey: "videos/x.mp4",
      storedVideoUrl: "https://stored.example/x.mp4",
      logger,
    });
    expect(result).toEqual({ kind: "ok", videoUrl: "https://stored.example/x.mp4" });
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns normalized stored URL when status is not completed (skip re-sign)", async () => {
    const sign = vi.fn();
    const logger = buildLogger();
    const result = await resolveVideoUrlForJobsApi({
      ...COMMON,
      storageService: buildStorage(sign),
      jobStatus: "running",
      objectKey: "videos/x.mp4",
      storedVideoUrl: "https://stored.example/x.mp4",
      logger,
    });
    expect(sign).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "ok", videoUrl: "https://stored.example/x.mp4" });
  });

  it("returns normalized stored URL when objectKey is null (skip re-sign)", async () => {
    const sign = vi.fn();
    const logger = buildLogger();
    const result = await resolveVideoUrlForJobsApi({
      ...COMMON,
      storageService: buildStorage(sign),
      jobStatus: "completed",
      objectKey: null,
      storedVideoUrl: "https://stored.example/x.mp4",
      logger,
    });
    expect(sign).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "ok", videoUrl: "https://stored.example/x.mp4" });
  });

  it("returns videoUrl: null (not 503) when legacy file:// stored URL AND no objectKey", async () => {
    // Distinguish from the 503 case — this is "asset legitimately not
    // playable" (legacy row with no recoverable path), not a transient
    // backend problem.
    const logger = buildLogger();
    const result = await resolveVideoUrlForJobsApi({
      ...COMMON,
      storageService: buildStorage(),
      jobStatus: "completed",
      objectKey: null,
      storedVideoUrl: "file:///abs/legacy.mp4",
      logger,
    });
    expect(result).toEqual({ kind: "ok", videoUrl: null });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
