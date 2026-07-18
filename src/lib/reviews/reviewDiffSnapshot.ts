import type { PromptPipelineV2Artifacts } from "@/domain/entities/PromptPipelineV2";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type {
  PersistedReviewWorkspaceMetrics,
  ReviewDiffFile,
  ReviewDiffFileChangeType,
  ReviewDiffHunk,
  ReviewDiffLine,
  ReviewDiffSnapshot,
  ReviewPin,
  ReviewPinCategory,
  SceneDiffAnchor,
} from "@/domain/entities/ReviewDiffSnapshot";

/**
 * Strips Git's synthetic `a/` or `b/` prefix from a raw path on `--- ` / `+++ `
 * lines. Only call on lines where the prefix is added by Git (i.e. the raw line
 * after the leading `--- ` / `+++ `). Do NOT call on values already extracted by
 * a regex capture group that consumed the prefix — that would strip a real
 * leading `a/` or `b/` directory and corrupt anchors for repos that legitimately
 * have such paths (e.g. `a/internal.ts`).
 */
function stripSyntheticAbPrefix(rawPath: string): string {
  return rawPath.replace(/^[ab]\//, "");
}

// Includes a file-index prefix so distinct paths whose sanitized forms collide
// (e.g. `src/a-b.ts` and `src/a/b.ts` both flatten to `src-a-b-ts`) still
// produce unique ids. The sanitized segment is kept for readability.
function createLineId(fileIndex: number, filePath: string, counter: number): string {
  return `f${fileIndex}-${filePath.replace(/[^a-zA-Z0-9]+/g, "-")}-${counter}`;
}

function createHunkId(fileIndex: number, filePath: string, hunkIndex: number): string {
  return `f${fileIndex}-${filePath.replace(/[^a-zA-Z0-9]+/g, "-")}-h${hunkIndex}`;
}

function determineChangeType(file: {
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}): ReviewDiffFileChangeType {
  if (file.isRenamed) return "renamed";
  if (file.isNew) return "added";
  if (file.isDeleted) return "deleted";
  return "modified";
}

export function buildReviewDiffSnapshot(args: {
  diff: string;
  headSha: string;
  headRepoFullName: string;
  capturedAt?: string;
}): ReviewDiffSnapshot {
  const lines = args.diff.split("\n");
  const files: ReviewDiffFile[] = [];

  let currentFile: {
    filePath: string;
    fileIndex: number;
    oldPath: string | null;
    changeType: ReviewDiffFileChangeType;
    isNew: boolean;
    isDeleted: boolean;
    isRenamed: boolean;
    hunks: ReviewDiffHunk[];
    oldLineNumber: number;
    newLineNumber: number;
    filePosition: number;
    lineCounter: number;
  } | null = null;
  let nextFileIndex = 0;
  let currentHunk: ReviewDiffHunk | null = null;

  const flushHunk = () => {
    if (!currentFile || !currentHunk) return;
    currentFile.hunks.push(currentHunk);
    currentHunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (!currentFile) return;
    files.push({
      filePath: currentFile.filePath,
      oldPath: currentFile.oldPath,
      changeType: determineChangeType(currentFile),
      hunks: currentFile.hunks,
    });
    currentFile = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!match) continue;
      currentFile = {
        // The regex literal `a\/` / `b\/` already consumed the synthetic prefix —
        // do NOT strip it again. Real repo paths that start with `a/` or `b/`
        // (e.g. `a/internal.ts`) would be silently truncated otherwise.
        filePath: match[2],
        fileIndex: nextFileIndex++,
        oldPath: match[1],
        changeType: "modified",
        isNew: false,
        isDeleted: false,
        isRenamed: false,
        hunks: [],
        oldLineNumber: 0,
        newLineNumber: 0,
        filePosition: 0,
        lineCounter: 0,
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("new file mode ")) {
      currentFile.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      currentFile.isRenamed = true;
      currentFile.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentFile.isRenamed = true;
      currentFile.filePath = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = line.slice(4);
      currentFile.oldPath = path === "/dev/null" ? null : stripSyntheticAbPrefix(path);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path !== "/dev/null") {
        currentFile.filePath = stripSyntheticAbPrefix(path);
      }
      continue;
    }

    if (line.startsWith("@@ ")) {
      flushHunk();
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      const oldStart = match ? Number.parseInt(match[1], 10) : 0;
      const newStart = match ? Number.parseInt(match[2], 10) : 0;
      currentFile.oldLineNumber = oldStart;
      currentFile.newLineNumber = newStart;
      currentHunk = {
        hunkId: createHunkId(currentFile.fileIndex, currentFile.filePath, currentFile.hunks.length + 1),
        header: line,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    const pushLine = (
      kind: ReviewDiffLine["kind"],
      oldLineNumber: number | null,
      newLineNumber: number | null,
      text: string,
    ) => {
      // Re-narrow inside the closure so the body stays free of non-null
      // assertions; the outer for-loop already guarantees both refs are set.
      const file = currentFile;
      const hunk = currentHunk;
      if (!file || !hunk) return;

      file.filePosition += 1;
      file.lineCounter += 1;
      hunk.lines.push({
        lineId: createLineId(file.fileIndex, file.filePath, file.lineCounter),
        kind,
        oldLineNumber,
        newLineNumber,
        text,
        position: file.filePosition,
      });
    };

    if (line.startsWith("+")) {
      pushLine("added", null, currentFile.newLineNumber, line.slice(1));
      currentFile.newLineNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      pushLine("removed", currentFile.oldLineNumber, null, line.slice(1));
      currentFile.oldLineNumber += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      pushLine("meta", null, null, line);
      continue;
    }

    pushLine("context", currentFile.oldLineNumber, currentFile.newLineNumber, line.startsWith(" ") ? line.slice(1) : line);
    currentFile.oldLineNumber += 1;
    currentFile.newLineNumber += 1;
  }

  flushFile();

  const totalRenderableLines = files.reduce(
    (sum, file) => sum + file.hunks.reduce((hunkSum, hunk) => hunkSum + hunk.lines.length, 0),
    0,
  );

  return {
    headSha: args.headSha,
    headRepoFullName: args.headRepoFullName,
    capturedAt: args.capturedAt ?? new Date().toISOString(),
    files,
    totalFiles: files.length,
    totalRenderableLines,
  };
}

function collectLineIdsForRange(
  diffFile: ReviewDiffFile | undefined,
  startLine: number,
  endLine: number,
): string[] {
  if (!diffFile) return [];
  const lineIds: string[] = [];
  for (const hunk of diffFile.hunks) {
    for (const line of hunk.lines) {
      const candidateLineNumber = line.newLineNumber ?? line.oldLineNumber;
      if (
        candidateLineNumber !== null
        && candidateLineNumber >= startLine
        && candidateLineNumber <= endLine
      ) {
        lineIds.push(line.lineId);
      }
    }
  }
  return lineIds;
}

export function buildSceneDiffAnchors(
  script: VideoScript,
  diffSnapshot: ReviewDiffSnapshot,
): SceneDiffAnchor[] {
  const anchors: SceneDiffAnchor[] = [];
  const fileMap = new Map(diffSnapshot.files.map((file) => [file.filePath, file] as const));

  for (const scene of script.scenes) {
    scene.codeBroll.forEach((entry, index) => {
      const startLine = entry.lineRange?.[0] ?? null;
      const endLine = entry.lineRange?.[1] ?? startLine;
      const diffFile = fileMap.get(entry.filePath);
      const lineIds =
        startLine !== null && endLine !== null
          ? collectLineIdsForRange(diffFile, startLine, endLine)
          : [];

      anchors.push({
        anchorId: `scene-${scene.sceneNumber}-anchor-${index + 1}`,
        sceneNumber: scene.sceneNumber,
        filePath: entry.filePath || null,
        startLine,
        endLine,
        precision: lineIds.length > 0 ? "exact" : "overview",
        lineIds,
      });
    });
  }

  return anchors;
}

function concernToCategory(issueClass: string): ReviewPinCategory {
  switch (issueClass) {
    case "validation_gap":
      return "test_gap";
    case "correctness":
    case "concurrency":
    case "data_integrity":
    case "security":
    case "regression":
      return "risk";
    default:
      return "question";
  }
}

export function buildReviewPins(args: {
  promptPipelineV2?: PromptPipelineV2Artifacts;
  anchors: SceneDiffAnchor[];
}): ReviewPin[] {
  const concerns = args.promptPipelineV2?.reviewConcerns ?? [];
  if (concerns.length === 0) {
    return [];
  }

  return concerns.map((concern) => {
    const matchingAnchors = args.anchors.filter(
      (anchor) => anchor.filePath !== null && concern.evidenceFilePaths.includes(anchor.filePath),
    );
    const anchorIds = matchingAnchors.map((anchor) => anchor.anchorId);
    const sceneNumbers = Array.from(new Set(matchingAnchors.map((anchor) => anchor.sceneNumber)));

    return {
      pinId: concern.concernId,
      category: concernToCategory(concern.issueClass),
      sceneNumbers,
      anchorIds,
      filePaths: concern.evidenceFilePaths,
      prose: concern.proseSupport ?? concern.riskStatement,
      suggestedComment:
        concern.issueClass === "validation_gap"
          ? concern.validationNeed
          : concern.riskStatement,
    };
  });
}

export function buildPersistedReviewWorkspaceMetrics(args: {
  diff: string;
  headSha: string;
  headRepoFullName: string;
  script: VideoScript;
  promptPipelineV2?: PromptPipelineV2Artifacts;
}): PersistedReviewWorkspaceMetrics {
  const reviewDiffSnapshot = buildReviewDiffSnapshot({
    diff: args.diff,
    headSha: args.headSha,
    headRepoFullName: args.headRepoFullName,
  });
  const sceneDiffAnchors = buildSceneDiffAnchors(args.script, reviewDiffSnapshot);
  const reviewPins = buildReviewPins({
    promptPipelineV2: args.promptPipelineV2,
    anchors: sceneDiffAnchors,
  });

  return {
    reviewDiffSnapshot,
    sceneDiffAnchors,
    reviewPins,
  };
}

export function findDiffLineById(
  diffSnapshot: ReviewDiffSnapshot,
  lineId: string,
): ReviewDiffLine | null {
  for (const file of diffSnapshot.files) {
    for (const hunk of file.hunks) {
      const line = hunk.lines.find((candidate) => candidate.lineId === lineId);
      if (line) {
        return line;
      }
    }
  }
  return null;
}

export function findDiffFileByPath(
  diffSnapshot: ReviewDiffSnapshot,
  filePath: string,
): ReviewDiffFile | null {
  return diffSnapshot.files.find((file) => file.filePath === filePath) ?? null;
}
