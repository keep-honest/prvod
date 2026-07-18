import { describe, expect, it } from "vitest";
import type { ReviewGraphData } from "@/domain/entities/ReviewGraph";
import { screenToWorldPoint, worldToScreenPoint } from "@/lib/reviews/reviewGraphMath";
import {
  buildReviewGraphRenderModel,
  queryReviewGraphSpatialIndex,
  updateReviewGraphSpatialIndexNode,
} from "@/lib/reviews/reviewGraphRenderModel";
import { makeReviewNode as makeNode, makeReviewGraph } from "./fixtures";

/** Extends shared makeReviewGraph with a dependency edge for render model tests. */
function makeGraph(nodes: Parameters<typeof makeReviewGraph>[0]): ReviewGraphData {
  const graph = makeReviewGraph(nodes);
  graph.edges = [
    {
      sourceId: nodes[0]?.id ?? "a",
      targetId: nodes[1]?.id ?? "b",
      relationship: "dependency",
      strength: 0.7,
    },
  ];
  return graph;
}

describe("buildReviewGraphRenderModel", () => {
  it("indexes edges by node incidence and pre-ranks nodes by importance", () => {
    const graph = makeGraph([
      makeNode({ id: "a", importance: 0.2 }),
      makeNode({ id: "b", filePath: "src/bar.ts", label: "bar.ts", importance: 0.9, primarySceneNumber: 2, sceneNumbers: [2] }),
      makeNode({ id: "c", filePath: "src/baz.ts", label: "baz.ts", importance: 0.5, primarySceneNumber: 3, sceneNumbers: [3] }),
    ]);

    const model = buildReviewGraphRenderModel(graph);
    expect(model.incidentEdgesByNodeId.get("a")).toHaveLength(1);
    expect(model.incidentEdgesByNodeId.get("b")).toHaveLength(1);
    expect(model.rankedNodes.map((node) => node.id)).toEqual(["b", "c", "a"]);
  });
});

describe("reviewGraphSpatialIndex", () => {
  it("returns the same nearby node candidates as a world-space lookup window", () => {
    const graph = makeGraph([
      makeNode({ id: "a", x: 120, y: 140 }),
      makeNode({ id: "b", filePath: "src/bar.ts", x: 500, y: 480, primarySceneNumber: 2, sceneNumbers: [2] }),
      makeNode({ id: "c", filePath: "src/baz.ts", x: 900, y: 880, primarySceneNumber: 3, sceneNumbers: [3] }),
    ]);
    const model = buildReviewGraphRenderModel(graph);
    const camera = { x: 500, y: 480, zoom: 1 };
    const viewport = { width: 800, height: 600 };
    const screenPoint = worldToScreenPoint({ x: 508, y: 486 }, camera, viewport);
    const worldPoint = screenToWorldPoint(screenPoint, camera, viewport);
    const candidates = queryReviewGraphSpatialIndex(model.spatialIndex, worldPoint, 30);

    expect(candidates).toContain("b");
    expect(candidates).not.toContain("a");
  });

  it("updates cell membership incrementally when a node is dragged", () => {
    const graph = makeGraph([
      makeNode({ id: "a", x: 120, y: 140 }),
      makeNode({ id: "b", filePath: "src/bar.ts", x: 500, y: 480, primarySceneNumber: 2, sceneNumbers: [2] }),
    ]);
    const model = buildReviewGraphRenderModel(graph);

    updateReviewGraphSpatialIndexNode(
      model.spatialIndex,
      "a",
      { x: 120, y: 140 },
      { x: 920, y: 940 },
    );

    expect(queryReviewGraphSpatialIndex(model.spatialIndex, { x: 120, y: 140 }, 60)).not.toContain("a");
    expect(queryReviewGraphSpatialIndex(model.spatialIndex, { x: 920, y: 940 }, 60)).toContain("a");
  });
});
