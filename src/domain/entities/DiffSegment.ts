import { z } from "zod";
import { fileChangeSummarySchema } from "./FileChangeSummary";

export const diffSegmentSchema = z.object({
  /** 0-based page index. */
  segmentIndex: z.number().int().nonnegative(),
  /** True only on the last yielded segment. */
  isFinal: z.boolean(),
  /**
   * Files present in this page. After DiffCorpusBuilder processes a segment,
   * this array is truncated to empty (length=0) to release element references (FR-003).
   */
  files: z.array(fileChangeSummarySchema),
  /**
   * Cumulative line count across all segments processed so far.
   * Set by DiffCorpusBuilder, not by the source.
   */
  cumulativeLines: z.number().int().nonnegative(),
});

export type DiffSegment = z.infer<typeof diffSegmentSchema>;
