import type { FileChunk } from "@/domain/entities/FileChunk";

/**
 * Splits a single oversized file's patch into ordered, size-bounded chunks.
 * Layer 1 port — DefaultFileChunker implements this in Layer 3.
 */
export interface IFileChunker {
  /**
   * Split `patch` into ≤ maxChunks chunks, each ≤ thresholdBytes in size.
   * Returns an array ordered by chunkIndex with isFinal on the last.
   */
  chunk(
    filePath: string,
    patch: string,
    options?: { thresholdBytes?: number; maxChunks?: number },
  ): FileChunk[];
}
