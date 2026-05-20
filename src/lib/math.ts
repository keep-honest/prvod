/**
 * Clamp a number to [min, max].
 *
 * Non-finite inputs (NaN, ±Infinity) return the midpoint of the range.
 * This prevents NaN propagation into SVG paths or canvas coordinates
 * where it would crash the renderer.
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return (min + max) / 2;
  }
  return Math.max(min, Math.min(max, value));
}
