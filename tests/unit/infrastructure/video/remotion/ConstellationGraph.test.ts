import { describe, it, expect } from "vitest";
import {
  computeEdgeReveal,
  computeFinaleDrift,
  computeFinaleEdgeProgress,
} from "@/infrastructure/video/remotion/components/ConstellationGraph";

describe("computeEdgeReveal", () => {
  it("returns 0 for unplaced edges", () => {
    expect(computeEdgeReveal({
      frame: 100,
      revealStartFrame: 50,
      revealFrames: 30,
      isActiveEdge: true,
      isPlaced: false,
    })).toBe(0);
  });

  it("returns 1 for placed non-active edges", () => {
    expect(computeEdgeReveal({
      frame: 0,
      revealStartFrame: 50,
      revealFrames: 30,
      isActiveEdge: false,
      isPlaced: true,
    })).toBe(1);
  });

  it("returns 0 for active edge before reveal starts", () => {
    expect(computeEdgeReveal({
      frame: 49,
      revealStartFrame: 50,
      revealFrames: 30,
      isActiveEdge: true,
      isPlaced: true,
    })).toBe(0);
  });

  it("returns 1 for active edge after reveal completes", () => {
    expect(computeEdgeReveal({
      frame: 80,
      revealStartFrame: 50,
      revealFrames: 30,
      isActiveEdge: true,
      isPlaced: true,
    })).toBe(1);
  });

  it("returns partial progress mid-reveal", () => {
    const progress = computeEdgeReveal({
      frame: 65,
      revealStartFrame: 50,
      revealFrames: 30,
      isActiveEdge: true,
      isPlaced: true,
    });
    expect(progress).toBe(0.5);
  });
});

describe("computeFinaleEdgeProgress", () => {
  it("returns 0 before both nodes have settled", () => {
    // Source at index 0 (delay 0), target at index 3 (delay 24).
    // Edge starts at max(0, 24) + 12 = 36.
    expect(computeFinaleEdgeProgress({
      frame: 35,
      sourceIndex: 0,
      targetIndex: 3,
    })).toBe(0);
  });

  it("returns 0 at exactly the edge start frame", () => {
    // Edge starts at max(0, 24) + 12 = 36.
    expect(computeFinaleEdgeProgress({
      frame: 36,
      sourceIndex: 0,
      targetIndex: 3,
    })).toBe(0);
  });

  it("returns partial progress mid-draw", () => {
    // Edge starts at 36, draw-in lasts 18 frames. At frame 45 = 9/18 = 0.5.
    const progress = computeFinaleEdgeProgress({
      frame: 45,
      sourceIndex: 0,
      targetIndex: 3,
    });
    expect(progress).toBe(0.5);
  });

  it("returns 1 after draw-in completes", () => {
    // Edge starts at 36, completes at 36 + 18 = 54.
    expect(computeFinaleEdgeProgress({
      frame: 54,
      sourceIndex: 0,
      targetIndex: 3,
    })).toBe(1);
  });

  it("uses the later endpoint for start timing", () => {
    // Both at index 2: delay = 16. Edge start = 16 + 12 = 28.
    expect(computeFinaleEdgeProgress({
      frame: 27,
      sourceIndex: 2,
      targetIndex: 2,
    })).toBe(0);

    expect(computeFinaleEdgeProgress({
      frame: 37,
      sourceIndex: 2,
      targetIndex: 2,
    })).toBe(0.5);
  });

  it("earlier edges finish before later ones start", () => {
    // Edge between nodes 0 and 1: starts at max(0, 8) + 12 = 20, ends at 38.
    // Edge between nodes 4 and 5: starts at max(32, 40) + 12 = 52.
    const earlyDone = computeFinaleEdgeProgress({
      frame: 38,
      sourceIndex: 0,
      targetIndex: 1,
    });
    const lateStart = computeFinaleEdgeProgress({
      frame: 38,
      sourceIndex: 4,
      targetIndex: 5,
    });
    expect(earlyDone).toBe(1);
    expect(lateStart).toBe(0);
  });
});

describe("computeFinaleDrift", () => {
  const base = { fps: 30, nodeIndex: 0, staggerDelay: 0 };

  it("returns zero before the node settles", () => {
    const drift = computeFinaleDrift({ ...base, frame: 20 });
    expect(drift.dx).toBe(0);
    expect(drift.dy).toBe(0);
  });

  it("returns non-zero offsets after the node settles", () => {
    const drift = computeFinaleDrift({ ...base, frame: 90 });
    expect(drift.dx).not.toBe(0);
    expect(drift.dy).not.toBe(0);
  });

  it("ramps up gradually over the first 30 frames after settle", () => {
    const early = computeFinaleDrift({ ...base, frame: 30 }); // 5 frames after settle
    const later = computeFinaleDrift({ ...base, frame: 55 }); // 30 frames after settle
    expect(Math.abs(later.dx)).toBeGreaterThan(Math.abs(early.dx));
  });

  it("stays within the drift radius", () => {
    for (let f = 60; f < 300; f += 10) {
      const drift = computeFinaleDrift({ ...base, frame: f, radius: 16 });
      expect(Math.abs(drift.dx)).toBeLessThanOrEqual(16);
      expect(Math.abs(drift.dy)).toBeLessThanOrEqual(16);
    }
  });

  it("produces different paths for different node indices", () => {
    const a = computeFinaleDrift({ ...base, frame: 120, nodeIndex: 0 });
    const b = computeFinaleDrift({ ...base, frame: 120, nodeIndex: 3 });
    expect(a.dx).not.toBeCloseTo(b.dx, 3);
  });

  it("accounts for stagger delay", () => {
    // Node with staggerDelay 40: at frame 60, only 60-40-25=−5 elapsed → zero
    const drift = computeFinaleDrift({ ...base, frame: 60, staggerDelay: 40 });
    expect(drift.dx).toBe(0);
    expect(drift.dy).toBe(0);
  });
});
