import { describe, expect, it } from "vitest";
import {
  computeEntranceTransform,
  computeExitTransform,
  computeKenBurnsTransform,
} from "@/infrastructure/video/remotion/components/AnimatedCodeCard";

const FPS = 30;

describe("AnimatedCodeCard animation helpers", () => {
  describe("computeEntranceTransform", () => {
    it("starts scaled down with zero opacity", () => {
      const t = computeEntranceTransform(0, FPS);
      expect(t.scale).toBeCloseTo(0.85, 1);
      expect(t.opacity).toBe(0);
      expect(t.translateY).toBeCloseTo(40, 0);
    });

    it("reaches full scale and opacity after spring settles", () => {
      // At frame 60 (2 seconds), spring should be fully settled
      const t = computeEntranceTransform(60, FPS);
      expect(t.scale).toBeGreaterThan(0.99);
      expect(t.opacity).toBe(1);
      expect(t.translateY).toBeLessThan(1);
    });

    it("opacity reaches 1 by frame 12", () => {
      const t = computeEntranceTransform(12, FPS);
      expect(t.opacity).toBe(1);
    });
  });

  describe("computeExitTransform", () => {
    const duration = 150;

    it("returns 1.0 scale and opacity before the exit zone", () => {
      const t = computeExitTransform(100, duration);
      expect(t.scale).toBe(1);
      expect(t.opacity).toBe(1);
    });

    it("fades and shrinks at the end", () => {
      const t = computeExitTransform(duration, duration);
      expect(t.scale).toBeCloseTo(0.97, 2);
      expect(t.opacity).toBeCloseTo(0, 1);
    });

    it("is at midpoint halfway through exit zone", () => {
      const exitStart = duration - 10;
      const mid = exitStart + 5;
      const t = computeExitTransform(mid, duration);
      expect(t.opacity).toBeCloseTo(0.5, 1);
    });
  });

  describe("computeKenBurnsTransform", () => {
    it("starts at zero translate and scale 1 (no scale drift)", () => {
      const t = computeKenBurnsTransform(0, 300);
      expect(t.translateX).toBe(0);
      expect(t.scale).toBe(1);
    });

    it("ends at -4px translate and scale 1", () => {
      const t = computeKenBurnsTransform(300, 300);
      expect(t.translateX).toBe(-4);
      expect(t.scale).toBe(1);
    });

    it("returns integer translateX values (pixel-snapped)", () => {
      // Mid-scene should round to integer, not sub-pixel
      const t = computeKenBurnsTransform(150, 300);
      expect(Number.isInteger(t.translateX)).toBe(true);
    });

    it("delays pan start until entrance settles", () => {
      // settleFrame = min(25, floor(300 * 0.15)) = 25
      const beforeSettle = computeKenBurnsTransform(10, 300);
      expect(beforeSettle.translateX).toBe(0);
      // After settle, drift begins
      const afterSettle = computeKenBurnsTransform(150, 300);
      expect(afterSettle.translateX).toBeLessThan(0);
      expect(afterSettle.scale).toBe(1);
    });
  });
});
