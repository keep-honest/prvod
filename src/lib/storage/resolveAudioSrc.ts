import type { IStorageService } from "@/interfaces/IStorageService";

/**
 * Pick the right URL form for a per-scene audio asset so the video
 * compositor can consume it.
 *
 * Two paths:
 *   - **Local storage**: the streaming HTTP route (`/api/local-storage/`)
 *     is browser-facing only and restricts to the `videos/` prefix —
 *     audio keys (`audio/...`) would 404. In-process compositors
 *     instead get an absolute filesystem path via `tryGetLocalPath`,
 *     wrapped as `file://${path}` to match the compositors' existing
 *     `startsWith("file://")` branches (FFmpeg copy / Remotion asset
 *     server registration).
 *   - **Remote storage** (S3/R2): adapters don't implement
 *     `tryGetLocalPath`, so the optional-chain returns `undefined`
 *     and we fall through to `getSignedUrl` (presigned HTTP URL).
 *
 * Failure modes:
 *   - `tryGetLocalPath` returns `null` ⇒ the file is genuinely missing
 *     on disk. We must NOT fall through to `getSignedUrl` because that
 *     would re-run a different not-found check inside the storage
 *     service, producing a misleading downstream error. Throw a
 *     specific error so the operator sees the real cause.
 *   - `tryGetLocalPath` rejects ⇒ propagates (e.g.
 *     `LocalStoragePathEscapeError` from symlink escape).
 *   - `getSignedUrl` rejects ⇒ propagates (caller layer decides
 *     whether to 503 or fall back to stored URL).
 */
export async function resolveAudioSrc(
  storageService: IStorageService,
  audioKey: string,
  expirySeconds: number,
): Promise<string> {
  const tryLocal = storageService.tryGetLocalPath;
  if (tryLocal !== undefined) {
    // Bind `this` to the service so impls that use `this.baseDir` work
    // when the method is read off the object as a bare reference.
    const localPath = await tryLocal.call(storageService, audioKey);
    if (localPath !== null) {
      return `file://${localPath}`;
    }
    // Local adapter says the file is not on disk. Don't fall through —
    // `getSignedUrl` would just re-run the same not-found check via a
    // different code path and throw a less helpful error. Surface the
    // real cause: the orchestrator is supposed to have uploaded the
    // file moments before this call.
    throw new Error(
      `Audio key not on local disk after upload: ${audioKey}. ` +
        `tryGetLocalPath returned null — file may have been deleted, ` +
        `the upload write didn't flush, or the key is malformed.`,
    );
  }
  return storageService.getSignedUrl(audioKey, expirySeconds);
}
