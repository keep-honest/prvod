import { describe, it, expect } from "vitest";
import {
  clampReviewGraphCamera,
  fitReviewGraphCamera,
  getVisibleReviewGraphLabels,
  pickReviewGraphNodeAtPoint,
  resolveReviewGraphActiveNodes,
  scaleReviewGraphCameraToViewport,
  screenToWorldPoint,
  worldToScreenPoint,
  REVIEW_GRAPH_MIN_ZOOM,
  REVIEW_GRAPH_MAX_ZOOM,
} from "@/lib/reviews/reviewGraphMath";
import { makeReviewNode as makeNode, makeReviewGraph as makeGraph } from "./fixtures";

const viewport = { width: 800, height: 600 };

describe("worldToScreenPoint / screenToWorldPoint round-trip", () => {
  it("round-trips at zoom 1 centered at origin", () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const world = { x: 100, y: -50 };
    const screen = worldToScreenPoint(world, camera, viewport);
    const back = screenToWorldPoint(screen, camera, viewport);
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.y).toBeCloseTo(world.y, 10);
  });

  it("round-trips at zoom 2 with offset camera", () => {
    const camera = { x: 300, y: 200, zoom: 2 };
    const world = { x: 500, y: 400 };
    const screen = worldToScreenPoint(world, camera, viewport);
    const back = screenToWorldPoint(screen, camera, viewport);
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.y).toBeCloseTo(world.y, 10);
  });

  it("camera center maps to viewport center", () => {
    const camera = { x: 250, y: 180, zoom: 1.5 };
    const screen = worldToScreenPoint({ x: camera.x, y: camera.y }, camera, viewport);
    expect(screen.x).toBeCloseTo(viewport.width / 2, 10);
    expect(screen.y).toBeCloseTo(viewport.height / 2, 10);
  });
});

describe("scaleReviewGraphCameraToViewport", () => {
  it("scales zoom proportionally when target is larger", () => {
    const camera = { x: 100, y: 200, zoom: 1 };
    const source = { width: 400, height: 300 };
    const target = { width: 800, height: 600 };
    const result = scaleReviewGraphCameraToViewport(camera, source, target);
    expect(result.x).toBe(camera.x);
    expect(result.y).toBe(camera.y);
    expect(result.zoom).toBeCloseTo(2, 5);
  });

  it("scales zoom proportionally when target is smaller", () => {
    const camera = { x: 0, y: 0, zoom: 2 };
    const source = { width: 800, height: 600 };
    const target = { width: 400, height: 300 };
    const result = scaleReviewGraphCameraToViewport(camera, source, target);
    expect(result.zoom).toBeCloseTo(1, 5);
  });

  it("clamps zoom to max", () => {
    const camera = { x: 0, y: 0, zoom: 2 };
    const source = { width: 100, height: 100 };
    const target = { width: 1000, height: 1000 };
    const result = scaleReviewGraphCameraToViewport(camera, source, target);
    expect(result.zoom).toBeLessThanOrEqual(REVIEW_GRAPH_MAX_ZOOM);
  });

  it("clamps zoom to min", () => {
    const camera = { x: 0, y: 0, zoom: 0.5 };
    const source = { width: 1000, height: 1000 };
    const target = { width: 50, height: 50 };
    const result = scaleReviewGraphCameraToViewport(camera, source, target);
    expect(result.zoom).toBeGreaterThanOrEqual(REVIEW_GRAPH_MIN_ZOOM);
  });

  it("returns camera unchanged for zero-size source viewport", () => {
    const camera = { x: 100, y: 200, zoom: 1.5 };
    const result = scaleReviewGraphCameraToViewport(camera, { width: 0, height: 0 }, viewport);
    expect(result).toEqual(camera);
  });
});

describe("clampReviewGraphCamera edge cases", () => {
  it("preserves camera position while clamping zoom", () => {
    const graph = makeGraph([
      makeNode({ x: 100, y: 100 }),
      makeNode({ id: "src/bar.ts", filePath: "src/bar.ts", x: 120, y: 100, primarySceneNumber: 2, sceneNumbers: [2] }),
    ]);
    const result = clampReviewGraphCamera(graph, { x: -50, y: 999, zoom: 10 }, { width: 2000, height: 1500 });
    expect(result.x).toBe(-50);
    expect(result.y).toBe(999);
    expect(result.zoom).toBeLessThanOrEqual(REVIEW_GRAPH_MAX_ZOOM);
  });

  it("returns default for empty graph", () => {
    const empty = makeGraph([]);
    const result = clampReviewGraphCamera(empty, { x: 999, y: 999, zoom: 5 }, viewport);
    expect(result).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("fitReviewGraphCamera", () => {
  it("returns default for empty graph", () => {
    const result = fitReviewGraphCamera({ nodes: [] }, viewport);
    expect(result).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("centers on a single node", () => {
    const node = makeNode({ x: 300, y: 200 });
    const result = fitReviewGraphCamera({ nodes: [node] }, viewport);
    expect(result.x).toBeCloseTo(300, 0);
    expect(result.y).toBeCloseTo(200, 0);
  });
});

describe("resolveReviewGraphActiveNodes", () => {
  it("returns all nodes that belong to the active scene", () => {
    const graph = makeGraph([
      makeNode({ id: "a", sceneNumbers: [1, 2] }),
      makeNode({ id: "b", filePath: "src/bar.ts", sceneNumbers: [2, 3], primarySceneNumber: 2 }),
      makeNode({ id: "c", filePath: "src/baz.ts", sceneNumbers: [4], primarySceneNumber: 4 }),
    ]);
    expect(resolveReviewGraphActiveNodes(graph, 2).map((node) => node.id).sort()).toEqual(["a", "b"]);
  });
});

describe("pickReviewGraphNodeAtPoint", () => {
  it("picks the closest node within hit slop", () => {
    const nodes = [
      makeNode({ id: "a", x: 100, y: 100, sceneNumbers: [1] }),
      makeNode({ id: "b", filePath: "src/bar.ts", x: 200, y: 200, primarySceneNumber: 2, sceneNumbers: [2] }),
    ];
    const graph = makeGraph(nodes);
    const camera = { x: 150, y: 150, zoom: 1 };
    const screenA = worldToScreenPoint({ x: 105, y: 105 }, camera, viewport);
    const result = pickReviewGraphNodeAtPoint(graph, camera, viewport, screenA);
    expect(result?.id).toBe("a");
  });

  it("returns null when no node is within range", () => {
    const graph = makeGraph([makeNode({ x: 100, y: 100 })]);
    const camera = { x: 500, y: 500, zoom: 0.5 };
    const result = pickReviewGraphNodeAtPoint(graph, camera, viewport, { x: 0, y: 0 });
    expect(result).toBeNull();
  });
});

describe("getVisibleReviewGraphLabels", () => {
  it("culls labels outside viewport bounds", () => {
    const farNode = makeNode({ id: "far", x: -10000, y: -10000, importance: 1 });
    const nearNode = makeNode({ id: "near", filePath: "src/near.ts", x: 400, y: 300, importance: 0.9, primarySceneNumber: 2, sceneNumbers: [2] });
    const graph = makeGraph([farNode, nearNode]);
    const camera = { x: 400, y: 300, zoom: 1 };
    const labels = getVisibleReviewGraphLabels({
      graph,
      camera,
      viewport,
      activeSceneNumber: null,
    });
    const ids = labels.map((label) => label.id);
    expect(ids).toContain("near");
    expect(ids).not.toContain("far");
  });

  it("always shows the selected node label regardless of zoom", () => {
    const graph = makeGraph([
      makeNode({ id: "a", sceneNumbers: [3], primarySceneNumber: 3 }),
      makeNode({ id: "b", filePath: "src/bar.ts", sceneNumbers: [3], primarySceneNumber: 3 }),
    ]);
    const camera = { x: 500, y: 400, zoom: 0.5 };
    const labels = getVisibleReviewGraphLabels({
      graph,
      camera,
      viewport,
      selectedNodeId: "a",
    });
    expect(labels).toHaveLength(1);
    expect(labels[0]?.id).toBe("a");
    expect(labels[0]?.emphasis).toBe("selected");
  });

  it("shows context labels when zoomed in above threshold", () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode({
        id: `src/m${i}.ts`,
        filePath: `src/m${i}.ts`,
        x: 400 + i * 20,
        y: 300,
        primarySceneNumber: i + 1,
        sceneNumbers: [i + 1],
        importance: 0.8 - i * 0.1,
      }),
    );
    const graph = makeGraph(nodes);
    const camera = { x: 450, y: 300, zoom: 1.2 };
    const labels = getVisibleReviewGraphLabels({
      graph,
      camera,
      viewport,
      activeSceneNumber: null,
    });
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.emphasis === "context")).toBe(true);
  });

  it("suppresses context labels while interaction mode is active", () => {
    const graph = makeGraph([
      makeNode({ id: "a", sceneNumbers: [1], primarySceneNumber: 1, importance: 0.9 }),
      makeNode({ id: "b", filePath: "src/bar.ts", sceneNumbers: [2], primarySceneNumber: 2, importance: 0.8 }),
    ]);
    const camera = { x: 500, y: 400, zoom: 1.2 };
    const labels = getVisibleReviewGraphLabels({
      graph,
      camera,
      viewport,
      activeSceneNumber: null,
      contextLabelsEnabled: false,
    });

    expect(labels).toEqual([]);
  });
});
