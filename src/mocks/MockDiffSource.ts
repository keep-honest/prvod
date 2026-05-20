import type { IDiffSource } from "@/interfaces/IDiffSource";
import type { DiffSegment } from "@/domain/entities/DiffSegment";
import type { FileChunk } from "@/domain/entities/FileChunk";

/**
 * In-memory IDiffSource for unit tests.
 * Backed by a DiffSegment[] and a Map<filePath, FileChunk[]>.
 */
export class MockDiffSource implements IDiffSource {
  constructor(
    private readonly segments_: DiffSegment[],
    private readonly chunkMap: Map<string, FileChunk[]> = new Map(),
  ) {}

  async *segments(options: { signal: AbortSignal }): AsyncIterable<DiffSegment> {
    for (const segment of this.segments_) {
      if (options.signal.aborted) {
        throw options.signal.reason instanceof Error ? options.signal.reason : new Error(String(options.signal.reason ?? "Aborted"));
      }
      yield segment;
    }
  }

  async *chunksForFile(
    filePath: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<FileChunk> {
    const chunks = this.chunkMap.get(filePath) ?? [];
    for (const chunk of chunks) {
      if (options.signal.aborted) {
        throw options.signal.reason instanceof Error ? options.signal.reason : new Error(String(options.signal.reason ?? "Aborted"));
      }
      yield chunk;
    }
  }
}
