import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClipAssets } from "@/infrastructure/video/prepareClipAssets";

const mockComputeDuration = vi.hoisted(() => vi.fn());
vi.mock("mediabunny", () => ({
  Input: vi.fn(() => ({ computeDuration: mockComputeDuration })),
  BufferSource: vi.fn(),
  ALL_FORMATS: [],
}));

describe("prepareClipAssets", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-assets-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => Uint8Array.from([0, 1, 2, 3]).buffer,
      })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("downloads clips, measures real duration, and normalizes frames with floor()", async () => {
    mockComputeDuration.mockResolvedValue(5.93);

    const assets = await prepareClipAssets(
      [
        {
          sceneNumber: 1,
          clipIndex: 0,
          clipUrl: "https://example.com/scene-1.mp4",
          durationSeconds: 6,
        },
      ],
      { cacheDir, fps: 30 },
    );

    expect(assets).toEqual([
      {
        sceneNumber: 1,
        clipIndex: 0,
        clipUrl: "https://example.com/scene-1.mp4",
        durationFrames: 177,
        durationSeconds: 5.9,
      },
    ]);
    await expect(fs.access(path.join(cacheDir, "scene-1-0.mp4"))).resolves.toBeUndefined();
  });

  it("treats mock clip URLs as synthetic assets without downloading or probing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const assets = await prepareClipAssets(
      [
        {
          sceneNumber: 3,
          clipIndex: 0,
          clipUrl: "mock://clip/10",
          durationSeconds: 10,
        },
      ],
      { cacheDir, fps: 30 },
    );

    expect(assets).toEqual([
      {
        sceneNumber: 3,
        clipIndex: 0,
        clipUrl: "mock://clip/10",
        durationFrames: 300,
        durationSeconds: 10,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockComputeDuration).not.toHaveBeenCalled();
  });

  it("propagates non-ENOENT filesystem errors instead of falling through to download", async () => {
    // Pre-create the cache file so readFile is attempted
    const clipPath = path.join(cacheDir, "scene-1-0.mp4");
    await fs.writeFile(clipPath, "data");

    // Make readFile throw EACCES (permission denied), not ENOENT
    const originalReadFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      prepareClipAssets(
        [{ sceneNumber: 1, clipIndex: 0, clipUrl: "https://example.com/scene-1.mp4", durationSeconds: 5 }],
        { cacheDir, fps: 30 },
      ),
    ).rejects.toThrow(/Failed to read cached clip.*EACCES/);

    // fetch should NOT have been called — error must propagate, not fall through to download
    expect(fetchSpy).not.toHaveBeenCalled();

    // Restore
    vi.mocked(fs.readFile).mockImplementation(originalReadFile as typeof fs.readFile);
  });

  it("throws with redacted URL when HTTP download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    let caught: Error | undefined;
    try {
      await prepareClipAssets(
        [{ sceneNumber: 1, clipIndex: 0, clipUrl: "https://cdn.example.com/scene-1.mp4?token=secret123", durationSeconds: 5 }],
        { cacheDir, fps: 30 },
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Failed to download clip.*403 Forbidden/);
    expect(caught!.message).not.toContain("secret123");
  });

  it("fails when the clip duration cannot be measured", async () => {
    mockComputeDuration.mockResolvedValue(null);

    await expect(
      prepareClipAssets(
        [
          {
            sceneNumber: 2,
            clipIndex: 0,
            clipUrl: "https://example.com/scene-2.mp4",
            durationSeconds: 4,
          },
        ],
        { cacheDir, fps: 30 },
      ),
    ).rejects.toThrow(/Unable to determine clip duration/);
  });
});
