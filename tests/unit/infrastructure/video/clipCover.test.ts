import { describe, expect, it } from "vitest";
import { computeClipCover, splitNarrationByDurations } from "@/infrastructure/video/clipCover";

describe("computeClipCover", () => {
  it("returns a single clip when target fits within the largest duration", () => {
    const result = computeClipCover(6, [4, 6, 8]);
    expect(result.durations).toEqual([6]);
    expect(result.totalSeconds).toBe(6);
  });

  it("returns the ceiling duration when target is below the smallest", () => {
    const result = computeClipCover(1, [4, 6, 8]);
    expect(result.durations).toEqual([4]);
    expect(result.totalSeconds).toBe(4);
  });

  it("finds the exact two-clip combination", () => {
    // 8+4=12 (cost 12, 2 clips) — not 10+4=14, not 4+4+4=12 (3 clips)
    const result = computeClipCover(12, [4, 8, 10]);
    expect(result.durations.sort((a, b) => a - b)).toEqual([4, 8]);
    expect(result.totalSeconds).toBe(12);
  });

  it("minimizes total cost over greedy largest-first", () => {
    // [5,5]=10 (cost 10) beats [3,8]=11 (cost 11)
    const result = computeClipCover(10, [3, 5, 8]);
    expect(result.durations.sort((a, b) => a - b)).toEqual([5, 5]);
    expect(result.totalSeconds).toBe(10);
  });

  it("handles targets with no exact sum — picks smallest overshoot", () => {
    // target=9, durations=[4,6,7]: no combo sums to exactly 9
    // [4,6]=10 is cheapest overshoot (10), cheaper than [7,4]=11 or [6,6]=12
    const result = computeClipCover(9, [4, 6, 7]);
    expect(result.durations.sort((a, b) => a - b)).toEqual([4, 6]);
    expect(result.totalSeconds).toBe(10);
  });

  it("handles three or more clips", () => {
    // target=20, durations=[4,8]: 4+8+8=20 (3 clips, cost 20)
    const result = computeClipCover(20, [4, 8]);
    expect(result.durations.sort((a, b) => a - b)).toEqual([4, 8, 8]);
    expect(result.totalSeconds).toBe(20);
  });

  it("falls back to ceil(target) when no valid durations provided", () => {
    const result = computeClipCover(7.3, []);
    expect(result.durations).toEqual([8]);
    expect(result.totalSeconds).toBe(8);
  });

  it("prefers fewer clips when total cost is equal", () => {
    // target=12, durations=[4,6,12]: [12] (1 clip) beats [6,6] (2 clips) — same cost
    const result = computeClipCover(12, [4, 6, 12]);
    expect(result.durations).toEqual([12]);
    expect(result.totalSeconds).toBe(12);
  });

  it("handles target of exactly one duration value", () => {
    const result = computeClipCover(8, [4, 6, 8]);
    expect(result.durations).toEqual([8]);
    expect(result.totalSeconds).toBe(8);
  });

  it("handles single valid duration requiring multiple clips", () => {
    // target=15, durations=[6]: needs ceil(15/6)=3 clips → 6+6+6=18
    const result = computeClipCover(15, [6]);
    expect(result.durations).toEqual([6, 6, 6]);
    expect(result.totalSeconds).toBe(18);
  });

  it("throws when targetSeconds is zero", () => {
    expect(() => computeClipCover(0, [4, 6])).toThrow(/targetSeconds must be positive/);
  });

  it("throws when targetSeconds is negative", () => {
    expect(() => computeClipCover(-5, [4, 6])).toThrow(/targetSeconds must be positive/);
  });
});

describe("splitNarrationByDurations", () => {
  it("splits words proportionally by duration", () => {
    const narration = "one two three four five six seven eight nine ten";
    const segments = splitNarrationByDurations(narration, [8, 4]);
    // 8/(8+4) = 2/3 of 10 words ≈ 7, 4/(8+4) = 1/3 ≈ 3
    expect(segments).toHaveLength(2);
    expect(segments[0].split(/\s+/).length).toBe(7);
    expect(segments[1].split(/\s+/).length).toBe(3);
    // All words present
    expect(segments.join(" ")).toBe(narration);
  });

  it("returns the full narration for a single duration", () => {
    const narration = "hello world foo bar";
    const segments = splitNarrationByDurations(narration, [8]);
    expect(segments).toEqual(["hello world foo bar"]);
  });

  it("returns empty strings for empty narration", () => {
    const segments = splitNarrationByDurations("", [8, 4]);
    expect(segments).toEqual(["", ""]);
  });

  it("handles equal durations", () => {
    const narration = "a b c d e f";
    const segments = splitNarrationByDurations(narration, [5, 5]);
    expect(segments).toHaveLength(2);
    expect(segments[0].split(/\s+/).length).toBe(3);
    expect(segments[1].split(/\s+/).length).toBe(3);
  });

  it("assigns at least one word per segment when possible", () => {
    const narration = "alpha beta";
    const segments = splitNarrationByDurations(narration, [8, 4, 4]);
    expect(segments).toHaveLength(3);
    // With only 2 words and 3 segments, last segment(s) may be empty
    const nonEmpty = segments.filter((s) => s.length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(2);
    expect(nonEmpty.join(" ")).toBe("alpha beta");
  });

  it("assigns remaining words to the last segment", () => {
    const narration = "a b c d e f g h i j k";
    const segments = splitNarrationByDurations(narration, [3, 7]);
    // 3/(3+7)=30% of 11 ≈ 3, 7/(3+7)=70% of 11 ≈ 8
    expect(segments.join(" ")).toBe(narration);
  });

  it("throws when all durations sum to zero", () => {
    expect(() => splitNarrationByDurations("hello world", [0, 0])).toThrow(
      /total duration must be positive/,
    );
  });
});
