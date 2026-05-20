import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createLogger } from "@/lib/logger";
import type { IStorageService } from "@/interfaces/IStorageService";

const logger = createLogger("LocalStorageService");

export class LocalStorageService implements IStorageService {
  private baseDir: string;

  constructor() {
    this.baseDir = path.resolve(process.env.LOCAL_STORAGE_DIR ?? ".local-storage");
    logger.info("LocalStorageService initialized", { baseDir: this.baseDir });
  }

  /** Resolves a storage key to an absolute path, rejecting traversal attempts. */
  private safePath(key: string): string {
    const resolved = path.resolve(this.baseDir, key);
    if (!resolved.startsWith(this.baseDir + path.sep) && resolved !== this.baseDir) {
      throw new Error(`Key escapes storage directory: ${key}`);
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

  async getSignedUrl(key: string, _expirySeconds: number): Promise<string> {
    const filePath = this.safePath(key);

    if (!existsSync(filePath)) {
      logger.error("Object not found in local storage", { key, filePath });
      throw new Error(`Object not found: ${key}`);
    }

    const url = `file://${filePath}`;
    logger.debug("Generated local file URL", { key });
    return url;
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
