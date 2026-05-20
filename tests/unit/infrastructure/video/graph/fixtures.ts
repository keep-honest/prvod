/**
 * Shared test fixtures for graph-related unit tests.
 * Used by graphRelationships, reviewPageRelationships, and umlRelationships tests.
 */
import type { VideoScript } from "@/domain/entities/VideoScript";
import { getDirectory } from "@/infrastructure/video/graph/graphRelationships";
import type { GraphNode } from "@/infrastructure/video/graph/types";

export function makeGraphNode(sceneNumber: number, filePath: string): GraphNode {
  return {
    nodeId: filePath,
    sceneNumber,
    filePath,
    x: 0,
    y: 0,
    label: filePath.split("/").pop() ?? filePath,
    directory: getDirectory(filePath),
    radius: 40,
  };
}

export function makeCodeScript(
  scenes: Array<{ sceneNumber: number; filePath: string; code: string }>,
): VideoScript {
  return {
    changeType: "feature",
    summary: "",
    headline: "",
    totalDurationSeconds: scenes.length * 6,
    totalWordCount: scenes.length * 20,
    keyFiles: scenes.map((s) => s.filePath),
    tags: [],
    narrativeRoles: [],
    voiceAssignments: [],
    scenes: scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      sceneType: "code_walkthrough",
      durationSeconds: 6,
      narration: "narration",
      codeBroll: [
        {
          filePath: s.filePath,
          code: s.code,
          language: "typescript",
          lineRange: [1, 1],
          highlights: [],
        },
      ],
    })),
  };
}
