import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  LocalStorageNotFoundError,
  LocalStoragePathEscapeError,
  LocalStorageService,
} from "@/infrastructure/storage/LocalStorageService";
import {
  STORAGE_URL_PATH_PREFIX,
  STORAGE_URL_SECRET_ENV,
} from "@/lib/storage/signLocalUrl";

const TEST_SECRET = "x".repeat(64);

describe("LocalStorageService", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let originalSecret: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-storage-test-"));
    originalEnv = process.env.LOCAL_STORAGE_DIR;
    originalSecret = process.env[STORAGE_URL_SECRET_ENV];
    process.env.LOCAL_STORAGE_DIR = tmpDir;
    process.env[STORAGE_URL_SECRET_ENV] = TEST_SECRET;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.LOCAL_STORAGE_DIR = originalEnv;
    } else {
      delete process.env.LOCAL_STORAGE_DIR;
    }
    if (originalSecret !== undefined) {
      process.env[STORAGE_URL_SECRET_ENV] = originalSecret;
    } else {
      Reflect.deleteProperty(process.env, STORAGE_URL_SECRET_ENV);
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("uploads a file and creates nested directories", async () => {
    const service = new LocalStorageService();
    const data = Buffer.from("test data");

    await service.upload("videos/owner/repo/42/job.mp4", data, "video/mp4");

    const filePath = path.join(tmpDir, "videos/owner/repo/42/job.mp4");
    const content = await fs.readFile(filePath);
    expect(content.toString()).toBe("test data");
  });

  it("getSignedUrl returns signed /api/local-storage/<key>?exp=...&sig=... for existing file", async () => {
    const service = new LocalStorageService();
    await service.upload("test/video.mp4", Buffer.from("video content"), "video/mp4");

    const url = await service.getSignedUrl("test/video.mp4", 3600);

    expect(url.startsWith(STORAGE_URL_PATH_PREFIX)).toBe(true);
    const u = new URL(url, "http://localhost");
    expect(u.pathname).toBe("/api/local-storage/test/video.mp4");
    expect(u.searchParams.get("exp")).toMatch(/^\d+$/);
    expect(u.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getSignedUrl URL-encodes path segments containing spaces", async () => {
    const service = new LocalStorageService();
    await service.upload("test/dir with space/video.mp4", Buffer.from("x"), "video/mp4");

    const url = await service.getSignedUrl("test/dir with space/video.mp4", 60);
    expect(url).toContain("/api/local-storage/test/dir%20with%20space/video.mp4");
  });

  it("getSignedUrl throws if STORAGE_URL_SECRET is unset", async () => {
    Reflect.deleteProperty(process.env, STORAGE_URL_SECRET_ENV);
    const service = new LocalStorageService();
    await service.upload("test/x.mp4", Buffer.from("x"), "video/mp4");

    await expect(service.getSignedUrl("test/x.mp4", 60)).rejects.toThrow(
      /STORAGE_URL_SECRET/,
    );
  });

  it("getSignedUrl throws LocalStorageNotFoundError for missing file", async () => {
    const service = new LocalStorageService();
    await expect(
      service.getSignedUrl("nonexistent/file.mp4", 3600),
    ).rejects.toBeInstanceOf(LocalStorageNotFoundError);
  });

  it("getSignedUrl is deterministic for the same key + secret + clock", async () => {
    const service = new LocalStorageService();
    await service.upload("test/x.mp4", Buffer.from("x"), "video/mp4");
    const fixed = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fixed);

    const a = await service.getSignedUrl("test/x.mp4", 60);
    const b = await service.getSignedUrl("test/x.mp4", 60);
    expect(a).toBe(b);
  });

  it("resolveForStreaming returns absolute path + size for existing file", async () => {
    const service = new LocalStorageService();
    const payload = Buffer.alloc(1024, "x");
    await service.upload("videos/x.mp4", payload, "video/mp4");

    const result = await service.resolveForStreaming("videos/x.mp4");
    // Compare against the realpath-resolved tmp dir so macOS /tmp -> /private/tmp
    // symlink resolution matches what the service returns.
    const realTmp = await fs.realpath(tmpDir);
    expect(result.absolutePath).toBe(path.join(realTmp, "videos/x.mp4"));
    expect(result.size).toBe(1024);
  });

  it("resolveForStreaming throws LocalStorageNotFoundError for missing file", async () => {
    const service = new LocalStorageService();
    await expect(service.resolveForStreaming("videos/missing.mp4")).rejects.toBeInstanceOf(
      LocalStorageNotFoundError,
    );
  });

  it("resolveForStreaming rejects symlinks that escape baseDir", async () => {
    // Plant a target file OUTSIDE baseDir, then a symlink to it INSIDE baseDir.
    const escapeTarget = path.join(os.tmpdir(), `escape-target-${Date.now()}.txt`);
    await fs.writeFile(escapeTarget, "should-not-leak");
    const linkPath = path.join(tmpDir, "videos", "escape-link.txt");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(escapeTarget, linkPath);

    try {
      const service = new LocalStorageService();
      await expect(
        service.resolveForStreaming("videos/escape-link.txt"),
      ).rejects.toBeInstanceOf(LocalStoragePathEscapeError);
    } finally {
      await fs.unlink(linkPath).catch(() => {});
      await fs.unlink(escapeTarget).catch(() => {});
    }
  });

  it("safePath throws LocalStoragePathEscapeError for traversal keys", async () => {
    const service = new LocalStorageService();
    // Traversal is caught at upload/getSignedUrl, both of which call safePath.
    await expect(
      service.upload("../../etc/passwd", Buffer.from("x"), "text/plain"),
    ).rejects.toBeInstanceOf(LocalStoragePathEscapeError);
  });

  it("constructor falls back to path.resolve when baseDir does not yet exist (ENOENT)", async () => {
    const missingDir = path.join(tmpDir, "nested", "deep", "not-yet-here");
    process.env.LOCAL_STORAGE_DIR = missingDir;
    expect(() => new LocalStorageService()).not.toThrow();
    // First upload creates the directory hierarchy under the requested path
    const service = new LocalStorageService();
    await service.upload("videos/x.mp4", Buffer.from("hello"), "video/mp4");
    const written = await fs.readFile(path.join(missingDir, "videos/x.mp4"), "utf8");
    expect(written).toBe("hello");
  });

  it("constructor resolves through unresolved-symlink parents when leaf does not yet exist", async () => {
    // Plant a symlink: tmpDir/symparent -> tmpDir/realparent. Then point
    // LOCAL_STORAGE_DIR at tmpDir/symparent/not-yet-here. The constructor
    // must realpath the symlink ancestor so subsequent containment checks
    // against the realpath-resolved upload path succeed. Without the
    // walk-upward fix, this test fails on every realistic dev setup
    // (`LOCAL_STORAGE_DIR=/tmp/x` on macOS, where /tmp -> /private/tmp).
    const realParent = path.join(tmpDir, "realparent");
    const symParent = path.join(tmpDir, "symparent");
    await fs.mkdir(realParent, { recursive: true });
    await fs.symlink(realParent, symParent);
    const missingLeaf = path.join(symParent, "videos-root");
    process.env.LOCAL_STORAGE_DIR = missingLeaf;

    const service = new LocalStorageService();
    // First upload creates the leaf via the symlinked parent. After upload,
    // resolveForStreaming/getSignedUrl/tryGetLocalPath must succeed —
    // they will compare realpath(<symlink>/leaf/...) against the baseDir
    // recorded at construction time.
    await service.upload("videos/x.mp4", Buffer.from("hello"), "video/mp4");
    const resolved = await service.resolveForStreaming("videos/x.mp4");
    expect(resolved.size).toBe(5);
    // tryGetLocalPath returns the realpath-resolved (private/var) form.
    const local = await service.tryGetLocalPath("videos/x.mp4");
    expect(local).not.toBeNull();
    // getSignedUrl should not throw LocalStoragePathEscapeError.
    await expect(service.getSignedUrl("videos/x.mp4", 60)).resolves.toMatch(
      /\/api\/local-storage\/videos\/x\.mp4\?exp=\d+&sig=[0-9a-f]+/,
    );
  });

  // Not tested: constructor re-throws non-ENOENT errors from realpathSync
  // (e.g. EACCES/EIO). vi.spyOn on a node:fs ESM export throws
  // "Cannot redefine property" — would require top-level vi.mock("node:fs")
  // which interferes with every other fs-using test in this file. The
  // contract is enforced by the `if (code === "ENOENT")` guard in
  // LocalStorageService and documented in the source.

  it("tryGetLocalPath returns absolute path for existing key", async () => {
    const service = new LocalStorageService();
    await service.upload("videos/x.mp4", Buffer.from("x"), "video/mp4");
    const result = await service.tryGetLocalPath("videos/x.mp4");
    const realTmp = await fs.realpath(tmpDir);
    expect(result).toBe(path.join(realTmp, "videos/x.mp4"));
  });

  it("tryGetLocalPath returns null for missing key (not throw)", async () => {
    const service = new LocalStorageService();
    const result = await service.tryGetLocalPath("videos/missing.mp4");
    expect(result).toBeNull();
  });

  it("tryGetLocalPath rejects symlink escape (not return null silently)", async () => {
    const escapeTarget = path.join(os.tmpdir(), `escape-target-tgl-${Date.now()}.txt`);
    await fs.writeFile(escapeTarget, "secret");
    const linkPath = path.join(tmpDir, "videos", "escape-link.txt");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(escapeTarget, linkPath);
    try {
      const service = new LocalStorageService();
      await expect(service.tryGetLocalPath("videos/escape-link.txt")).rejects.toBeInstanceOf(
        LocalStoragePathEscapeError,
      );
    } finally {
      await fs.unlink(linkPath).catch(() => {});
      await fs.unlink(escapeTarget).catch(() => {});
    }
  });

  it("getSignedUrl rejects symlink escape (matches resolveForStreaming containment)", async () => {
    // Round-1 hardening: getSignedUrl now applies the same realpath check
    // as resolveForStreaming so we never mint a signed URL for a key the
    // streaming route would refuse.
    const escapeTarget = path.join(os.tmpdir(), `escape-target-gsu-${Date.now()}.txt`);
    await fs.writeFile(escapeTarget, "secret");
    const linkPath = path.join(tmpDir, "videos", "escape-link.txt");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(escapeTarget, linkPath);
    try {
      const service = new LocalStorageService();
      await expect(service.getSignedUrl("videos/escape-link.txt", 60)).rejects.toBeInstanceOf(
        LocalStoragePathEscapeError,
      );
    } finally {
      await fs.unlink(linkPath).catch(() => {});
      await fs.unlink(escapeTarget).catch(() => {});
    }
  });

  it("delete removes the file", async () => {
    const service = new LocalStorageService();
    const data = Buffer.from("to delete");

    await service.upload("delete-me.mp4", data, "video/mp4");
    await service.delete("delete-me.mp4");

    const filePath = path.join(tmpDir, "delete-me.mp4");
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("delete does not throw for non-existent file", async () => {
    const service = new LocalStorageService();
    await expect(service.delete("nonexistent.mp4")).resolves.not.toThrow();
  });
});
