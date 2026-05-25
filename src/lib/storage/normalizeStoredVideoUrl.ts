/**
 * Defensive helper for legacy `videoUrl` rows in the jobs table.
 *
 * Before the local-storage streaming route existed, `LocalStorageService.getSignedUrl()`
 * returned `file://${absolutePath}`. Browsers refuse to load those URLs from
 * any `http(s)://` origin, so any persisted `file://` row is unplayable.
 *
 * Returning null for `file://` inputs forces callers down the re-sign path
 * (`storageService.getSignedUrl(job.objectKey, …)`) instead of using the
 * stored value. Pass-through everything else unchanged (HTTPS S3 URLs,
 * already-signed `/api/local-storage/…` URLs from the new code path).
 *
 * Idempotent. Removable once the dev DB has been rotated or every legacy
 * job has been re-fetched at least once.
 */
export function normalizeStoredVideoUrl(url: string | null): string | null {
  if (url === null) return null;
  if (url.startsWith("file://")) return null;
  return url;
}
