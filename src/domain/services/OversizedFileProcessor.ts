import { createLogger } from "@/lib/logger";
import { DiffParseError } from "@/lib/diff-errors";
import type { IDiffSource } from "@/interfaces/IDiffSource";
import type { IOversizedFileSummariser } from "@/interfaces/IOversizedFileSummariser";
import type { FileChangeSummary } from "@/domain/entities/FileChangeSummary";
import type { RollingSummary } from "@/domain/entities/RollingSummary";

const logger = createLogger("OversizedFileProcessor");

export interface OversizedFileResult {
  /** FileChangeSummary with analysis.wasChunked === true */
  summary: FileChangeSummary;
  chunksProcessed: number;
  /** Sum of linesAdded + linesRemoved across all chunks */
  totalLinesInFile: number;
}

/**
 * Processes a single oversized file by streaming its chunks, building a rolling
 * summary via an injected LLM summariser, and returning a final FileChangeSummary
 * with wasChunked === true.
 *
 * Memory-safety: chunk.patch is set to empty string after each LLM call (FR-018).
 */
export class OversizedFileProcessor {
  constructor(private readonly summariser: IOversizedFileSummariser) {}

  async process(
    source: IDiffSource,
    filePath: string,
    baseEntry: Pick<FileChangeSummary, "changeType" | "previousFilePath" | "isBinary" | "language" | "linesAdded" | "linesRemoved">,
    options: { signal: AbortSignal },
  ): Promise<OversizedFileResult> {
    const { signal } = options;

    logger.debug("diff.oversized_file.process.start", { filePath });

    let rollingSummary: RollingSummary | null = null;
    let chunksProcessed = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    let sawAnyPatchContent = false;

    for await (const chunk of source.chunksForFile(filePath, { signal })) {
      const { chunkIndex, totalChunks, isFinal, patch } = chunk;

      // Count lines before discarding patch
      const { linesAdded, linesRemoved } = countPatchLines(patch);
      totalLinesAdded += linesAdded;
      totalLinesRemoved += linesRemoved;
      if (patch.length > 0) sawAnyPatchContent = true;

      rollingSummary = await this.summariser.update(rollingSummary, chunk, isFinal, { signal });

      // FR-018: discard raw patch immediately after LLM call
      (chunk as { patch: string }).patch = "";

      chunksProcessed++;

      logger.debug("diff.oversized_file.chunk", {
        filePath,
        chunkIndex,
        totalChunks,
        isFinal,
        chunksProcessed,
        summaryBytes: Buffer.byteLength(rollingSummary.text, "utf8"),
      });

      if (isFinal) break;
    }

    if (!rollingSummary) {
      throw new DiffParseError(0, `No chunks yielded by IDiffSource for oversized file: ${filePath}`);
    }

    const chunkCount = Math.min(8, chunksProcessed) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

    // GitHub omits the `patch` field for very large files; in that case the chunk
    // stream yields an empty stub and our line counts are zero. Fall back to the
    // additions/deletions reported by the PR Files API so the corpus undercount
    // doesn't bypass the 200k-line hard cap or mis-rank the file as trivial.
    const finalLinesAdded =
      sawAnyPatchContent || totalLinesAdded > 0 ? totalLinesAdded : baseEntry.linesAdded;
    const finalLinesRemoved =
      sawAnyPatchContent || totalLinesRemoved > 0 ? totalLinesRemoved : baseEntry.linesRemoved;
    if (!sawAnyPatchContent) {
      logger.warn("diff.oversized_file.patch_withheld_using_metadata_counts", {
        filePath,
        baseEntryLinesAdded: baseEntry.linesAdded,
        baseEntryLinesRemoved: baseEntry.linesRemoved,
      });
    }

    const summary: FileChangeSummary = {
      filePath,
      previousFilePath: baseEntry.previousFilePath,
      language: baseEntry.language,
      changeType: baseEntry.changeType,
      linesAdded: finalLinesAdded,
      linesRemoved: finalLinesRemoved,
      isBinary: baseEntry.isBinary,
      snippets: [
        {
          kind: "summary_narrative",
          content: rollingSummary.text.slice(0, 8_192),
        },
      ],
      analysis: {
        wasChunked: true,
        chunkCount,
        rollingSummary: rollingSummary.text,
      },
      importanceScore: 0.8,
    };

    logger.info("diff.oversized_file.process.done", {
      filePath,
      chunksProcessed,
      linesAdded: finalLinesAdded,
      linesRemoved: finalLinesRemoved,
      patchWithheld: !sawAnyPatchContent,
    });

    return {
      summary,
      chunksProcessed,
      totalLinesInFile: finalLinesAdded + finalLinesRemoved,
    };
  }
}

/** Count added/removed lines from a unified diff patch text. */
function countPatchLines(patch: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
    else if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}
