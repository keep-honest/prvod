import { describe, it, expect, vi } from "vitest";
import { DiffCorpusBuilder } from "@/domain/services/DiffCorpusBuilder";
import { MockDiffSource } from "@/mocks/MockDiffSource";
import { DiffTooLargeError } from "@/lib/diff-errors";
import type { FileChangeSummary } from "@/domain/entities/FileChangeSummary";
import type { DiffSegment } from "@/domain/entities/DiffSegment";
import type { OversizedFileProcessor } from "@/domain/services/OversizedFileProcessor";

function makeFile(filePath: string, linesAdded = 10, linesRemoved = 5): FileChangeSummary {
  return {
    filePath,
    previousFilePath: null,
    language: "typescript",
    changeType: "modified",
    linesAdded,
    linesRemoved,
    isBinary: false,
    snippets: [{ kind: "hunk", content: `+${filePath} added` }],
    analysis: null,
    importanceScore: 0.5,
  };
}

function makeSegment(
  segmentIndex: number,
  files: FileChangeSummary[],
  isFinal = false,
): DiffSegment {
  return { segmentIndex, isFinal, files, cumulativeLines: 0 };
}

const signal = new AbortController().signal;

describe("DiffCorpusBuilder", () => {
  it("builds a corpus from a single final segment", async () => {
    const seg = makeSegment(0, [makeFile("src/a.ts"), makeFile("src/b.ts")], true);
    const source = new MockDiffSource([seg]);
    const corpus = await new DiffCorpusBuilder().build("job-1", source, { signal, sourceType: "github_pr" });

    expect(corpus.jobId).toBe("job-1");
    expect(Object.keys(corpus.files)).toHaveLength(2);
    expect(corpus.totalLines).toBe(30); // (10+5)*2
    expect(corpus.segmentCount).toBe(1);
    expect(corpus.isComplete).toBe(true);
    expect(corpus.sourceType).toBe("github_pr");
  });

  it("accumulates files across multiple segments", async () => {
    const segments = [
      makeSegment(0, [makeFile("src/a.ts", 100, 20)]),
      makeSegment(1, [makeFile("src/b.ts", 50, 10)], true),
    ];
    const source = new MockDiffSource(segments);
    const corpus = await new DiffCorpusBuilder().build("job-2", source, { signal, sourceType: "github_pr" });

    expect(Object.keys(corpus.files)).toHaveLength(2);
    expect(corpus.totalLines).toBe(100 + 20 + 50 + 10);
    expect(corpus.segmentCount).toBe(2);
    expect(corpus.isComplete).toBe(true);
  });

  it("deduplicates files that appear in multiple segments (FR-005)", async () => {
    const file1First = makeFile("src/shared.ts", 10, 0);
    const file1Second = makeFile("src/shared.ts", 5, 2);
    const segments = [
      makeSegment(0, [file1First]),
      makeSegment(1, [file1Second], true),
    ];
    const source = new MockDiffSource(segments);
    const corpus = await new DiffCorpusBuilder().build("job-3", source, { signal, sourceType: "github_pr" });

    expect(Object.keys(corpus.files)).toHaveLength(1);
    const merged = corpus.files["src/shared.ts"]!;
    // Lines from both segments are merged
    expect(merged.linesAdded).toBe(15);
    expect(merged.linesRemoved).toBe(2);
    // totalLines only counted once (first appearance)
    expect(corpus.totalLines).toBe(10);
  });

  it("throws DiffTooLargeError when totalLines > 200,000 (FR-004)", async () => {
    const bigFile = makeFile("src/big.ts", 200_001, 0);
    const segments = [makeSegment(0, [bigFile], true)];
    const source = new MockDiffSource(segments);

    await expect(
      new DiffCorpusBuilder().build("job-4", source, { signal, sourceType: "github_pr" }),
    ).rejects.toThrow(DiffTooLargeError);
  });

  it("stops processing at the first DiffTooLargeError and includes segment context", async () => {
    const bigFile = makeFile("src/huge.ts", 250_000, 0);
    const segments = [makeSegment(0, [bigFile])];
    const source = new MockDiffSource(segments);

    let err: DiffTooLargeError | undefined;
    try {
      await new DiffCorpusBuilder().build("job-5", source, { signal, sourceType: "github_pr" });
    } catch (e) {
      if (e instanceof DiffTooLargeError) err = e;
    }
    expect(err).toBeDefined();
    expect(err!.capLines).toBe(200_000);
    expect(err!.segmentIndex).toBe(0);
  });

  it("truncates segment.files to empty array after merging (FR-003)", async () => {
    const seg = makeSegment(0, [makeFile("src/a.ts")], true);
    const source = new MockDiffSource([seg]);
    await new DiffCorpusBuilder().build("job-6", source, { signal, sourceType: "github_pr" });
    // The builder empties segment.files in-place after processing to release element references
    expect(seg.files).toHaveLength(0);
  });

  it("stops after isFinal segment without consuming further segments", async () => {
    let seg2Consumed = false;
    const source: import("@/interfaces/IDiffSource").IDiffSource = {
      async *segments() {
        yield makeSegment(0, [makeFile("src/a.ts")], true);
        seg2Consumed = true;
        yield makeSegment(1, [makeFile("src/b.ts")], false);
      },
      async *chunksForFile() {},
    };
    await new DiffCorpusBuilder().build("job-7", source, { signal, sourceType: "github_pr" });
    expect(seg2Consumed).toBe(false);
  });

  it("propagates abort signal when aborted before first segment", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    const source: import("@/interfaces/IDiffSource").IDiffSource = {
      async *segments(opts) {
        if (opts.signal.aborted) throw opts.signal.reason;
        yield makeSegment(0, [makeFile("src/a.ts")], true);
      },
      async *chunksForFile() {},
    };
    await expect(
      new DiffCorpusBuilder().build("job-8", source, { signal: ctrl.signal, sourceType: "github_pr" }),
    ).rejects.toThrow("cancelled");
  });

  // --- oversized file processor ---

  it("delegates oversized file (analysis.wasChunked=null) to processor when provided", async () => {
    const oversizedFile: FileChangeSummary = {
      ...makeFile("src/huge.ts"),
      analysis: { wasChunked: null },
    };
    const processedFile: FileChangeSummary = {
      ...makeFile("src/huge.ts", 0, 0),
      snippets: [{ kind: "summary_narrative", content: "LLM summary" }],
      analysis: { wasChunked: true, chunkCount: 2, rollingSummary: "LLM summary" },
    };

    const mockProcessor = {
      process: vi.fn().mockResolvedValue({ summary: processedFile, chunksProcessed: 2, totalLinesInFile: 0 }),
    } as unknown as OversizedFileProcessor;

    const seg = makeSegment(0, [oversizedFile], true);
    const source = new MockDiffSource([seg]);
    const corpus = await new DiffCorpusBuilder().build("job-oversized", source, {
      signal,
      sourceType: "github_pr",
      oversizedProcessor: mockProcessor,
    });

    expect(mockProcessor.process).toHaveBeenCalledOnce();
    expect(corpus.files["src/huge.ts"]!.analysis?.wasChunked).toBe(true);
    expect(corpus.chunkedFileCount).toBe(1);
  });

  it("re-throws when oversized processor fails (non-abort)", async () => {
    const oversizedFile: FileChangeSummary = {
      ...makeFile("src/broken.ts"),
      analysis: { wasChunked: null },
    };

    const mockProcessor = {
      process: vi.fn().mockRejectedValue(new Error("LLM call failed")),
    } as unknown as OversizedFileProcessor;

    const seg = makeSegment(0, [oversizedFile], true);
    const source = new MockDiffSource([seg]);

    await expect(
      new DiffCorpusBuilder().build("job-oversized-fail", source, {
        signal,
        sourceType: "github_pr",
        oversizedProcessor: mockProcessor,
      }),
    ).rejects.toThrow("LLM call failed");
  });

  it("propagates abort-triggered error from oversized processor without logging it as a processing error", async () => {
    const ctrl = new AbortController();
    const abortErr = new Error("aborted mid-chunk");
    const oversizedFile: FileChangeSummary = {
      ...makeFile("src/huge.ts"),
      analysis: { wasChunked: null },
    };
    const mockProcessor = {
      process: vi.fn().mockImplementation(async () => {
        ctrl.abort(abortErr);
        throw abortErr;
      }),
    } as unknown as OversizedFileProcessor;

    const seg = makeSegment(0, [oversizedFile], true);
    const source = new MockDiffSource([seg]);

    await expect(
      new DiffCorpusBuilder().build("job-abort-mid", source, {
        signal: ctrl.signal,
        sourceType: "github_pr",
        oversizedProcessor: mockProcessor,
      }),
    ).rejects.toThrow("aborted mid-chunk");
  });

  it("returns isComplete=false when source ends without a final segment", async () => {
    const source: import("@/interfaces/IDiffSource").IDiffSource = {
      async *segments() {
        yield makeSegment(0, [makeFile("src/a.ts")], false); // never isFinal
        // generator ends naturally — no isFinal=true segment
      },
      async *chunksForFile() {},
    };
    const corpus = await new DiffCorpusBuilder().build("job-incomplete", source, {
      signal,
      sourceType: "github_pr",
    });
    expect(corpus.isComplete).toBe(false);
    expect(Object.keys(corpus.files)).toHaveLength(1);
    expect(corpus.segmentCount).toBe(1);
  });

  it("retains oversized file as-is when no processor is provided", async () => {
    const oversizedFile: FileChangeSummary = {
      ...makeFile("src/huge.ts"),
      analysis: { wasChunked: null },
    };
    const seg = makeSegment(0, [oversizedFile], true);
    const source = new MockDiffSource([seg]);

    const corpus = await new DiffCorpusBuilder().build("job-no-processor", source, {
      signal,
      sourceType: "github_pr",
    });

    expect(corpus.isComplete).toBe(true);
    expect(Object.keys(corpus.files)).toHaveLength(1);
    expect(corpus.files["src/huge.ts"]!.analysis).toEqual({ wasChunked: null });
    // wasChunked:null has analysis !== null → counts toward chunkedFileCount per spec invariant
    expect(corpus.chunkedFileCount).toBe(1);
  });

  it("skips binary files and does not add them to corpus", async () => {
    const binaryFile: FileChangeSummary = {
      ...makeFile("assets/logo.png"),
      isBinary: true,
      snippets: [],
    };
    const textFile = makeFile("src/a.ts");
    const seg = makeSegment(0, [binaryFile, textFile], true);
    const source = new MockDiffSource([seg]);
    const corpus = await new DiffCorpusBuilder().build("job-binary", source, { signal, sourceType: "github_pr" });

    expect(Object.keys(corpus.files)).toHaveLength(1);
    expect(corpus.files["src/a.ts"]).toBeDefined();
    expect(corpus.files["assets/logo.png"]).toBeUndefined();
  });

  it("uses most-recent changeType when same file appears in multiple segments", async () => {
    const file1: FileChangeSummary = { ...makeFile("src/shared.ts"), changeType: "added" };
    const file2: FileChangeSummary = { ...makeFile("src/shared.ts"), changeType: "modified" };
    const segments = [
      makeSegment(0, [file1]),
      makeSegment(1, [file2], true),
    ];
    const source = new MockDiffSource(segments);
    const corpus = await new DiffCorpusBuilder().build("job-conflict", source, { signal, sourceType: "github_pr" });

    expect(Object.keys(corpus.files)).toHaveLength(1);
    expect(corpus.files["src/shared.ts"]!.changeType).toBe("modified"); // most-recent wins
  });

  it("promotes chunkedFileCount when dedup upgrades wasChunked from null to true", async () => {
    const file1: FileChangeSummary = {
      ...makeFile("src/shared.ts"),
      analysis: { wasChunked: null },
    };
    const file2: FileChangeSummary = {
      ...makeFile("src/shared.ts"),
      analysis: { wasChunked: true, chunkCount: 2, rollingSummary: "summary" },
    };
    const segments = [
      makeSegment(0, [file1]),
      makeSegment(1, [file2], true),
    ];
    const source = new MockDiffSource(segments);
    const corpus = await new DiffCorpusBuilder().build("job-promote", source, { signal, sourceType: "github_pr" });

    expect(corpus.chunkedFileCount).toBe(1);
    expect(corpus.files["src/shared.ts"]!.analysis?.wasChunked).toBe(true);
  });

  it("counts chunkedFileCount correctly for files with analysis", async () => {
    const fileWithAnalysis: FileChangeSummary = {
      ...makeFile("src/large.ts"),
      analysis: { wasChunked: true, chunkCount: 3, rollingSummary: "big file summary" },
    };
    const seg = makeSegment(0, [makeFile("src/small.ts"), fileWithAnalysis], true);
    const source = new MockDiffSource([seg]);
    const corpus = await new DiffCorpusBuilder().build("job-9", source, { signal, sourceType: "github_pr" });

    expect(corpus.chunkedFileCount).toBe(1);
  });
});
