import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFileDiffSource } from "@/infrastructure/diff/LocalFileDiffSource";
import { DiffParseError } from "@/lib/diff-errors";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lfds-test-"));
});

afterEach(() => {
  try {
    for (const f of readdirSync(tempDir)) {
      unlinkSync(join(tempDir, f));
    }
  } catch { /* best-effort */ }
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

const TWO_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 000..111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 context
+added line
 unchanged
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 000..222
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+function hello() {}
+export default hello;
`;

describe("LocalFileDiffSource", () => {
  describe("segments()", () => {
    it("emits a final segment for a simple diff", async () => {
      const p = writeDiff("simple.diff", SIMPLE_DIFF);
      const source = new LocalFileDiffSource(p);
      const segments = [];
      for await (const seg of source.segments({ signal })) {
        segments.push(seg);
      }
      expect(segments).toHaveLength(1);
      expect(segments[0].isFinal).toBe(true);
      expect(segments[0].files).toHaveLength(1);
      expect(segments[0].files[0]?.filePath).toBe("src/a.ts");
    });

    it("emits all files across multiple segments", async () => {
      const p = writeDiff("two.diff", TWO_FILE_DIFF);
      const source = new LocalFileDiffSource(p);
      const segments = [];
      for await (const seg of source.segments({ signal })) {
        segments.push(seg);
      }
      const allFiles = segments.flatMap((s) => s.files);
      expect(allFiles).toHaveLength(2);
      expect(allFiles.map((f) => f.filePath)).toContain("src/a.ts");
      expect(allFiles.map((f) => f.filePath)).toContain("src/b.ts");
    });

    it("segments at 30-file boundary", async () => {
      const lines: string[] = [];
      for (let i = 0; i < 31; i++) {
        lines.push(`diff --git a/src/f${i}.ts b/src/f${i}.ts`);
        lines.push(`--- a/src/f${i}.ts`);
        lines.push(`+++ b/src/f${i}.ts`);
        lines.push(`@@ -1 +1 @@`);
        lines.push(`+change ${i}`);
      }
      const p = writeDiff("many.diff", lines.join("\n") + "\n");
      const source = new LocalFileDiffSource(p);
      const segments = [];
      for await (const seg of source.segments({ signal })) {
        segments.push(seg);
      }
      expect(segments.length).toBeGreaterThan(1);
      expect(segments[segments.length - 1].isFinal).toBe(true);
      expect(segments.flatMap((s) => s.files)).toHaveLength(31);
    });

    it("yields single final empty segment for empty diff", async () => {
      const p = writeDiff("empty.diff", "");
      const source = new LocalFileDiffSource(p);
      const segments = [];
      for await (const seg of source.segments({ signal })) {
        segments.push(seg);
      }
      expect(segments).toHaveLength(1);
      expect(segments[0].isFinal).toBe(true);
      expect(segments[0].files).toHaveLength(0);
    });

    it("propagates abort signal", async () => {
      const ctrl = new AbortController();
      ctrl.abort(new Error("aborted in segments"));
      const p = writeDiff("abort.diff", SIMPLE_DIFF);
      const source = new LocalFileDiffSource(p);
      await expect(async () => {
        for await (const _seg of source.segments({ signal: ctrl.signal })) {
          // should not reach
        }
      }).rejects.toThrow("aborted in segments");
    });
  });

  describe("chunksForFile()", () => {
    it("yields chunks for a known file", async () => {
      const p = writeDiff("simple.diff", SIMPLE_DIFF);
      const source = new LocalFileDiffSource(p);
      const chunks = [];
      for await (const chunk of source.chunksForFile("src/a.ts", { signal })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].isFinal).toBe(true);
      expect(chunks[0].filePath).toBe("src/a.ts");
    });

    it("patch content includes the hunk header", async () => {
      const p = writeDiff("simple.diff", SIMPLE_DIFF);
      const source = new LocalFileDiffSource(p);
      const chunks = [];
      for await (const chunk of source.chunksForFile("src/a.ts", { signal })) {
        chunks.push(chunk);
      }
      // The first chunk should contain the @@ hunk header
      expect(chunks[0].patch).toContain("@@");
    });

    it("throws DiffParseError for a file not in the diff", async () => {
      const p = writeDiff("simple.diff", SIMPLE_DIFF);
      const source = new LocalFileDiffSource(p);
      await expect(async () => {
        for await (const _chunk of source.chunksForFile("src/nonexistent.ts", { signal })) {
          // should not reach here
        }
      }).rejects.toBeInstanceOf(DiffParseError);
    });

    it("correctly extracts second file in a two-file diff", async () => {
      const p = writeDiff("two.diff", TWO_FILE_DIFF);
      const source = new LocalFileDiffSource(p);
      const chunks = [];
      for await (const chunk of source.chunksForFile("src/b.ts", { signal })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].patch).toContain("@@");
      // Should contain content from src/b.ts, not src/a.ts
      expect(chunks.join("")).not.toContain("added line");
      expect(chunks.map((c) => c.patch).join("")).toContain("function hello");
    });

    it("propagates abort signal in chunksForFile", async () => {
      const ctrl = new AbortController();
      ctrl.abort(new Error("aborted in chunksForFile"));
      const p = writeDiff("abort.diff", SIMPLE_DIFF);
      const source = new LocalFileDiffSource(p);
      await expect(async () => {
        for await (const _chunk of source.chunksForFile("src/a.ts", { signal: ctrl.signal })) {
          // should not reach
        }
      }).rejects.toThrow("aborted in chunksForFile");
    });
  });
});
