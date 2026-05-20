import { z } from "zod";

export const jobStatusEnum = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusEnum>;

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ["processing", "failed", "cancelled"],
  processing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["processing"],
  cancelled: [],
};

export type TriggeredVia = "github_app_webhook" | "github_action" | "api";

export interface VideoJob {
  id: string;
  repoFullName: string;
  prNumber: number;
  status: JobStatus;
  videoUrl: string | null;
  objectKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  scriptJson: unknown;
  ttsAudioJson: unknown;
  durationMs: number | null;
  metricsJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  // Tenant fields — null for API-triggered jobs
  installationRef: string | null;
  githubInstallationId: number | null;
  githubRepositoryId: number | null;
  triggeredVia: TriggeredVia;
  triggeredBy: string | null;
  deliveryId: string | null;
  apiKeyId: string | null;
  /** Whether the "Generating..." PR comment was posted (prevents duplicates on webhook redelivery) */
  statusCommentPosted: boolean;
  /** True for @prvod script requests — excluded from the daily video rate limit */
  scriptOnly: boolean;
  /** Whether the source repository is private (drives review page access control) */
  repoIsPrivate: boolean;
  /** Current pipeline stage for in-progress jobs (null when queued, completed, or failed) */
  currentStage: string | null;
}

export type NewVideoJob = Pick<VideoJob, "repoFullName" | "prNumber"> & {
  triggeredVia?: TriggeredVia;     // defaults to "api"
  installationRef?: string | null;
  githubInstallationId?: number | null;
  githubRepositoryId?: number | null;
  triggeredBy?: string | null;
  deliveryId?: string | null;
  metricsJson?: Record<string, unknown> | null;
  apiKeyId?: string | null;
  scriptOnly?: boolean;
  repoIsPrivate?: boolean;
};

export function transitionStatus(current: JobStatus, next: JobStatus): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid status transition: ${current} → ${next}`);
  }
}

export function validateJobState(job: VideoJob): void {
  if (job.status === "completed" && !job.videoUrl && !job.scriptJson && !job.ttsAudioJson) {
    throw new Error("Completed job must have a videoUrl, scriptJson, or ttsAudioJson");
  }
  if (job.status === "failed" && !job.errorMessage) {
    throw new Error("Failed job must have an errorMessage");
  }
}
