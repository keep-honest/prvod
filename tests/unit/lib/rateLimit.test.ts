import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRateLimiter } from "@/lib/rateLimit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 });
    expect(limiter.check("ip1").allowed).toBe(true);
    expect(limiter.check("ip1").allowed).toBe(true);
    expect(limiter.check("ip1").allowed).toBe(true);
  });

  it("blocks requests exceeding the limit", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
    limiter.check("ip1");
    limiter.check("ip1");
    const result = limiter.check("ip1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("resets after the window expires", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.check("ip1");
    expect(limiter.check("ip1").allowed).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(limiter.check("ip1").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.check("ip1");
    expect(limiter.check("ip1").allowed).toBe(false);
    expect(limiter.check("ip2").allowed).toBe(true);
  });

  it("uses default config when none provided", () => {
    const limiter = createRateLimiter();
    // Should allow up to 60 requests in 60s window (defaults)
    for (let i = 0; i < 60; i++) {
      expect(limiter.check("ip1").allowed).toBe(true);
    }
    expect(limiter.check("ip1").allowed).toBe(false);
  });
});
