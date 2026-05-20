import { describe, expect, it } from "vitest";
import {
  deriveReviewPageEdges,
  mergeWithPrecedence,
} from "@/infrastructure/video/graph/reviewPageRelationships";
import type { DerivedEdge } from "@/infrastructure/video/graph/graphRelationships";
import { makeGraphNode as makeNode, makeCodeScript as makeScript } from "./fixtures";

// ── mergeWithPrecedence ──────────────────────────────────────────────────

describe("mergeWithPrecedence", () => {
  it("returns an empty array for no input", () => {
    expect(mergeWithPrecedence([])).toEqual([]);
  });

  it("preserves a single edge unchanged", () => {
    const edges: DerivedEdge[] = [
      { sourceSceneNumber: 1, targetSceneNumber: 2, relationship: "association" },
    ];
    expect(mergeWithPrecedence(edges)).toEqual(edges);
  });

  it("keeps the strongest relationship when the same pair has multiple classifications", () => {
    const edges: DerivedEdge[] = [
      { sourceSceneNumber: 1, targetSceneNumber: 2, relationship: "association" },
      { sourceSceneNumber: 1, targetSceneNumber: 2, relationship: "inheritance" },
      { sourceSceneNumber: 1, targetSceneNumber: 2, relationship: "composition" },
    ];
    const merged = mergeWithPrecedence(edges);
    expect(merged).toHaveLength(1);
    expect(merged[0].relationship).toBe("inheritance");
  });

  it("dedupes across undirected pair direction (1->2 same as 2->1)", () => {
    const edges: DerivedEdge[] = [
      { sourceSceneNumber: 1, targetSceneNumber: 2, relationship: "dependency" },
      { sourceSceneNumber: 2, targetSceneNumber: 1, relationship: "realization" },
    ];
    const merged = mergeWithPrecedence(edges);
    expect(merged).toHaveLength(1);
    expect(merged[0].relationship).toBe("realization");
  });

  it("keeps distinct edges for different pairs", () => {
    const edges: DerivedEdge[] = [
      { sourceSceneNumber: 1, targetSceneNumber: 2, relationship: "dependency" },
      { sourceSceneNumber: 2, targetSceneNumber: 3, relationship: "test_pair" },
      { sourceSceneNumber: 1, targetSceneNumber: 3, relationship: "association" },
    ];
    const merged = mergeWithPrecedence(edges);
    expect(merged).toHaveLength(3);
  });
});

// ── deriveReviewPageEdges ────────────────────────────────────────────────

describe("deriveReviewPageEdges", () => {
  it("returns no edges when there are fewer than 2 nodes", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts", code: "class A {}" },
    ]);
    expect(deriveReviewPageEdges([makeNode(1, "src/a.ts")], script)).toEqual([]);
  });

  it("emits UML edges for class extensions", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Base.ts", code: "export class Base {}" },
      { sceneNumber: 2, filePath: "src/Derived.ts", code: "class Derived extends Base {}" },
    ]);
    const edges = deriveReviewPageEdges(
      [makeNode(1, "src/Base.ts"), makeNode(2, "src/Derived.ts")],
      script,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("inheritance");
  });

  it("emits test_pair edges for Foo.test.ts <-> Foo.ts across scenes", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Auth.ts", code: "export class Auth {}" },
      { sceneNumber: 2, filePath: "src/Auth.test.ts", code: "import { Auth } from './Auth';" },
    ]);
    const edges = deriveReviewPageEdges(
      [makeNode(1, "src/Auth.ts"), makeNode(2, "src/Auth.test.ts")],
      script,
    );
    // UML dependency beats test_pair for this pair (dependency is stronger)
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("dependency");
  });

  it("keeps test_pair when there is no stronger UML relationship", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Auth.ts", code: "export class Auth {}" },
      {
        sceneNumber: 2,
        filePath: "src/Auth.test.ts",
        code: "describe('Auth', () => { it('works', () => {}); });",
      },
    ]);
    const edges = deriveReviewPageEdges(
      [makeNode(1, "src/Auth.ts"), makeNode(2, "src/Auth.test.ts")],
      script,
    );
    // Test file doesn't reference Auth's symbol here, so no association/dep.
    // Only test_pair survives.
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("test_pair");
  });

  it("does NOT emit same_directory or key_file_adjacency edges (review-page excludes them)", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/lib/Auth.ts", code: "export class Auth {}" },
      { sceneNumber: 2, filePath: "src/lib/Crypto.ts", code: "export class Crypto {}" },
    ]);
    const edges = deriveReviewPageEdges(
      [makeNode(1, "src/lib/Auth.ts"), makeNode(2, "src/lib/Crypto.ts")],
      script,
    );
    // Same directory, but no UML / test_pair relationship — should be empty
    expect(edges).toEqual([]);
  });

  it("leaves orphan nodes without edges", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Auth.ts", code: "export class Auth {}" },
      { sceneNumber: 2, filePath: "src/main.ts", code: "import { Auth } from './Auth'; new Auth();" },
      { sceneNumber: 3, filePath: "config/tsconfig.json", code: "{}" },
    ]);
    const edges = deriveReviewPageEdges(
      [
        makeNode(1, "src/Auth.ts"),
        makeNode(2, "src/main.ts"),
        makeNode(3, "config/tsconfig.json"),
      ],
      script,
    );
    // Scene 3 is an orphan — no edges touch it
    expect(edges.every((e) => e.sourceSceneNumber !== 3 && e.targetSceneNumber !== 3)).toBe(true);
  });
});
