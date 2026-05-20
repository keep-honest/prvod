import type {
  ReviewGraphData,
  ReviewGraphEdge,
  ReviewGraphNode,
  ReviewGraphSource,
} from "@/domain/entities/ReviewGraph";
import type { VideoScript } from "@/domain/entities/VideoScript";
import { fitReviewGraphCamera } from "@/lib/reviews/reviewGraphMath";
import { clamp } from "@/lib/math";
import { createLogger } from "@/lib/logger";
import { getBasename, isTestBasename } from "./graphRelationships";
import {
  collectReviewGraphFiles,
  computeReviewFileLayout,
  deriveReviewFileEdges,
  type ReviewGraphCanonicalFiles,
  type ReviewFileLayoutResult,
} from "./reviewFileGraph";
import type { GraphEdgeRelationship } from "./types";

const logger = createLogger("buildReviewGraphData");

const REVIEW_GRAPH_VIEWPORT = {
  width: 2560,
  height: 1600,
} as const;

const EDGE_STRENGTH: Record<GraphEdgeRelationship, number> = {
  inheritance: 1,
  realization: 0.94,
  composition: 0.88,
  dependency: 0.7,
  test_pair: 0.82,
  association: 0.56,
  same_directory: 0.5,
  key_file_adjacency: 0.44,
};

function deriveClusterIds(layout: ReviewFileLayoutResult): Map<string, string> {
  const neighbors = new Map<string, string[]>();

  for (const node of layout.nodes) {
    neighbors.set(node.filePath, []);
  }

  for (const edge of layout.edges) {
    neighbors.get(edge.sourceFilePath)?.push(edge.targetFilePath);
    neighbors.get(edge.targetFilePath)?.push(edge.sourceFilePath);
  }

  const visited = new Set<string>();
  const clusters = new Map<string, string>();
  let index = 0;

  for (const node of layout.nodes) {
    if (visited.has(node.filePath)) continue;
    index += 1;
    const clusterId = `cluster-${index}`;
    const queue = [node.filePath];
    visited.add(node.filePath);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      clusters.set(current, clusterId);
      for (const neighbor of neighbors.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return clusters;
}

export function toReviewGraphData(
  layout: ReviewFileLayoutResult,
  script: VideoScript,
  canonicalFiles?: ReviewGraphCanonicalFiles,
): ReviewGraphData {
  const fileSources = collectReviewGraphFiles(script, canonicalFiles);
  const sourceByFilePath = new Map(
    fileSources.map((source) => [source.filePath, source] as const),
  );
  const degreeByFilePath = new Map<string, number>();

  for (const node of layout.nodes) {
    degreeByFilePath.set(node.filePath, 0);
  }
  for (const edge of layout.edges) {
    degreeByFilePath.set(
      edge.sourceFilePath,
      (degreeByFilePath.get(edge.sourceFilePath) ?? 0) + 1,
    );
    degreeByFilePath.set(
      edge.targetFilePath,
      (degreeByFilePath.get(edge.targetFilePath) ?? 0) + 1,
    );
  }

  const maxDegree = Math.max(1, ...degreeByFilePath.values());
  const keyFileIndex = new Map(script.keyFiles.map((filePath, index) => [filePath, index]));
  const clusterIds = deriveClusterIds(layout);

  const nodes: ReviewGraphNode[] = layout.nodes.flatMap((node) => {
    const source = sourceByFilePath.get(node.filePath);
    if (!source) return [];
    const degree = degreeByFilePath.get(node.filePath) ?? 0;
    const keyFileRank = keyFileIndex.get(node.filePath);
    const keyFileBonus = keyFileRank === undefined
      ? 0
      : Math.max(0.08, 0.28 - keyFileRank * 0.025);

    return [{
      id: node.filePath,
      filePath: node.filePath,
      label: node.label,
      x: Math.round(node.x * 100) / 100,
      y: Math.round(node.y * 100) / 100,
      sceneNumbers: source.sceneNumbers,
      primarySceneNumber: source.primarySceneNumber,
      degree,
      clusterId: clusterIds.get(node.filePath) ?? `cluster-file-${getBasename(node.filePath)}`,
      isTest: isTestBasename(getBasename(node.filePath)),
      importance: clamp(0.3 + (degree / maxDegree) * 0.45 + keyFileBonus, 0.25, 1),
    }];
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const edges: ReviewGraphEdge[] = layout.edges.flatMap((edge) => {
    const source = nodeById.get(edge.sourceFilePath);
    const target = nodeById.get(edge.targetFilePath);
    if (!source || !target || source.id === target.id) return [];
    return [{
      sourceId: source.id,
      targetId: target.id,
      relationship: edge.relationship,
      strength: EDGE_STRENGTH[edge.relationship] ?? 0.5,
    }];
  });

  return {
    nodes,
    edges,
    viewport: {
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      initialCamera: fitReviewGraphCamera(
        { nodes },
        {
          width: layout.viewportWidth,
          height: layout.viewportHeight,
        },
      ),
    },
  };
}

export function buildReviewGraphData(
  script: VideoScript,
  jobId: string,
  reviewGraphSource?: ReviewGraphSource,
): ReviewGraphData | undefined {
  try {
    const files = collectReviewGraphFiles(script, reviewGraphSource?.files);
    if (files.length < 2) {
      logger.debug("Review graph skipped — fewer than 2 file nodes", {
        jobId,
        nodeCount: files.length,
      });
      return undefined;
    }

    const edges = deriveReviewFileEdges(files);
    const layout = computeReviewFileLayout(
      files,
      edges,
      REVIEW_GRAPH_VIEWPORT.width,
      REVIEW_GRAPH_VIEWPORT.height,
    );

    return toReviewGraphData(layout, script, reviewGraphSource?.files);
  } catch (err) {
    logger.error("Unexpected failure computing review graph data — omitting graph", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return undefined;
  }
}

export function buildSyntheticReviewGraphData(nodeCount: number): ReviewGraphData {
  const nodes: ReviewGraphNode[] = Array.from({ length: nodeCount }, (_, index) => {
    const angle = (index / Math.max(1, nodeCount)) * Math.PI * 2;
    const orbit = 420 + (index % 11) * 18;
    return {
      id: `src/module-${index}.ts`,
      filePath: `src/module-${index}.ts`,
      label: `module-${index}.ts`,
      x: REVIEW_GRAPH_VIEWPORT.width / 2 + Math.cos(angle) * orbit,
      y: REVIEW_GRAPH_VIEWPORT.height / 2 + Math.sin(angle) * orbit,
      sceneNumbers: [index + 1],
      primarySceneNumber: index + 1,
      degree: 2,
      clusterId: `cluster-${(index % 6) + 1}`,
      isTest: false,
      importance: 0.42 + ((index % 7) / 20),
    };
  });

  const edges: ReviewGraphEdge[] = nodes.flatMap((node, index) => {
    const next = nodes[(index + 1) % nodes.length];
    const skip = nodes[(index + 11) % nodes.length];
    const outgoing: ReviewGraphEdge[] = [
      {
        sourceId: node.id,
        targetId: next.id,
        relationship: "dependency",
        strength: EDGE_STRENGTH.dependency,
      },
    ];
    if (skip && skip.id !== node.id && skip.id !== next.id) {
      outgoing.push({
        sourceId: node.id,
        targetId: skip.id,
        relationship: "association",
        strength: EDGE_STRENGTH.association,
      });
    }
    return outgoing;
  });

  return {
    nodes,
    edges,
    viewport: {
      width: REVIEW_GRAPH_VIEWPORT.width,
      height: REVIEW_GRAPH_VIEWPORT.height,
      initialCamera: fitReviewGraphCamera(
        { nodes },
        REVIEW_GRAPH_VIEWPORT,
      ),
    },
  };
}
