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

export interface VisibleReviewGraphLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  emphasis: "selected" | "hovered" | "context";
}

export const REVIEW_GRAPH_MIN_ZOOM = 0.42;
export const REVIEW_GRAPH_MAX_ZOOM = 2.8;
export const REVIEW_GRAPH_WORLD_PADDING = 180;
export const REVIEW_GRAPH_LABEL_ZOOM = 0.86;
export const REVIEW_GRAPH_LABEL_LIMIT = 14;

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

export function clampReviewGraphCamera(
  graph: Pick<ReviewGraphData, "nodes">,
  camera: ReviewGraphCamera,
  _viewport: ReviewGraphScreenViewport,
): ReviewGraphCamera {
  if (graph.nodes.length === 0) {
    return { x: 0, y: 0, zoom: 1 };
  }

  const zoom = clamp(camera.zoom, REVIEW_GRAPH_MIN_ZOOM, REVIEW_GRAPH_MAX_ZOOM);
  return {
    x: camera.x,
    y: camera.y,
    zoom,
  };
}

export function scaleReviewGraphCameraToViewport(
  camera: ReviewGraphCamera,
  sourceViewport: ReviewGraphScreenViewport,
  targetViewport: ReviewGraphScreenViewport,
): ReviewGraphCamera {
  if (sourceViewport.width <= 0 || sourceViewport.height <= 0) {
    return camera;
  }

  return {
    x: camera.x,
    y: camera.y,
    zoom: clamp(
      camera.zoom
        * Math.min(
          targetViewport.width / sourceViewport.width,
          targetViewport.height / sourceViewport.height,
        ),
      REVIEW_GRAPH_MIN_ZOOM,
      REVIEW_GRAPH_MAX_ZOOM,
    ),
  };
}

export function worldToScreenPoint(
  point: { x: number; y: number },
  camera: ReviewGraphCamera,
  viewport: ReviewGraphScreenViewport,
): { x: number; y: number } {
  return {
    x: (point.x - camera.x) * camera.zoom + viewport.width / 2,
    y: (point.y - camera.y) * camera.zoom + viewport.height / 2,
  };
}

export function screenToWorldPoint(
  point: { x: number; y: number },
  camera: ReviewGraphCamera,
  viewport: ReviewGraphScreenViewport,
): { x: number; y: number } {
  return {
    x: (point.x - viewport.width / 2) / camera.zoom + camera.x,
    y: (point.y - viewport.height / 2) / camera.zoom + camera.y,
  };
}

export function resolveReviewGraphFocusNode(
  graph: Pick<ReviewGraphData, "nodes">,
  args: { nodeId?: string | null; sceneNumber?: number | null },
): ReviewGraphNode | null {
  if (args.nodeId) {
    return graph.nodes.find((node) => node.id === args.nodeId) ?? null;
  }
  if (args.sceneNumber !== null && args.sceneNumber !== undefined) {
    return graph.nodes.find((node) => node.sceneNumbers.includes(args.sceneNumber as number)) ?? null;
  }
  return null;
}

export function resolveReviewGraphActiveNodes(
  graph: Pick<ReviewGraphData, "nodes">,
  sceneNumber?: number | null,
): ReviewGraphNode[] {
  if (sceneNumber === null || sceneNumber === undefined) {
    return [];
  }
  return graph.nodes.filter((node) => node.sceneNumbers.includes(sceneNumber));
}

export function pickReviewGraphNodeAtPoint(
  graph: Pick<ReviewGraphData, "nodes">,
  camera: ReviewGraphCamera,
  viewport: ReviewGraphScreenViewport,
  point: { x: number; y: number },
  hitSlop = 10,
): ReviewGraphNode | null {
  const world = screenToWorldPoint(point, camera, viewport);
  let closest: ReviewGraphNode | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const node of graph.nodes) {
    const dx = world.x - node.x;
    const dy = world.y - node.y;
    const distance = Math.hypot(dx, dy);
    if (distance > hitSlop / camera.zoom + 14) continue;
    if (distance < closestDistance) {
      closest = node;
      closestDistance = distance;
    }
  }

  return closest;
}

export function getVisibleReviewGraphLabels(args: {
  graph: ReviewGraphData;
  camera: ReviewGraphCamera;
  viewport: ReviewGraphScreenViewport;
  hoveredNodeId?: string | null;
  activeSceneNumber?: number | null;
  selectedNodeId?: string | null;
  labelLimit?: number;
  rankedNodes?: readonly ReviewGraphNode[];
  contextLabelsEnabled?: boolean;
}): VisibleReviewGraphLabel[] {
  const labelLimit = args.labelLimit ?? REVIEW_GRAPH_LABEL_LIMIT;
  const labels = new Map<string, VisibleReviewGraphLabel>();
  const addLabel = (node: ReviewGraphNode, emphasis: VisibleReviewGraphLabel["emphasis"]) => {
    const screen = worldToScreenPoint(node, args.camera, args.viewport);
    if (
      screen.x < -80
      || screen.x > args.viewport.width + 80
      || screen.y < -40
      || screen.y > args.viewport.height + 40
    ) {
      return;
    }

    labels.set(node.id, {
      id: node.id,
      text: node.label,
      x: Math.round(screen.x),
      y: Math.round(screen.y),
      emphasis,
    });
  };

  const hovered = resolveReviewGraphFocusNode(args.graph, { nodeId: args.hoveredNodeId ?? undefined });
  const selected = resolveReviewGraphFocusNode(args.graph, { nodeId: args.selectedNodeId ?? undefined });

  if (selected) {
    addLabel(selected, "selected");
  }
  if (hovered) addLabel(hovered, selected?.id === hovered.id ? "selected" : "hovered");

  const contextLabelsEnabled = args.contextLabelsEnabled ?? true;
  if (contextLabelsEnabled && args.camera.zoom >= REVIEW_GRAPH_LABEL_ZOOM) {
    const ranked = (args.rankedNodes ?? args.graph.nodes)
      .slice(0, Math.max(0, labelLimit - labels.size));
    for (const node of ranked) {
      if (!labels.has(node.id)) {
        addLabel(node, "context");
      }
    }
  }

  return [...labels.values()];
}
