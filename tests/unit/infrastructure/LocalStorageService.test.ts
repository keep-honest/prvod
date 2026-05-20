import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalStorageService } from "@/infrastructure/storage/LocalStorageService";

describe("LocalStorageService", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-storage-test-"));
    originalEnv = process.env.LOCAL_STORAGE_DIR;
    process.env.LOCAL_STORAGE_DIR = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.LOCAL_STORAGE_DIR = originalEnv;
    } else {
      delete process.env.LOCAL_STORAGE_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uploads a file and creates nested directories", async () => {
    const service = new LocalStorageService();
    const data = Buffer.from("test data");

    await service.upload("videos/owner/repo/42/job.mp4", data, "video/mp4");

    const filePath = path.join(tmpDir, "videos/owner/repo/42/job.mp4");
    const content = await fs.readFile(filePath);
    expect(content.toString()).toBe("test data");
  });

  it("getSignedUrl returns file:// URL for existing file", async () => {
    const service = new LocalStorageService();
    const data = Buffer.from("video content");

    await service.upload("test/video.mp4", data, "video/mp4");
    const url = await service.getSignedUrl("test/video.mp4", 3600);

    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain("test/video.mp4");
  });

  it("getSignedUrl throws for non-existent file", async () => {
    const service = new LocalStorageService();

    await expect(
      service.getSignedUrl("nonexistent/file.mp4", 3600),
    ).rejects.toThrow("Object not found");
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
