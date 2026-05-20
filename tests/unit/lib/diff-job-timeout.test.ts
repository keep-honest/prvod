import { describe, it, expect, vi, afterEach } from "vitest";
import { createDiffJobTimeout } from "@/lib/diff-job-timeout";

describe("createDiffJobTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a signal and clear function", () => {
    const { signal, clear } = createDiffJobTimeout(5_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(typeof clear).toBe("function");
    clear();
  });

  it("signal is not aborted before the deadline", () => {
    vi.useFakeTimers();
    const { signal, clear } = createDiffJobTimeout(1_000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(500);
    expect(signal.aborted).toBe(false);
    clear();
  });

  it("signal fires after the deadline", () => {
    vi.useFakeTimers();
    const { signal, clear } = createDiffJobTimeout(1_000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(signal.aborted).toBe(true);
    clear();
  });

  it("clear() cancels the timer so signal never fires", () => {
    vi.useFakeTimers();
    const { signal, clear } = createDiffJobTimeout(1_000);
    clear();
    vi.advanceTimersByTime(2_000);
    expect(signal.aborted).toBe(false);
  });

  it("abort reason is a DiffFetchTimeoutError so PipelineRunner can map it to DIFF_FETCH_TIMEOUT", async () => {
    vi.useFakeTimers();
    const { DiffFetchTimeoutError } = await import("@/lib/diff-errors");
    const ms = 500;
    const { signal, clear } = createDiffJobTimeout(ms);
    vi.advanceTimersByTime(ms + 1);
    expect(signal.reason).toBeInstanceOf(DiffFetchTimeoutError);
    expect((signal.reason as { errorTag?: string }).errorTag).toBe("DIFF_FETCH_TIMEOUT");
    expect((signal.reason as Error).message).toContain("500");
    clear();
  });
});
