import { z } from "zod";

/**
 * Edge relationship types shared across the video graph (Remotion/FFmpeg)
 * and the review-page graph. Defined in the domain layer so entities
 * never depend outward on infrastructure.
 */
export type GraphEdgeRelationship =
  // Legacy — emitted by the in-video (Remotion/FFmpeg) graph only.
  | "same_directory"
  | "key_file_adjacency"
  // UML — emitted by the review-page graph.
  | "inheritance"     // class X extends Y
  | "realization"     // class X implements I
  | "composition"     // class X has a typed field of class Y
  | "dependency"      // file imports from another file
  | "association"     // weak reference (method call, parameter type, etc.)
  | "test_pair";      // Foo.test.ts ↔ Foo.ts

export interface ReviewGraphCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface ReviewGraphNode {
  id: string;
  filePath: string;
  label: string;
  x: number;
  y: number;
  sceneNumbers: number[];
  primarySceneNumber: number;
  degree: number;
  clusterId: string;
  isTest: boolean;
  importance: number;
}

export interface ReviewGraphEdge {
  sourceId: string;
  targetId: string;
  relationship: GraphEdgeRelationship;
  strength: number;
}

export interface ReviewGraphViewport {
  width: number;
  height: number;
  initialCamera: ReviewGraphCamera;
}

export interface ReviewGraphData {
  nodes: ReviewGraphNode[];
  edges: ReviewGraphEdge[];
  viewport: ReviewGraphViewport;
}

export const reviewGraphSourceSchema = z.object({
  version: z.literal(1),
  files: z.record(z.string(), z.string()),
});

export type ReviewGraphSource = z.infer<typeof reviewGraphSourceSchema>;

export function parseReviewGraphSource(value: unknown): ReviewGraphSource | undefined {
  const parsed = reviewGraphSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
