import { createLogger } from "@/lib/logger";
import { retryWithBackoff } from "@/lib/retry";
import { sanitizeErrorBody } from "@/lib/sanitize";

const logger = createLogger("githubFetch");

export const GITHUB_API = "https://api.github.com";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 8_000;
const MAX_ERROR_DEPTH = 6;

export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly method: string;
  readonly url: string;
  readonly retryable: boolean;

  constructor(args: {
    status: number;
    body: string;
    method: string;
    url: string;
    retryable: boolean;
  }) {
    super(`GitHub API ${args.status}: ${args.body}`);
    this.name = "GitHubApiError";
    this.status = args.status;
    this.body = args.body;
    this.method = args.method;
    this.url = args.url;
    this.retryable = args.retryable;
  }
}

export class GitHubTransportError extends Error {
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`GitHub fetch failed (${method} ${url}): ${causeMessage}`, {
      cause,
    });
    this.name = "GitHubTransportError";
    this.method = method;
    this.url = url;
  }
}

export interface GitHubFetchOptions {
  label?: string;
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  context?: Record<string, unknown>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === "AbortError" || code === "ABORT_ERR";
}

function shouldRetryGitHubError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof GitHubApiError) return error.retryable;
  if (error instanceof GitHubTransportError) {
    const cause = (error as { cause?: unknown }).cause;
    return !isAbortError(cause);
  }
  return true;
}

function toErrorsArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  return null;
}

function summarizeErrorValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value == null) return undefined;
  if (depth > MAX_ERROR_DEPTH) return "[truncated: max depth]";

  if (typeof value === "object" || typeof value === "function") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
  }

  if (value instanceof Error) {
    const extra = value as {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    const summary: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      code: extra.code,
      errno: extra.errno,
      syscall: extra.syscall,
    };
    if (value instanceof GitHubApiError) {
      summary.status = value.status;
      summary.body = value.body;
      summary.method = value.method;
      summary.url = value.url;
      summary.retryable = value.retryable;
    }
    if (value instanceof GitHubTransportError) {
      summary.method = value.method;
      summary.url = value.url;
    }
    const cause = summarizeErrorValue(extra.cause, seen, depth + 1);
    if (cause !== undefined) summary.cause = cause;
    const errors = toErrorsArray(extra.errors);
    if (errors) {
      summary.errors = errors.map((inner) =>
        summarizeErrorValue(inner, seen, depth + 1),
      );
    }
    return summary;
  }

  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, Object.getOwnPropertyNames(value));
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function describeGitHubError(error: unknown): Record<string, unknown> {
  const summary = summarizeErrorValue(error);
  return typeof summary === "object" && summary !== null && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : { message: String(summary) };
}

function methodOf(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return sanitizeErrorBody(await res.text());
  } catch (readErr) {
    logger.debug("Could not read GitHub error response body", {
      error: readErr instanceof Error ? readErr.message : String(readErr),
    });
    return "[body unreadable]";
  }
}

export async function githubFetch(
  url: string,
  init: RequestInit = {},
  options: GitHubFetchOptions = {},
): Promise<Response> {
  const method = methodOf(init);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const label = options.label ?? `github ${method} ${url}`;
  let attemptsStarted = 0;

  try {
    return await retryWithBackoff(
      async () => {
        attemptsStarted++;
        let res: Response;
        try {
          res = await fetch(url, init);
        } catch (error) {
          const wrapped = new GitHubTransportError(method, url, error);
          logger.warn("GitHub API transport failure", {
            ...options.context,
            method,
            url,
            attempt: attemptsStarted,
            maxAttempts,
            retryable: shouldRetryGitHubError(wrapped),
            error: describeGitHubError(wrapped),
          });
          throw wrapped;
        }

        if (res.ok) return res;

        const body = await readErrorBody(res);
        const retryable = isRetryableStatus(res.status);
        const error = new GitHubApiError({
          status: res.status,
          body,
          method,
          url,
          retryable,
        });
        logger[retryable ? "warn" : "error"]("GitHub API HTTP failure", {
          ...options.context,
          method,
          url,
          attempt: attemptsStarted,
          maxAttempts,
          status: res.status,
          retryable,
          body,
        });
        throw error;
      },
      {
        label,
        maxAttempts,
        baseMs: options.baseMs ?? DEFAULT_BASE_MS,
        capMs: options.capMs ?? DEFAULT_CAP_MS,
        shouldRetry: shouldRetryGitHubError,
        signal: init.signal ?? undefined,
      },
    );
  } catch (error) {
    logger.error("GitHub API request failed", {
      ...options.context,
      method,
      url,
      attemptsStarted,
      maxAttempts,
      error: describeGitHubError(error),
    });
    throw error;
  }
}
