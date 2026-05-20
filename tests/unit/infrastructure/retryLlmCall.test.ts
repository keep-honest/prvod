import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LlmRateLimitedError,
  isTransientLlmError,
  retryLlmCall,
} from "@/infrastructure/llm/retryLlmCall";

describe("isTransientLlmError", () => {
  it("returns false for non-error values", () => {
    expect(isTransientLlmError(null)).toBe(false);
    expect(isTransientLlmError(undefined)).toBe(false);
    expect(isTransientLlmError("a string")).toBe(false);
    expect(isTransientLlmError(42)).toBe(false);
  });

  it("returns true for HTTP 429 status field", () => {
    expect(isTransientLlmError({ status: 429, message: "Too Many Requests" })).toBe(true);
    expect(isTransientLlmError({ statusCode: 429, message: "Too Many Requests" })).toBe(true);
  });

  it("returns true for 5xx status codes", () => {
    expect(isTransientLlmError({ status: 500 })).toBe(true);
    expect(isTransientLlmError({ status: 502 })).toBe(true);
    expect(isTransientLlmError({ status: 503 })).toBe(true);
    expect(isTransientLlmError({ status: 504 })).toBe(true);
    expect(isTransientLlmError({ status: 599 })).toBe(true);
  });

  it("returns false for 4xx auth/bad-request status codes", () => {
    expect(isTransientLlmError({ status: 400, message: "Bad request" })).toBe(false);
    expect(isTransientLlmError({ status: 401, message: "Unauthorized" })).toBe(false);
    expect(isTransientLlmError({ status: 403, message: "Forbidden" })).toBe(false);
    expect(isTransientLlmError({ status: 404, message: "Not found" })).toBe(false);
  });

  it("returns true for retryable node network error codes", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]) {
      expect(isTransientLlmError({ code, message: `system ${code}` })).toBe(true);
    }
  });

  it("matches Gemini / OpenAI / Anthropic transient-text patterns", () => {
    const samples = [
      "429 Too Many Requests",
      "Rate limit exceeded for model foo",
      "RESOURCE_EXHAUSTED: No capacity available for model gemini-2.5-pro on the server",
      "MODEL_CAPACITY_EXHAUSTED (domain=cloudcode-pa)",
      "Anthropic API is overloaded, please try again",
      "upstream connect error or disconnect/reset before headers",
      "gemini CLI timed out after 90000ms",
      "Max attempts reached", // gemini-cli wrapper
    ];
    for (const message of samples) {
      expect(isTransientLlmError(new Error(message))).toBe(true);
    }
  });

  it("returns false for non-transient error messages", () => {
    const samples = [
      new Error("ZodError: expected string"),
      new Error("Invalid API key"),
      new Error("JSON parse failure"),
      new Error("video script scene outline missing"),
    ];
    for (const err of samples) {
      expect(isTransientLlmError(err)).toBe(false);
    }
  });
});

describe("retryLlmCall", () => {
  const originalRandom = Math.random;

  beforeEach(() => {
    // Fake timers so we don't actually wait for the backoff delays.
    vi.useFakeTimers();
    // Freeze jitter so the sleep delay is deterministic.
    Math.random = () => 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    Math.random = originalRandom;
  });

  async function runAllTimers(p: Promise<unknown>) {
    // Advance all pending timers so queued sleeps resolve.
    await vi.runAllTimersAsync();
    return p;
  }

  it("returns the result on the first successful attempt with no retry", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryLlmCall(fn, { label: "test.happy" });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws non-transient errors immediately without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ZodError: bad shape"));
    await expect(retryLlmCall(fn, { label: "test.nonTransient" })).rejects.toThrow(
      "ZodError: bad shape",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors and returns the eventual success", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockRejectedValueOnce(new Error("Anthropic API is overloaded"))
      .mockResolvedValueOnce("eventually ok");

    const promise = retryLlmCall(fn, {
      label: "test.transientRecovery",
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });
    await runAllTimers(promise);
    const result = await promise;

    expect(result).toBe("eventually ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws LlmRateLimitedError after exhausting maxAttempts on transient errors", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("RESOURCE_EXHAUSTED: no capacity available"));

    // Attach a silent catch BEFORE advancing timers so vitest does not treat
    // the rejection as unhandled while fake timers are still flushing.
    const promise = retryLlmCall(fn, {
      label: "test.exhaustion",
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 20,
    });
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(LlmRateLimitedError);
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("annotates LlmRateLimitedError with label, attempts, and lastError", async () => {
    const lastInner = new Error("429 rate limit");
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(lastInner);

    const promise = retryLlmCall(fn, {
      label: "coverage_judge",
      maxAttempts: 2,
      baseDelayMs: 5,
    });
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(LlmRateLimitedError);
      const err = outcome.error as LlmRateLimitedError;
      expect(err.code).toBe("LLM_RATE_LIMITED_EXHAUSTED");
      expect(err.details.label).toBe("coverage_judge");
      expect(err.details.attempts).toBe(2);
      expect(err.details.lastError).toBe(lastInner);
    }
  });

  it("respects a custom shouldRetry predicate", async () => {
    // shouldRetry=false → even a 429 is treated as fatal.
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("429 rate limit"));
    await expect(
      retryLlmCall(fn, {
        label: "test.customPredicate",
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("429 rate limit");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors LLM_MAX_RETRIES env override when no explicit maxAttempts passed", async () => {
    const original = process.env.LLM_MAX_RETRIES;
    process.env.LLM_MAX_RETRIES = "2";
    try {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("429 rate limit"));
      const promise = retryLlmCall(fn, {
        label: "test.envOverride",
        baseDelayMs: 5,
      });
      const settled = promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.runAllTimersAsync();
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(LlmRateLimitedError);
      }
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      if (original === undefined) delete process.env.LLM_MAX_RETRIES;
      else process.env.LLM_MAX_RETRIES = original;
    }
  });
});
