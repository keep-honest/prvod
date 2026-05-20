import { describe, it, expect } from "vitest";
import { OversizedFileProcessor } from "@/domain/services/OversizedFileProcessor";
import { MockDiffSource } from "@/mocks/MockDiffSource";
import type { IOversizedFileSummariser } from "@/interfaces/IOversizedFileSummariser";
import type { FileChunk } from "@/domain/entities/FileChunk";
import type { RollingSummary } from "@/domain/entities/RollingSummary";

const signal = new AbortController().signal;

/**
 * Stub summariser: appends chunk content to a growing text, bounded to 6 KB.
 */
class StubSummariser implements IOversizedFileSummariser {
  async update(
    prior: RollingSummary | null,
    chunk: FileChunk,
    _isFinal: boolean,
    _options: { signal: AbortSignal },
  ): Promise<RollingSummary> {
    const combined = (prior?.text ?? "") + `\nchunk-${chunk.chunkIndex}: ${chunk.patch.slice(0, 200)}`;
    return {
      filePath: chunk.filePath,
      chunksConsumed: (prior?.chunksConsumed ?? 0) + 1,
      text: combined.slice(0, 6000),
    };
  }
}

function makeChunks(count: number, filePath = "src/large.ts"): FileChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    filePath,
    chunkIndex: i,
    totalChunks: Math.max(2, count) as FileChunk["totalChunks"],
    isFinal: i === count - 1,
    patch: `@@ -${i * 50 + 1},50 +${i * 50 + 1},51 @@\n` +
      Array.from({ length: 50 }, (__, j) => ` line ${i * 50 + j}`).join("\n") +
      `\n+added line ${i}\n`,
  }));
}

describe("Oversized-file chunking integration (OversizedFileProcessor)", () => {
  it("produces analysis.wasChunked === true for a multi-chunk file", async () => {
    const chunks = makeChunks(3);
    const source = new MockDiffSource([], new Map([["src/large.ts", chunks]]));
    const processor = new OversizedFileProcessor(new StubSummariser());

    const result = await processor.process(
      source,
      "src/large.ts",
      { changeType: "modified", previousFilePath: null, isBinary: false, language: "typescript", linesAdded: 0, linesRemoved: 0 },
      { signal },
    );

    expect(result.summary.analysis?.wasChunked).toBe(true);
    expect(result.chunksProcessed).toBe(3);
  });

  it("rolling summary stays within 6000 bytes for 5 chunks", async () => {
    const chunks = makeChunks(5);
    const source = new MockDiffSource([], new Map([["src/large.ts", chunks]]));
    const processor = new OversizedFileProcessor(new StubSummariser());

    const result = await processor.process(
      source,
      "src/large.ts",
      { changeType: "modified", previousFilePath: null, isBinary: false, language: "typescript", linesAdded: 0, linesRemoved: 0 },
      { signal },
    );

    const summaryText = result.summary.analysis?.wasChunked === true
      ? result.summary.analysis.rollingSummary ?? ""
      : "";
    expect(Buffer.byteLength(summaryText, "utf8")).toBeLessThanOrEqual(6000);
  });

  it("discards chunk patch after each LLM call (FR-018)", async () => {
    const discardedPatches: string[] = [];
    const capturingSummariser: IOversizedFileSummariser = {
      async update(prior, chunk, _isFinal, _opts) {
        // After this call returns, caller nulls chunk.patch
        discardedPatches.push(chunk.patch);
        return {
          filePath: chunk.filePath,
          chunksConsumed: (prior?.chunksConsumed ?? 0) + 1,
          text: (prior?.text ?? "") + `chunk-${chunk.chunkIndex}`,
        };
      },
    };

    const chunks = makeChunks(3);
    const originalPatches = chunks.map((c) => c.patch);

    const source = new MockDiffSource([], new Map([["src/large.ts", chunks]]));
    const processor = new OversizedFileProcessor(capturingSummariser);

    await processor.process(
      source,
      "src/large.ts",
      { changeType: "modified", previousFilePath: null, isBinary: false, language: "typescript", linesAdded: 0, linesRemoved: 0 },
      { signal },
    );

    // The summariser received non-empty patches (captured before discard)
    expect(discardedPatches[0]).toBe(originalPatches[0]);
    // After processing, the chunks array should have empty patch strings (FR-018)
    for (const chunk of chunks) {
      expect(chunk.patch).toBe("");
    }
  });

  it("carries linesAdded and linesRemoved from all chunks", async () => {
    const chunks: FileChunk[] = [
      { filePath: "src/f.ts", chunkIndex: 0, totalChunks: 2, isFinal: false, patch: "@@ -1,3 +1,4 @@\n context\n+added1\n unchanged\n-removed1\n" },
      { filePath: "src/f.ts", chunkIndex: 1, totalChunks: 2, isFinal: true, patch: "@@ -10,2 +10,3 @@\n context\n+added2\n unchanged\n" },
    ];

    const source = new MockDiffSource([], new Map([["src/f.ts", chunks]]));
    const processor = new OversizedFileProcessor(new StubSummariser());

    const result = await processor.process(
      source,
      "src/f.ts",
      { changeType: "modified", previousFilePath: null, isBinary: false, language: "typescript", linesAdded: 0, linesRemoved: 0 },
      { signal },
    );

    // +added1 +added2 = 2 added; -removed1 = 1 removed
    expect(result.summary.linesAdded).toBe(2);
    expect(result.summary.linesRemoved).toBe(1);
    expect(result.totalLinesInFile).toBe(3);
  });
});
