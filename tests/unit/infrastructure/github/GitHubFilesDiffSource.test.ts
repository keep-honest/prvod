import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubFilesDiffSource } from "@/infrastructure/github/GitHubFilesDiffSource";
import { DiffFetchTimeoutError, DiffParseError } from "@/lib/diff-errors";
import type { GitHubAppTokenService } from "@/infrastructure/github/GitHubAppTokenService";

// Minimal mock token service
const mockTokenService = {
  getToken: vi.fn().mockResolvedValue("token-abc"),
} as unknown as GitHubAppTokenService;

function makeEntry(
  filename: string,
  overrides: Partial<{
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    status: string;
    previous_filename?: string;
  }> = {},
) {
  return {
    filename,
    status: "modified",
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "@@ -1,3 +1,4 @@\n context\n+added\n removed",
    ...overrides,
  };
}

function buildLinkHeader(page: number, hasNext: boolean) {
  if (!hasNext) return "";
  return `<https://api.github.com/repos/owner/repo/pulls/1/files?per_page=30&page=${page + 1}>; rel="next"`;
}

describe("GitHubFilesDiffSource", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("yields a single final segment for a one-page response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [makeEntry("src/a.ts"), makeEntry("src/b.ts")],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    expect(segments).toHaveLength(1);
    expect(segments[0].isFinal).toBe(true);
    expect(segments[0].segmentIndex).toBe(0);
    expect(segments[0].files).toHaveLength(2);
  });

  it("paginates across multiple pages and sets isFinal on the last", async () => {
    const page1Files = [makeEntry("src/a.ts"), makeEntry("src/b.ts")];
    const page2Files = [makeEntry("src/c.ts")];

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page1Files,
        headers: { get: (h: string) => h === "Link" ? buildLinkHeader(1, true) : null },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page2Files,
        headers: { get: () => null },
      } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    expect(segments).toHaveLength(2);
    expect(segments[0].isFinal).toBe(false);
    expect(segments[0].segmentIndex).toBe(0);
    expect(segments[1].isFinal).toBe(true);
    expect(segments[1].segmentIndex).toBe(1);
  });

  it("terminates on empty first page with an empty final segment", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    expect(segments).toHaveLength(1);
    expect(segments[0].isFinal).toBe(true);
    expect(segments[0].files).toHaveLength(0);
  });

  it("marks files as oversized when patch exceeds 64 KB", async () => {
    const largePatch = "+" + "x".repeat(66_000);
    const entry = makeEntry("src/big.ts", { additions: 100, deletions: 0, changes: 100, patch: largePatch });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [entry],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    // Oversized file: snippets empty, analysis set to placeholder { wasChunked: null }
    const file = segments[0].files[0]!;
    expect(file.snippets).toHaveLength(0);
    expect(file.analysis).toEqual({ wasChunked: null });
  });

  it("marks files as oversized when changes > 2000", async () => {
    const entry = makeEntry("src/generated.ts", { additions: 1500, deletions: 600, changes: 2100 });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [entry],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    const file = segments[0].files[0]!;
    expect(file.snippets).toHaveLength(0);
  });

  it("retries on 500 and succeeds on second attempt", async () => {
    const files = [makeEntry("src/a.ts")];

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal Server Error", headers: { get: () => null } } as never)
      .mockResolvedValueOnce({ ok: true, json: async () => files, headers: { get: () => null } } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(segments).toHaveLength(1);
    expect(segments[0].files).toHaveLength(1);
  });

  it("throws DiffFetchTimeoutError after maxAttempts 5xx failures", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    await expect(async () => {
      for await (const _seg of source.segments({ signal })) {
        // consume
      }
    }).rejects.toBeInstanceOf(DiffFetchTimeoutError);
  }, 10_000);

  it("propagates abort signal immediately", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("user cancelled"));

    global.fetch = vi.fn();

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    await expect(async () => {
      for await (const _seg of source.segments({ signal: ctrl.signal })) {
        // should not reach here
      }
    }).rejects.toThrow("user cancelled");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // --- chunksForFile ---

  it("chunksForFile: yields an empty stub chunk when GitHub withholds the patch", async () => {
    const entry = {
      filename: "src/huge.ts",
      status: "modified",
      additions: 500,
      deletions: 200,
      changes: 700,
      // no patch — GitHub withholds for very large files
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [entry],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const chunks = [];
    for await (const chunk of source.chunksForFile("src/huge.ts", { signal })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].filePath).toBe("src/huge.ts");
    expect(chunks[0].patch).toBe("");
    expect(chunks[0].isFinal).toBe(true);
  });

  it("chunksForFile: yields chunks from the page where the file is found", async () => {
    const targetEntry = makeEntry("src/target.ts", { patch: "@@ -1,3 +1,4 @@\n ctx\n+added\n-removed" });
    const otherEntry = makeEntry("src/other.ts");

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [otherEntry, targetEntry],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const chunks = [];
    for await (const chunk of source.chunksForFile("src/target.ts", { signal })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].filePath).toBe("src/target.ts");
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
  });

  it("chunksForFile: scans page 2 when file not on page 1", async () => {
    const page1Entry = makeEntry("src/other.ts");
    const targetEntry = makeEntry("src/target.ts", { patch: "@@ -1,2 +1,3 @@\n ctx\n+added" });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [page1Entry],
        headers: { get: (h: string) => h === "Link" ? buildLinkHeader(1, true) : null },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [targetEntry],
        headers: { get: () => null },
      } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const chunks = [];
    for await (const chunk of source.chunksForFile("src/target.ts", { signal })) {
      chunks.push(chunk);
    }

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].filePath).toBe("src/target.ts");
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
  });

  it("chunksForFile: throws DiffParseError when file not found across all pages", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [makeEntry("src/other.ts")],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    await expect(async () => {
      for await (const _chunk of source.chunksForFile("src/nonexistent.ts", { signal })) {
        // consume
      }
    }).rejects.toBeInstanceOf(DiffParseError);
  });

  it("chunksForFile: throws DiffParseError when file absent across two pages (multi-page scan)", async () => {
    // page 1: different file with Link:next → page 2: also different file, no Link → file never found
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeEntry("src/other-p1.ts")],
        headers: { get: (h: string) => h === "Link" ? buildLinkHeader(1, true) : null },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeEntry("src/other-p2.ts")],
        headers: { get: () => null },
      } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    await expect(async () => {
      for await (const _chunk of source.chunksForFile("src/target.ts", { signal })) {
        // consume
      }
    }).rejects.toBeInstanceOf(DiffParseError);

    expect(global.fetch).toHaveBeenCalledTimes(2); // both pages scanned
  });

  it("chunksForFile: propagates abort signal without fetching", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));

    global.fetch = vi.fn();

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    await expect(async () => {
      for await (const _chunk of source.chunksForFile("src/a.ts", { signal: ctrl.signal })) {
        // should not reach here
      }
    }).rejects.toThrow("cancelled");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("chunksForFile: non-retryable 404 makes exactly one fetch call", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    await expect(async () => {
      for await (const _chunk of source.chunksForFile("src/a.ts", { signal })) {
        // consume
      }
    }).rejects.toBeInstanceOf(DiffFetchTimeoutError);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("chunksForFile: throws DiffFetchTimeoutError after maxAttempts failures", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    await expect(async () => {
      for await (const _chunk of source.chunksForFile("src/a.ts", { signal })) {
        // consume
      }
    }).rejects.toBeInstanceOf(DiffFetchTimeoutError);
  }, 10_000);

  it("chunksForFile: abort between pages rethrows abort reason, not DiffFetchTimeoutError", async () => {
    const ctrl = new AbortController();

    global.fetch = vi.fn().mockImplementationOnce(async () => {
      // Abort after page 1 succeeds — before page 2 is fetched
      ctrl.abort(new Error("aborted between pages"));
      return {
        ok: true,
        json: async () => [makeEntry("src/other.ts")], // target not on page 1
        headers: { get: (h: string) => h === "Link" ? buildLinkHeader(1, true) : null },
      } as never;
    });

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    let thrown: unknown = null;
    try {
      for await (const _chunk of source.chunksForFile("src/target.ts", { signal: ctrl.signal })) {
        // should not yield anything
      }
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeInstanceOf(DiffFetchTimeoutError);
    expect((thrown as Error).message).toBe("aborted between pages");
    expect(global.fetch).toHaveBeenCalledTimes(1); // page 2 never fetched
  });

  it("marks files as oversized when patch field is absent (GitHub withheld)", async () => {
    // Entry with no patch property at all (not empty string, completely absent)
    const entry = {
      filename: "src/withheld.ts",
      status: "modified",
      additions: 800,
      deletions: 300,
      changes: 1100,
      // patch is intentionally absent
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [entry],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    const file = segments[0].files[0]!;
    expect(file.snippets).toHaveLength(0);
    expect(file.analysis).toEqual({ wasChunked: null });
  });

  it("segments: mid-pagination empty page emits warn log and stops without final segment", async () => {
    // Page 1 returns files with Link:next; page 2 returns empty unexpectedly
    const page1Files = [makeEntry("src/a.ts")];

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page1Files,
        headers: { get: (h: string) => h === "Link" ? buildLinkHeader(1, true) : null },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: { get: () => null },
      } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    // Only the first segment (isFinal:false) was yielded — the mid-pagination empty page aborts without a final segment
    expect(segments).toHaveLength(1);
    expect(segments[0].isFinal).toBe(false);
    expect(segments[0].files).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("normalises renamed file status to 'renamed' changeType", async () => {
    const entry = makeEntry("src/new.ts", { status: "renamed", previous_filename: "src/old.ts" });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [entry],
      headers: { get: () => null },
    } as never);

    const source = new GitHubFilesDiffSource("owner/repo", 1, 42, mockTokenService);
    const segments = [];
    for await (const seg of source.segments({ signal })) {
      segments.push(seg);
    }

    const file = segments[0].files[0]!;
    expect(file.changeType).toBe("renamed");
    expect(file.previousFilePath).toBe("src/old.ts");
  });
});
