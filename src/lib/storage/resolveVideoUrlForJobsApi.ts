import type { IStorageService } from "@/interfaces/IStorageService";
import { normalizeStoredVideoUrl } from "@/lib/storage/normalizeStoredVideoUrl";

export interface LogSink {
  warn(msg: string, ctx: Record<string, unknown>): void;
  error(msg: string, ctx: Record<string, unknown>): void;
}

export type JobsApiUrlResolution =
  | { kind: "ok"; videoUrl: string | null }
  | { kind: "signing-unavailable"; reason: string };

/**
 * Resolve the playable video URL the JSON jobs API hands to clients.
 *
 * Three outcomes:
 *   - `{ kind: "ok", videoUrl: <signed-or-stored> }` — caller returns 200.
 *   - `{ kind: "ok", videoUrl: null }` — caller returns 200 with
 *     `videoUrl: null` (legitimate "no asset yet").
 *   - `{ kind: "signing-unavailable" }` — caller returns 503 so the
 *     client can distinguish a transient backend problem from "no
 *     asset" and retry without rendering an "expired" UI.
 *
 * The 503 path fires only when:
 *   - The job is completed AND has an objectKey (we WERE supposed to be
 *     able to mint a fresh URL), AND
 *   - `getSignedUrl` threw, AND
 *   - We have no usable fallback (`normalizeStoredVideoUrl(videoUrl)`
 *     returns null — either the stored URL is missing or legacy `file://`).
 *
 * Extracted from `src/app/api/jobs/[id]/route.ts` so the branch matrix
 * (especially the 503 emission) is unit-testable without spinning up
 * the full auth + container harness.
 */
export async function resolveVideoUrlForJobsApi(args: {
  storageService: IStorageService;
  jobStatus: string;
  objectKey: string | null;
  storedVideoUrl: string | null;
  expirySeconds: number;
  jobId: string;
  logger: LogSink;
}): Promise<JobsApiUrlResolution> {
  const { storageService, jobStatus, objectKey, storedVideoUrl, expirySeconds, jobId, logger } = args;

  let videoUrl = normalizeStoredVideoUrl(storedVideoUrl);

  if (jobStatus !== "completed" || objectKey === null) {
    return { kind: "ok", videoUrl };
  }

  try {
    videoUrl = await storageService.getSignedUrl(objectKey, expirySeconds);
    return { kind: "ok", videoUrl };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown";
    if (videoUrl === null) {
      // No fallback — surface 503 so client can retry rather than
      // render a stale or "expired" state for a transient backend issue.
      logger.error("Signed URL refresh failed and no fallback available", { jobId, error: reason });
      return { kind: "signing-unavailable", reason };
    }
    logger.warn("Failed to refresh signed URL, using stored URL", { jobId, error: reason });
    return { kind: "ok", videoUrl };
  }
}
