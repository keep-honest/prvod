import { describe, expect, it, vi } from "vitest";
import { resolveVideoUrlForWatch } from "@/lib/storage/resolveVideoUrlForWatch";
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
    getSignedUrl: getSignedUrl ?? vi.fn().mockResolvedValue("https://signed/fresh.mp4"),
  };
}

describe("resolveVideoUrlForWatch", () => {
  it("re-signs via objectKey when present (ignores stored URL)", async () => {
    const sign = vi.fn().mockResolvedValue("/api/local-storage/videos/x.mp4?exp=1&sig=ab");
    const logger = buildLogger();
    const result = await resolveVideoUrlForWatch({
      storageService: buildStorage(sign),
      objectKey: "videos/x.mp4",
      storedVideoUrl: "https://stale.example/x.mp4",
      expirySeconds: 3600,
      jobId: "job-1",
      logger,
    });
    expect(sign).toHaveBeenCalledWith("videos/x.mp4", 3600);
    expect(result.videoUrl).toBe("/api/local-storage/videos/x.mp4?exp=1&sig=ab");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("falls back to stored URL on signing failure when fallback is usable; logs at WARN", async () => {
    const signErr = new Error("S3 503");
    const logger = buildLogger();
    const result = await resolveVideoUrlForWatch({
      storageService: buildStorage(vi.fn().mockRejectedValue(signErr)),
      objectKey: "videos/x.mp4",
      storedVideoUrl: "https://stored.example/x.mp4",
      expirySeconds: 60,
      jobId: "job-w",
      logger,
    });
    expect(result.videoUrl).toBe("https://stored.example/x.mp4");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to stored URL"),
      expect.objectContaining({ jobId: "job-w", error: "S3 503" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns null on signing failure when stored URL is legacy file://; logs at ERROR", async () => {
    // Operator must be able to distinguish "transient signing failure with
    // no recoverable fallback" from "user typed a stale URL". ERROR level
    // surfaces the former so on-call sees it correlate with backend issues.
    const signErr = new Error("R2 timeout");
    const logger = buildLogger();
    const result = await resolveVideoUrlForWatch({
      storageService: buildStorage(vi.fn().mockRejectedValue(signErr)),
      objectKey: "videos/x.mp4",
      storedVideoUrl: "file:///abs/path/x.mp4",
      expirySeconds: 60,
      jobId: "job-e",
      logger,
    });
    expect(result.videoUrl).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("re-sign failed and no fallback available"),
      expect.objectContaining({ jobId: "job-e", error: "R2 timeout" }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns null on signing failure when stored URL is also null", async () => {
    const logger = buildLogger();
    const result = await resolveVideoUrlForWatch({
      storageService: buildStorage(vi.fn().mockRejectedValue(new Error("x"))),
      objectKey: "videos/x.mp4",
      storedVideoUrl: null,
      expirySeconds: 60,
      jobId: "job-n",
      logger,
    });
    expect(result.videoUrl).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses stored URL when objectKey is absent (skip re-sign entirely)", async () => {
    const sign = vi.fn();
    const logger = buildLogger();
    const result = await resolveVideoUrlForWatch({
      storageService: buildStorage(sign),
      objectKey: null,
      storedVideoUrl: "https://stored.example/x.mp4",
      expirySeconds: 60,
      jobId: "job-s",
      logger,
    });
    expect(sign).not.toHaveBeenCalled();
    expect(result.videoUrl).toBe("https://stored.example/x.mp4");
  });

  it("strips legacy file:// stored URL when objectKey is absent (no re-sign possible)", async () => {
    const logger = buildLogger();
    const result = await resolveVideoUrlForWatch({
      storageService: buildStorage(),
      objectKey: null,
      storedVideoUrl: "file:///abs/x.mp4",
      expirySeconds: 60,
      jobId: "job-f",
      logger,
    });
    expect(result.videoUrl).toBeNull();
  });
});
