import { beforeEach, describe, expect, it } from "vitest";
import { MockJobRepository } from "@/mocks/MockJobRepository";

describe("MockJobRepository", () => {
  beforeEach(() => {
    new MockJobRepository({ sharedStore: true }).reset();
  });

  it("uses isolated store by default", async () => {
    const repoA = new MockJobRepository();
    const repoB = new MockJobRepository();

    const jobA = await repoA.create({ repoFullName: "owner/repo", prNumber: 1 });
    const jobB = await repoB.create({ repoFullName: "owner/repo", prNumber: 1 });

    expect(jobA.id).not.toBe(jobB.id);
    expect(await repoA.findById(jobB.id)).toBeNull();
    expect(await repoB.findById(jobA.id)).toBeNull();
  });

  it("shares state when configured with sharedStore=true", async () => {
    const repoA = new MockJobRepository({ sharedStore: true });
    const repoB = new MockJobRepository({ sharedStore: true });

    const job = await repoA.create({ repoFullName: "owner/repo", prNumber: 1 });
    const found = await repoB.findById(job.id);

    expect(found?.id).toBe(job.id);
    await expect(
      repoB.create({ repoFullName: "owner/repo", prNumber: 1 }),
    ).rejects.toThrow("Duplicate active job for this PR");
  });

  it("findActiveByPR returns active processing jobs regardless of age", async () => {
    const repo = new MockJobRepository();
    const job = await repo.create({ repoFullName: "owner/repo", prNumber: 1 });
    await repo.updateStatus(job.id, "processing");

    // Backdate updatedAt — staleness is handled by failStaleProcessingJobs, not findActiveByPR
    job.updatedAt = new Date(Date.now() - 31 * 60_000);

    const found = await repo.findActiveByPR("owner/repo", 1, null);
    expect(found?.id).toBe(job.id);
  });

  it("findActiveByPR returns null for completed jobs", async () => {
    const repo = new MockJobRepository();
    const job = await repo.create({ repoFullName: "owner/repo", prNumber: 1 });
    await repo.updateStatus(job.id, "completed");

    const found = await repo.findActiveByPR("owner/repo", 1, null);
    expect(found).toBeNull();
  });

  it("failStaleProcessingJobs with threshold=0 fails all active jobs", async () => {
    const repo = new MockJobRepository();
    const processing = await repo.create({ repoFullName: "owner/repo", prNumber: 1 });
    await repo.updateStatus(processing.id, "processing");
    const queued = await repo.create({ repoFullName: "owner/repo", prNumber: 2 });
    const completed = await repo.create({ repoFullName: "owner/repo", prNumber: 3 });
    await repo.updateStatus(completed.id, "processing");
    await repo.updateStatus(completed.id, "completed");

    const reaped = await repo.failStaleProcessingJobs(0);
    expect(reaped).toBe(2); // processing + queued

    const p = await repo.findById(processing.id);
    expect(p?.status).toBe("failed");
    expect(p?.errorCode).toBe("STALE_PROCESSING");

    const q = await repo.findById(queued.id);
    expect(q?.status).toBe("failed");

    const c = await repo.findById(completed.id);
    expect(c?.status).toBe("completed"); // untouched
  });

  it("failStaleProcessingJobs respects threshold", async () => {
    const repo = new MockJobRepository();
    const stale = await repo.create({ repoFullName: "owner/repo", prNumber: 1 });
    await repo.updateStatus(stale.id, "processing");
    stale.updatedAt = new Date(Date.now() - 20 * 60_000); // 20 min ago

    const fresh = await repo.create({ repoFullName: "owner/repo", prNumber: 2 });
    await repo.updateStatus(fresh.id, "processing");

    const reaped = await repo.failStaleProcessingJobs(10); // 10 min threshold
    expect(reaped).toBe(1); // only stale

    expect((await repo.findById(stale.id))?.status).toBe("failed");
    expect((await repo.findById(fresh.id))?.status).toBe("processing");
  });

  it("updateStatus allows failed → processing retry transitions unconditionally", async () => {
    const repo = new MockJobRepository();
    const job = await repo.create({ repoFullName: "owner/repo", prNumber: 1 });
    await repo.updateStatus(job.id, "failed", { errorCode: "STAGE_X_ERROR" });

    // Retry path explicitly transitions failed → processing.
    const retried = await repo.updateStatus(job.id, "processing", { currentStage: "analyzing" });
    expect(retried.status).toBe("processing");
    expect(retried.currentStage).toBe("analyzing");
  });

  it("updateProcessingStage skips terminal rows (no row reset on stage-update race)", async () => {
    const repo = new MockJobRepository();
    const job = await repo.create({ repoFullName: "owner/repo", prNumber: 1 });
    await repo.updateStatus(job.id, "processing");
    await repo.updateStatus(job.id, "completed");

    // Late-arriving fire-and-forget stage update must not reset status.
    const result = await repo.updateProcessingStage(job.id, "uploading");
    expect(result).toBeNull();

    const final = await repo.findById(job.id);
    expect(final?.status).toBe("completed");
  });

  it("updateProcessingStage updates currentStage on non-terminal rows", async () => {
    const repo = new MockJobRepository();
    const job = await repo.create({ repoFullName: "owner/repo", prNumber: 1 });
    await repo.updateStatus(job.id, "processing");

    const updated = await repo.updateProcessingStage(job.id, "scripting");
    expect(updated?.currentStage).toBe("scripting");
    expect(updated?.status).toBe("processing");
  });
});
