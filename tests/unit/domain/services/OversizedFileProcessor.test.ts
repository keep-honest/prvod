import { describe, it, expect, vi } from "vitest";
import { OversizedFileProcessor } from "@/domain/services/OversizedFileProcessor";
import { DiffParseError } from "@/lib/diff-errors";
import type { IOversizedFileSummariser } from "@/interfaces/IOversizedFileSummariser";
import type { FileChunk } from "@/domain/entities/FileChunk";
import type { RollingSummary } from "@/domain/entities/RollingSummary";
import type { IDiffSource } from "@/interfaces/IDiffSource";

function makeChunk(
  filePath: string,
  chunkIndex: number,
  totalChunks: number,
  isFinal: boolean,
  patch = `@@ -1,2 +1,3 @@\n+added line ${chunkIndex}`,
): FileChunk {
  return { filePath, chunkIndex, totalChunks, isFinal, patch };
}

function makeMockSummariser(
  impl: (prior: RollingSummary | null, chunk: FileChunk, isFinal: boolean) => Promise<RollingSummary>,
): IOversizedFileSummariser {
  return { update: vi.fn().mockImplementation(impl) };
}

function makeSource(chunks: FileChunk[]): IDiffSource {
  return {
    async *segments() {},
    async *chunksForFile(_filePath: string) {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

const signal = new AbortController().signal;
const baseEntry = {
  changeType: "modified" as const,
  previousFilePath: null,
  isBinary: false,
  language: "typescript",
  linesAdded: 0,
  linesRemoved: 0,
};

describe("OversizedFileProcessor", () => {
  it("calls summariser once per chunk and returns wasChunked=true", async () => {
    const chunks = [
      makeChunk("src/big.ts", 0, 2, false),
      makeChunk("src/big.ts", 1, 2, true),
    ];
    const source = makeSource(chunks);
    const summariser = makeMockSummariser(async (prior, chunk, isFinal) => ({
      filePath: chunk.filePath,
      chunksConsumed: (prior?.chunksConsumed ?? 0) + 1,
      text: `summary after chunk ${chunk.chunkIndex}${isFinal ? " FINAL" : ""}`,
    }));

    const processor = new OversizedFileProcessor(summariser);
    const result = await processor.process(source, "src/big.ts", baseEntry, { signal });

    expect(summariser.update).toHaveBeenCalledTimes(2);
    expect(result.chunksProcessed).toBe(2);
    expect(result.summary.analysis).toMatchObject({ wasChunked: true, chunkCount: 2 });
    expect(result.summary.analysis?.wasChunked).toBe(true);
  });

  it("passes rolling summary from previous chunk to next call (FR-017)", async () => {
    const chunks = [
      makeChunk("src/a.ts", 0, 2, false),
      makeChunk("src/a.ts", 1, 2, true),
    ];
    const source = makeSource(chunks);
    const summaryHistory: Array<RollingSummary | null> = [];
    const summariser = makeMockSummariser(async (prior, chunk) => {
      summaryHistory.push(prior);
      return {
        filePath: chunk.filePath,
        chunksConsumed: (prior?.chunksConsumed ?? 0) + 1,
        text: `text-${chunk.chunkIndex}`,
      };
    });

    const processor = new OversizedFileProcessor(summariser);
    await processor.process(source, "src/a.ts", baseEntry, { signal });

    // First call: prior should be null
    expect(summaryHistory[0]).toBeNull();
    // Second call: prior should be the result of first call
    expect(summaryHistory[1]).toMatchObject({ chunksConsumed: 1, text: "text-0" });
  });

  it("discards chunk.patch after LLM call (FR-018)", async () => {
    const chunk1 = makeChunk("src/b.ts", 0, 2, false, "@@ -1 +1 @@\n+change 1");
    const chunk2 = makeChunk("src/b.ts", 1, 2, true, "@@ -2 +2 @@\n+change 2");
    const source = makeSource([chunk1, chunk2]);

    const _patchesAfterCall: string[] = [];
    const summariser = makeMockSummariser(async (_prior, chunk) => {
      // Capture patch state AFTER the summariser returns — processor should null it
      const result: RollingSummary = {
        filePath: chunk.filePath,
        chunksConsumed: 1,
        text: "summary",
      };
      return result;
    });

    const processor = new OversizedFileProcessor(summariser);
    await processor.process(source, "src/b.ts", baseEntry, { signal });

    // After processing, both chunks' patches should be emptied
    expect(chunk1.patch).toBe("");
    expect(chunk2.patch).toBe("");
  });

  it("accumulates linesAdded and linesRemoved across chunks", async () => {
    const chunks = [
      makeChunk("src/c.ts", 0, 2, false, "@@ -1,2 +1,3 @@\n+added\n+added2\n context"),
      makeChunk("src/c.ts", 1, 2, true, "@@ -3,1 +4,2 @@\n-removed\n+replacement"),
    ];
    const source = makeSource(chunks);
    const summariser = makeMockSummariser(async (_prior, chunk) => ({
      filePath: chunk.filePath,
      chunksConsumed: 1,
      text: "summary",
    }));

    const processor = new OversizedFileProcessor(summariser);
    const result = await processor.process(source, "src/c.ts", baseEntry, { signal });

    // chunk 0: 2 additions ("+added", "+added2"); chunk 1: 1 addition ("+replacement"), 1 removal ("-removed")
    expect(result.summary.linesAdded).toBe(3);
    expect(result.summary.linesRemoved).toBe(1);
    expect(result.totalLinesInFile).toBe(4);
  });

  it("throws when source yields no chunks", async () => {
    const source: IDiffSource = {
      async *segments() {},
      async *chunksForFile() { /* yields nothing */ },
    };
    const summariser = makeMockSummariser(async (_prior, chunk) => ({
      filePath: chunk.filePath,
      chunksConsumed: 1,
      text: "x",
    }));

    const processor = new OversizedFileProcessor(summariser);
    await expect(
      processor.process(source, "src/empty.ts", baseEntry, { signal }),
    ).rejects.toBeInstanceOf(DiffParseError);
  });

  it("propagates abort signal to summariser", async () => {
    const ctrl = new AbortController();
    const chunk = makeChunk("src/d.ts", 0, 2, false);
    const source = makeSource([chunk]);

    const summariser: IOversizedFileSummariser = {
      update: vi.fn().mockImplementation(async (_prior, _chunk, _isFinal, opts) => {
        if (opts.signal.aborted) throw opts.signal.reason;
        return { filePath: "src/d.ts", chunksConsumed: 1, text: "summary" };
      }),
    };

    ctrl.abort(new Error("cancelled"));
    const processor = new OversizedFileProcessor(summariser);
    await expect(
      processor.process(source, "src/d.ts", baseEntry, { signal: ctrl.signal }),
    ).rejects.toThrow("cancelled");
  });

  it("result has summary_narrative snippet with the final rolling summary text", async () => {
    const chunks = [makeChunk("src/e.ts", 0, 2, true)];
    const source = makeSource(chunks);
    const summariser = makeMockSummariser(async (_prior, chunk) => ({
      filePath: chunk.filePath,
      chunksConsumed: 1,
      text: "The file implements a service pattern with three main classes.",
    }));

    const processor = new OversizedFileProcessor(summariser);
    const result = await processor.process(source, "src/e.ts", baseEntry, { signal });

    const narrativeSnippet = result.summary.snippets.find((s) => s.kind === "summary_narrative");
    expect(narrativeSnippet).toBeDefined();
    expect(narrativeSnippet?.content).toContain("service pattern");
  });

  it("caps chunkCount at 8 when source yields more than 8 chunks", async () => {
    const totalRaw = 9;
    // Construct 9 raw chunks (bypasses Zod max:8 schema — processor itself enforces the cap)
    const chunks = Array.from({ length: totalRaw }, (_, i) =>
      makeChunk("src/huge.ts", i, totalRaw, i === totalRaw - 1),
    );
    const source = makeSource(chunks);
    const summariser = makeMockSummariser(async (_prior, chunk) => ({
      filePath: chunk.filePath,
      chunksConsumed: 1,
      text: "summary",
    }));

    const processor = new OversizedFileProcessor(summariser);
    const result = await processor.process(source, "src/huge.ts", baseEntry, { signal });

    expect(result.chunksProcessed).toBe(9); // actual processed count
    expect(result.summary.analysis?.wasChunked).toBe(true);
    if (result.summary.analysis?.wasChunked === true) {
      expect(result.summary.analysis.chunkCount).toBe(8); // capped at 8
    }
  });

  it("rollingSummary in analysis matches the final summary text", async () => {
    const chunks = [makeChunk("src/f.ts", 0, 2, true)];
    const source = makeSource(chunks);
    const finalText = "Final rolling summary text.";
    const summariser = makeMockSummariser(async (_prior, chunk) => ({
      filePath: chunk.filePath,
      chunksConsumed: 1,
      text: finalText,
    }));

    const processor = new OversizedFileProcessor(summariser);
    const result = await processor.process(source, "src/f.ts", baseEntry, { signal });

    expect(result.summary.analysis?.wasChunked).toBe(true);
    if (result.summary.analysis?.wasChunked === true) {
      expect(result.summary.analysis.rollingSummary).toBe(finalText);
    }
  });

  it("falls back to baseEntry line counts when GitHub withholds the patch (empty stub)", async () => {
    // GitHub may yield a single empty-patch stub for very large files
    const emptyStub: FileChunk = {
      filePath: "src/withheld.ts",
      chunkIndex: 0,
      totalChunks: 1,
      isFinal: true,
      patch: "",
    };
    const source = makeSource([emptyStub]);
    const summariser = makeMockSummariser(async (_prior, chunk) => ({
      filePath: chunk.filePath,
      chunksConsumed: 1,
      text: "metadata-only summary",
    }));

    const processor = new OversizedFileProcessor(summariser);
    const result = await processor.process(
      source,
      "src/withheld.ts",
      {
        changeType: "modified",
        previousFilePath: null,
        isBinary: false,
        language: "typescript",
        linesAdded: 4_500,
        linesRemoved: 800,
      },
      { signal },
    );

    expect(result.summary.linesAdded).toBe(4_500);
    expect(result.summary.linesRemoved).toBe(800);
    expect(result.totalLinesInFile).toBe(5_300);
  });

  it("uses counted line totals when chunks contain real patch content (ignores baseEntry)", async () => {
    // Patch present → count from chunks, not baseEntry
    const chunk = makeChunk("src/real.ts", 0, 1, true);
    const source = makeSource([chunk]);
    const summariser = makeMockSummariser(async (_prior, c) => ({
      filePath: c.filePath,
      chunksConsumed: 1,
      text: "real summary",
    }));

    const processor = new OversizedFileProcessor(summariser);
    const result = await processor.process(
      source,
      "src/real.ts",
      {
        changeType: "modified",
        previousFilePath: null,
        isBinary: false,
        language: "typescript",
        linesAdded: 99_999, // would be wrong if used
        linesRemoved: 99_999,
      },
      { signal },
    );

    // makeChunk patch contains 1 added + 1 removed line per chunk by default
    expect(result.summary.linesAdded).toBeLessThan(99_999);
    expect(result.summary.linesRemoved).toBeLessThan(99_999);
  });
});
