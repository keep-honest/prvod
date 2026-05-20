/**
 * Constellation graph types — shared between Remotion compositor, FFmpeg
 * compositor, and the review page. All coordinates are in the video's canvas
 * space (1920x1080). The review page's SVG uses the same viewBox so positions
 * are reused verbatim without recalculation.
 */

export type { GraphEdgeRelationship } from "@/domain/entities/ReviewGraph";
import type { GraphEdgeRelationship } from "@/domain/entities/ReviewGraph";

export interface GraphNode {
  /** Unique node identity — equals `filePath` (guaranteed unique after dedup). */
  nodeId: string;
  /** Scene that first introduced this file (used for temporal visibility ordering). */
  sceneNumber: number;
  /** Full file path from the scene's codeBroll. */
  filePath: string;
  /** X coordinate in canvas space (0..viewportWidth). */
  x: number;
  /** Y coordinate in canvas space (0..viewportHeight). */
  y: number;
  /** Short label (basename of filePath). */
  label: string;
  /** Directory portion of filePath; used for clustering. */
  directory: string;
  /** Node circle radius in pixels. */
  radius: number;
}

export interface GraphEdge {
  /** Unique node identity of the source endpoint. */
  sourceNodeId: string;
  /** Unique node identity of the target endpoint. */
  targetNodeId: string;
  /** Scene number of the source node (for temporal visibility logic). */
  sourceSceneNumber: number;
  /** Scene number of the target node (for temporal visibility logic). */
  targetSceneNumber: number;
  relationship: GraphEdgeRelationship;
  /** Pre-computed SVG path `d` attribute (quadratic bezier via `Q` command). */
  pathD: string;
}

export interface GraphLayoutData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewportWidth: number;
  viewportHeight: number;
}

export const DEFAULT_VIEWPORT_WIDTH = 1920;
export const DEFAULT_VIEWPORT_HEIGHT = 1080;
export const DEFAULT_NODE_RADIUS = 40;
export const NODE_MARGIN = 120;
