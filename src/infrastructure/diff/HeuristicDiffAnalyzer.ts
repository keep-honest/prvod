import { createLogger } from "@/lib/logger";
import type { IDiffAnalyzer, DiffAnalysis, FileChange } from "@/interfaces/IDiffAnalyzer";
import type { ChangeType } from "@/domain/entities/VideoScript";
import type { FileChangeSummary } from "@/domain/entities/FileChangeSummary";

const logger = createLogger("HeuristicDiffAnalyzer");

// Generous caps — popcorn mode uses up to 80 files / 40 diffs.
// The prompt builder applies further mode-specific slicing.
const MAX_TOP_FILES = 80;
const MAX_DIFF_FILES = 40;

/** Weight multiplier by file path pattern for importance scoring. */
function fileWeight(filePath: string): number {
  const lower = filePath.toLowerCase();

  if (
    lower.includes("package-lock") ||
    lower.includes("yarn.lock") ||
    lower.includes("pnpm-lock") ||
    lower.endsWith(".gen.ts") ||
    lower.endsWith(".generated.ts") ||
    lower.includes("/generated/")
  ) {
    return 0.3;
  }

  if (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__") ||
    lower.includes("/test/") ||
    lower.includes("/tests/")
  ) {
    return 0.5;
  }

  if (lower.startsWith("src/") || lower.startsWith("lib/") || lower.startsWith("app/")) {
    return 1.5;
  }

  return 1.0;
}

function directoryOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "." : filePath.slice(0, lastSlash);
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__") ||
    lower.includes("/test/") ||
    lower.includes("/tests/")
  );
}

function isDocFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".md");
}

function isDependencyFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("package.json") ||
    lower.includes("package-lock") ||
    lower.includes("yarn.lock") ||
    lower.includes("pnpm-lock") ||
    lower.includes("go.mod") ||
    lower.includes("go.sum") ||
    lower.includes("cargo.toml") ||
    lower.includes("cargo.lock") ||
    lower.includes("requirements.txt") ||
    lower.includes("poetry.lock") ||
    lower.includes("gemfile") ||
    lower.includes("pubspec.yaml")
  );
}

function isConfigFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("dockerfile") ||
    lower.includes(".yml") ||
    lower.includes(".yaml") ||
    lower.includes(".toml") ||
    lower.includes(".env") ||
    lower.includes("tsconfig") ||
    lower.includes("eslint") ||
    lower.includes("prettier") ||
    lower.endsWith(".config.ts") ||
    lower.endsWith(".config.js") ||
    lower.endsWith(".config.mjs") ||
    lower.includes(".github/")
  );
}

function detectChangeType(files: FileChange[]): ChangeType {
  if (files.length === 0) return "mixed";

  const allTests = files.every((f) => isTestFile(f.filePath));
  if (allTests) return "docs";

  const allDocs = files.every((f) => isDocFile(f.filePath));
  if (allDocs) return "docs";

  const allDeps = files.every((f) => isDependencyFile(f.filePath));
  if (allDeps) return "dependency";

  const allConfig = files.every((f) => isConfigFile(f.filePath));
  if (allConfig) return "config";

  const totalAdded = files.reduce((s, f) => s + f.linesAdded, 0);
  const totalRemoved = files.reduce((s, f) => s + f.linesRemoved, 0);
  const totalChanged = totalAdded + totalRemoved;

  if (totalChanged > 0 && totalRemoved / totalChanged > 0.6) return "refactor";

  const newFiles = files.filter((f) => f.isNew).length;
  if (newFiles >= 3 || (files.length > 0 && newFiles / files.length > 0.5)) {
    return "feature";
  }

  // Small, targeted changes across few files suggest a bugfix
  if (files.length <= 3 && totalChanged <= 30 && totalChanged > 0) {
    return "bugfix";
  }

  return "mixed";
}

/**
 * Parses unified diff output and extracts per-file statistics.
 * Pure logic -- no I/O or external dependencies.
 */
export class HeuristicDiffAnalyzer implements IDiffAnalyzer {
  analyze(diff: string): DiffAnalysis {
    logger.debug("Starting diff analysis", { diffLength: diff.length });

    const files = this.parseFiles(diff);
    const diffChunks = this.extractDiffChunks(diff);

    const totalLinesAdded = files.reduce((s, f) => s + f.linesAdded, 0);
    const totalLinesRemoved = files.reduce((s, f) => s + f.linesRemoved, 0);
    const suggestedChangeType = detectChangeType(files);

    // Group by directory
    const directoryGroups: Record<string, FileChange[]> = {};
    for (const file of files) {
      const dir = file.directory;
      if (!directoryGroups[dir]) directoryGroups[dir] = [];
      directoryGroups[dir].push(file);
    }

    // Top files by importance, capped at MAX_TOP_FILES
    const topFiles = [...files]
      .sort((a, b) => b.importanceScore - a.importanceScore)
      .slice(0, MAX_TOP_FILES);

    // Collect actual diff content for the top N files
    const topFileDiffs: Record<string, string> = {};
    for (const file of topFiles.slice(0, MAX_DIFF_FILES)) {
      const chunk = diffChunks.get(file.filePath);
      if (chunk) topFileDiffs[file.filePath] = chunk;
    }

    logger.info("Diff analysis complete", {
      totalFiles: files.length,
      totalLinesAdded,
      totalLinesRemoved,
      changeType: suggestedChangeType,
    });

    return {
      files,
      totalFilesChanged: files.length,
      totalLinesAdded,
      totalLinesRemoved,
      suggestedChangeType,
      directoryGroups,
      topFiles,
      topFileDiffs,
    };
  }

  /**
   * Derives DiffAnalysis from a pre-built FileChangeSummary array (spec 005).
   * Replaces the deprecated analyze(diff) in the paginated pipeline path.
   */
  analyzeCorpus(files: FileChangeSummary[]): DiffAnalysis {
    logger.debug("Starting corpus analysis", { fileCount: files.length });

    const fileChanges: FileChange[] = files.map((f) => ({
      filePath: f.filePath,
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
      isNew: f.changeType === "added",
      isDeleted: f.changeType === "deleted",
      isRenamed: f.changeType === "renamed",
      directory: directoryOf(f.filePath),
      importanceScore: f.importanceScore * (f.linesAdded + f.linesRemoved),
    }));

    const totalLinesAdded = fileChanges.reduce((s, f) => s + f.linesAdded, 0);
    const totalLinesRemoved = fileChanges.reduce((s, f) => s + f.linesRemoved, 0);
    const suggestedChangeType = detectChangeType(fileChanges);

    const directoryGroups: Record<string, FileChange[]> = {};
    for (const file of fileChanges) {
      const dir = file.directory;
      if (!directoryGroups[dir]) directoryGroups[dir] = [];
      directoryGroups[dir].push(file);
    }

    const topFiles = [...fileChanges]
      .sort((a, b) => b.importanceScore - a.importanceScore)
      .slice(0, MAX_TOP_FILES);

    // Build topFileDiffs from snippet content or rolling summary for chunked files
    const topFileDiffs: Record<string, string> = {};
    const summaryByPath = new Map<string, FileChangeSummary>(files.map((f) => [f.filePath, f]));
    for (const file of topFiles.slice(0, MAX_DIFF_FILES)) {
      const summary = summaryByPath.get(file.filePath);
      if (!summary) continue;
      if (summary.snippets.length > 0) {
        topFileDiffs[file.filePath] = summary.snippets.map((s) => s.content).join("\n");
      } else if (summary.analysis?.wasChunked === true && summary.analysis.rollingSummary) {
        // Chunked oversized file: use LLM rolling summary as diff context
        topFileDiffs[file.filePath] = `[Large file — rolling summary]\n${summary.analysis.rollingSummary}`;
      }
    }

    logger.info("Corpus analysis complete", {
      totalFiles: fileChanges.length,
      totalLinesAdded,
      totalLinesRemoved,
      changeType: suggestedChangeType,
    });

    return {
      files: fileChanges,
      totalFilesChanged: fileChanges.length,
      totalLinesAdded,
      totalLinesRemoved,
      suggestedChangeType,
      directoryGroups,
      topFiles,
      topFileDiffs,
    };
  }

  /** Parse unified diff into per-file FileChange entries. */
  private parseFiles(diff: string): FileChange[] {
    const files: FileChange[] = [];
    const lines = diff.split("\n");

    let currentPath: string | null = null;
    let linesAdded = 0;
    let linesRemoved = 0;
    let isNew = false;
    let isDeleted = false;
    let isRenamed = false;

    const flush = () => {
      if (!currentPath) return;
      const weight = fileWeight(currentPath);
      files.push({
        filePath: currentPath,
        linesAdded,
        linesRemoved,
        isNew,
        isDeleted,
        isRenamed,
        directory: directoryOf(currentPath),
        importanceScore: (linesAdded + linesRemoved) * weight,
      });
    };

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        flush();
        // Reset per-file state
        currentPath = null;
        linesAdded = 0;
        linesRemoved = 0;
        isNew = false;
        isDeleted = false;
        isRenamed = false;

        // Extract path from "diff --git a/path b/path"
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (match) currentPath = match[2];
        continue;
      }

      if (line.startsWith("new file mode")) {
        isNew = true;
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        isDeleted = true;
        continue;
      }
      if (line.startsWith("rename from") || line.startsWith("rename to")) {
        isRenamed = true;
        continue;
      }

      // Fallback path extraction from +++ line
      if (line.startsWith("+++ ") && !currentPath) {
        const path = line.slice(4).replace(/^b\//, "");
        if (path !== "/dev/null") currentPath = path;
        continue;
      }
      if (line.startsWith("--- ")) {
        // If file is deleted and we don't have a path yet
        if (!currentPath) {
          const path = line.slice(4).replace(/^a\//, "");
          if (path !== "/dev/null") currentPath = path;
        }
        continue;
      }

      // Hunk header -- skip
      if (line.startsWith("@@")) continue;

      // Count additions/removals (only inside a file block)
      if (currentPath) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          linesAdded++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          linesRemoved++;
        }
      }
    }

    // Flush last file
    flush();
    return files;
  }

  /** Collect raw diff hunks keyed by file path. */
  private extractDiffChunks(diff: string): Map<string, string> {
    const chunks = new Map<string, string>();
    const fileSections = diff.split(/^(?=diff --git )/m);

    for (const section of fileSections) {
      if (!section.startsWith("diff --git ")) continue;

      const match = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
      if (!match) continue;

      const filePath = match[2];
      chunks.set(filePath, section);
    }

    return chunks;
  }
}
