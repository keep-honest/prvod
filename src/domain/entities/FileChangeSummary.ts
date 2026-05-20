import { z } from "zod";

export const changeTypeEnum = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
]);

export const fileChangeSummarySchema = z.object({
  /** Canonical path — the post-rename path if renamed; used as dedup key. */
  filePath: z.string().min(1).max(1024),
  /** Previous path if renamed/copied; null otherwise. */
  previousFilePath: z.string().max(1024).nullable().default(null),
  /** Detected language from extension + heuristics. */
  language: z.string().max(64),
  changeType: changeTypeEnum,
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  /** True if file is binary — snippets will always be empty. */
  isBinary: z.boolean().default(false),
  /**
   * Bounded representative snippets. Normal files: top-K changed hunks ≤ 8 KB total.
   * Chunked oversized files: concise narrative + illustrative lines from rolling summary.
   */
  snippets: z
    .array(
      z.object({
        kind: z.enum(["hunk", "summary_narrative", "header"]),
        content: z.string().max(8_192),
      }),
    )
    .max(8),
  /**
   * null  = normal file, no chunking needed.
   * { wasChunked: null } = oversized placeholder, DiffCorpusBuilder will delegate to OversizedFileProcessor.
   * { wasChunked: true, ... } = fully processed via rolling-summary path.
   */
  analysis: z
    .discriminatedUnion("wasChunked", [
      z.object({
        wasChunked: z.literal(true),
        chunkCount: z.number().int().min(1).max(8),
        rollingSummary: z.string().max(6_000),
      }),
      z.object({
        wasChunked: z.null(),
      }),
    ])
    .nullable()
    .default(null),
  /** Relative importance 0–1 used by the coverage planner. */
  importanceScore: z.number().min(0).max(1),
});

export type FileChangeSummary = z.infer<typeof fileChangeSummarySchema>;
export type ChangeType = z.infer<typeof changeTypeEnum>;
