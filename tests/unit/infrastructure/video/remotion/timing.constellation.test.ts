import { describe, expect, it } from "vitest";
import {
  CONSTELLATION_SUFFIX_FRAMES,
  FINALE_ABSOLUTE_MIN_FRAMES,
  FINALE_BASE_FRAMES,
  FINALE_STAGGER_FRAMES,
  GRAPH_REVEAL_FRAMES,
  SHRINK_ANIMATION_FRAMES,
  computeFinaleMinFrames,
  getConstellationSuffix,
} from "@/infrastructure/video/remotion/timing";

describe("constellation timing constants", () => {
  it("sums shrink and reveal frames into the suffix total", () => {
    expect(CONSTELLATION_SUFFIX_FRAMES).toBe(
      SHRINK_ANIMATION_FRAMES + GRAPH_REVEAL_FRAMES,
    );
  });

  it("uses 45/30 frame defaults (1.5s + 1.0s at 30fps)", () => {
    expect(SHRINK_ANIMATION_FRAMES).toBe(45);
    expect(GRAPH_REVEAL_FRAMES).toBe(30);
    expect(CONSTELLATION_SUFFIX_FRAMES).toBe(75);
  });
});

describe("getConstellationSuffix", () => {
  it("returns the full suffix for scenes with codeBroll", () => {
    expect(getConstellationSuffix(true)).toBe(CONSTELLATION_SUFFIX_FRAMES);
  });

  it("returns zero for scenes without codeBroll", () => {
    expect(getConstellationSuffix(false)).toBe(0);
  });
});

describe("computeFinaleMinFrames", () => {
  it("returns FINALE_ABSOLUTE_MIN_FRAMES for 0 nodes", () => {
    expect(computeFinaleMinFrames(0)).toBe(FINALE_ABSOLUTE_MIN_FRAMES);
  });

  it("returns FINALE_ABSOLUTE_MIN_FRAMES for 1 node (stagger budget is 0)", () => {
    // (1-1)*8 + 150 = 150 < 240 → clamps to absolute min
    expect(computeFinaleMinFrames(1)).toBe(FINALE_ABSOLUTE_MIN_FRAMES);
  });

  it("returns FINALE_ABSOLUTE_MIN_FRAMES when stagger budget is still below the floor", () => {
    // (8-1)*8 + 150 = 56 + 150 = 206 < 240 → still clamps
    expect(computeFinaleMinFrames(8)).toBe(FINALE_ABSOLUTE_MIN_FRAMES);
  });

  it("stagger budget overtakes absolute minimum once nodeCount is large enough", () => {
    // (13-1)*8 + 150 = 96 + 150 = 246 > 240
    expect(computeFinaleMinFrames(13)).toBe(246);
  });

  it("matches the formula max((n-1)*stagger + base, absMin) for a range of inputs", () => {
    for (const n of [2, 5, 10, 20]) {
      const expected = Math.max(
        (n - 1) * FINALE_STAGGER_FRAMES + FINALE_BASE_FRAMES,
        FINALE_ABSOLUTE_MIN_FRAMES,
      );
      expect(computeFinaleMinFrames(n)).toBe(expected);
    }
  });
});
