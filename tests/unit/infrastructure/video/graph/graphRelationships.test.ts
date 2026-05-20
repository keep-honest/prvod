import { describe, expect, it } from "vitest";
import {
  deriveEdges,
  deriveTestPairEdges,
  getBasename,
  getDirectory,
  isTestBasename,
  stripTestSuffix,
} from "@/infrastructure/video/graph/graphRelationships";
import { makeGraphNode as makeNode } from "./fixtures";

describe("graphRelationships.getDirectory", () => {
  it("returns the parent directory for posix paths", () => {
    expect(getDirectory("src/app/page.tsx")).toBe("src/app");
  });

  it("handles windows-style paths", () => {
    expect(getDirectory("src\\lib\\auth.ts")).toBe("src/lib");
  });

  it("returns empty string for bare filenames", () => {
    expect(getDirectory("README.md")).toBe("");
  });
});

describe("graphRelationships.getBasename", () => {
  it("returns the last path segment", () => {
    expect(getBasename("src/app/page.tsx")).toBe("page.tsx");
  });

  it("returns the input when there's no separator", () => {
    expect(getBasename("README.md")).toBe("README.md");
  });
});

describe("graphRelationships.deriveEdges", () => {
  it("returns no edges when there are fewer than 2 nodes", () => {
    expect(deriveEdges([])).toEqual([]);
    expect(deriveEdges([makeNode(1, "src/a.ts")])).toEqual([]);
  });

  it("creates a same_directory edge for two files in the same folder", () => {
    const nodes = [
      makeNode(1, "src/lib/a.ts"),
      makeNode(2, "src/lib/b.ts"),
    ];
    const edges = deriveEdges(nodes);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("same_directory");
    expect(edges[0].sourceSceneNumber).toBe(1);
    expect(edges[0].targetSceneNumber).toBe(2);
  });

  it("creates same_directory edge between nodes sharing a sceneNumber (multi-snippet scene)", () => {
    const nodes = [
      makeNode(1, "src/lib/a.ts"),
      makeNode(1, "src/lib/b.ts"),
    ];
    const edges = deriveEdges(nodes);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("same_directory");
    expect(edges[0].sourceNodeId).toBe("src/lib/a.ts");
    expect(edges[0].targetNodeId).toBe("src/lib/b.ts");
  });

  it("does not connect files in different directories without keyFiles hints", () => {
    const nodes = [
      makeNode(1, "src/lib/a.ts"),
      makeNode(2, "src/api/b.ts"),
    ];
    expect(deriveEdges(nodes)).toEqual([]);
  });

  it("adds a key_file_adjacency edge between consecutive keyFiles entries", () => {
    const nodes = [
      makeNode(1, "src/lib/a.ts"),
      makeNode(2, "src/api/b.ts"),
      makeNode(3, "src/pages/c.tsx"),
    ];
    const edges = deriveEdges(nodes, [
      "src/lib/a.ts",
      "src/api/b.ts",
      "src/pages/c.tsx",
    ]);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.relationship)).toEqual([
      "key_file_adjacency",
      "key_file_adjacency",
    ]);
  });

  it("prefers same_directory when both relations would apply", () => {
    const nodes = [
      makeNode(1, "src/lib/a.ts"),
      makeNode(2, "src/lib/b.ts"),
    ];
    const edges = deriveEdges(nodes, ["src/lib/a.ts", "src/lib/b.ts"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("same_directory");
  });

  it("ignores self-referential and missing keyFiles entries", () => {
    const nodes = [
      makeNode(1, "src/lib/a.ts"),
      makeNode(2, "src/api/b.ts"),
    ];
    const edges = deriveEdges(nodes, [
      "src/lib/a.ts",
      "unknown.ts",
      "src/api/b.ts",
    ]);
    // "unknown.ts" has no node → only adjacency between a.ts ↔ ? is skipped.
    // Nothing should remain.
    expect(edges).toEqual([]);
  });

  it("deduplicates edges by unordered pair", () => {
    const nodes = [
      makeNode(1, "src/lib/a.ts"),
      makeNode(2, "src/lib/b.ts"),
      makeNode(3, "src/lib/c.ts"),
    ];
    const edges = deriveEdges(nodes);
    // 3 nodes in the same directory → 3 undirected edges (1-2, 1-3, 2-3).
    expect(edges).toHaveLength(3);
    const keys = new Set(
      edges.map((e) =>
        e.sourceSceneNumber < e.targetSceneNumber
          ? `${e.sourceSceneNumber}-${e.targetSceneNumber}`
          : `${e.targetSceneNumber}-${e.sourceSceneNumber}`,
      ),
    );
    expect(keys.size).toBe(3);
  });
});

describe("graphRelationships.stripTestSuffix", () => {
  it("strips .test.ts suffix", () => {
    expect(stripTestSuffix("Auth.test.ts")).toBe("Auth.ts");
  });

  it("strips .spec.tsx suffix", () => {
    expect(stripTestSuffix("Button.spec.tsx")).toBe("Button.tsx");
  });

  it("strips .test.mjs / .test.cjs variants", () => {
    expect(stripTestSuffix("loader.test.mjs")).toBe("loader.mjs");
    expect(stripTestSuffix("loader.test.cjs")).toBe("loader.cjs");
  });

  it("returns null for non-test basenames", () => {
    expect(stripTestSuffix("Auth.ts")).toBeNull();
    expect(stripTestSuffix("README.md")).toBeNull();
    expect(stripTestSuffix("Auth.test.unknown-ext")).toBeNull();
  });
});

describe("graphRelationships.isTestBasename", () => {
  it("recognizes test files", () => {
    expect(isTestBasename("Auth.test.ts")).toBe(true);
    expect(isTestBasename("Auth.spec.ts")).toBe(true);
    expect(isTestBasename("Button.test.tsx")).toBe(true);
  });

  it("rejects non-test files", () => {
    expect(isTestBasename("Auth.ts")).toBe(false);
    expect(isTestBasename("README.md")).toBe(false);
  });
});

describe("graphRelationships.deriveTestPairEdges", () => {
  it("returns no edges when there are fewer than 2 nodes", () => {
    expect(deriveTestPairEdges([])).toEqual([]);
    expect(deriveTestPairEdges([makeNode(1, "src/Auth.ts")])).toEqual([]);
  });

  it("pairs a test file with its implementation in a different scene", () => {
    const nodes = [
      makeNode(1, "src/auth/Auth.ts"),
      makeNode(2, "src/auth/Auth.test.ts"),
    ];
    const edges = deriveTestPairEdges(nodes);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("test_pair");
    expect(edges[0].sourceSceneNumber).toBe(1);
    expect(edges[0].targetSceneNumber).toBe(2);
  });

  it("ignores test/test pairs (both files are tests)", () => {
    const nodes = [
      makeNode(1, "src/Auth.test.ts"),
      makeNode(2, "src/Auth.spec.ts"),
    ];
    expect(deriveTestPairEdges(nodes)).toEqual([]);
  });

  it("ignores impl/impl pairs (neither file is a test)", () => {
    const nodes = [
      makeNode(1, "src/Auth.ts"),
      makeNode(2, "src/lib/Auth.ts"),
    ];
    expect(deriveTestPairEdges(nodes)).toEqual([]);
  });

  it("produces test_pair edge even when both files share the same scene number", () => {
    const nodes = [
      makeNode(1, "src/auth/Auth.ts"),
      makeNode(1, "src/auth/Auth.test.ts"),
    ];
    const edges = deriveTestPairEdges(nodes);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("test_pair");
  });

  it("supports .spec.ts and handles multiple test-pair groups independently", () => {
    const nodes = [
      makeNode(1, "src/auth/Auth.ts"),
      makeNode(2, "src/auth/Auth.spec.ts"),
      makeNode(3, "src/lib/Token.ts"),
      makeNode(4, "src/lib/Token.test.ts"),
    ];
    const edges = deriveTestPairEdges(nodes);
    expect(edges).toHaveLength(2);
    const pairs = new Set(
      edges.map((e) => `${Math.min(e.sourceSceneNumber, e.targetSceneNumber)}-${Math.max(e.sourceSceneNumber, e.targetSceneNumber)}`),
    );
    expect(pairs.has("1-2")).toBe(true);
    expect(pairs.has("3-4")).toBe(true);
  });
});
