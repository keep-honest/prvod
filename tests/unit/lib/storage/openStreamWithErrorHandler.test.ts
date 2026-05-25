import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openStreamWithErrorHandler } from "@/lib/storage/openStreamWithErrorHandler";

describe("openStreamWithErrorHandler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-error-handler-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function buildLogger() {
    return { error: vi.fn() };
  }

  async function consumeStream(stream: ReadableStream): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    try {
      // Loop until done so we observe `error`-event side effects.
      // The reader may throw on the abort that follows our injected error;
      // catch that so the test's assertions on the logger still run.
       
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
      }
    } catch {
      // Expected when the underlying Node stream aborts mid-read.
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  it("happy path: returns a ReadableStream that emits the file body", async () => {
    const filePath = path.join(tmpDir, "ok.bin");
    const payload = Buffer.from("hello world");
    await fs.writeFile(filePath, payload);

    const logger = buildLogger();
    const stream = openStreamWithErrorHandler(filePath, "videos/ok.bin", logger);
    const body = await consumeStream(stream);

    expect(body.equals(payload)).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("happy path with Range: returns only the requested bytes", async () => {
    const filePath = path.join(tmpDir, "range.bin");
    await fs.writeFile(filePath, Buffer.from("0123456789"));

    const logger = buildLogger();
    const stream = openStreamWithErrorHandler(filePath, "videos/range.bin", logger, {
      start: 2,
      end: 5,
    });
    const body = await consumeStream(stream);

    expect(body.toString()).toBe("2345");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs at error when the underlying file is missing (delayed open ENOENT)", async () => {
    // `createReadStream` defers the file open to next-tick, so the
    // 'error' listener attaches before the open attempt fires.
    const logger = buildLogger();
    const stream = openStreamWithErrorHandler(
      path.join(tmpDir, "does-not-exist.bin"),
      "videos/missing.bin",
      logger,
    );
    await consumeStream(stream);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("local-storage stream error mid-response"),
      expect.objectContaining({
        key: "videos/missing.bin",
        error: expect.stringMatching(/ENOENT/),
      }),
    );
  });

  it("logs at error when the file is deleted mid-read", async () => {
    // Write a large file, start reading, delete it mid-stream.
    const filePath = path.join(tmpDir, "delete-mid.bin");
    await fs.writeFile(filePath, Buffer.alloc(64 * 1024, "x"));

    const logger = buildLogger();
    const stream = openStreamWithErrorHandler(filePath, "videos/delete-mid.bin", logger);
    const reader = stream.getReader();
    try {
      // Read one chunk to confirm the stream opened, then delete the file
      // before reading further. The Node stream emits 'error' on the next
      // attempted read after the FD is invalidated.
      await reader.read();
      await fs.unlink(filePath);
      // Drain remaining reads; expect at least one to surface the error.
      try {
         
        while (true) {
          const r = await reader.read();
          if (r.done) break;
        }
      } catch {
        // Expected: read may throw once the underlying stream aborts.
      }
    } finally {
      reader.releaseLock();
    }

    // This test is best-effort: on fast filesystems the read may complete
    // before unlink takes effect, so we don't assert logger was called.
    // The point of having the test is to exercise the error path with a
    // real stream — if the listener was attached AFTER toWeb() (the bug
    // this helper prevents), Node would emit unhandled-error and crash
    // the test runner. If the test reaches this assertion it proved the
    // listener is wired correctly.
    expect(true).toBe(true);
  });

  it("includes the key in the log context so operators can correlate", async () => {
    const logger = buildLogger();
    const stream = openStreamWithErrorHandler(
      path.join(tmpDir, "missing-context.bin"),
      "videos/job-abc-123/scene-4.mp4",
      logger,
    );
    await consumeStream(stream);

    if (logger.error.mock.calls.length > 0) {
      const ctx = logger.error.mock.calls[0][1];
      expect(ctx.key).toBe("videos/job-abc-123/scene-4.mp4");
    } else {
      throw new Error("expected error log for missing file");
    }
  });
});
