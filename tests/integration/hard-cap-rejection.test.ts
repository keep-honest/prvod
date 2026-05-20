import { describe, it, expect } from "vitest";
import { DiffCorpusBuilder } from "@/domain/services/DiffCorpusBuilder";
import { DiffTooLargeError } from "@/lib/diff-errors";
import { MockDiffSource } from "@/mocks/MockDiffSource";
import type { FileChangeSummary } from "@/domain/entities/FileChangeSummary";

const signal = new AbortController().signal;

function makeFile(filePath: string, linesAdded: number, linesRemoved = 0): FileChangeSummary {
  return {
    filePath,
    previousFilePath: null,
    language: "typescript",
    changeType: "modified",
    linesAdded,
    linesRemoved,
    isBinary: false,
    snippets: [],
    analysis: null,
    importanceScore: 1,
  };
}

describe("Hard-cap rejection (FR-004)", () => {
  it("throws DiffTooLargeError when totalLines exceeds 200,000", async () => {
    // Two segments: first 150k lines (safe), second pushes past 200k
    const bigFile = makeFile("src/giant.ts", 150_001);
    const pushoverFile = makeFile("src/pushover.ts", 60_000);

    const source = new MockDiffSource([
      { segmentIndex: 0, isFinal: false, files: [bigFile], cumulativeLines: 0 },
      { segmentIndex: 1, isFinal: true, files: [pushoverFile], cumulativeLines: 0 },
    ]);

    const builder = new DiffCorpusBuilder();

    await expect(
      builder.build("job-hardcap-test", source, {
        signal,
        sourceType: "local_diff_file",
      }),
    ).rejects.toThrow(DiffTooLargeError);
  });

  it("DiffTooLargeError carries capLines: 200_000 and correct observedLines", async () => {
    const firstFile = makeFile("src/a.ts", 180_000);
    const secondFile = makeFile("src/b.ts", 30_000);

    const source = new MockDiffSource([
      { segmentIndex: 0, isFinal: false, files: [firstFile], cumulativeLines: 0 },
      { segmentIndex: 1, isFinal: true, files: [secondFile], cumulativeLines: 0 },
    ]);

    const builder = new DiffCorpusBuilder();

    let caught: DiffTooLargeError | undefined;
    try {
      await builder.build("job-hardcap-fields-test", source, {
        signal,
        sourceType: "local_diff_file",
      });
    } catch (err) {
      if (err instanceof DiffTooLargeError) caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught?.capLines).toBe(200_000);
    expect(caught?.observedLines).toBe(210_000);
    expect(caught?.errorTag).toBe("DIFF_TOO_LARGE");
  });

  it("does not throw when totalLines is exactly at the cap", async () => {
    // 200 files × 1000 lines = exactly 200,000 — should be accepted
    const files = Array.from({ length: 200 }, (_, i) =>
      makeFile(`src/f${i}.ts`, 1000),
    );
    const source = new MockDiffSource([
      { segmentIndex: 0, isFinal: true, files, cumulativeLines: 0 },
    ]);

    const builder = new DiffCorpusBuilder();
    const corpus = await builder.build("job-atcap-test", source, {
      signal,
      sourceType: "local_diff_file",
    });

    expect(corpus.totalLines).toBe(200_000);
    expect(corpus.isComplete).toBe(true);
  });

  it("corpus state is empty after hard-cap rejection (no partial data)", async () => {
    const bigFile = makeFile("src/big.ts", 210_000);

    const source = new MockDiffSource([
      { segmentIndex: 0, isFinal: true, files: [bigFile], cumulativeLines: 0 },
    ]);

    const builder = new DiffCorpusBuilder();

    await expect(
      builder.build("job-empty-state-test", source, {
        signal,
        sourceType: "local_diff_file",
      }),
    ).rejects.toThrow(DiffTooLargeError);
  });
});
