import type { DiffSegment } from "@/domain/entities/DiffSegment";
import type { FileChunk } from "@/domain/entities/FileChunk";

/**
 * Streaming, segment-by-segment source of pull-request diff data.
 * The only way any implementation exposes diff content to the pipeline.
 *
 * Layer 1 port — implementations live in Layer 3 only.
 */
export interface IDiffSource {
  /**
   * Stream diff segments in order. Implementations MUST:
   *   - Yield one DiffSegment per page/chunk.
   *   - Set `segment.isFinal === true` on and only on the last yielded segment.
   *   - Release all raw-patch memory associated with a segment as soon as
   *     the caller consumes the next item (or the iterator is closed).
   *   - Abort promptly when the provided AbortSignal fires.
   */
  segments(options: { signal: AbortSignal }): AsyncIterable<DiffSegment>;

  /**
   * Stream the chunks of a single oversized file in order.
   * Used by OversizedFileProcessor after a file has been flagged by segments().
   *
   * Each chunk.patch ≤ PER_FILE_CHUNK_THRESHOLD_BYTES (64 KB default).
   * Implementations MUST null out chunk.patch before yielding the next chunk.
   */
  chunksForFile(
    filePath: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<FileChunk>;
}
