import { describe, expect, it } from "vitest";
import {
  getSnippetLineChangeKind,
  getSnippetLineNumbers,
  normalizeSnippetHighlights,
} from "@/infrastructure/video/codeLineMapping";

describe("codeLineMapping", () => {
  it("numbers snippet lines from the source line range", () => {
    expect(getSnippetLineNumbers(3, [10, 12])).toEqual([10, 11, 12]);
  });

  it("keeps absolute highlights inside the source line range", () => {
    expect(
      normalizeSnippetHighlights({
        highlights: [11],
        lineRange: [10, 12],
        lineCount: 3,
      }),
    ).toEqual([11]);
  });

  it("converts legacy relative highlights to source line numbers", () => {
    expect(
      normalizeSnippetHighlights({
        highlights: [1, 2],
        lineRange: [10, 11],
        lineCount: 2,
      }),
    ).toEqual([10, 11]);
  });

  it("classifies unified diff removed lines without treating file headers as deletions", () => {
    expect(getSnippetLineChangeKind("-  return oldValue;")).toBe("removed");
    expect(getSnippetLineChangeKind("--- a/src/file.ts")).toBe("context");
  });
});
