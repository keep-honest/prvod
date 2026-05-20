export type CodeLineRange = [number, number] | null | undefined;
export type SnippetLineChangeKind = "added" | "removed" | "context";

export function getSnippetLineNumber(index: number, lineRange?: CodeLineRange): number {
  return (lineRange?.[0] ?? 1) + index;
}

export function getSnippetLineNumbers(
  lineCount: number,
  lineRange?: CodeLineRange,
): number[] {
  return Array.from({ length: lineCount }, (_, index) =>
    getSnippetLineNumber(index, lineRange),
  );
}

export function normalizeSnippetHighlights(args: {
  highlights: number[];
  lineRange?: CodeLineRange;
  lineCount: number;
}): number[] {
  const { highlights, lineRange, lineCount } = args;
  if (!lineRange) {
    return Array.from(new Set(highlights));
  }

  const [startLine, endLine] = lineRange;
  const normalized = highlights.map((highlight) => {
    if (highlight >= startLine && highlight <= endLine) {
      return highlight;
    }

    if (highlight >= 1 && highlight <= lineCount) {
      return startLine + highlight - 1;
    }

    return highlight;
  });

  return Array.from(new Set(normalized));
}

export function getSnippetLineChangeKind(line: string): SnippetLineChangeKind {
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "removed";
  }

  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "added";
  }

  return "context";
}
