import { describe, expect, it } from "vitest";
import { buildReviewDiffSnapshot } from "@/lib/reviews/reviewDiffSnapshot";

describe("buildReviewDiffSnapshot", () => {
  it("produces distinct line ids for files whose sanitized paths collide", () => {
    // Both `src/a-b.ts` and `src/a/b.ts` flatten to `src-a-b-ts` under the
    // legacy non-alphanumeric sanitizer. The file-index prefix must keep
    // their lineIds (and hunkIds) unambiguous so global lookups by id can
    // still resolve to the correct file.
    const diff = `diff --git a/src/a-b.ts b/src/a-b.ts
--- a/src/a-b.ts
+++ b/src/a-b.ts
@@ -1,1 +1,1 @@
-old hyphen
+new hyphen
diff --git a/src/a/b.ts b/src/a/b.ts
--- a/src/a/b.ts
+++ b/src/a/b.ts
@@ -1,1 +1,1 @@
-old slash
+new slash
`;

    const snapshot = buildReviewDiffSnapshot({
      diff,
      headSha: "head",
      headRepoFullName: "acme/repo",
      capturedAt: "2026-04-26T00:00:00.000Z",
    });

    expect(snapshot.files).toHaveLength(2);
    const allLineIds = snapshot.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.lineId)));
    const allHunkIds = snapshot.files.flatMap((file) => file.hunks.map((hunk) => hunk.hunkId));

    expect(new Set(allLineIds).size).toBe(allLineIds.length);
    expect(new Set(allHunkIds).size).toBe(allHunkIds.length);
    expect(snapshot.files[0].hunks[0].lines[0].lineId).toMatch(/^f0-/);
    expect(snapshot.files[1].hunks[0].lines[0].lineId).toMatch(/^f1-/);
  });

  it("preserves real leading 'a/' or 'b/' directory segments in file paths", () => {
    // Repo legitimately has a top-level `a/` directory. Git renders the diff
    // with synthetic prefixes (`a/a/internal.ts` / `b/a/internal.ts`); the
    // parser must strip ONLY the synthetic outer layer and keep the inner `a/`.
    const diff = [
      "diff --git a/a/internal.ts b/a/internal.ts",
      "--- a/a/internal.ts",
      "+++ b/a/internal.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const snapshot = buildReviewDiffSnapshot({ diff, headSha: "h", headRepoFullName: "o/r" });
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].filePath).toBe("a/internal.ts");
    expect(snapshot.files[0].oldPath).toBe("a/internal.ts");
  });

  it("counts subsequent hunk headers in GitHub position math (multi-hunk file)", () => {
    // GitHub's legacy review-comment `position` counts every line below the
    // file's FIRST @@ header, INCLUDING later hunk header lines: "The position
    // in the diff continues to increase through lines of whitespace and
    // additional hunks until the beginning of a new file." A comment placed
    // with an off-by-one position lands on the wrong line (or 422s).
    const diff = [
      "diff --git a/src/two-hunks.ts b/src/two-hunks.ts",
      "--- a/src/two-hunks.ts",
      "+++ b/src/two-hunks.ts",
      "@@ -1,3 +1,3 @@", // first header: not counted; next line is position 1
      " context-a", //      position 1
      "-old-line", //       position 2
      "+new-line", //       position 3
      "@@ -10,3 +10,4 @@", // second header: occupies position 4
      " context-b", //      position 5
      "+added-line", //     position 6
      " context-c", //      position 7
      "@@ -30,1 +31,2 @@", // third header: occupies position 8
      "+tail-line", //      position 9
      " context-d", //      position 10
    ].join("\n");

    const snapshot = buildReviewDiffSnapshot({ diff, headSha: "h", headRepoFullName: "o/r" });
    expect(snapshot.files).toHaveLength(1);
    const [first, second, third] = snapshot.files[0].hunks;

    expect(first.lines.map((line) => line.position)).toEqual([1, 2, 3]);
    // Absolute positions in the second hunk must account for its @@ line.
    expect(second.lines.map((line) => line.position)).toEqual([5, 6, 7]);
    expect(second.lines.map((line) => line.text)).toEqual([
      "context-b",
      "added-line",
      "context-c",
    ]);
    expect(third.lines.map((line) => line.position)).toEqual([9, 10]);

    // Line numbers stay driven by the hunk headers, independent of position.
    expect(second.lines[1].newLineNumber).toBe(11);
    expect(third.lines[0].newLineNumber).toBe(31);
  });

  it("restarts position counting for each file in a multi-file diff", () => {
    const diff = [
      "diff --git a/first.ts b/first.ts",
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -1,1 +1,1 @@",
      "-a", // position 1
      "+b", // position 2
      "@@ -5,1 +5,1 @@", // position 3
      "+c", // position 4
      "diff --git a/second.ts b/second.ts",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -1,1 +1,1 @@",
      "+x", // position 1 — counter must reset at the new file
    ].join("\n");

    const snapshot = buildReviewDiffSnapshot({ diff, headSha: "h", headRepoFullName: "o/r" });
    expect(snapshot.files[0].hunks[1].lines.map((line) => line.position)).toEqual([4]);
    expect(snapshot.files[1].hunks[0].lines.map((line) => line.position)).toEqual([1]);
  });

  it("keeps deleted-file paths intact when +++ is /dev/null", () => {
    // Deleted files have +++ /dev/null so filePath comes from the diff --git line.
    // The parser must not strip a real `a/` prefix from that capture.
    const diff = [
      "diff --git a/a/legacy.ts b/a/legacy.ts",
      "deleted file mode 100644",
      "--- a/a/legacy.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-content",
    ].join("\n");
    const snapshot = buildReviewDiffSnapshot({ diff, headSha: "h", headRepoFullName: "o/r" });
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].filePath).toBe("a/legacy.ts");
    expect(snapshot.files[0].changeType).toBe("deleted");
  });
});
