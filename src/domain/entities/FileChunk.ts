import { z } from "zod";

export const fileChunkSchema = z.object({
  filePath: z.string().min(1).max(1024),
  chunkIndex: z.number().int().nonnegative(),
  totalChunks: z.number().int().min(1).max(8),
  isFinal: z.boolean(),
  /**
   * Raw patch text for this chunk only. ≤ PER_FILE_CHUNK_THRESHOLD_BYTES (64 KB default).
   * MUST be set to empty string and garbage-collected as soon as
   * OversizedFileProcessor returns its result (FR-018).
   */
  patch: z.string(),
});

export type FileChunk = z.infer<typeof fileChunkSchema>;
