import type {
  ReviewGraphCamera,
  ReviewGraphData,
  ReviewGraphNode,
} from "@/domain/entities/ReviewGraph";
import { clamp } from "@/lib/math";

interface ReviewGraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ReviewGraphScreenViewport {
  width: number;
  height: number;
}

export const REVIEW_GRAPH_MIN_ZOOM = 0.42;
export const REVIEW_GRAPH_MAX_ZOOM = 2.8;
export const REVIEW_GRAPH_WORLD_PADDING = 180;

function getReviewGraphBounds(nodes: readonly ReviewGraphNode[]): ReviewGraphBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  return nodes.reduce<ReviewGraphBounds>(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      minY: Math.min(acc.minY, node.y),
      maxX: Math.max(acc.maxX, node.x),
      maxY: Math.max(acc.maxY, node.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

export function fitReviewGraphCamera(
  graph: Pick<ReviewGraphData, "nodes">,
  viewport: ReviewGraphScreenViewport,
  padding = REVIEW_GRAPH_WORLD_PADDING,
): ReviewGraphCamera {
  if (graph.nodes.length === 0) {
    return { x: 0, y: 0, zoom: 1 };
  }

  const bounds = getReviewGraphBounds(graph.nodes);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const usableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = clamp(
    Math.min(usableWidth / width, usableHeight / height),
    REVIEW_GRAPH_MIN_ZOOM,
    1.28,
  );

  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    zoom,
  };
}
