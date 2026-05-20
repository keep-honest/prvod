import { describe, it, expect } from "vitest";
import {
  transitionStatus,
  validateJobState,
  type VideoJob,
} from "@/domain/entities/VideoJob";

function makeJob(overrides: Partial<VideoJob> = {}): VideoJob {
  return {
    id: "test-id",
    repoFullName: "owner/repo",
    prNumber: 1,
    status: "queued",
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

describe("VideoJob state machine", () => {
  describe("transitionStatus", () => {
    it("allows queued → processing", () => {
      expect(() => transitionStatus("queued", "processing")).not.toThrow();
    });

    it("allows queued → cancelled", () => {
      expect(() => transitionStatus("queued", "cancelled")).not.toThrow();
    });

    it("allows queued → failed", () => {
      expect(() => transitionStatus("queued", "failed")).not.toThrow();
    });

    it("allows processing → completed", () => {
      expect(() => transitionStatus("processing", "completed")).not.toThrow();
    });

    it("allows processing → failed", () => {
      expect(() => transitionStatus("processing", "failed")).not.toThrow();
    });

    it("allows processing → cancelled", () => {
      expect(() => transitionStatus("processing", "cancelled")).not.toThrow();
    });

    it("rejects queued → completed", () => {
      expect(() => transitionStatus("queued", "completed")).toThrow(
        "Invalid status transition: queued → completed",
      );
    });

    it("rejects completed → processing", () => {
      expect(() => transitionStatus("completed", "processing")).toThrow(
        "Invalid status transition",
      );
    });

    it("allows failed → processing (retry)", () => {
      expect(() => transitionStatus("failed", "processing")).not.toThrow();
    });

    it("rejects cancelled → processing", () => {
      expect(() => transitionStatus("cancelled", "processing")).toThrow(
        "Invalid status transition",
      );
    });
  });

  describe("validateJobState", () => {
    it("passes for completed job with videoUrl", () => {
      const job = makeJob({
        status: "completed",
        videoUrl: "https://example.com/video.mp4",
      });
      expect(() => validateJobState(job)).not.toThrow();
    });

    it("passes for completed script-only job with scriptJson but no videoUrl", () => {
      const job = makeJob({
        status: "completed",
        videoUrl: null,
        scriptJson: { scenes: [] },
      });
      expect(() => validateJobState(job)).not.toThrow();
    });

    it("passes for completed tts-only job with ttsAudioJson", () => {
      const job = makeJob({
        status: "completed",
        videoUrl: null,
        scriptJson: null,
        ttsAudioJson: [{ sceneNumber: 1 }],
      });
      expect(() => validateJobState(job)).not.toThrow();
    });

    it("fails for completed job with no videoUrl, scriptJson, or ttsAudioJson", () => {
      const job = makeJob({
        status: "completed",
        videoUrl: null,
        scriptJson: null,
        ttsAudioJson: null,
      });
      expect(() => validateJobState(job)).toThrow(
        "Completed job must have a videoUrl, scriptJson, or ttsAudioJson",
      );
    });

    it("passes for failed job with errorMessage", () => {
      const job = makeJob({
        status: "failed",
        errorMessage: "Something went wrong",
      });
      expect(() => validateJobState(job)).not.toThrow();
    });

    it("fails for failed job without errorMessage", () => {
      const job = makeJob({ status: "failed", errorMessage: null });
      expect(() => validateJobState(job)).toThrow(
        "Failed job must have an errorMessage",
      );
    });

    it("passes for queued job without videoUrl", () => {
      const job = makeJob({ status: "queued" });
      expect(() => validateJobState(job)).not.toThrow();
    });
  });
});
