export interface IStorageService {
  upload(key: string, data: Buffer, contentType: string): Promise<void>;
  getSignedUrl(key: string, expirySeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  /**
   * If the storage backend lives on the local filesystem, return the
   * absolute on-disk path for `key`. Returns `null` for remote backends.
   *
   * Server-internal consumers (the video compositor stitching per-scene
   * audio, for example) use this to bypass the HTTP signed-URL round-trip
   * entirely — `getSignedUrl` is browser-facing only. Implementations
   * MUST apply the same containment + symlink-escape guards as
   * `getSignedUrl` (e.g. via `realpath`).
   */
  tryGetLocalPath?(key: string): Promise<string | null>;
}
