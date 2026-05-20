/**
 * Shared webhook rate-limiter instance.
 *
 * Lives in a sibling module — not in `route.ts` — because Next.js's App
 * Router only allows a fixed set of named exports on route files
 * (HTTP verbs, `config`, `dynamic`, etc.). A helper like
 * `resetWebhookRateLimiterForTests` directly on `route.ts` trips the
 * generated `.next/types/...` guard with:
 *
 *   Property 'resetWebhookRateLimiterForTests' is incompatible with
 *   index signature. Type '() => void' is not assignable to type 'never'.
 *
 * Moving the limiter + test helper here leaves `route.ts` clean and
 * keeps the test reset a simple function call.
 */
import { createRateLimiter } from "@/lib/rateLimit";

export const webhookRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
});

export function resetWebhookRateLimiterForTests(): void {
  webhookRateLimiter.reset();
}
