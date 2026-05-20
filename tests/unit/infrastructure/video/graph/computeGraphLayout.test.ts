import { describe, expect, it, vi } from "vitest";
import type { VideoScript } from "@/domain/entities/VideoScript";
import { computeGraphLayout, getConstellationOwnerSceneNumbers } from "@/infrastructure/video/graph/computeGraphLayout";
import type { DerivedEdge } from "@/infrastructure/video/graph/graphRelationships";
import { deriveReviewPageEdges } from "@/infrastructure/video/graph/reviewPageRelationships";
import type { GraphNode } from "@/infrastructure/video/graph/types";
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  NODE_MARGIN,
} from "@/infrastructure/video/graph/types";

function makeScript(
  scenes: { sceneNumber: number; filePath?: string; filePaths?: string[]; sceneType?: VideoScript["scenes"][number]["sceneType"] }[],
  keyFiles: string[] = [],
): VideoScript {
  return {
    changeType: "feature",
    summary: "",
    headline: "",
    totalDurationSeconds: scenes.length * 6,
    totalWordCount: scenes.length * 20,
    keyFiles,
    tags: [],
    narrativeRoles: [],
    voiceAssignments: [],
    scenes: scenes.map((s) => {
      const paths = s.filePaths ?? (s.filePath ? [s.filePath] : []);
      return {
        sceneNumber: s.sceneNumber,
        sceneType: s.sceneType ?? "code_walkthrough",
        durationSeconds: 6,
        narration: "narration",
        codeBroll: paths.map((fp) => ({
          filePath: fp,
          code: "const x = 1;",
          language: "typescript",
          lineRange: [1, 1] as [number, number],
          highlights: [],
        })),
      };
    }),
  };
}

describe("computeGraphLayout", () => {
  it("returns an empty layout when no scenes have code broll", () => {
    const script = makeScript([
      { sceneNumber: 1, sceneType: "overview" },
      { sceneNumber: 2, sceneType: "summary" },
    ]);
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.viewportWidth).toBe(DEFAULT_VIEWPORT_WIDTH);
    expect(layout.viewportHeight).toBe(DEFAULT_VIEWPORT_HEIGHT);
  });

  it("uses the horizontal-row fallback for fewer than 4 nodes", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2, filePath: "src/b.ts" },
      { sceneNumber: 3, filePath: "src/c.ts" },
    ]);
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toHaveLength(3);
    // All three nodes should share the same Y coordinate (they're in a row).
    const ys = new Set(layout.nodes.map((n) => Math.round(n.y)));
    expect(ys.size).toBe(1);
  });

  it("deduplicates nodes when the same file appears in multiple scenes", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2, filePath: "src/a.ts" }, // same file
      { sceneNumber: 3, filePath: "src/b.ts" },
    ]);
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toHaveLength(2);
    // The first scene that introduced the file owns the node.
    expect(layout.nodes[0].sceneNumber).toBe(1);
  });

  it("runs the force simulation for graphs with 4+ nodes and clamps to viewport margins", () => {
    const script = makeScript(
      [
        { sceneNumber: 1, filePath: "src/lib/a.ts" },
        { sceneNumber: 2, filePath: "src/lib/b.ts" },
        { sceneNumber: 3, filePath: "src/api/c.ts" },
        { sceneNumber: 4, filePath: "src/api/d.ts" },
        { sceneNumber: 5, filePath: "src/pages/e.tsx" },
      ],
      ["src/lib/a.ts", "src/api/c.ts", "src/pages/e.tsx"],
    );
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toHaveLength(5);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(NODE_MARGIN);
      expect(node.x).toBeLessThanOrEqual(DEFAULT_VIEWPORT_WIDTH - NODE_MARGIN);
      expect(node.y).toBeGreaterThanOrEqual(NODE_MARGIN);
      expect(node.y).toBeLessThanOrEqual(DEFAULT_VIEWPORT_HEIGHT - NODE_MARGIN);
    }
    // Each edge should come with a pre-computed SVG path.
    for (const edge of layout.edges) {
      expect(edge.pathD).toMatch(/^M\s\d/);
    }
    expect(layout.edges.length).toBeGreaterThan(0);
  });

  it("is deterministic: the same script produces byte-equal output twice", () => {
    const script = makeScript(
      [
        { sceneNumber: 1, filePath: "src/lib/a.ts" },
        { sceneNumber: 2, filePath: "src/lib/b.ts" },
        { sceneNumber: 3, filePath: "src/lib/c.ts" },
        { sceneNumber: 4, filePath: "src/api/d.ts" },
        { sceneNumber: 5, filePath: "src/api/e.ts" },
      ],
      ["src/lib/a.ts", "src/lib/b.ts"],
    );
    const layoutA = computeGraphLayout(script);
    const layoutB = computeGraphLayout(script);
    expect(JSON.stringify(layoutA)).toBe(JSON.stringify(layoutB));
  });

  it("clusters nodes by directory when the graph grows beyond the cluster threshold", () => {
    const scenes = Array.from({ length: 22 }, (_, i) => ({
      sceneNumber: i + 1,
      filePath: `src/${i < 11 ? "lib" : "api"}/file${i}.ts`,
    }));
    const script = makeScript(scenes);
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toHaveLength(22);
    // Nodes should still be inside the viewport after the simulation runs.
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(NODE_MARGIN);
      expect(node.x).toBeLessThanOrEqual(DEFAULT_VIEWPORT_WIDTH - NODE_MARGIN);
      expect(node.y).toBeGreaterThanOrEqual(NODE_MARGIN);
      expect(node.y).toBeLessThanOrEqual(DEFAULT_VIEWPORT_HEIGHT - NODE_MARGIN);
    }
  });

  it("uses the force simulation exactly at the 4-node boundary", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/lib/a.ts" },
      { sceneNumber: 2, filePath: "src/lib/b.ts" },
      { sceneNumber: 3, filePath: "src/lib/c.ts" },
      { sceneNumber: 4, filePath: "src/api/d.ts" },
    ]);
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toHaveLength(4);
    // With < 4 the fallback puts every node on the same Y; with the force
    // simulation the nodes should not be perfectly colinear.
    const ys = new Set(layout.nodes.map((n) => Math.round(n.y)));
    expect(ys.size).toBeGreaterThan(1);
  });

  it("keeps all node positions finite for a single-cluster degenerate graph", () => {
    // 21 nodes all in the same directory — exercises the `> 20` clustering
    // path with `clusterCount = 1` where every node is seeded on a single
    // mini-ring (a classic source of NaN velocities under charge forces).
    const scenes = Array.from({ length: 21 }, (_, i) => ({
      sceneNumber: i + 1,
      filePath: `src/common/file${i}.ts`,
    }));
    const script = makeScript(scenes);
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toHaveLength(21);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(NODE_MARGIN);
      expect(node.x).toBeLessThanOrEqual(DEFAULT_VIEWPORT_WIDTH - NODE_MARGIN);
      expect(node.y).toBeGreaterThanOrEqual(NODE_MARGIN);
      expect(node.y).toBeLessThanOrEqual(DEFAULT_VIEWPORT_HEIGHT - NODE_MARGIN);
    }
    for (const edge of layout.edges) {
      // The bezier path must never contain NaN — any propagation would crash
      // downstream SVG rendering or Sharp rasterization.
      expect(edge.pathD).not.toContain("NaN");
      expect(edge.pathD).toMatch(/^M\s\d/);
    }
  });

  it("throws on a non-finite viewport", () => {
    const script = makeScript([{ sceneNumber: 1, filePath: "src/a.ts" }]);
    expect(() =>
      computeGraphLayout(script, { viewportWidth: Number.NaN }),
    ).toThrow(/non-finite viewport/);
  });

  it("throws when the viewport is too small to fit the node margin on both axes", () => {
    const script = makeScript([{ sceneNumber: 1, filePath: "src/a.ts" }]);
    expect(() =>
      computeGraphLayout(script, { viewportWidth: 100, viewportHeight: 100 }),
    ).toThrow(/too small/);
  });

  it("emits no edges when all nodes live in the empty-string directory (files at repo root)", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "a.ts" },
      { sceneNumber: 2, filePath: "b.ts" },
      { sceneNumber: 3, filePath: "c.ts" },
      { sceneNumber: 4, filePath: "d.ts" },
    ]);
    const layout = computeGraphLayout(script);
    // Four files all in directory "" — the same_directory check guards
    // against empty-string false clustering, so no edges should form
    // (unless keyFiles creates adjacency, which the fixture doesn't).
    expect(layout.edges).toEqual([]);
  });
});

describe("computeGraphLayout edgeDerivation option", () => {
  it("uses the default legacy derivation (same_directory / key_file_adjacency) when no option is provided", () => {
    // Two nodes in the same directory with no UML signals whatsoever — the
    // legacy derivation must still produce a same_directory edge.
    const script = makeScript(
      [
        { sceneNumber: 1, filePath: "src/lib/a.ts" },
        { sceneNumber: 2, filePath: "src/lib/b.ts" },
      ],
      ["src/lib/a.ts", "src/lib/b.ts"],
    );
    const layout = computeGraphLayout(script);
    expect(layout.edges.length).toBeGreaterThan(0);
    // Every edge must be one of the legacy kinds — not UML
    for (const edge of layout.edges) {
      expect(["same_directory", "key_file_adjacency"]).toContain(edge.relationship);
    }
  });

  it("calls the provided edgeDerivation callback with the node list and script", () => {
    const fakeEdges: DerivedEdge[] = [
      { sourceSceneNumber: 1, targetSceneNumber: 2, sourceNodeId: "src/a.ts", targetNodeId: "src/b.ts", relationship: "inheritance" },
    ];
    const callback = vi.fn<(nodes: GraphNode[], s: VideoScript) => DerivedEdge[]>(() => fakeEdges);

    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2, filePath: "src/b.ts" },
    ]);
    const layout = computeGraphLayout(script, { edgeDerivation: callback });

    // Callback was invoked at least once with an array of GraphNode and the script
    expect(callback).toHaveBeenCalled();
    const firstCall = callback.mock.calls[0];
    expect(Array.isArray(firstCall[0])).toBe(true);
    expect(firstCall[0].every((n) => typeof n.sceneNumber === "number")).toBe(true);
    expect(firstCall[1]).toBe(script);

    // The returned edges carry the callback's relationship through untouched
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0].relationship).toBe("inheritance");
    expect(layout.edges[0].sourceSceneNumber).toBe(1);
    expect(layout.edges[0].targetSceneNumber).toBe(2);
    // pathD should be populated (quadratic bezier between the placed nodes)
    expect(layout.edges[0].pathD).toMatch(/^M\s\d/);
  });

  it("calls edgeDerivation for BOTH the force-simulation seed pass and the final edge list (4+ nodes)", () => {
    // With >=4 nodes, computeGraphLayout runs the force simulation and calls
    // the derivation twice: once on the seeded preview nodes (for the link
    // force) and once on the final placedNodes (for the returned edge list).
    // This test locks that in.
    const callback = vi.fn<(nodes: GraphNode[], s: VideoScript) => DerivedEdge[]>(() => []);
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/lib/a.ts" },
      { sceneNumber: 2, filePath: "src/lib/b.ts" },
      { sceneNumber: 3, filePath: "src/api/c.ts" },
      { sceneNumber: 4, filePath: "src/api/d.ts" },
    ]);
    computeGraphLayout(script, { edgeDerivation: callback });
    // Expected: one call for the force-simulation link seed + one for the
    // final edge list = 2 total invocations.
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("accepts deriveReviewPageEdges end-to-end and produces UML edges from code snippets", () => {
    // Smoke test: the real `deriveReviewPageEdges` function should produce
    // an inheritance edge when the script has `class X extends Y`.
    const script: VideoScript = {
      changeType: "feature",
      summary: "",
      headline: "",
      totalDurationSeconds: 12,
      totalWordCount: 40,
      keyFiles: ["src/Base.ts", "src/Derived.ts"],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "code_walkthrough",
          durationSeconds: 6,
          narration: "n1",
          codeBroll: [
            {
              filePath: "src/Base.ts",
              code: "export class Base {}",
              language: "typescript",
              lineRange: [1, 1],
              highlights: [],
            },
          ],
        },
        {
          sceneNumber: 2,
          sceneType: "code_walkthrough",
          durationSeconds: 6,
          narration: "n2",
          codeBroll: [
            {
              filePath: "src/Derived.ts",
              code: "class Derived extends Base {}",
              language: "typescript",
              lineRange: [1, 1],
              highlights: [],
            },
          ],
        },
      ],
    };

    const layout = computeGraphLayout(script, { edgeDerivation: deriveReviewPageEdges });
    const inheritanceEdges = layout.edges.filter((e) => e.relationship === "inheritance");
    expect(inheritanceEdges).toHaveLength(1);
    // None of the legacy kinds should appear (deriveReviewPageEdges excludes them)
    expect(
      layout.edges.some(
        (e) => e.relationship === "same_directory" || e.relationship === "key_file_adjacency",
      ),
    ).toBe(false);
  });

  it("preserves the legacy in-video graph behavior when called without an edgeDerivation option", () => {
    // Regression guard: the Remotion/FFmpeg compositors call `computeGraphLayout(script)`
    // with no options. They must still receive edges classified as
    // same_directory / key_file_adjacency, not UML kinds.
    const script = makeScript(
      [
        { sceneNumber: 1, filePath: "src/lib/a.ts" },
        { sceneNumber: 2, filePath: "src/lib/b.ts" },
        { sceneNumber: 3, filePath: "src/lib/c.ts" },
        { sceneNumber: 4, filePath: "src/lib/d.ts" },
      ],
      ["src/lib/a.ts", "src/lib/b.ts"],
    );
    const layout = computeGraphLayout(script);
    expect(layout.edges.length).toBeGreaterThan(0);
    const relationshipKinds = new Set(layout.edges.map((e) => e.relationship));
    // No UML relationships leak into the legacy path
    expect(relationshipKinds.has("inheritance")).toBe(false);
    expect(relationshipKinds.has("realization")).toBe(false);
    expect(relationshipKinds.has("composition")).toBe(false);
    expect(relationshipKinds.has("dependency")).toBe(false);
    expect(relationshipKinds.has("association")).toBe(false);
    expect(relationshipKinds.has("test_pair")).toBe(false);
  });
});

describe("computeGraphLayout multi-snippet scenes", () => {
  it("produces multiple nodes from a multi-snippet scene", () => {
    const script = makeScript([
      { sceneNumber: 1, filePaths: ["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"] },
      { sceneNumber: 2, filePath: "src/api/d.ts" },
    ]);
    const layout = computeGraphLayout(script);
    expect(layout.nodes).toHaveLength(4);
    // All three files from scene 1 share the same sceneNumber
    const scene1Nodes = layout.nodes.filter((n) => n.sceneNumber === 1);
    expect(scene1Nodes).toHaveLength(3);
    expect(scene1Nodes.map((n) => n.filePath).sort()).toEqual(["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"]);
  });

  it("deduplicates across scenes even when file appears in secondary codeBroll position", () => {
    const script = makeScript([
      { sceneNumber: 1, filePaths: ["src/a.ts", "src/b.ts"] },
      { sceneNumber: 2, filePaths: ["src/b.ts", "src/c.ts"] }, // b.ts is a revisit
    ]);
    const layout = computeGraphLayout(script);
    // 3 unique files: a.ts (scene 1), b.ts (scene 1), c.ts (scene 2)
    expect(layout.nodes).toHaveLength(3);
    const bNode = layout.nodes.find((n) => n.filePath === "src/b.ts");
    expect(bNode?.sceneNumber).toBe(1); // first occurrence owns it
  });

  it("populates nodeId as filePath on every node", () => {
    const script = makeScript([
      { sceneNumber: 1, filePaths: ["src/a.ts", "src/b.ts"] },
    ]);
    const layout = computeGraphLayout(script);
    for (const node of layout.nodes) {
      expect(node.nodeId).toBe(node.filePath);
    }
  });

  it("populates sourceNodeId and targetNodeId on edges", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/lib/a.ts" },
      { sceneNumber: 2, filePath: "src/lib/b.ts" },
    ]);
    const layout = computeGraphLayout(script);
    expect(layout.edges.length).toBeGreaterThan(0);
    for (const edge of layout.edges) {
      expect(edge.sourceNodeId).toBeTruthy();
      expect(edge.targetNodeId).toBeTruthy();
    }
  });
});

describe("getConstellationOwnerSceneNumbers", () => {
  // Import is at the top; getConstellationOwnerSceneNumbers is re-exported
  it("returns scenes that first introduce a file", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2, filePath: "src/b.ts" },
      { sceneNumber: 3, filePath: "src/a.ts" }, // revisit
    ]);
    const owners = getConstellationOwnerSceneNumbers(script.scenes);
    expect(owners).toEqual(new Set([1, 2]));
  });

  it("includes a scene when its secondary codeBroll introduces a new file", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2, filePaths: ["src/a.ts", "src/b.ts"] }, // a.ts revisit, b.ts new
    ]);
    const owners = getConstellationOwnerSceneNumbers(script.scenes);
    expect(owners).toEqual(new Set([1, 2]));
  });

  it("excludes scenes with no codeBroll", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2 }, // no codeBroll
    ]);
    const owners = getConstellationOwnerSceneNumbers(script.scenes);
    expect(owners).toEqual(new Set([1]));
  });

  it("excludes pure revisit scenes where all files were previously seen", () => {
    const script = makeScript([
      { sceneNumber: 1, filePaths: ["src/a.ts", "src/b.ts"] },
      { sceneNumber: 2, filePaths: ["src/a.ts", "src/b.ts"] }, // all revisits
    ]);
    const owners = getConstellationOwnerSceneNumbers(script.scenes);
    expect(owners).toEqual(new Set([1]));
  });
});
