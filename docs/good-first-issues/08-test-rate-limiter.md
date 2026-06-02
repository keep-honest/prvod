# Add unit tests for the in-memory rate limiter

**Labels:** `good first issue` · `testing` · `area: lib`

**Effort:** Medium

## The problem

`src/lib/rateLimit.ts` exports `createRateLimiter({ windowMs, maxRequests })`,
returning `{ check(key), reset() }`. It enforces a per-key request quota inside a
sliding window and expires stale buckets. It guards request handlers, but has **no
test file**, so quota enforcement and window-reset behavior are unverified.

## Proposed approach

Create `tests/unit/lib/rateLimit.test.ts`, using Vitest fake timers to advance
through the window. Cover:

- the first `maxRequests` calls for a key return `allowed: true`,
- the `maxRequests + 1`th call returns `allowed: false` with a positive
  `retryAfterMs`,
- after `windowMs` elapses the same key is allowed again (count resets),
- two different keys have independent quotas,
- `reset()` clears all buckets,
- the defaults are applied when no config is passed (`windowMs` 60_000,
  `maxRequests` 60).

## Acceptance criteria

- [ ] New `tests/unit/lib/rateLimit.test.ts` covering quota, window reset, key
      isolation, `reset()`, and defaults.
- [ ] Tests use fake timers and `npm run test:unit` passes.

## Files you'll likely touch

- `tests/unit/lib/rateLimit.test.ts` (new)

## Why this is a good first issue

A compact, well-defined module with clear inputs/outputs, plus a chance to practice
time-based testing — and it locks down behavior that protects the API.
