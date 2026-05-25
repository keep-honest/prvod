import type { IStorageService } from "@/interfaces/IStorageService";
import { normalizeStoredVideoUrl } from "@/lib/storage/normalizeStoredVideoUrl";

export type LogSeverity = "warn" | "error";

export interface LogSink {
  warn(msg: string, ctx: Record<string, unknown>): void;
  error(msg: string, ctx: Record<string, unknown>): void;
}

export interface WatchUrlResolution {
  /** URL the page should hand to the `<video src>` element, or null to render `<ExpiredPage>`. */
  videoUrl: string | null;
}

/**
 * Resolve the playable video URL for the public watch page.
 *
 * Preference order:
 *   1. Re-sign via `objectKey` (so legacy `file://` rows in the DB
 *      heal automatically and new signed URLs are minted fresh on
 *      every page load — storage-side expiry resets per visit).
 *   2. Fall back to `normalizeStoredVideoUrl(videoUrl)` if re-sign
 *      throws OR `objectKey` is absent. `normalizeStoredVideoUrl`
 *      strips legacy `file://` URLs (returns null) which the page
 *      treats as "expired".
 *
 * Logging severity tells the operator whether a user-visible
 * "expired" page is caused by:
 *   - **error**: signing failed AND no usable fallback exists — the
 *     user is locked out by a backend problem.
 *   - **warn**: signing failed BUT a stored URL is still usable —
 *     the user sees the video, but the signing path is degraded.
 *
 * Extracted from `src/app/watch/[jobId]/page.tsx` so the branch
 * matrix is unit-testable without a Next server-component harness.
 */
export async function resolveVideoUrlForWatch(args: {
  storageService: IStorageService;
  objectKey: string | null;
  storedVideoUrl: string | null;
  expirySeconds: number;
  jobId: string;
  logger: LogSink;
}): Promise<WatchUrlResolution> {
  const { storageService, objectKey, storedVideoUrl, expirySeconds, jobId, logger } = args;

  if (objectKey === null) {
    return { videoUrl: normalizeStoredVideoUrl(storedVideoUrl) };
  }

  try {
    const signed = await storageService.getSignedUrl(objectKey, expirySeconds);
    return { videoUrl: signed };
  } catch (signErr) {
    const fallback = normalizeStoredVideoUrl(storedVideoUrl);
    const ctx = {
      jobId,
      error: signErr instanceof Error ? signErr.message : String(signErr),
    };
    if (fallback === null) {
      logger.error("Watch page: re-sign failed and no fallback available", ctx);
    } else {
      logger.warn("Watch page: re-sign failed, falling back to stored URL", ctx);
    }
    return { videoUrl: fallback };
  }
}
