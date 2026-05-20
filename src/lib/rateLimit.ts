import { createLogger } from "@/lib/logger";

const logger = createLogger("rateLimit");

interface RateLimitConfig {
  windowMs?: number;
  maxRequests?: number;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface RateLimiter {
  check(key: string): RateLimitResult;
  reset(): void;
}

// In-memory rate limiter — effective only for single-instance deployments.
// For multi-instance/serverless, replace with Redis-backed implementation.
export function createRateLimiter(config?: RateLimitConfig): RateLimiter {
  const windowMs = config?.windowMs ?? 60_000;
  const maxRequests = config?.maxRequests ?? 60;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }, 5 * 60_000);
  cleanup.unref();

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      const bucket = buckets.get(key);

      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterMs: 0 };
      }

      bucket.count++;
      if (bucket.count > maxRequests) {
        logger.warn("Rate limit exceeded", { count: bucket.count, maxRequests });
        return { allowed: false, retryAfterMs: bucket.resetAt - now };
      }

      return { allowed: true, retryAfterMs: 0 };
    },
    reset(): void {
      buckets.clear();
    },
  };
}
