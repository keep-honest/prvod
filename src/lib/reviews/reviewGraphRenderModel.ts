import type { ReviewGraphData, ReviewGraphEdge, ReviewGraphNode } from "@/domain/entities/ReviewGraph";

export interface ReviewGraphSpatialIndex {
  cellSize: number;
  cells: Map<string, Set<string>>;
  nodeCells: Map<string, string>;
}

export interface ReviewGraphRenderEdge {
  id: string;
  edge: ReviewGraphEdge;
}

export interface ReviewGraphRenderModel {
  graph: ReviewGraphData;
  nodesById: Map<string, ReviewGraphNode>;
  edgesById: Map<string, ReviewGraphRenderEdge>;
  edgeIds: string[];
  incidentEdgesByNodeId: Map<string, string[]>;
  rankedNodes: ReviewGraphNode[];
  spatialIndex: ReviewGraphSpatialIndex;
}

const DEFAULT_CELL_SIZE = 160;

function toCellKey(x: number, y: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

export function reviewGraphEdgeId(edge: ReviewGraphEdge): string {
  return `${edge.sourceId}::${edge.targetId}::${edge.relationship}`;
}

export function buildReviewGraphSpatialIndex(
  nodes: readonly ReviewGraphNode[],
  cellSize = DEFAULT_CELL_SIZE,
): ReviewGraphSpatialIndex {
  const cells = new Map<string, Set<string>>();
  const nodeCells = new Map<string, string>();

  for (const node of nodes) {
    const key = toCellKey(node.x, node.y, cellSize);
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      cells.set(key, bucket);
    }
    bucket.add(node.id);
    nodeCells.set(node.id, key);
  }

  return {
    cellSize,
    cells,
    nodeCells,
  };
}

export function queryReviewGraphSpatialIndex(
  index: ReviewGraphSpatialIndex,
  point: { x: number; y: number },
  radius: number,
): string[] {
  const minCellX = Math.floor((point.x - radius) / index.cellSize);
  const maxCellX = Math.floor((point.x + radius) / index.cellSize);
  const minCellY = Math.floor((point.y - radius) / index.cellSize);
  const maxCellY = Math.floor((point.y + radius) / index.cellSize);
  const ids = new Set<string>();

  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      const bucket = index.cells.get(`${cellX}:${cellY}`);
      if (!bucket) continue;
      for (const id of bucket) {
        ids.add(id);
      }
    }
  }

  return [...ids];
}

export function updateReviewGraphSpatialIndexNode(
  index: ReviewGraphSpatialIndex,
  nodeId: string,
  previous: { x: number; y: number },
  next: { x: number; y: number },
): void {
  const previousKey = index.nodeCells.get(nodeId) ?? toCellKey(previous.x, previous.y, index.cellSize);
  const nextKey = toCellKey(next.x, next.y, index.cellSize);
  if (previousKey === nextKey) {
    index.nodeCells.set(nodeId, nextKey);
    return;
  }

  const previousBucket = index.cells.get(previousKey);
  previousBucket?.delete(nodeId);
  if (previousBucket && previousBucket.size === 0) {
    index.cells.delete(previousKey);
  }

  let nextBucket = index.cells.get(nextKey);
  if (!nextBucket) {
    nextBucket = new Set<string>();
    index.cells.set(nextKey, nextBucket);
  }
  nextBucket.add(nodeId);
  index.nodeCells.set(nodeId, nextKey);
}

export function buildReviewGraphRenderModel(graph: ReviewGraphData): ReviewGraphRenderModel {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map<string, ReviewGraphRenderEdge>();
  const incidentEdgesByNodeId = new Map<string, string[]>();

  for (const node of graph.nodes) {
    incidentEdgesByNodeId.set(node.id, []);
  }

  for (const edge of graph.edges) {
    const id = reviewGraphEdgeId(edge);
    edgesById.set(id, { id, edge });
    incidentEdgesByNodeId.get(edge.sourceId)?.push(id);
    incidentEdgesByNodeId.get(edge.targetId)?.push(id);
  }

  return {
    graph,
    nodesById,
    edgesById,
    edgeIds: [...edgesById.keys()],
    incidentEdgesByNodeId,
    rankedNodes: [...graph.nodes].sort(
      (a, b) => b.importance - a.importance || a.label.localeCompare(b.label),
    ),
    spatialIndex: buildReviewGraphSpatialIndex(graph.nodes),
  };
}
