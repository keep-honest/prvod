import { z } from "zod";

export const rollingSummarySchema = z.object({
  filePath: z.string().min(1).max(1024),
  /** How many chunks have contributed so far. */
  chunksConsumed: z.number().int().nonnegative(),
  /** Summary text, bounded to ~1500 tokens (6 KB UTF-8 upper bound). */
  text: z.string().max(6_000),
});

export type RollingSummary = z.infer<typeof rollingSummarySchema>;
