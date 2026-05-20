import type { VideoJob } from "@/domain/entities/VideoJob";

/** Canonical shape returned by POST /api/jobs for both new and idempotent responses. */
export interface JobResponseBody {
  id: string;
  repoFullName: string;
  prNumber: number;
  status: string;
  videoUrl: string | null;
  scriptJson: unknown;
  ttsAudioJson: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Serialise a VideoJob into the standard JSON response shape. */
export function serializeJobResponse(job: VideoJob): JobResponseBody {
  return {
    id: job.id,
    repoFullName: job.repoFullName,
    prNumber: job.prNumber,
    status: job.status,
    videoUrl: job.videoUrl ?? null,
    scriptJson: job.scriptJson ?? null,
    ttsAudioJson: job.ttsAudioJson ?? null,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}
