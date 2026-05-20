import { createLogger } from "@/lib/logger";
import { DiffTooLargeError } from "@/lib/diff-errors";
import type { IDiffSource } from "@/interfaces/IDiffSource";
import type { FileChangeSummary } from "@/domain/entities/FileChangeSummary";
import type { DiffMetadataCorpus } from "@/domain/entities/DiffMetadataCorpus";
import type { OversizedFileProcessor } from "@/domain/services/OversizedFileProcessor";

const logger = createLogger("DiffCorpusBuilder");

/** Hard cap on total diff lines (FR-004). */
const HARD_CAP_LINES = 200_000;

export interface BuildOptions {
  signal: AbortSignal;
  sourceType: "github_pr" | "local_diff_file";
  /** Optional processor for oversized files. If omitted, oversized files are included as-is. */
  oversizedProcessor?: OversizedFileProcessor;
}

/**
 * Consumes an IDiffSource segment stream and accumulates a DiffMetadataCorpus.
 * Memory-safety: segment.files is nulled after merging (FR-003).
 * Hard cap: throws DiffTooLargeError when totalLines > 200,000 (FR-004).
 * Oversized files: delegates to OversizedFileProcessor when provided (T028).
 */
export class DiffCorpusBuilder {
  async build(
    jobId: string,
    source: IDiffSource,
    options: BuildOptions,
  ): Promise<DiffMetadataCorpus> {
    const { signal, sourceType, oversizedProcessor } = options;

    const corpus: DiffMetadataCorpus = {
      jobId,
      files: {},
      totalLines: 0,
      segmentCount: 0,
      chunkedFileCount: 0,
      isComplete: false,
      sourceType,
    };

    logger.debug("DiffCorpusBuilder.build starting", { jobId, sourceType });

    for await (const segment of source.segments({ signal })) {
      const files = segment.files;

      for (const file of files) {
        // Binary files carry no diff content — skip with warning per spec edge case
        if (file.isBinary) {
          logger.warn("diff.corpus.file_binary.skipped", { jobId, filePath: file.filePath });
          continue;
        }

        // Detect oversized placeholder set by IDiffSource implementations
        const isOversized = file.analysis !== null && file.analysis.wasChunked === null;

        // Pre-check the hard cap using the metadata counts already on `file`
        // BEFORE any LLM summarisation. Otherwise an oversized file that alone
        // pushes the corpus past 200k lines burns chunking + summariser calls
        // before being rejected by the post-processing cap check below.
        // Skip this for already-existing entries (dedup path doesn't grow lines).
        if (!corpus.files[file.filePath]) {
          const preCheckLines = file.linesAdded + file.linesRemoved;
          const preCheckTotal = corpus.totalLines + preCheckLines;
          if (preCheckTotal > HARD_CAP_LINES) {
            logger.warn("diff.corpus.hard_cap_exceeded.pre_oversized", {
              jobId,
              filePath: file.filePath,
              fileLines: preCheckLines,
              totalLinesBefore: corpus.totalLines,
              newTotal: preCheckTotal,
              capLines: HARD_CAP_LINES,
              isOversized,
            });
            throw new DiffTooLargeError(HARD_CAP_LINES, preCheckTotal, segment.segmentIndex);
          }
        }

        let finalFile = file;
        if (isOversized && !oversizedProcessor) {
          logger.warn("diff.oversized_file.no_processor", {
            jobId,
            filePath: file.filePath,
            consequence: "file included in corpus with wasChunked:null placeholder — no rolling summary will be generated",
          });
        }
        if (isOversized && oversizedProcessor) {
          logger.debug("diff.oversized_file.delegating", { jobId, filePath: file.filePath });
          try {
            const result = await oversizedProcessor.process(
              source,
              file.filePath,
              {
                changeType: file.changeType,
                previousFilePath: file.previousFilePath,
                isBinary: file.isBinary,
                language: file.language,
                // Carry the PR Files API additions/deletions so the processor can
                // fall back to them when GitHub withholds the patch field.
                linesAdded: file.linesAdded,
                linesRemoved: file.linesRemoved,
              },
              { signal },
            );
            finalFile = result.summary;
          } catch (err) {
            if (signal.aborted) throw err;
            logger.error("diff.oversized_file.process.failed", {
              jobId,
              filePath: file.filePath,
              segmentIndex: segment.segmentIndex,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        }

        const existing = corpus.files[finalFile.filePath];
        if (existing) {
          // Dedup: merge into existing entry (FR-005) — do NOT re-count lines
          logger.debug("diff.corpus.file_dedup", { jobId, filePath: finalFile.filePath });
          // Log warning when changeType conflicts across segments (spec edge case)
          if (existing.changeType !== finalFile.changeType) {
            logger.warn("diff.corpus.file_dedup.conflict", {
              jobId,
              filePath: finalFile.filePath,
              existingChangeType: existing.changeType,
              incomingChangeType: finalFile.changeType,
            });
          }
          const merged = mergeFileSummaries(existing, finalFile);
          corpus.files[finalFile.filePath] = merged;
          // Only increment if this merge promoted the file from no analysis to having analysis
          if (existing.analysis === null && merged.analysis !== null) {
            corpus.chunkedFileCount++;
          }
        } else {
          const fileLines = finalFile.linesAdded + finalFile.linesRemoved;
          const newTotal = corpus.totalLines + fileLines;

          if (newTotal > HARD_CAP_LINES) {
            logger.warn("diff.corpus.hard_cap_exceeded", {
              jobId,
              filePath: finalFile.filePath,
              fileLines,
              totalLinesBefore: corpus.totalLines,
              newTotal,
              capLines: HARD_CAP_LINES,
            });
            throw new DiffTooLargeError(HARD_CAP_LINES, newTotal, segment.segmentIndex);
          }

          corpus.files[finalFile.filePath] = finalFile;
          corpus.totalLines += fileLines;
          if (finalFile.analysis !== null) {
            corpus.chunkedFileCount++;
          }
        }
      }

      // Capture count before GC release so the log reports the correct value
      const processedFileCount = files.length;
      // Release segment files for GC (FR-003) — truncate in-place to release element references
      segment.files.length = 0;

      corpus.segmentCount++;

      logger.debug("diff.segment.fetch.success", {
        jobId,
        segmentIndex: segment.segmentIndex,
        isFinal: segment.isFinal,
        fileCount: processedFileCount,
        totalLines: corpus.totalLines,
      });

      if (segment.isFinal) {
        corpus.isComplete = true;
        break;
      }
    }

    if (!corpus.isComplete) {
      logger.warn("diff.corpus.incomplete", {
        jobId,
        segmentCount: corpus.segmentCount,
        totalFiles: Object.keys(corpus.files).length,
        totalLines: corpus.totalLines,
        sourceType,
        reason: "No isFinal segment received — source may have terminated early",
      });
    } else {
      logger.info("diff.corpus.finalized", {
        jobId,
        totalFiles: Object.keys(corpus.files).length,
        totalLines: corpus.totalLines,
        segmentCount: corpus.segmentCount,
        chunkedFileCount: corpus.chunkedFileCount,
        isComplete: corpus.isComplete,
        sourceType,
      });
    }

    return corpus;
  }
}

/** Merge two FileChangeSummary records for the same filePath. */
function mergeFileSummaries(
  existing: FileChangeSummary,
  incoming: FileChangeSummary,
): FileChangeSummary {
  // Union snippets (up to max 8)
  const mergedSnippets = [
    ...existing.snippets,
    ...incoming.snippets.filter(
      (s) => !existing.snippets.some((e) => e.content === s.content),
    ),
  ].slice(0, 8);

  return {
    ...existing,
    // Most-recent state wins for file metadata (spec edge case: segments can disagree on changeType)
    changeType: incoming.changeType,
    previousFilePath: incoming.previousFilePath,
    linesAdded: existing.linesAdded + incoming.linesAdded,
    linesRemoved: existing.linesRemoved + incoming.linesRemoved,
    snippets: mergedSnippets,
    // Prefer the incoming analysis if it's the fully-processed state
    analysis: incoming.analysis?.wasChunked === true ? incoming.analysis : existing.analysis,
    // Keep the higher importance score
    importanceScore: Math.max(existing.importanceScore, incoming.importanceScore),
  };
}
