import { describe, expect, it, vi } from "vitest";
import { sanitizeGraphLayout } from "@/domain/services/VideoOrchestrator";
import { createLogger } from "@/lib/logger";

function makeLayout(
  nodeIds: string[],
  edges: Array<[string, string]>,
): Parameters<typeof sanitizeGraphLayout>[0] {
  return {
    nodes: nodeIds.map((id, i) => ({
      nodeId: id,
      sceneNumber: i + 1,
      filePath: `src/${id}.ts`,
      x: 0,
      y: 0,
      label: id,
      directory: "src",
      radius: 20,
    })),
    edges: edges.map(([src, tgt]) => ({
      sourceNodeId: src,
      targetNodeId: tgt,
      sourceSceneNumber: 1,
      targetSceneNumber: 2,
      relationship: "dependency" as const,
      pathD: `M 0 0 L 100 100`,
    })),
    viewportWidth: 1920,
    viewportHeight: 1080,
  };
}

describe("sanitizeGraphLayout", () => {
  it("returns the same reference when all edges are valid", () => {
    const layout = makeLayout(["a", "b"], [["a", "b"]]);
    const logger = createLogger("test");
    expect(sanitizeGraphLayout(layout, logger)).toBe(layout);
  });

  it("filters edges with unknown sourceNodeId and logs error", () => {
    const layout = makeLayout(["a", "b"], [["a", "b"], ["x", "b"]]);
    const logger = createLogger("test");
    const spy = vi.spyOn(logger, "error");

    const result = sanitizeGraphLayout(layout, logger);

    expect(result).not.toBe(layout);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.sourceNodeId).toBe("a");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("unknown nodeId");
  });

  it("filters edges with unknown targetNodeId and logs error", () => {
    const layout = makeLayout(["a", "b"], [["a", "z"]]);
    const logger = createLogger("test");
    const spy = vi.spyOn(logger, "error");

    const result = sanitizeGraphLayout(layout, logger);

    expect(result.edges).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("logs one error per bad edge and retains valid edges", () => {
    const layout = makeLayout(["a", "b", "c"], [["a", "b"], ["x", "b"], ["a", "y"]]);
    const logger = createLogger("test");
    const spy = vi.spyOn(logger, "error");

    const result = sanitizeGraphLayout(layout, logger);

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.sourceNodeId).toBe("a");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("preserves all nodes regardless of edge validity", () => {
    const layout = makeLayout(["a", "b"], [["unknown", "b"]]);
    const logger = createLogger("test");

    const result = sanitizeGraphLayout(layout, logger);

    expect(result.nodes).toHaveLength(2);
  });
});
