import * as nodeFs from "node:fs";
import * as nodeReadline from "node:readline";
import { createLogger } from "@/lib/logger";
import { DiffParseError } from "@/lib/diff-errors";
import type { FileChangeSummary, ChangeType } from "@/domain/entities/FileChangeSummary";
import type { DiffSegment } from "@/domain/entities/DiffSegment";

const logger = createLogger("unifiedDiffParser");

const MAX_FILES_PER_SEGMENT = 30;
const MAX_PATCH_BYTES_PER_SEGMENT = 1024 * 1024; // 1 MB
const OVERSIZE_PATCH_BYTES = 64 * 1024;
const OVERSIZE_CHANGES = 2000;

type ParserState = "outside" | "file_header" | "hunk_body";

interface FileInProgress {
  filePath: string;
  previousFilePath: string | null;
  changeType: ChangeType;
  isBinary: boolean;
  linesAdded: number;
  linesRemoved: number;
  patchLines: string[];
  patchBytes: number;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift",
    cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c",
    php: "php", sh: "shell", bash: "shell",
    html: "html", css: "css", scss: "css", sass: "css",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", mdx: "markdown",
    sql: "sql", graphql: "graphql",
  };
  return map[ext] ?? "text";
}

function computeImportanceScore(filePath: string, totalLines: number): number {
  const lower = filePath.toLowerCase();
  let weight = 1.0;
  if (
    lower.includes("package-lock") || lower.includes("yarn.lock") ||
    lower.includes("pnpm-lock") || lower.endsWith(".snap") || lower.endsWith(".map")
  ) {
    weight *= 0.1;
  }
  if (lower.includes("test") || lower.includes("spec") || lower.includes("__tests__")) {
    weight *= 0.6;
  }
  weight *= Math.min(1, 1 + Math.log10(Math.max(1, totalLines)) / 10);
  return Math.round(weight * 100) / 100;
}

function finalizeFile(file: FileInProgress, segmentIndex: number): FileChangeSummary {
  const patch = file.patchLines.join("\n");
  const isOversized =
    !file.isBinary && (
      file.patchBytes > OVERSIZE_PATCH_BYTES ||
      file.linesAdded + file.linesRemoved > OVERSIZE_CHANGES
    );

  const snippets: FileChangeSummary["snippets"] = [];
  if (!isOversized && !file.isBinary && patch) {
    snippets.push({ kind: "hunk", content: patch.slice(0, 8_192) });
  }

  logger.debug("diff.parser.file", {
    filePath: file.filePath,
    changeType: file.changeType,
    linesAdded: file.linesAdded,
    linesRemoved: file.linesRemoved,
    isOversized,
    segmentIndex,
  });

  return {
    filePath: file.filePath,
    previousFilePath: file.previousFilePath,
    language: detectLanguage(file.filePath),
    changeType: file.changeType,
    linesAdded: file.linesAdded,
    linesRemoved: file.linesRemoved,
    isBinary: file.isBinary,
    snippets,
    analysis: isOversized ? { wasChunked: null } : null,
    importanceScore: computeImportanceScore(file.filePath, file.linesAdded + file.linesRemoved),
  };
}

/**
 * Streaming state-machine parser for unified git diffs.
 * Emits DiffSegments of up to MAX_FILES_PER_SEGMENT files or MAX_PATCH_BYTES_PER_SEGMENT bytes.
 * Holds at most one file's patch in memory at a time.
 */
export async function* parseDiffFile(
  diffFilePath: string,
  options: { signal: AbortSignal },
): AsyncIterable<DiffSegment> {
  const { signal } = options;

  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted"));
  }

  logger.debug("diff.parser.start", { diffFilePath });

  const fileStream = nodeFs.createReadStream(diffFilePath, { encoding: "utf8" });
  const rl = nodeReadline.createInterface({ input: fileStream, crlfDelay: Infinity });

  signal.addEventListener("abort", () => { fileStream.destroy(); rl.close(); }, { once: true });

  let state: ParserState = "outside";
  let currentFile: FileInProgress | null = null;
  let segmentFiles: FileChangeSummary[] = [];
  let segmentIndex = 0;
  let segmentPatchBytes = 0;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let totalFilesFound = 0;
  let hadContent = false;

  function flushCurrentFile(): void {
    if (!currentFile) return;
    const summary = finalizeFile(currentFile, segmentIndex);
    segmentFiles.push(summary);
    segmentPatchBytes += currentFile.patchBytes;
    currentFile = null;
    renameFrom = null;
    renameTo = null;
  }

  function shouldFlushSegment(): boolean {
    return (
      segmentFiles.length >= MAX_FILES_PER_SEGMENT ||
      segmentPatchBytes >= MAX_PATCH_BYTES_PER_SEGMENT
    );
  }

  try {
    for await (const line of rl) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted"));

      if (!hadContent && line.trim().length > 0) hadContent = true;

      if (line.startsWith("diff --git ")) {
        flushCurrentFile();
        state = "file_header";
        totalFilesFound++;

        if (shouldFlushSegment() && segmentFiles.length > 0) {
          logger.debug("diff.parser.segment_flush", {
            segmentIndex,
            fileCount: segmentFiles.length,
            segmentPatchBytes,
          });
          yield { segmentIndex, isFinal: false, files: segmentFiles, cumulativeLines: 0 };
          segmentIndex++;
          segmentFiles = [];
          segmentPatchBytes = 0;
        }

        const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (match) {
          currentFile = {
            filePath: match[2],
            previousFilePath: null,
            changeType: "modified",
            isBinary: false,
            linesAdded: 0,
            linesRemoved: 0,
            patchLines: [],
            patchBytes: 0,
          };
        }
        renameFrom = null;
        renameTo = null;
        continue;
      }

      if (!currentFile) continue;

      if (state === "file_header") {
        if (line.startsWith("new file mode")) {
          currentFile.changeType = "added";
        } else if (line.startsWith("deleted file mode")) {
          currentFile.changeType = "deleted";
        } else if (line.startsWith("rename from ")) {
          renameFrom = line.slice("rename from ".length).trim();
          currentFile.changeType = "renamed";
          currentFile.previousFilePath = renameFrom;
        } else if (line.startsWith("rename to ")) {
          renameTo = line.slice("rename to ".length).trim();
          currentFile.filePath = renameTo;
        } else if (line.startsWith("Binary files ")) {
          currentFile.isBinary = true;
        } else if (line.startsWith("+++ ")) {
          const raw = line.startsWith("+++ b/") ? line.slice("+++ b/".length) : line.slice("+++ ".length);
          const cleanPath = raw.trim();
          if (cleanPath && cleanPath !== "/dev/null") {
            if (!renameTo) currentFile.filePath = cleanPath;
          }
        } else if (line.startsWith("@@ ")) {
          state = "hunk_body";
          currentFile.patchLines.push(line);
          currentFile.patchBytes += Buffer.byteLength(line + "\n", "utf8");
        }
        continue;
      }

      if (state === "hunk_body") {
        if (line.startsWith("@@ ")) {
          currentFile.patchLines.push(line);
          currentFile.patchBytes += Buffer.byteLength(line + "\n", "utf8");
        } else if (
          line.startsWith("+") || line.startsWith("-") ||
          line.startsWith(" ") || line.startsWith("\\")
        ) {
          // Inside hunk_body, the leading +/- is the diff prefix; the rest is the
          // actual content. A real added line whose content starts with "++" is
          // emitted as "+++…" and must still count as +1 added. The previous
          // !startsWith("+++") / !startsWith("---") guards conflated these with
          // file-header lines, but file headers only appear in file_header state.
          if (line.startsWith("+")) currentFile.linesAdded++;
          else if (line.startsWith("-")) currentFile.linesRemoved++;
          currentFile.patchLines.push(line);
          currentFile.patchBytes += Buffer.byteLength(line + "\n", "utf8");
        }
        continue;
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      logger.error("diff.parser.read_error", {
        diffFilePath,
        segmentIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    fileStream.destroy();
    rl.close();
  }

  flushCurrentFile();

  if (totalFilesFound === 0 && hadContent) {
    logger.warn("diff.parser.no_files_found", {
      diffFilePath,
      reason: "No 'diff --git' headers found — file is not a unified git diff",
    });
    throw new DiffParseError(0, "No 'diff --git' headers found — file is not a unified git diff");
  }

  logger.debug("diff.parser.done", {
    diffFilePath,
    finalSegmentIndex: segmentIndex,
    finalSegmentFileCount: segmentFiles.length,
    totalFilesFound,
  });

  yield { segmentIndex, isFinal: true, files: segmentFiles, cumulativeLines: 0 };
}

/**
 * Re-reads a diff file and extracts the raw patch for a specific file path.
 * Unlike parseDiffFile, this collects raw hunk lines for oversized files too
 * (which parseDiffFile intentionally strips from snippets).
 */
export async function extractFilePatch(
  diffFilePath: string,
  targetFilePath: string,
  options: { signal: AbortSignal },
): Promise<string> {
  const { signal } = options;

  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted"));
  }

  const fileStream = nodeFs.createReadStream(diffFilePath, { encoding: "utf8" });
  const rl = nodeReadline.createInterface({ input: fileStream, crlfDelay: Infinity });

  signal.addEventListener("abort", () => { fileStream.destroy(); rl.close(); }, { once: true });

  let state: ParserState = "outside";
  let currentFilePath: string | null = null;
  let renameTo: string | null = null;
  const patchLines: string[] = [];
  let capturing = false;

  try {
    for await (const line of rl) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted"));

      if (line.startsWith("diff --git ")) {
        if (capturing) break; // all content for targetFilePath already collected
        state = "file_header";
        renameTo = null;
        capturing = false;
        const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        currentFilePath = match ? match[2] : null;
        continue;
      }

      if (!currentFilePath) continue;

      if (state === "file_header") {
        if (line.startsWith("rename to ")) {
          renameTo = line.slice("rename to ".length).trim();
          currentFilePath = renameTo;
        } else if (line.startsWith("+++ ")) {
          const raw = line.startsWith("+++ b/") ? line.slice("+++ b/".length) : line.slice("+++ ".length);
          const cleanPath = raw.trim();
          if (cleanPath && cleanPath !== "/dev/null" && !renameTo) {
            currentFilePath = cleanPath;
          }
        } else if (line.startsWith("@@ ")) {
          state = "hunk_body";
          if (currentFilePath === targetFilePath) {
            capturing = true;
            patchLines.push(line);
          }
        }
        continue;
      }

      if (state === "hunk_body" && capturing) {
        if (
          line.startsWith("@@ ") || line.startsWith("+") || line.startsWith("-") ||
          line.startsWith(" ") || line.startsWith("\\")
        ) {
          patchLines.push(line);
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      logger.error("diff.parser.extract_patch.read_error", {
        diffFilePath,
        targetFilePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    fileStream.destroy();
    rl.close();
  }

  return patchLines.join("\n");
}
