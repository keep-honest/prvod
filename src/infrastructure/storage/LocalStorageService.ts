import path from "node:path";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createLogger } from "@/lib/logger";
import type { IStorageService } from "@/interfaces/IStorageService";
import { readStorageUrlSecret, signLocalUrl } from "@/lib/storage/signLocalUrl";

const logger = createLogger("LocalStorageService");

/**
 * Resolve `requested` through symlinks while tolerating a not-yet-created
 * leaf directory.
 *
 * `realpathSync(requested)` only succeeds when every path component
 * exists. For dev setups where `LOCAL_STORAGE_DIR=/tmp/prvod-storage`
 * but `prvod-storage` isn't created yet, we walk upward to the first
 * ancestor that exists, realpath it, then rejoin the remaining suffix.
 * This is the only way to honour the symlink-resolved containment
 * invariant when the leaf will be created later (lazy `mkdir` on first
 * upload).
 *
 * Permission / IO errors propagate so a misconfigured filesystem fails
 * loudly at boot rather than at first stream.
 */
function resolveBaseDirThroughExistingAncestor(requested: string): string {
  const segments = path.relative(path.parse(requested).root, requested).split(path.sep);
  let probe = path.parse(requested).root;
  for (let i = 0; i <= segments.length; i += 1) {
    try {
      const real = realpathSync(probe);
      if (i === segments.length) {
        // All segments exist — full realpath succeeded.
        return real;
      }
      // Probe exists; descend into the next segment and try again.
      probe = path.join(probe, segments[i]);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      // First non-existent component: realpath the parent (the previous
      // probe value, which we know was real because realpath succeeded
      // for it last loop) and rejoin the remaining segments.
      const lastReal = realpathSync(path.dirname(probe));
      const remainingFromHere = segments.slice(i - 1);
      const reconstructed = path.join(lastReal, ...remainingFromHere);
      logger.warn("LOCAL_STORAGE_DIR does not exist yet — will be created on first upload", {
        requested,
        firstExistingAncestor: lastReal,
        reconstructedBaseDir: reconstructed,
      });
      return reconstructed;
    }
  }
  // Unreachable — the loop either returns inside the try or returns from
  // the ENOENT catch. Defensive return to satisfy TypeScript.
  return requested;
}

/** Thrown by `resolveForStreaming` when the key does not exist on disk. */
export class LocalStorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = "LocalStorageNotFoundError";
  }
}

/** Thrown by `resolveForStreaming` when path traversal or symlink escape is detected. */
export class LocalStoragePathEscapeError extends Error {
  constructor(key: string) {
    super(`Key escapes storage directory: ${key}`);
    this.name = "LocalStoragePathEscapeError";
  }
}

export class LocalStorageService implements IStorageService {
  private readonly baseDir: string;

  constructor() {
    // Resolve to a real path so symlink-bearing parents (e.g. macOS
    // `/tmp` -> `/private/tmp`) don't break the symlink-escape check
    // in `resolveForStreaming` (which compares against `fs.realpath`).
    //
    // If the leaf directory doesn't exist yet, walk up to the first
    // existing ancestor, realpath THAT, then reattach the remaining
    // suffix. Without this, `LOCAL_STORAGE_DIR=/tmp/new-storage` on
    // macOS would set baseDir to `/tmp/new-storage`, but after first
    // upload `fs.realpath` returns `/private/tmp/new-storage/...` and
    // every containment check would throw `LocalStoragePathEscapeError`.
    //
    // Permission / IO errors during the walk fail loudly rather than
    // masquerading as "directory will be created later".
    const requested = path.resolve(process.env.LOCAL_STORAGE_DIR ?? ".local-storage");
    this.baseDir = resolveBaseDirThroughExistingAncestor(requested);
    logger.info("LocalStorageService initialized", { baseDir: this.baseDir });
  }

  /** Resolves a storage key to an absolute path, rejecting traversal attempts. */
  private safePath(key: string): string {
    const resolved = path.resolve(this.baseDir, key);
    if (!resolved.startsWith(this.baseDir + path.sep) && resolved !== this.baseDir) {
      throw new LocalStoragePathEscapeError(key);
    }
    return resolved;
  }

  async upload(key: string, data: Buffer, _contentType: string): Promise<void> {
    const filePath = this.safePath(key);
    logger.info("Uploading to local storage", {
      key,
      sizeBytes: data.length,
      filePath,
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const start = performance.now();
    await fs.writeFile(filePath, data);
    const elapsedMs = Math.round(performance.now() - start);
    const throughputMBs =
      elapsedMs > 0 ? (data.length / 1024 / 1024 / (elapsedMs / 1000)).toFixed(1) : "N/A";

    logger.info("Upload complete", { key, elapsedMs, throughputMBs });
  }

  async getSignedUrl(key: string, expirySeconds: number): Promise<string> {
    // Use the same realpath + containment check as `resolveForStreaming`
    // so we never mint a signed URL pointing at a path the streaming
    // route would later refuse. `resolveForStreaming` throws the typed
    // not-found / path-escape errors which the caller already handles.
    await this.resolveForStreaming(key);

    // HMAC-signed relative URL pointing at the streaming route. Matches
    // the S3 adapter's presigned-URL contract: signature + expiry baked
    // in, leaked URLs go dead after `expirySeconds`. Secret is read
    // lazily so unit tests of upload/delete don't require it.
    const url = signLocalUrl(key, expirySeconds, readStorageUrlSecret());
    logger.debug("Generated signed local URL", { key });
    return url;
  }

  /**
   * Resolve a key to an absolute on-disk path for streaming.
   *
   * Re-applies `safePath()`, then `fs.realpath` to defeat symlink
   * escape, then re-checks containment against the resolved real path.
   * The streaming route MUST use this — never `safePath()` alone — so
   * a malicious symlink under `.local-storage/` cannot exfiltrate files
   * outside the base directory.
   */
  async resolveForStreaming(key: string): Promise<{ absolutePath: string; size: number }> {
    const candidate = this.safePath(key);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new LocalStorageNotFoundError(key);
      }
      throw err;
    }
    if (!real.startsWith(this.baseDir + path.sep) && real !== this.baseDir) {
      throw new LocalStoragePathEscapeError(key);
    }
    const stat = await fs.stat(real);
    return { absolutePath: real, size: stat.size };
  }

  /**
   * Return the absolute on-disk path for `key` for in-process consumers
   * (compositors, batch jobs) that don't want to round-trip through the
   * HTTP route. Applies the same containment + symlink-escape guard as
   * `resolveForStreaming`. Returns `null` when the file does not exist
   * rather than throwing — caller can fall back to the signed HTTP URL.
   */
  async tryGetLocalPath(key: string): Promise<string | null> {
    try {
      const { absolutePath } = await this.resolveForStreaming(key);
      return absolutePath;
    } catch (err) {
      if (err instanceof LocalStorageNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.safePath(key);
    logger.info("Deleting from local storage", { key });

    await fs.unlink(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        logger.debug("File not found for deletion (noop)", { key });
      } else {
        throw err;
      }
    });
  }
}
