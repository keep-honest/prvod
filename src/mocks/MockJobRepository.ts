import type { IJobRepository } from "@/interfaces/IJobRepository";
import type {
  VideoJob,
  NewVideoJob,
  JobStatus,
} from "@/domain/entities/VideoJob";
import { randomUUID } from "crypto";

interface MockJobStore {
  jobs: VideoJob[];
}

type GlobalWithMockStore = typeof globalThis & {
  __pr2vidMockJobStore?: MockJobStore;
};

function getGlobalMockStore(): MockJobStore {
  const g = globalThis as GlobalWithMockStore;
  if (!g.__pr2vidMockJobStore) {
    g.__pr2vidMockJobStore = { jobs: [] };
  }
  return g.__pr2vidMockJobStore;
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["completed", "failed", "cancelled"]);

interface MockJobRepositoryOptions {
  sharedStore?: boolean;
}

export class MockJobRepository implements IJobRepository {
  private readonly store: MockJobStore;

  constructor(options: MockJobRepositoryOptions = {}) {
    const sharedStore =
      options.sharedStore ?? process.env.USE_MOCK_SERVICES === "true";
    this.store = sharedStore ? getGlobalMockStore() : { jobs: [] };
  }

  async create(input: NewVideoJob): Promise<VideoJob> {
    // Enforce partial unique constraint: one active job per (installation, repo, PR)
    const existing = this.store.jobs.find(
      (j) =>
        j.repoFullName === input.repoFullName &&
        j.prNumber === input.prNumber &&
        j.installationRef === (input.installationRef ?? null) &&
        (j.status === "queued" || j.status === "processing"),
    );
    if (existing) {
      throw Object.assign(new Error("Duplicate active job for this PR"), { code: "23505" });
    }

    const now = new Date();
    const job: VideoJob = {
      id: randomUUID(),
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      status: "queued",
      videoUrl: null,
      objectKey: null,
      errorCode: null,
      errorMessage: null,
      scriptJson: null,
      ttsAudioJson: null,
      durationMs: null,
      metricsJson: input.metricsJson ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      installationRef: input.installationRef ?? null,
      githubInstallationId: input.githubInstallationId ?? null,
      githubRepositoryId: input.githubRepositoryId ?? null,
      triggeredVia: input.triggeredVia ?? "api",
      triggeredBy: input.triggeredBy ?? null,
      deliveryId: input.deliveryId ?? null,
      apiKeyId: input.apiKeyId ?? null,
      statusCommentPosted: false,
      scriptOnly: input.scriptOnly ?? false,
      repoIsPrivate: input.repoIsPrivate ?? false,
      currentStage: null,
    };
    this.store.jobs.push(job);
    return job;
  }

  async findById(id: string): Promise<VideoJob | null> {
    return this.store.jobs.find((j) => j.id === id) ?? null;
  }

  async findActiveByPR(
    repoFullName: string,
    prNumber: number,
    installationRef?: string | null,
  ): Promise<VideoJob | null> {
    return (
      this.store.jobs.find(
        (j) =>
          j.repoFullName === repoFullName &&
          j.prNumber === prNumber &&
          (installationRef === undefined || j.installationRef === installationRef) &&
          (j.status === "queued" || j.status === "processing"),
      ) ?? null
    );
  }

  async findAnyByPR(
    repoFullName: string,
    prNumber: number,
    installationRef?: string | null,
  ): Promise<VideoJob | null> {
    // Return last inserted (most recent) matching job regardless of status
    const matches = this.store.jobs.filter(
      (j) =>
        j.repoFullName === repoFullName &&
        j.prNumber === prNumber &&
        (installationRef === undefined || j.installationRef === installationRef),
    );
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  async updateStatus(
    id: string,
    status: JobStatus,
    fields?: Partial<VideoJob>,
  ): Promise<VideoJob> {
    const job = this.store.jobs.find((j) => j.id === id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    job.status = status;
    job.updatedAt = new Date();
    if (fields) {
      Object.assign(job, fields);
    }
    if (TERMINAL_STATUSES.has(status)) {
      job.completedAt = new Date();
    }
    return job;
  }

  async updateProcessingStage(id: string, stage: string): Promise<VideoJob | null> {
    const job = this.store.jobs.find((j) => j.id === id);
    if (!job) return null;
    if (TERMINAL_STATUSES.has(job.status)) return null;
    job.currentStage = stage;
    job.updatedAt = new Date();
    return job;
  }

  async countRecentByRepo(
    repoFullName: string,
    since: Date,
    installationRef?: string | null,
    excludeScriptOnly?: boolean,
  ): Promise<number> {
    return this.store.jobs.filter(
      (j) =>
        j.repoFullName === repoFullName &&
        j.createdAt >= since &&
        (installationRef === undefined || j.installationRef === installationRef) &&
        (!excludeScriptOnly || !j.scriptOnly),
    ).length;
  }

  async failStaleProcessingJobs(thresholdMinutes: number): Promise<number> {
    const now = new Date();
    const cutoff = thresholdMinutes > 0
      ? new Date(now.getTime() - thresholdMinutes * 60_000)
      : null;

    let count = 0;
    for (const job of this.store.jobs) {
      if (job.status !== "queued" && job.status !== "processing") continue;
      if (cutoff && job.updatedAt >= cutoff) continue;
      job.status = "failed";
      job.errorCode = "STALE_PROCESSING";
      job.errorMessage = "Server restarted while job was processing";
      job.completedAt = now;
      job.updatedAt = now;
      count++;
    }
    return count;
  }

  async deleteById(id: string): Promise<boolean> {
    const idx = this.store.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    this.store.jobs.splice(idx, 1);
    return true;
  }

  /** Test helper: reset all jobs */
  reset(): void {
    this.store.jobs = [];
  }
}
