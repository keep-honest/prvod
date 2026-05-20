import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDiffFile, extractFilePatch } from "@/infrastructure/diff/unifiedDiffParser";
import { DiffParseError } from "@/lib/diff-errors";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "udp-test-"));
});

afterEach(async () => {
  try {
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(tempDir)) {
      unlinkSync(join(tempDir, f));
    }
  } catch { /* cleanup best-effort */ }
});

function writeDiff(name: string, content: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const signal = new AbortController().signal;

const SIMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 000..111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 context
+added line
 unchanged
-removed line
`;

const ADDED_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+function hello() {}
+export default hello;
`;

const DELETED_FILE_DIFF = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 111..000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-function goodbye() {}
-export default goodbye;
`;

const RENAMED_FILE_DIFF = `diff --git a/src/old.ts b/src/renamed.ts
similarity index 90%
rename from src/old.ts
rename to src/renamed.ts
--- a/src/old.ts
+++ b/src/renamed.ts
@@ -1,2 +1,2 @@
-function old() {}
+function renamed() {}
`;

const BINARY_FILE_DIFF = `diff --git a/assets/icon.png b/assets/icon.png
index aaa..bbb 100644
Binary files a/assets/icon.png and b/assets/icon.png differ
`;

describe("unifiedDiffParser", () => {
  it("parses a simple modified file", async () => {
    const p = writeDiff("simple.diff", SIMPLE_DIFF);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }

    expect(segments).toHaveLength(1);
    expect(segments[0].isFinal).toBe(true);
    expect(segments[0].files).toHaveLength(1);

    const file = segments[0].files[0]!;
    expect(file.filePath).toBe("src/a.ts");
    expect(file.changeType).toBe("modified");
    expect(file.linesAdded).toBe(1);
    expect(file.linesRemoved).toBe(1);
    expect(file.isBinary).toBe(false);
  });

  it("detects new file mode as changeType=added", async () => {
    const p = writeDiff("added.diff", ADDED_FILE_DIFF);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    const file = segments[0].files[0]!;
    expect(file.changeType).toBe("added");
    expect(file.linesAdded).toBe(2);
    expect(file.linesRemoved).toBe(0);
  });

  it("counts hunk-body lines whose content begins with +++ or ---", async () => {
    // Inside hunk_body, the leading +/- is the diff prefix; any payload that
    // happens to begin with ++/-- is real content. Previously skipped from
    // linesAdded/linesRemoved due to a !startsWith("+++") / !startsWith("---")
    // guard meant for file headers (which only appear in file_header state).
    const diff = `diff --git a/src/markdown.md b/src/markdown.md
--- a/src/markdown.md
+++ b/src/markdown.md
@@ -1,2 +1,4 @@
 unchanged
+++ heading prefix line that is real content
+--- divider
-old line
---
`;
    const p = writeDiff("plus-prefix.diff", diff);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    const file = segments[0].files[0]!;
    // Content lines: "+++ heading...", "+--- divider", "-old line", "---"
    // Added: 2 (the "+++…" and the "+---…")
    // Removed: 2 (the "-old line" and the "---")
    expect(file.linesAdded).toBe(2);
    expect(file.linesRemoved).toBe(2);
  });

  it("detects deleted file mode as changeType=deleted", async () => {
    const p = writeDiff("deleted.diff", DELETED_FILE_DIFF);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    const file = segments[0].files[0]!;
    expect(file.changeType).toBe("deleted");
    expect(file.linesAdded).toBe(0);
    expect(file.linesRemoved).toBe(2);
  });

  it("detects rename from/to and sets previousFilePath", async () => {
    const p = writeDiff("renamed.diff", RENAMED_FILE_DIFF);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    const file = segments[0].files[0]!;
    expect(file.changeType).toBe("renamed");
    expect(file.filePath).toBe("src/renamed.ts");
    expect(file.previousFilePath).toBe("src/old.ts");
  });

  it("marks binary files with isBinary=true and empty snippets", async () => {
    const p = writeDiff("binary.diff", BINARY_FILE_DIFF);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    const file = segments[0].files[0]!;
    expect(file.isBinary).toBe(true);
    expect(file.snippets).toHaveLength(0);
  });

  it("parses multiple files in a single diff", async () => {
    const multiDiff = SIMPLE_DIFF + ADDED_FILE_DIFF + DELETED_FILE_DIFF;
    const p = writeDiff("multi.diff", multiDiff);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    const allFiles = segments.flatMap((s) => s.files);
    expect(allFiles).toHaveLength(3);
    const paths = allFiles.map((f) => f.filePath);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/new.ts");
    expect(paths).toContain("src/old.ts");
  });

  it("segments at MAX_FILES_PER_SEGMENT (30 files)", async () => {
    // Generate 31 modified files
    const lines: string[] = [];
    for (let i = 0; i < 31; i++) {
      lines.push(`diff --git a/src/f${i}.ts b/src/f${i}.ts`);
      lines.push(`--- a/src/f${i}.ts`);
      lines.push(`+++ b/src/f${i}.ts`);
      lines.push(`@@ -1 +1 @@`);
      lines.push(`+change ${i}`);
    }
    const p = writeDiff("segmented.diff", lines.join("\n") + "\n");
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[segments.length - 1].isFinal).toBe(true);
    for (let i = 0; i < segments.length - 1; i++) {
      expect(segments[i].isFinal).toBe(false);
    }
    const totalFiles = segments.flatMap((s) => s.files).length;
    expect(totalFiles).toBe(31);
  });

  it("flags oversized patches with analysis: { wasChunked: null }", async () => {
    // Build a patch with > 2000 changed lines
    const lines = [`diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1,2001 +1,2001 @@`];
    for (let i = 0; i < 2001; i++) {
      lines.push(`+line ${i}`);
    }
    for (let i = 0; i < 2001; i++) {
      lines.push(`-old line ${i}`);
    }
    const p = writeDiff("oversized.diff", lines.join("\n") + "\n");
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    const file = segments.flatMap((s) => s.files).find((f) => f.filePath === "src/big.ts");
    expect(file).toBeDefined();
    expect(file!.analysis).toEqual({ wasChunked: null });
    expect(file!.snippets).toHaveLength(0);
  });

  it("yields a final segment with empty files for an empty diff", async () => {
    const p = writeDiff("empty.diff", "");
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }
    expect(segments).toHaveLength(1);
    expect(segments[0].isFinal).toBe(true);
    expect(segments[0].files).toHaveLength(0);
  });

  it("throws DiffParseError for non-empty content with no diff --git headers (--- / Index: format)", async () => {
    const legacyDiff = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    const p = writeDiff("legacy-format.diff", legacyDiff);
    await expect(async () => {
      for await (const _seg of parseDiffFile(p, { signal })) {
        // should not reach
      }
    }).rejects.toBeInstanceOf(DiffParseError);
  });

  it("propagates abort signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("test cancelled"));

    const p = writeDiff("abort.diff", SIMPLE_DIFF);
    await expect(async () => {
      for await (const _seg of parseDiffFile(p, { signal: ctrl.signal })) {
        // should not reach
      }
    }).rejects.toThrow("test cancelled");
  });

  it("segments at 1 MB patch byte boundary (MAX_PATCH_BYTES_PER_SEGMENT)", async () => {
    // Build a diff where files 0+1 together exceed 1 MB patch bytes,
    // causing a segment flush when file 2's diff header is seen.
    // File count stays under 30 so only the byte-cap triggers.
    const bigLine = "+" + "x".repeat(200); // ~201 bytes per line
    const linesPerFile = 3000; // ~201 * 3000 ≈ 600 KB per file; two files ≈ 1.2 MB

    function buildFileDiff(i: number): string {
      const header = `diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,${linesPerFile} +1,${linesPerFile} @@\n`;
      const body = (bigLine + "\n").repeat(linesPerFile);
      return header + body;
    }

    const content = buildFileDiff(0) + buildFileDiff(1) + buildFileDiff(2);
    const p = writeDiff("byte-cap.diff", content);
    const segments = [];
    for await (const seg of parseDiffFile(p, { signal })) {
      segments.push(seg);
    }

    // Files 0+1 together exceed 1 MB → file 2 triggers a segment flush before it starts
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[segments.length - 1].isFinal).toBe(true);
    for (let i = 0; i < segments.length - 1; i++) {
      expect(segments[i].isFinal).toBe(false);
    }
    // All 3 files must appear across all segments
    const allFiles = segments.flatMap((s) => s.files);
    expect(allFiles).toHaveLength(3);
    const paths = allFiles.map((f) => f.filePath);
    expect(paths).toContain("src/f0.ts");
    expect(paths).toContain("src/f1.ts");
    expect(paths).toContain("src/f2.ts");
  }, 15_000);
});

const MULTI_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 000..111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 context
+added line
 unchanged
-removed line
diff --git a/src/big.ts b/src/big.ts
index 111..222 100644
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,5 +1,6 @@
 first context
+new line 1
 second context
-old line
 third context
@@ -100,3 +101,3 @@
 another hunk context
-old hunk line
+new hunk line
diff --git a/src/last.ts b/src/last.ts
index 222..333 100644
--- a/src/last.ts
+++ b/src/last.ts
@@ -1,2 +1,2 @@
-old last
+new last
`;

const RENAMED_MULTI_DIFF = `diff --git a/src/original.ts b/src/moved.ts
similarity index 90%
rename from src/original.ts
rename to src/moved.ts
--- a/src/original.ts
+++ b/src/moved.ts
@@ -1,2 +1,2 @@
-old function
+new function
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-x
+y
`;

describe("extractFilePatch", () => {
  it("extracts the patch for the first file in the diff", async () => {
    const p = writeDiff("efp-first.diff", MULTI_FILE_DIFF);
    const patch = await extractFilePatch(p, "src/a.ts", { signal });
    expect(patch).toContain("@@ -1,3 +1,4 @@");
    expect(patch).toContain("+added line");
    expect(patch).toContain("-removed line");
    expect(patch).not.toContain("src/big.ts");
  });

  it("extracts the patch for a middle file and stops at the next diff --git", async () => {
    const p = writeDiff("efp-middle.diff", MULTI_FILE_DIFF);
    const patch = await extractFilePatch(p, "src/big.ts", { signal });
    // Both hunks from src/big.ts
    expect(patch).toContain("@@ -1,5 +1,6 @@");
    expect(patch).toContain("@@ -100,3 +101,3 @@");
    expect(patch).toContain("+new line 1");
    expect(patch).toContain("+new hunk line");
    // Must not bleed into the next file
    expect(patch).not.toContain("src/last.ts");
    expect(patch).not.toContain("-old last");
  });

  it("extracts the patch for the last file in the diff", async () => {
    const p = writeDiff("efp-last.diff", MULTI_FILE_DIFF);
    const patch = await extractFilePatch(p, "src/last.ts", { signal });
    expect(patch).toContain("@@ -1,2 +1,2 @@");
    expect(patch).toContain("-old last");
    expect(patch).toContain("+new last");
  });

  it("extracts patch for a renamed file using the post-rename path", async () => {
    const p = writeDiff("efp-rename.diff", RENAMED_MULTI_DIFF);
    const patch = await extractFilePatch(p, "src/moved.ts", { signal });
    expect(patch).toContain("@@ -1,2 +1,2 @@");
    expect(patch).toContain("-old function");
    expect(patch).toContain("+new function");
  });

  it("returns empty string when the target file is not in the diff", async () => {
    const p = writeDiff("efp-notfound.diff", MULTI_FILE_DIFF);
    const patch = await extractFilePatch(p, "src/nonexistent.ts", { signal });
    expect(patch).toBe("");
  });

  it("returns empty string for a file that has no hunk body", async () => {
    const noHunkDiff = `diff --git a/src/binary.png b/src/binary.png
Binary files a/src/binary.png and b/src/binary.png differ
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
+change
`;
    const p = writeDiff("efp-nohunk.diff", noHunkDiff);
    const patch = await extractFilePatch(p, "src/binary.png", { signal });
    expect(patch).toBe("");
  });

  it("propagates abort signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("aborted"));
    const p = writeDiff("efp-abort.diff", MULTI_FILE_DIFF);
    await expect(
      extractFilePatch(p, "src/a.ts", { signal: ctrl.signal }),
    ).rejects.toThrow("aborted");
  });
});
