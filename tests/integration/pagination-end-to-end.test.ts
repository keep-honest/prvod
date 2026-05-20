import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFileDiffSource } from "@/infrastructure/diff/LocalFileDiffSource";
import { DiffCorpusBuilder } from "@/domain/services/DiffCorpusBuilder";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pagination-e2e-"));
});

afterEach(() => {
  try {
    for (const f of readdirSync(tempDir)) {
      unlinkSync(join(tempDir, f));
    }
  } catch { /* best-effort */ }
});

function buildLargeDiff(fileCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    lines.push(`diff --git a/src/f${i}.ts b/src/f${i}.ts`);
    lines.push(`index 000..${i.toString().padStart(3, "0")} 100644`);
    lines.push(`--- a/src/f${i}.ts`);
    lines.push(`+++ b/src/f${i}.ts`);
    lines.push(`@@ -1,2 +1,3 @@`);
    lines.push(` context`);
    lines.push(`+added line ${i}`);
    lines.push(` unchanged`);
  }
  return lines.join("\n") + "\n";
}

describe("Pagination end-to-end (LocalFileDiffSource + DiffCorpusBuilder)", () => {
  it("produces segmentCount >= 2 for a 31-file diff (hits 30-file boundary)", async () => {
    const diffContent = buildLargeDiff(31);
    const diffPath = join(tempDir, "large.diff");
    writeFileSync(diffPath, diffContent, "utf8");

    const source = new LocalFileDiffSource(diffPath);
    const builder = new DiffCorpusBuilder();
    const signal = new AbortController().signal;

    const corpus = await builder.build("job-pagination-test", source, {
      signal,
      sourceType: "local_diff_file",
    });

    expect(corpus.segmentCount).toBeGreaterThanOrEqual(2);
    expect(corpus.isComplete).toBe(true);
    expect(Object.keys(corpus.files)).toHaveLength(31);
    for (let i = 0; i < 31; i++) {
      expect(corpus.files[`src/f${i}.ts`]).toBeDefined();
    }
  });

  it("totalLines reflects all 31 files across segments", async () => {
    const diffContent = buildLargeDiff(31);
    const diffPath = join(tempDir, "large2.diff");
    writeFileSync(diffPath, diffContent, "utf8");

    const source = new LocalFileDiffSource(diffPath);
    const builder = new DiffCorpusBuilder();
    const signal = new AbortController().signal;

    const corpus = await builder.build("job-lines-test", source, {
      signal,
      sourceType: "local_diff_file",
    });

    // Each file: 1 line added, 0 removed
    expect(corpus.totalLines).toBe(31);
  });

  it("handles a minimal single-file diff as one segment", async () => {
    const singleFileDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 000..111 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " context",
      "+added",
    ].join("\n") + "\n";

    const diffPath = join(tempDir, "single.diff");
    writeFileSync(diffPath, singleFileDiff, "utf8");

    const source = new LocalFileDiffSource(diffPath);
    const builder = new DiffCorpusBuilder();
    const signal = new AbortController().signal;

    const corpus = await builder.build("job-single-test", source, {
      signal,
      sourceType: "local_diff_file",
    });

    expect(corpus.segmentCount).toBe(1);
    expect(corpus.isComplete).toBe(true);
    expect(Object.keys(corpus.files)).toHaveLength(1);
  });

  it("deduplicates a file that appears in multiple segments", async () => {
    // This is hard to trigger with LocalFileDiffSource (parser won't emit the same file twice)
    // so we use MockDiffSource to simulate the dedup path at the builder level.
    const { MockDiffSource } = await import("@/mocks/MockDiffSource");

    const segment1 = {
      segmentIndex: 0,
      isFinal: false,
      files: [
        {
          filePath: "src/shared.ts",
          previousFilePath: null,
          language: "typescript",
          changeType: "modified" as const,
          linesAdded: 5,
          linesRemoved: 2,
          isBinary: false,
          snippets: [],
          analysis: null,
          importanceScore: 1,
        },
      ],
      cumulativeLines: 0,
    };
    const segment2 = {
      segmentIndex: 1,
      isFinal: true,
      files: [
        {
          filePath: "src/shared.ts",
          previousFilePath: null,
          language: "typescript",
          changeType: "modified" as const,
          linesAdded: 3,
          linesRemoved: 1,
          isBinary: false,
          snippets: [],
          analysis: null,
          importanceScore: 1,
        },
      ],
      cumulativeLines: 0,
    };

    const source = new MockDiffSource([segment1, segment2]);
    const builder = new DiffCorpusBuilder();
    const signal = new AbortController().signal;

    const corpus = await builder.build("job-dedup-test", source, {
      signal,
      sourceType: "github_pr",
    });

    // Should deduplicate: only one entry for src/shared.ts
    expect(Object.keys(corpus.files)).toHaveLength(1);
    expect(corpus.segmentCount).toBe(2);
    // Merged linesAdded: 5+3=8, linesRemoved: 2+1=3
    expect(corpus.files["src/shared.ts"]?.linesAdded).toBe(8);
    expect(corpus.files["src/shared.ts"]?.linesRemoved).toBe(3);
  });
});
