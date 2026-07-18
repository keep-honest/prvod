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
