import { describe, expect, it } from "vitest";
import { generateGraphOverlayPng } from "@/infrastructure/video/ffmpeg/generateGraphOverlayPng";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";

function makeLayout(
  nodes: Array<{ sceneNumber: number; label: string; x: number; y: number }>,
  edges: Array<{ source: number; target: number; pathD: string }> = [],
): GraphLayoutData {
  return {
    viewportWidth: 1920,
    viewportHeight: 1080,
    nodes: nodes.map((n) => ({
      nodeId: `src/${n.label}`,
      sceneNumber: n.sceneNumber,
      filePath: `src/${n.label}`,
      x: n.x,
      y: n.y,
      label: n.label,
      directory: "src",
      radius: 40,
    })),
    edges: edges.map((e) => {
      const srcPath = `src/${nodes.find((n) => n.sceneNumber === e.source)!.label}`;
      const tgtPath = `src/${nodes.find((n) => n.sceneNumber === e.target)!.label}`;
      return {
        sourceNodeId: srcPath,
        targetNodeId: tgtPath,
        sourceSceneNumber: e.source,
        targetSceneNumber: e.target,
        relationship: "same_directory",
        pathD: e.pathD,
      };
    }),
  };
}

// PNG files always start with these 8 magic bytes.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("generateGraphOverlayPng", () => {
  it("produces a valid PNG buffer for a minimal two-node layout", async () => {
    const layout = makeLayout(
      [
        { sceneNumber: 1, label: "a.ts", x: 700, y: 540 },
        { sceneNumber: 2, label: "b.ts", x: 1200, y: 540 },
      ],
      [{ source: 1, target: 2, pathD: "M 700 540 Q 950 400 1200 540" }],
    );
    const buffer = await generateGraphOverlayPng(layout);
    expect(buffer.length).toBeGreaterThan(PNG_SIGNATURE.length);
    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("escapes XML-reserved characters in node labels without throwing", async () => {
    // Filenames with <, >, &, ", ' should never break SVG parsing.
    const layout = makeLayout([
      { sceneNumber: 1, label: "Foo<Bar>.tsx", x: 500, y: 500 },
      { sceneNumber: 2, label: "a & b.ts", x: 900, y: 500 },
      { sceneNumber: 3, label: `"quoted".ts`, x: 1300, y: 500 },
      { sceneNumber: 4, label: "it's.ts", x: 1600, y: 500 },
    ]);
    const buffer = await generateGraphOverlayPng(layout);
    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("handles an empty-nodes layout without throwing", async () => {
    const layout = makeLayout([]);
    const buffer = await generateGraphOverlayPng(layout);
    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("produces a PNG even when there are no edges", async () => {
    const layout = makeLayout([
      { sceneNumber: 1, label: "isolated.ts", x: 960, y: 540 },
    ]);
    const buffer = await generateGraphOverlayPng(layout);
    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });
});
