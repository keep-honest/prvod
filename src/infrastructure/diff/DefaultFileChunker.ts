import { createLogger } from "@/lib/logger";
import type { IFileChunker } from "@/interfaces/IFileChunker";
import type { FileChunk } from "@/domain/entities/FileChunk";

const logger = createLogger("DefaultFileChunker");

const DEFAULT_THRESHOLD_BYTES = 64 * 1024; // 64 KB
const DEFAULT_MAX_CHUNKS = 8;

/**
 * Splits a unified diff patch into hunk-aligned chunks bounded by thresholdBytes.
 * Splitting happens at hunk boundaries (lines starting with "@@") so each chunk
 * is a valid, self-contained patch fragment for summarisation.
 */
export class DefaultFileChunker implements IFileChunker {
  chunk(
    filePath: string,
    patch: string,
    options?: { thresholdBytes?: number; maxChunks?: number },
  ): FileChunk[] {
    const thresholdBytes = options?.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
    const maxChunks = options?.maxChunks ?? DEFAULT_MAX_CHUNKS;

    const patchBytes = Buffer.byteLength(patch, "utf8");
    logger.debug("diff.chunker.start", { filePath, patchBytes, thresholdBytes, maxChunks });

    // Split at hunk boundaries first, then split any single hunk that already
    // exceeds the threshold at line boundaries so no individual chunk can grow
    // unbounded (e.g. a generated file rewritten in one giant hunk).
    const rawHunks = splitAtHunkBoundaries(patch).filter((h) => h.trim().length > 0);
    const hunks: string[] = [];
    for (const hunk of rawHunks) {
      if (Buffer.byteLength(hunk, "utf8") <= thresholdBytes) {
        hunks.push(hunk);
        continue;
      }
      const sliced = sliceLargeHunk(hunk, thresholdBytes);
      logger.warn("diff.chunker.large_hunk_sliced", {
        filePath,
        originalBytes: Buffer.byteLength(hunk, "utf8"),
        sliceCount: sliced.length,
        thresholdBytes,
      });
      hunks.push(...sliced);
    }
    if (hunks.length === 0) {
      logger.debug("diff.chunker.empty", { filePath });
      return [{
        filePath,
        chunkIndex: 0,
        totalChunks: 1,
        isFinal: true,
        patch: "",
      }];
    }

    // Accumulate hunks into chunks. Each chunk must respect both thresholdBytes
    // AND the maxChunks count cap (FileChunk.totalChunks schema is min 1, max 8).
    // When the file exceeds maxChunks * thresholdBytes total, the tail is dropped
    // with a warning rather than overflowed into the final chunk — the summariser
    // gets a rolling summary of the leading bytes instead of a single oversized
    // patch that would violate the IFileChunker/IDiffSource contract.
    const rawChunks: string[] = [];
    let current = "";
    let droppedHunks = 0;
    let droppedBytes = 0;

    for (const hunk of hunks) {
      const hunkBytes = Buffer.byteLength(hunk, "utf8");
      const currentBytes = Buffer.byteLength(current, "utf8");

      if (current && currentBytes + hunkBytes > thresholdBytes) {
        // Flush current chunk. If we already have maxChunks-1 in rawChunks,
        // drop the remainder rather than letting current become unbounded.
        if (rawChunks.length >= maxChunks) {
          droppedHunks++;
          droppedBytes += hunkBytes;
          continue;
        }
        rawChunks.push(current);
        current = hunkBytes <= thresholdBytes ? hunk : "";
        if (hunkBytes > thresholdBytes) {
          // Should not happen — sliceLargeHunk above keeps each hunk <= threshold —
          // but guard anyway so we never silently emit an oversized chunk.
          droppedHunks++;
          droppedBytes += hunkBytes;
        }
      } else if (rawChunks.length >= maxChunks && !current) {
        // No room for this hunk and no current to merge into — drop.
        droppedHunks++;
        droppedBytes += hunkBytes;
      } else {
        current = current ? current + hunk : hunk;
      }
    }

    if (current) {
      if (rawChunks.length < maxChunks) {
        rawChunks.push(current);
      } else {
        droppedHunks++;
        droppedBytes += Buffer.byteLength(current, "utf8");
      }
    }

    if (droppedHunks > 0) {
      logger.warn("diff.chunker.content_truncated", {
        filePath,
        droppedHunks,
        droppedBytes,
        thresholdBytes,
        maxChunks,
        keptChunks: rawChunks.length,
        consequence: "rolling summary covers leading bytes only; tail of file is omitted",
      });
    }

    const totalChunks = Math.min(rawChunks.length, maxChunks) as FileChunk["totalChunks"];

    logger.debug("diff.chunker.done", { filePath, totalHunks: hunks.length, chunkCount: totalChunks });

    return rawChunks.slice(0, maxChunks).map((patchText, i) => ({
      filePath,
      chunkIndex: i,
      totalChunks,
      isFinal: i === rawChunks.length - 1 || i === maxChunks - 1,
      patch: patchText,
    }));
  }
}

// Marker appended to a truncated long line so the LLM summariser knows the
// content was clipped. Kept short to leave most of the byte budget for content.
const LONG_LINE_TRUNCATION_MARKER = "...[truncated]";

/**
 * Truncates a single line that on its own exceeds the per-slice byte budget
 * (e.g. a minified JS bundle, lockfile, or generated JSON line). Preserves the
 * leading +/- character so the resulting fragment is still recognisable as a
 * diff line; appends a marker so the summariser can see it was clipped.
 */
function truncateLongLine(line: string, maxBytes: number): string {
  const markerBytes = Buffer.byteLength(LONG_LINE_TRUNCATION_MARKER, "utf8");
  // Reserve at least 1 byte for the diff prefix (+/-/space/\) and the marker.
  if (maxBytes <= markerBytes + 1) {
    // Threshold is too tight to express even the marker; emit prefix + marker.
    const prefix = line.charAt(0);
    return prefix + LONG_LINE_TRUNCATION_MARKER;
  }
  const buf = Buffer.from(line, "utf8");
  const keepBytes = maxBytes - markerBytes;
  // Walk back to a UTF-8 character boundary so we don't split a multibyte char.
  let end = keepBytes;
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xC0) !== 0x80) break;
    end--;
  }
  return buf.subarray(0, end).toString("utf8") + LONG_LINE_TRUNCATION_MARKER;
}

/**
 * Splits a single hunk that exceeds thresholdBytes into line-aligned sub-slices,
 * each <= thresholdBytes. The hunk header (@@ line) is repeated on each slice so
 * downstream summarisers still see a hunk-shaped fragment.
 */
function sliceLargeHunk(hunk: string, thresholdBytes: number): string[] {
  const lines = hunk.split("\n");
  // The first line is the hunk header (@@ -... +... @@). Repeat on each slice.
  const header = lines[0]?.startsWith("@@") ? lines[0] : "";
  const bodyLines = header ? lines.slice(1) : lines;
  const headerBytes = header ? Buffer.byteLength(header + "\n", "utf8") : 0;
  // Per-line byte budget after reserving the header on each slice.
  const lineBudget = Math.max(1, thresholdBytes - headerBytes);

  const slices: string[] = [];
  let currentLines: string[] = [];
  let currentBytes = headerBytes;
  let longLineCount = 0;

  for (const rawLine of bodyLines) {
    // Pathological single line longer than the per-line budget: byte-truncate
    // (including the trailing newline) so the resulting slice respects the cap.
    const lineWithNlBytes = Buffer.byteLength(rawLine + "\n", "utf8");
    let line = rawLine;
    let lineBytes = lineWithNlBytes;
    if (lineWithNlBytes > lineBudget) {
      // Reserve 1 byte for the trailing newline within the budget.
      line = truncateLongLine(rawLine, Math.max(1, lineBudget - 1));
      lineBytes = Buffer.byteLength(line + "\n", "utf8");
      longLineCount++;
    }

    if (currentBytes + lineBytes > thresholdBytes && currentLines.length > 0) {
      slices.push((header ? header + "\n" : "") + currentLines.join("\n"));
      currentLines = [line];
      currentBytes = headerBytes + lineBytes;
    } else {
      currentLines.push(line);
      currentBytes += lineBytes;
    }
  }
  if (currentLines.length > 0) {
    slices.push((header ? header + "\n" : "") + currentLines.join("\n"));
  }
  if (longLineCount > 0) {
    logger.warn("diff.chunker.long_line_truncated", {
      longLineCount,
      thresholdBytes,
      consequence: "individual long lines truncated to fit byte cap; summariser sees [...truncated] marker",
    });
  }
  return slices.length > 0 ? slices : [hunk];
}

/** Split a unified diff into individual hunk strings (each starts with "@@"). */
function splitAtHunkBoundaries(patch: string): string[] {
  const lines = patch.split("\n");
  const hunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@") && current.length > 0) {
      hunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    hunks.push(current.join("\n"));
  }

  return hunks;
}
