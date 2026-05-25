import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeGitHubError,
  GitHubApiError,
  GitHubTransportError,
  githubFetch,
} from "@/infrastructure/github/githubFetch";

describe("githubFetch", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a transport-level fetch failure and preserves the underlying cause", async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const fetchFailed = new TypeError("fetch failed", { cause });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(fetchFailed)
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const res = await githubFetch(
      "https://api.github.com/repos/owner/repo/issues/1/comments",
      { method: "POST" },
      { label: "test.githubFetch.transport", maxAttempts: 2, baseMs: 1, capMs: 1 },
    );

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("retries retryable GitHub HTTP statuses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const res = await githubFetch(
      "https://api.github.com/repos/owner/repo/pulls/1",
      {},
      { label: "test.githubFetch.503", maxAttempts: 2, baseMs: 1, capMs: 1 },
    );

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable GitHub HTTP statuses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    await expect(
      githubFetch(
        "https://api.github.com/repos/owner/repo/pulls/999",
        {},
        { label: "test.githubFetch.404", maxAttempts: 3, baseMs: 1, capMs: 1 },
      ),
    ).rejects.toMatchObject({
      name: "GitHubApiError",
      status: 404,
      body: "Not Found",
    } satisfies Partial<GitHubApiError>);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not retry abort errors", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    (abortError as { code?: string }).code = "ABORT_ERR";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);

    await expect(
      githubFetch(
        "https://api.github.com/repos/owner/repo/pulls/1",
        {},
        { label: "test.githubFetch.abort", maxAttempts: 3, baseMs: 1, capMs: 1 },
      ),
    ).rejects.toBeInstanceOf(GitHubTransportError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("describeGitHubError", () => {
  it("includes nested cause details from Node fetch failures", () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const fetchFailed = new TypeError("fetch failed", { cause });
    const wrapped = new GitHubTransportError(
      "POST",
      "https://api.github.com/repos/owner/repo/issues/1/comments",
      fetchFailed,
    );

    expect(describeGitHubError(wrapped)).toMatchObject({
      name: "GitHubTransportError",
      message: expect.stringContaining("fetch failed"),
      cause: {
        name: "TypeError",
        message: "fetch failed",
        cause: {
          name: "Error",
          message: "Connect Timeout Error",
          code: "UND_ERR_CONNECT_TIMEOUT",
        },
      },
    });
  });
});
