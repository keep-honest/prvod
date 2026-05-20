/**
 * Exponential-backoff retry wrapper for LLM invocations.
 *
 * Wraps a single LLM call (CLI exec, Anthropic SDK, Gemini API, etc.) and
 * retries on transient errors — HTTP 429, RESOURCE_EXHAUSTED, model
 * overload, 5xx responses, and common network errors. Non-transient errors
 * (schema validation, auth, bad request) are rethrown immediately so
 * deterministic failures don't waste retry attempts.
 *
 * Retry is LLM-call-scoped, not pipeline-scoped. A single pipeline run will
 * retry each LLM call independently before giving up — it does not re-run
 * the whole pipeline. When the max attempts for a given call are exhausted,
 * the helper throws {@link LlmRateLimitedError} which the pipeline treats as
 * a non-retryable terminal failure.
 */

import { createLogger } from "@/lib/logger";

const logger = createLogger("retryLlmCall");

/** Error thrown when LLM-level retries are exhausted. */
export class LlmRateLimitedError extends Error {
  readonly code = "LLM_RATE_LIMITED_EXHAUSTED";

  constructor(
    message: string,
    public readonly details: {
      label: string;
      attempts: number;
      lastError: unknown;
    },
  ) {
    super(message);
    this.name = "LlmRateLimitedError";
  }
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/** Phrases providers use when the call is retryable. Case-insensitive. */
const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /rate ?limit/i,
  /rate[- ]?limited/i,
  /too many requests/i,
  /resource[_ ]exhausted/i,
  /model[_ ]capacity[_ ]exhausted/i,
  /no capacity available/i,
  /overloaded/i,
  /service unavailable/i,
  /upstream connect error/i,
  /upstream request timeout/i,
  /timed out after \d+ms/i,
  /max attempts reached/i, // gemini-cli bubbles this up after its own internal retries
  /econnreset/i,
  /etimedout/i,
  /enotfound/i,
  /eai_again/i,
];

/**
 * Inspects an unknown error value and returns true when it looks like a
 * transient rate-limit / capacity / network error that is worth retrying.
 *
 * This intentionally looks at both structured fields (`status`, `code`) and
 * error message substrings. CLI writers surface the provider's raw stderr
 * as part of the thrown message, so substring matching is often the only
 * signal we have.
 */
export function isTransientLlmError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;

  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };

  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : null;
  if (status !== null) {
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
  }

  const code = typeof candidate.code === "string" ? candidate.code : null;
  if (code && NETWORK_CODES.has(code)) return true;

  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (!message) return false;

  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}

export interface RetryLlmCallOptions {
  /** Short label used in logs (e.g. "coverage_judge", "claude.sdk.messages.create"). */
  label: string;
  /** Override max attempts. Defaults to LLM_MAX_RETRIES env var (default 5). */
  maxAttempts?: number;
  /** Override base delay in ms. Defaults to LLM_RETRY_BASE_DELAY_MS env var (default 1000). */
  baseDelayMs?: number;
  /** Upper cap for an individual delay. Default 30s. */
  maxDelayMs?: number;
  /** Optional: reject retries on errors that fail this predicate. Used to short-circuit deterministic validation errors. */
  shouldRetry?: (err: unknown) => boolean;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  // Exponential: base * 2^(attempt-1). Capped at maxDelayMs.
  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, maxDelayMs);
  // Full jitter: uniform in [capped/2, capped]. Keeps the backoff bounded
  // while smoothing thundering-herd retries from concurrent jobs.
  const half = capped / 2;
  return Math.round(half + Math.random() * half);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with exponential-backoff retries on transient errors.
 *
 * - Non-transient errors (as judged by {@link isTransientLlmError} or
 *   `options.shouldRetry`) are thrown immediately on the first attempt.
 * - Transient errors trigger a backoff and another attempt up to
 *   `maxAttempts`.
 * - When `maxAttempts` is exhausted, an {@link LlmRateLimitedError} is
 *   thrown. Callers should let it propagate to `PipelineRunner`, which
 *   classifies it as non-retryable at the pipeline level.
 */
export async function retryLlmCall<T>(
  fn: () => Promise<T>,
  options: RetryLlmCallOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? readIntEnv("LLM_MAX_RETRIES", 5);
  const baseDelayMs = options.baseDelayMs ?? readIntEnv("LLM_RETRY_BASE_DELAY_MS", 1000);
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const predicate = options.shouldRetry ?? isTransientLlmError;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!predicate(err)) {
        throw err;
      }

      if (attempt >= maxAttempts) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logger.error("LLM call retries exhausted", {
          label: options.label,
          attempts: attempt,
          maxAttempts,
          error: errMessage.slice(0, 500),
        });
        throw new LlmRateLimitedError(
          `LLM call "${options.label}" failed after ${attempt} attempts: ${errMessage}`,
          { label: options.label, attempts: attempt, lastError: err },
        );
      }

      const delayMs = computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      logger.warn("LLM call transient failure — retrying with backoff", {
        label: options.label,
        attempt,
        maxAttempts,
        nextAttemptInMs: delayMs,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws via the exhausted branch.
  throw new LlmRateLimitedError(
    `LLM call "${options.label}" failed after ${maxAttempts} attempts (unreachable)`,
    { label: options.label, attempts: maxAttempts, lastError },
  );
}
