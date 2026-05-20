/**
 * Parses the `CAPTION_OFFSET_MS` environment variable into a numeric offset.
 *
 * Shared between FFmpegCompositor and RemotionCompositor to allow users to
 * fine-tune caption-to-audio sync without rebuilding. Positive values delay
 * captions; negative values advance them.
 *
 * @param raw - The raw env var string, or undefined if not set
 * @returns `offsetMs` (defaults to 0) and an optional `warning` string if the value was unparseable
 *
 * @example
 * ```ts
 * const { offsetMs, warning } = parseCaptionOffsetMs(process.env.CAPTION_OFFSET_MS);
 * if (warning) logger.warn(warning);
 * ```
 */
export function parseCaptionOffsetMs(raw: string | undefined): { offsetMs: number; warning?: string } {
  if (raw == null) return { offsetMs: 0 };
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return { offsetMs: 0, warning: `Invalid CAPTION_OFFSET_MS env var: "${raw}"` };
  }
  return { offsetMs: parsed };
}
