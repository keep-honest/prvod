import { createLogger } from "@/lib/logger";

const logger = createLogger("retry");

export interface RetryOptions<E = unknown> {
  /** Short label used in log messages. */
  label: string;
  /** Total attempts including the first (default: 3). */
  maxAttempts?: number;
  /** Base delay in ms before the first retry (default: 500). */
  baseMs?: number;
  /** Upper cap for a single delay (default: 8000). */
  capMs?: number;
  /** Return true to retry; return false to rethrow immediately (default: always retry). */
  shouldRetry?: (err: E) => boolean;
  /** Optional AbortSignal — if fired, the sleep is cancelled and the error is rethrown. */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  // Exponential with full jitter in [cap/2, cap]
  const exponential = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, capMs);
  const half = capped / 2;
  return Math.round(half + Math.random() * half);
}

/**
 * Execute `fn` with exponential-backoff retries.
 *
 * Non-retryable errors (per `shouldRetry`) are rethrown immediately.
 * When `maxAttempts` is exhausted the last error is rethrown as-is.
 */
export async function retryWithBackoff<T, E = unknown>(
  fn: () => Promise<T>,
  options: RetryOptions<E>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 500;
  const capMs = options.capMs ?? 8_000;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const { signal, label } = options;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Aborted before attempt");
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err as E)) throw err;
      if (attempt >= maxAttempts) break;

      const delay = backoffMs(attempt, baseMs, capMs);
      logger.warn("Retryable failure — backing off", {
        label,
        attempt,
        maxAttempts,
        nextAttemptInMs: delay,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
      await sleep(delay, signal);
    }
  }

  logger.error("Retries exhausted", { label, maxAttempts });
  throw lastErr;
}
