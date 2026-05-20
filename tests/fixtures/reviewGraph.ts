import type { ReviewGraphData } from "@/domain/entities/ReviewGraph";

/**
 * Shared review graph fixture for constellation graph tests.
 *
 * Three-node graph with two edges. Node "src/lib/Auth.ts" belongs to
 * scenes [1, 3], "src/lib/Auth.test.ts" to [2], "src/app/page.tsx" to [3].
 * Used by: ConstellationGraphView, GraphModal, GraphModal.helpers, pipHandoff.
 */
export function makeReviewGraph(overrides: Partial<ReviewGraphData> = {}): ReviewGraphData {
  return {
    nodes: [
      {
        id: "src/lib/Auth.ts",
        filePath: "src/lib/Auth.ts",
        label: "Auth.ts",
        x: 500,
        y: 400,
        sceneNumbers: [1, 3],
        primarySceneNumber: 1,
        degree: 2,
        clusterId: "cluster-1",
        isTest: false,
        importance: 0.82,
      },
      {
        id: "src/lib/Auth.test.ts",
        filePath: "src/lib/Auth.test.ts",
        label: "Auth.test.ts",
        x: 900,
        y: 420,
        sceneNumbers: [2],
        primarySceneNumber: 2,
        degree: 1,
        clusterId: "cluster-1",
        isTest: true,
        importance: 0.61,
      },
      {
        id: "src/app/page.tsx",
        filePath: "src/app/page.tsx",
        label: "page.tsx",
        x: 1440,
        y: 780,
        sceneNumbers: [3],
        primarySceneNumber: 3,
        degree: 3,
        clusterId: "cluster-2",
        isTest: false,
        importance: 0.94,
      },
    ],
    edges: [
      {
        sourceId: "src/lib/Auth.ts",
        targetId: "src/lib/Auth.test.ts",
        relationship: "test_pair",
        strength: 0.82,
      },
      {
        sourceId: "src/lib/Auth.ts",
        targetId: "src/app/page.tsx",
        relationship: "dependency",
        strength: 0.7,
      },
    ],
    viewport: {
      width: 2560,
      height: 1600,
      initialCamera: { x: 920, y: 580, zoom: 0.7 },
    },
    ...overrides,
  };
}

/**
 * Two-node variant used by GraphModal and pipHandoff tests.
 * Replaces Auth.test.ts with api/login.ts (scene 2 only, no test flag).
 */
export function makeTwoNodeReviewGraph(overrides: Partial<ReviewGraphData> = {}): ReviewGraphData {
  return {
    nodes: [
      {
        id: "src/lib/Auth.ts",
        filePath: "src/lib/Auth.ts",
        label: "Auth.ts",
        x: 500,
        y: 400,
        sceneNumbers: [1, 3],
        primarySceneNumber: 1,
        degree: 2,
        clusterId: "cluster-1",
        isTest: false,
        importance: 0.82,
      },
      {
        id: "src/api/login.ts",
        filePath: "src/api/login.ts",
        label: "login.ts",
        x: 1200,
        y: 600,
        sceneNumbers: [2],
        primarySceneNumber: 2,
        degree: 1,
        clusterId: "cluster-2",
        isTest: false,
        importance: 0.71,
      },
    ],
    edges: [],
    viewport: {
      width: 2560,
      height: 1600,
      initialCamera: { x: 850, y: 500, zoom: 0.72 },
    },
    ...overrides,
  };
}
