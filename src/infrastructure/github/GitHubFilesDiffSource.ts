import { createLogger } from "@/lib/logger";
import { DiffFetchTimeoutError, DiffParseError } from "@/lib/diff-errors";
import type { IDiffSource } from "@/interfaces/IDiffSource";
import type { DiffSegment } from "@/domain/entities/DiffSegment";
import type { FileChunk } from "@/domain/entities/FileChunk";
import type { FileChangeSummary, ChangeType } from "@/domain/entities/FileChangeSummary";
import type { GitHubAppTokenService } from "./GitHubAppTokenService";
import { GITHUB_API, githubFetch } from "./githubFetch";

const logger = createLogger("GitHubFilesDiffSource");

const PER_PAGE = 30;
const OVERSIZE_PATCH_BYTES = 65_536; // 64 KB
const OVERSIZE_CHANGES = 2_000;

/** Maps file extensions to language identifiers. */
function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    cs: "csharp",
    cpp: "cpp",
    cc: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    toml: "toml",
    md: "markdown",
    mdx: "markdown",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    vue: "vue",
    svelte: "svelte",
    tf: "terraform",
    proto: "protobuf",
    graphql: "graphql",
    gql: "graphql",
  };
  return map[ext] ?? "text";
}

/** Maps GitHub status strings to our ChangeType enum. */
function mapStatus(status: string): ChangeType {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    case "changed":
    case "unchanged":
    case "modified":
    default:
      return "modified";
  }
}

/** One file entry from the GitHub PR Files API. */
interface GitHubFilesEntry {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/**
 * Converts a GitHub PR Files API entry to a FileChangeSummary.
 * Oversized files (patch missing or > 64 KB or changes > 2000) get
 * empty snippets and null analysis — DiffCorpusBuilder delegates those
 * to OversizedFileProcessor.
 */
function toFileChangeSummary(entry: GitHubFilesEntry): {
  summary: FileChangeSummary;
  isOversized: boolean;
} {
  const isOversized =
    !entry.patch ||
    entry.patch.length > OVERSIZE_PATCH_BYTES ||
    entry.changes > OVERSIZE_CHANGES;

  const snippets: FileChangeSummary["snippets"] = [];
  if (!isOversized && entry.patch) {
    snippets.push({ kind: "hunk", content: entry.patch.slice(0, 8_192) });
  }

  const weight = computeImportanceScore(entry.filename, entry.additions + entry.deletions);

  const summary: FileChangeSummary = {
    filePath: entry.filename,
    previousFilePath: entry.previous_filename ?? null,
    language: detectLanguage(entry.filename),
    changeType: mapStatus(entry.status),
    linesAdded: entry.additions,
    linesRemoved: entry.deletions,
    isBinary: false,
    snippets,
    // Placeholder for oversized files — DiffCorpusBuilder will trigger OversizedFileProcessor
    analysis: isOversized ? { wasChunked: null } : null,
    importanceScore: weight,
  };

  return { summary, isOversized };
}

function computeImportanceScore(filePath: string, totalLines: number): number {
  const lower = filePath.toLowerCase();
  let weight = 1.0;

  if (
    lower.includes("package-lock") ||
    lower.includes("yarn.lock") ||
    lower.includes("pnpm-lock") ||
    lower.endsWith(".gen.ts") ||
    lower.endsWith(".generated.ts") ||
    lower.includes("/generated/")
  ) {
    weight = 0.3;
  } else if (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__") ||
    lower.includes("/test/") ||
    lower.includes("/tests/")
  ) {
    weight = 0.5;
  } else if (
    lower.startsWith("src/") ||
    lower.startsWith("lib/") ||
    lower.startsWith("app/")
  ) {
    weight = 1.5;
  }

  // Normalize to 0–1 range using log scale: score = weight * log(lines+1) / log(10001)
  const rawScore = weight * Math.log(totalLines + 1) / Math.log(10_001);
  return Math.min(1, rawScore);
}

/**
 * Streaming IDiffSource backed by the GitHub PR Files API.
 * Paginates GET /repos/:o/:r/pulls/:n/files?per_page=30&page=N.
 * Each page becomes one DiffSegment.
 */
export class GitHubFilesDiffSource implements IDiffSource {
  constructor(
    private readonly repoFullName: string,
    private readonly prNumber: number,
    private readonly installationId: number,
    private readonly tokenService: GitHubAppTokenService,
  ) {}

  async *segments(options: { signal: AbortSignal }): AsyncIterable<DiffSegment> {
    const { signal } = options;
    let page = 1;
    let segmentIndex = 0;
    let done = false;

    while (!done) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted"));
      }

      const url = `${GITHUB_API}/repos/${this.repoFullName}/pulls/${this.prNumber}/files?per_page=${PER_PAGE}&page=${page}`;
      logger.debug("Fetching PR files page", {
        repo: this.repoFullName,
        pr: this.prNumber,
        page,
        segmentIndex,
      });

      let entries: { data: GitHubFilesEntry[]; hasNext: boolean };
      try {
        const token = await this.tokenService.getToken(this.installationId);
        const res = await githubFetch(
          url,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal,
          },
          {
            label: `github-pr-files page=${page}`,
            context: {
              repo: this.repoFullName,
              pr: this.prNumber,
              page,
              segmentIndex,
            },
          },
        );

        const data = (await res.json()) as GitHubFilesEntry[];

        // Termination: empty page or no next-page Link header
        const linkHeader = res.headers.get("Link") ?? "";
        const hasNext = linkHeader.includes(`rel="next"`);

        entries = { data, hasNext };
      } catch (err) {
        if (signal.aborted) throw err;
        throw new DiffFetchTimeoutError("fetch", {
          cause: err instanceof Error ? err : new Error(String(err)),
          segmentIndex,
        });
      }

      const { data, hasNext } = entries;

      if (data.length === 0) {
        // Empty page — emit a final empty segment if this is the very first page
        if (segmentIndex === 0) {
          const segment: DiffSegment = {
            segmentIndex: 0,
            isFinal: true,
            files: [],
            cumulativeLines: 0,
          };
          logger.info("PR files page returned empty result on first page", {
            repo: this.repoFullName,
            pr: this.prNumber,
          });
          yield segment;
        } else {
          logger.warn("diff.github.segments.early_empty_page", {
            repo: this.repoFullName,
            pr: this.prNumber,
            page,
            segmentIndex,
          });
        }
        break;
      }

      const files: FileChangeSummary[] = [];
      for (const entry of data) {
        const { summary } = toFileChangeSummary(entry);
        files.push(summary);
      }

      done = !hasNext;
      const segment: DiffSegment = {
        segmentIndex,
        isFinal: done,
        files,
        cumulativeLines: 0, // filled in by DiffCorpusBuilder
      };

      logger.info("diff.segment.fetch.success", {
        repo: this.repoFullName,
        pr: this.prNumber,
        page,
        segmentIndex,
        fileCount: files.length,
        isFinal: done,
      });

      yield segment;

      segmentIndex++;
      page++;
    }
  }

  async *chunksForFile(
    filePath: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<FileChunk> {
    // Re-fetch all pages to locate the file and extract its patch.
    // Then delegate splitting to DefaultFileChunker.
    const { signal } = options;
    let foundPatch: string | null = null;
    logger.debug("diff.github.chunksForFile.start", {
      repo: this.repoFullName,
      pr: this.prNumber,
      filePath,
    });

    let page = 1;
    let hasNext = true;

    while (hasNext && foundPatch === null) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted"));
      }

      const url = `${GITHUB_API}/repos/${this.repoFullName}/pulls/${this.prNumber}/files?per_page=${PER_PAGE}&page=${page}`;

      let result: { data: GitHubFilesEntry[]; hasNext: boolean };
      try {
        const token = await this.tokenService.getToken(this.installationId);
        const res = await githubFetch(
          url,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal,
          },
          {
            label: `github-pr-file-chunk page=${page} file=${filePath}`,
            context: {
              repo: this.repoFullName,
              pr: this.prNumber,
              filePath,
              page,
            },
          },
        );

        const data = (await res.json()) as GitHubFilesEntry[];
        const linkHeader = res.headers.get("Link") ?? "";
        result = { data, hasNext: linkHeader.includes(`rel="next"`) };
      } catch (err) {
        if (signal.aborted) throw err;
        throw new DiffFetchTimeoutError("fetch", {
          cause: err instanceof Error ? err : new Error(String(err)),
        });
      }

      hasNext = result.hasNext;
      const entry = result.data.find((e) => e.filename === filePath);
      if (entry && !entry.patch) {
        // GitHub withholds the patch field for very large files — yield an empty stub
        // so OversizedFileProcessor can produce a best-effort summary from metadata.
        logger.warn("diff.github.chunksForFile.patch_withheld_by_github", {
          repo: this.repoFullName,
          pr: this.prNumber,
          filePath,
          changes: entry.changes,
        });
        yield {
          filePath,
          chunkIndex: 0,
          totalChunks: 1,
          isFinal: true,
          patch: "",
        } satisfies FileChunk;
        return;
      } else if (entry?.patch) {
        foundPatch = entry.patch;
        logger.debug("diff.github.chunksForFile.patch_found", {
          repo: this.repoFullName,
          pr: this.prNumber,
          filePath,
          patchBytes: Buffer.byteLength(foundPatch, "utf8"),
          foundOnPage: page,
        });
      }

      page++;
    }

    if (!foundPatch) {
      logger.warn("diff.github.chunksForFile.patch_not_found", {
        repo: this.repoFullName,
        pr: this.prNumber,
        filePath,
        pagesScanned: page - 1,
      });
      throw new DiffParseError(0, `File patch not found in PR after scanning ${page - 1} pages: ${filePath}`);
    }

    // Split into 64 KB chunks
    const { DefaultFileChunker } = await import("@/infrastructure/diff/DefaultFileChunker");
    const chunker = new DefaultFileChunker();
    const chunks = chunker.chunk(filePath, foundPatch);
    logger.debug("diff.github.chunksForFile.chunks_ready", {
      repo: this.repoFullName,
      pr: this.prNumber,
      filePath,
      chunkCount: chunks.length,
    });
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}
