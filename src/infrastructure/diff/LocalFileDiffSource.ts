import { createLogger } from "@/lib/logger";
import { parseDiffFile, extractFilePatch } from "@/infrastructure/diff/unifiedDiffParser";
import { DefaultFileChunker } from "@/infrastructure/diff/DefaultFileChunker";
import { DiffParseError } from "@/lib/diff-errors";
import type { IDiffSource } from "@/interfaces/IDiffSource";
import type { DiffSegment } from "@/domain/entities/DiffSegment";
import type { FileChunk } from "@/domain/entities/FileChunk";

const logger = createLogger("LocalFileDiffSource");

/**
 * IDiffSource implementation for local unified-diff files.
 * Streams the file via unifiedDiffParser; chunksForFile re-reads the same file
 * and extracts only the target file's patch.
 *
 * Caller (PipelineRunner) is responsible for deleting tempPath after ingest (FR-022).
 */
export class LocalFileDiffSource implements IDiffSource {
  private readonly chunker = new DefaultFileChunker();

  constructor(private readonly tempPath: string) {}

  async *segments(options: { signal: AbortSignal }): AsyncIterable<DiffSegment> {
    yield* parseDiffFile(this.tempPath, options);
  }

  async *chunksForFile(
    filePath: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<FileChunk> {
    logger.debug("diff.local.chunksForFile.start", { filePath, tempPath: this.tempPath });

    // Use extractFilePatch to collect raw hunk lines — parseDiffFile strips patch
    // content from oversized files' snippets, so re-parsing through it would yield
    // an empty patch for the very files that need chunking.
    const patch = await extractFilePatch(this.tempPath, filePath, options);

    const patchBytes = Buffer.byteLength(patch, "utf8");
    if (patchBytes === 0) {
      logger.error("diff.local.chunksForFile.patch_not_found", { filePath, tempPath: this.tempPath });
      throw new DiffParseError(0, `File patch not found in local diff: ${filePath}`);
    }
    logger.debug("diff.local.chunksForFile.patch_found", { filePath, patchBytes });

    const chunks = this.chunker.chunk(filePath, patch);
    logger.debug("diff.local.chunksForFile.chunks_ready", { filePath, chunkCount: chunks.length });
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}
