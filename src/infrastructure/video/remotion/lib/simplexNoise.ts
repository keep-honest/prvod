/**
 * Minimal 2D simplex noise — pure function, seeded for determinism.
 *
 * No external dependencies. Avoids Remotion's webpack bundling issues with
 * third-party noise libraries. Output range is [-1, 1].
 *
 * Based on Stefan Gustavson's simplex noise implementation (public domain),
 * adapted to accept a numeric seed for deterministic permutation tables.
 */

// Gradient vectors for 2D simplex noise (12 directions)
const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
] as const;

const F2 = 0.5 * (Math.sqrt(3) - 1); // Skew factor for 2D
const G2 = (3 - Math.sqrt(3)) / 6;   // Unskew factor for 2D

/**
 * Build a seeded permutation table. The seed shifts a base permutation
 * so the same seed always produces the same noise field.
 */
function buildPermTable(seed: number): Uint8Array {
  const perm = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;

  // Fisher-Yates shuffle with a simple LCG seeded RNG
  let s = seed | 0;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = ((s >>> 0) % (i + 1));
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }

  // Double the table to avoid index wrapping
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  return perm;
}

function dot2(g: readonly [number, number], x: number, y: number): number {
  return g[0] * x + g[1] * y;
}

/**
 * Create a seeded 2D simplex noise function.
 *
 * @param seed - Integer seed for deterministic output.
 * @returns A function `(x: number, y: number) => number` in range [-1, 1].
 */
export function createNoise2D(seed: number): (x: number, y: number) => number {
  const perm = buildPermTable(seed);

  return function noise2D(xin: number, yin: number): number {
    // Skew the input space to determine which simplex cell we're in
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);

    // Unskew back to (x,y) space
    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = xin - X0;
    const y0 = yin - Y0;

    // Determine which simplex triangle we're in
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    // Hash coordinates of the three simplex corners
    const ii = i & 255;
    const jj = j & 255;
    const gi0 = perm[ii + perm[jj]] % 12;
    const gi1 = perm[ii + i1 + perm[jj + j1]] % 12;
    const gi2 = perm[ii + 1 + perm[jj + 1]] % 12;

    // Calculate contribution from each corner
    let n0 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * dot2(GRAD2[gi0], x0, y0);
    }

    let n1 = 0;
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * dot2(GRAD2[gi1], x1, y1);
    }

    let n2 = 0;
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * dot2(GRAD2[gi2], x2, y2);
    }

    // Scale to [-1, 1]
    return 70 * (n0 + n1 + n2);
  };
}
