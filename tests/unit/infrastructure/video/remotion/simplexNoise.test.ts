import { describe, it, expect } from "vitest";
import { createNoise2D } from "@/infrastructure/video/remotion/lib/simplexNoise";

describe("simplexNoise", () => {
  it("is deterministic — same seed + coordinates produce the same value", () => {
    const noise1 = createNoise2D(42);
    const noise2 = createNoise2D(42);
    for (let i = 0; i < 50; i++) {
      const x = i * 0.37;
      const y = i * 0.53;
      expect(noise1(x, y)).toBe(noise2(x, y));
    }
  });

  it("produces values in the range [-1, 1]", () => {
    const noise = createNoise2D(123);
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const v = noise(x * 0.05, y * 0.05);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
    // Should have some spread — not all zeros
    expect(max - min).toBeGreaterThan(0.3);
  });

  it("produces different output for different seeds", () => {
    const noiseA = createNoise2D(1);
    const noiseB = createNoise2D(9999);
    let differences = 0;
    for (let i = 0; i < 20; i++) {
      if (noiseA(i * 0.1, i * 0.2) !== noiseB(i * 0.1, i * 0.2)) {
        differences++;
      }
    }
    // Vast majority of samples should differ
    expect(differences).toBeGreaterThan(15);
  });

  it("returns 0 at the origin for any seed (simplex property)", () => {
    // Simplex noise at (0, 0) is always 0 because all gradient dot products
    // with the zero vector are zero.
    const noise = createNoise2D(77);
    expect(noise(0, 0)).toBe(0);
  });

  it("is smooth — nearby coordinates produce similar values", () => {
    const noise = createNoise2D(42);
    const base = noise(5.0, 5.0);
    const nearby = noise(5.001, 5.001);
    expect(Math.abs(base - nearby)).toBeLessThan(0.01);
  });

  it("handles large coordinates without NaN or Infinity", () => {
    const noise = createNoise2D(42);
    const v = noise(100000, -50000);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(-1);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("handles negative coordinates", () => {
    const noise = createNoise2D(42);
    const v = noise(-3.7, -8.2);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(-1);
    expect(v).toBeLessThanOrEqual(1);
  });
});
