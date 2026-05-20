import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalCheckpointStore } from "@/infrastructure/persistence/LocalCheckpointStore";
import type { PipelineCheckpoint } from "@/interfaces/IPipelineCheckpoint";

describe("LocalCheckpointStore", () => {
  let tmpDir: string;
  let store: LocalCheckpointStore;

  const checkpoint: PipelineCheckpoint = {
    jobId: "test-job-123",
    completedStep: 5,
    prContext: {
      repoFullName: "owner/repo",
      prNumber: 42,
      prTitle: "Test PR",
      prDescription: "",
      diffSource: { kind: "github_pr" as const, repoFullName: "owner/repo", prNumber: 42, installationId: 1 },
      baseBranch: "main",
      headBranch: "feature",
      headSha: "",
      issues: [],
      milestone: null,
      isPrivate: false,
      durationMode: "default" as const,
    deepdive: false,
    },
    script: {
      changeType: "feature",
      summary: "Test",
      headline: "",
      scenes: [],
      totalDurationSeconds: 60,
      totalWordCount: 150,
      keyFiles: [],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
    },
    clips: [{ sceneNumber: 1, clipIndex: 0, clipUrl: "https://example.com/clip.mp4", durationSeconds: 8 }],
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
    process.env.LOCAL_STORAGE_DIR = tmpDir;
    store = new LocalCheckpointStore();
  });

  afterEach(async () => {
    delete process.env.LOCAL_STORAGE_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a checkpoint", async () => {
    await store.save(checkpoint);
    const loaded = await store.load("test-job-123");

    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error("Expected checkpoint to be loaded");
    expect(loaded.jobId).toBe("test-job-123");
    expect(loaded.completedStep).toBe(5);
    expect(loaded.clips).toHaveLength(1);
  });

  it("returns null for non-existent checkpoint", async () => {
    const loaded = await store.load("non-existent");
    expect(loaded).toBeNull();
  });

  it("deletes a checkpoint", async () => {
    await store.save(checkpoint);
    await store.delete("test-job-123");
    const loaded = await store.load("test-job-123");
    expect(loaded).toBeNull();
  });

  it("delete is idempotent for non-existent checkpoints", async () => {
    await expect(store.delete("non-existent")).resolves.toBeUndefined();
  });

  it("overwrites existing checkpoint on save", async () => {
    await store.save(checkpoint);
    await store.save({ ...checkpoint, completedStep: 2 });

    const loaded = await store.load("test-job-123");
    if (!loaded) throw new Error("Expected checkpoint to be loaded");
    expect(loaded.completedStep).toBe(2);
  });
});
