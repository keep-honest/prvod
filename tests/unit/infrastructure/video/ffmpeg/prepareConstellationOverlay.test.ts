import { describe, expect, it, vi } from "vitest";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import {
  prepareConstellationOverlay,
  type FsLike,
} from "@/infrastructure/video/ffmpeg/prepareConstellationOverlay";

// ── Helpers ──────────────────────────────────────────────────────────

function makeLayout(nodeCount: number): GraphLayoutData {
  return {
    viewportWidth: 1920,
    viewportHeight: 1080,
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      nodeId: `src/file${i}.ts`,
      sceneNumber: i + 2, // scenes 2..N (scene 1 is narrative overview)
      filePath: `src/file${i}.ts`,
      x: 200 + i * 100,
      y: 500,
      label: `file${i}.ts`,
      directory: "src",
      radius: 40,
    })),
    edges: [],
  };
}

function makeScript(sceneCount: number): VideoScript {
  return {
    changeType: "feature",
    summary: "",
    headline: "",
    totalDurationSeconds: sceneCount * 6,
    totalWordCount: sceneCount * 20,
    keyFiles: [],
    tags: [],
    narrativeRoles: [],
    voiceAssignments: [],
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      sceneNumber: i + 1,
      sceneType: i === 0 ? "overview" : "code_walkthrough",
      durationSeconds: 6,
      narration: "narration",
      codeBroll: [],
    })),
  };
}

function makeFs(overrides: Partial<FsLike> = {}): {
  fs: FsLike;
  writes: string[];
  mkdirs: string[];
} {
  const writes: string[] = [];
  const mkdirs: string[] = [];
  const fs: FsLike = {
    writeFile: vi.fn(async (file) => {
      writes.push(String(file));
    }),
    mkdir: vi.fn(async (dir) => {
      mkdirs.push(String(dir));
      return undefined;
    }),
    ...overrides,
  };
  return { fs, writes, mkdirs };
}

const TEST_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]);

// ── Tests ────────────────────────────────────────────────────────────

describe("prepareConstellationOverlay", () => {
  it("returns undefined when graphLayout is absent", async () => {
    const { fs } = makeFs();
    const generatePng = vi.fn(async () => TEST_PNG);
    const result = await prepareConstellationOverlay({
      graphLayout: undefined,
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
    });
    expect(result).toBeUndefined();
    expect(generatePng).not.toHaveBeenCalled();
  });

  it("returns undefined when graphLayout has zero nodes", async () => {
    const { fs } = makeFs();
    const generatePng = vi.fn(async () => TEST_PNG);
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(0),
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
    });
    expect(result).toBeUndefined();
    expect(generatePng).not.toHaveBeenCalled();
  });

  it("returns undefined when the script has no scenes", async () => {
    const { fs } = makeFs();
    const generatePng = vi.fn(async () => TEST_PNG);
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script: makeScript(0),
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
    });
    expect(result).toBeUndefined();
    expect(generatePng).not.toHaveBeenCalled();
  });

  it("writes the PNG and attaches it to the FINAL scene's sceneNumber", async () => {
    const { fs, writes } = makeFs();
    const generatePng = vi.fn(async () => TEST_PNG);
    const script = makeScript(5);
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script,
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
    });
    expect(result).toBeDefined();
    expect(result?.sceneNumber).toBe(5); // last scene
    expect(result?.pngPath).toBe("/tmp/render/constellation-graph.png");
    expect(result?.fadeInSec).toBe(0.6);
    expect(writes).toContain("/tmp/render/constellation-graph.png");
    expect(generatePng).toHaveBeenCalledTimes(1);
  });

  it("uses the last scene's sceneNumber even when scene numbers are non-contiguous", async () => {
    const { fs } = makeFs();
    const generatePng = vi.fn(async () => TEST_PNG);
    const script = makeScript(3);
    // Force non-contiguous numbering: e.g., 1, 7, 12
    script.scenes[0].sceneNumber = 1;
    script.scenes[1].sceneNumber = 7;
    script.scenes[2].sceneNumber = 12;
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script,
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
    });
    expect(result?.sceneNumber).toBe(12);
  });

  it("returns undefined and does not propagate when generatePng throws", async () => {
    const { fs, writes } = makeFs();
    const generatePng = vi.fn(async () => {
      throw new Error("sharp crashed");
    });
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
    });
    expect(result).toBeUndefined();
    expect(writes).toHaveLength(0);
  });

  it("returns undefined and does not propagate when primary writeFile throws", async () => {
    const fs: FsLike = {
      writeFile: vi.fn(async () => {
        throw new Error("ENOSPC: no space left on device");
      }),
      mkdir: vi.fn(async () => undefined),
    };
    const generatePng = vi.fn(async () => TEST_PNG);
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
    });
    expect(result).toBeUndefined();
  });

  it("swallows debug mkdir failures and still returns the overlay entry", async () => {
    const writes: string[] = [];
    let writeCall = 0;
    const fs: FsLike = {
      writeFile: vi.fn(async (file) => {
        writeCall++;
        writes.push(String(file));
        // First write (primary) succeeds; second (debug) won't be reached
        // because mkdir failed earlier.
      }),
      mkdir: vi.fn(async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }),
    };
    const generatePng = vi.fn(async () => TEST_PNG);
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      cacheDir: "/tmp/cache",
      generatePng,
      fs,
    });
    expect(result).toBeDefined();
    expect(result?.sceneNumber).toBe(3);
    // Both the primary and the debug write are attempted. The debug write
    // also succeeds here (mkdir rejecting does not chain to writeFile in the
    // current implementation — they're independent `.catch` blocks).
    expect(writeCall).toBe(2);
  });

  it("swallows debug writeFile failures and still returns the overlay entry", async () => {
    let writeCall = 0;
    const fs: FsLike = {
      writeFile: vi.fn(async (file) => {
        writeCall++;
        if (String(file).includes("debug")) {
          throw Object.assign(new Error("EROFS"), { code: "EROFS" });
        }
      }),
      mkdir: vi.fn(async () => undefined),
    };
    const generatePng = vi.fn(async () => TEST_PNG);
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      cacheDir: "/tmp/cache",
      generatePng,
      fs,
    });
    expect(result).toBeDefined();
    expect(result?.pngPath).toBe("/tmp/render/constellation-graph.png");
    expect(writeCall).toBe(2); // primary + failed debug attempt
  });

  it("does not touch cache directory when cacheDir is omitted", async () => {
    const { fs, mkdirs, writes } = makeFs();
    const generatePng = vi.fn(async () => TEST_PNG);
    await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      // no cacheDir
      generatePng,
      fs,
    });
    expect(mkdirs).toHaveLength(0);
    expect(writes).toHaveLength(1); // only the primary write
    expect(writes[0]).toBe("/tmp/render/constellation-graph.png");
  });

  it("honors a custom fadeInSec override", async () => {
    const { fs } = makeFs();
    const generatePng = vi.fn(async () => TEST_PNG);
    const result = await prepareConstellationOverlay({
      graphLayout: makeLayout(3),
      script: makeScript(3),
      renderTmpDir: "/tmp/render",
      generatePng,
      fs,
      fadeInSec: 1.25,
    });
    expect(result?.fadeInSec).toBe(1.25);
  });
});
