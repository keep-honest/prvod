/**
 * Shared test fixtures for review-graph unit tests.
 * Used by reviewGraphMath and reviewGraphRenderModel tests.
 */
import type { ReviewGraphNode, ReviewGraphData } from "@/domain/entities/ReviewGraph";

export function makeReviewNode(overrides: Partial<ReviewGraphNode> = {}): ReviewGraphNode {
  return {
    id: "src/foo.ts",
    filePath: "src/foo.ts",
    label: "foo.ts",
    x: 500,
    y: 400,
    sceneNumbers: [1],
    primarySceneNumber: 1,
    degree: 2,
    clusterId: "cluster-1",
    isTest: false,
    importance: 0.6,
    ...overrides,
  };
}

export function makeReviewGraph(nodes: ReviewGraphNode[]): ReviewGraphData {
  return {
    nodes,
    edges: [],
    viewport: { width: 1920, height: 1080, initialCamera: { x: 0, y: 0, zoom: 1 } },
  };
}
