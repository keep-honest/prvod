import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/logger";
import { isValidUuid } from "@/lib/validation";
import { withJobsReadAuth } from "@/lib/apiMiddleware";

const DEFAULT_SIGNED_URL_EXPIRY_HOURS = 4;

interface StoredTtsAudioEntry {
  sceneNumber: number;
  audioKey?: string | null;
  audioUrl?: string;
  wordTimings?: unknown;
  clipDurations?: number[];
}

function resolveSignedUrlExpirySeconds(): number {
  const parsedHours = Number.parseInt(
    process.env.SIGNED_URL_EXPIRY_HOURS ?? "",
    10,
  );
  const expiryHours =
    Number.isFinite(parsedHours) && parsedHours > 0
      ? Math.min(parsedHours, 168)
      : DEFAULT_SIGNED_URL_EXPIRY_HOURS;
  return expiryHours * 3600;
}

function isStoredTtsAudioEntry(value: unknown): value is StoredTtsAudioEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "sceneNumber" in value &&
    typeof (value as { sceneNumber?: unknown }).sceneNumber === "number"
  );
}

async function refreshTtsAudioJson(
  rawTtsAudioJson: unknown,
  storageService: {
    getSignedUrl(key: string, expirySeconds: number): Promise<string>;
  },
  expirySeconds: number,
  logger: ReturnType<typeof createLogger>,
): Promise<unknown> {
  if (!Array.isArray(rawTtsAudioJson)) {
    return rawTtsAudioJson ?? null;
  }

  return Promise.all(
    rawTtsAudioJson.map(async (entry) => {
      if (!isStoredTtsAudioEntry(entry)) {
        return entry;
      }

      let audioUrl =
        typeof entry.audioUrl === "string" ? entry.audioUrl : undefined;
      if (typeof entry.audioKey === "string" && entry.audioKey.length > 0) {
        try {
          audioUrl = await storageService.getSignedUrl(
            entry.audioKey,
            expirySeconds,
          );
        } catch (error) {
          logger.warn("Failed to refresh per-scene audio URL", {
            sceneNumber: entry.sceneNumber,
            audioKey: entry.audioKey,
            error: error instanceof Error ? error.message : "Unknown",
          });
        }
      }

      return {
        sceneNumber: entry.sceneNumber,
        ...(audioUrl ? { audioUrl } : {}),
        ...(entry.wordTimings !== undefined
          ? { wordTimings: entry.wordTimings }
          : {}),
        ...(Array.isArray(entry.clipDurations)
          ? { clipDurations: entry.clipDurations }
          : {}),
      };
    }),
  );
}

export const GET = withJobsReadAuth(async (
  _request: NextRequest,
  { container, auth, logger },
  routeContext: { params: Promise<{ id: string }> },
) => {
  const { id: jobId } = await routeContext.params;
  logger.info("GET /api/jobs/:id", { jobId });

  if (!isValidUuid(jobId)) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Job not found" },
      { status: 404 },
    );
  }

  let job;
  try {
    job = await container.jobRepository.findById(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database error";
    logger.error("Failed to fetch job", { jobId, error: message });
    return NextResponse.json(
      { error: "INTERNAL_SERVER_ERROR", message: "Failed to fetch job" },
      { status: 500 },
    );
  }

  if (!job) {
    logger.warn("Job not found", { jobId });
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Job not found" },
      { status: 404 },
    );
  }

  // One-time keys can only read their own jobs (authorization scoping)
  const isOneTimeKey = auth.maxUses !== null;
  if (isOneTimeKey && job.apiKeyId !== auth.keyId) {
    logger.warn("One-time key attempted to access another key's job", {
      keyId: auth.keyId,
      jobApiKeyId: job.apiKeyId,
      jobId,
    });
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Job not found" },
      { status: 404 },
    );
  }

  // Refresh signed URL if job is completed and has an objectKey
  let videoUrl = job.videoUrl;
  const expirySeconds = resolveSignedUrlExpirySeconds();
  if (job.status === "completed" && job.objectKey) {
    try {
      videoUrl = await container.storageService.getSignedUrl(
        job.objectKey,
        expirySeconds,
      );
    } catch (error) {
      logger.warn("Failed to refresh signed URL, using stored URL", {
        error: error instanceof Error ? error.message : "Unknown",
      });
    }
  }
  const ttsAudioJson =
    job.status === "completed"
      ? await refreshTtsAudioJson(
          job.ttsAudioJson,
          container.storageService,
          expirySeconds,
          logger,
        )
      : (job.ttsAudioJson ?? null);

  logger.info("Job status returned", { jobId, status: job.status });

  return NextResponse.json({
    id: job.id,
    repoFullName: job.repoFullName,
    prNumber: job.prNumber,
    status: job.status,
    videoUrl,
    scriptJson: job.scriptJson ?? null,
    ttsAudioJson,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
});
