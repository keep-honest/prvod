import { z } from "zod";
import { fileChangeSummarySchema } from "./FileChangeSummary";

export const diffMetadataCorpusSchema = z.object({
  /** Job ID that owns this corpus — for observability. */
  jobId: z.string().uuid(),
  /** Dedup map: filePath → FileChangeSummary. */
  files: z.record(z.string(), fileChangeSummarySchema),
  /** Sum of linesAdded + linesRemoved across all files. */
  totalLines: z.number().int().nonnegative(),
  /** Number of segments merged into this corpus. */
  segmentCount: z.number().int().nonnegative(),
  /** Number of files that required rolling-summary chunking. */
  chunkedFileCount: z.number().int().nonnegative(),
  /** True once all segments have been consumed. */
  isComplete: z.boolean(),
  /** Whether the diff came from a GitHub PR or a local file. */
  sourceType: z.enum(["github_pr", "local_diff_file"]),
});

export type DiffMetadataCorpus = z.infer<typeof diffMetadataCorpusSchema>;
