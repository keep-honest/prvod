# Add unit tests for the `retry()` helper

**Labels:** `good first issue` · `testing` · `area: lib`

**Effort:** Medium

## The problem

`src/lib/retry.ts` implements the project's retry-with-exponential-backoff helper —
`maxAttempts`, `baseMs`, `capMs`, a `shouldRetry(err)` predicate, and `AbortSignal`
cancellation. It's used across infrastructure code, but has **no dedicated test
file**, so the backoff, early-exit, and cancellation paths are unverified.

## Proposed approach

Create `tests/unit/lib/retry.test.ts`. Use Vitest's fake timers
(`vi.useFakeTimers()`) so the test doesn't actually wait for backoff delays.
Cover:

- succeeds on the first attempt → underlying fn called once,
- fails then succeeds → retried and eventually resolves,
- exhausts `maxAttempts` → rejects with the last error, called exactly
  `maxAttempts` times,
- `shouldRetry` returning `false` → rethrows immediately without further attempts,
- delay grows exponentially from `baseMs` and is capped at `capMs`
  (advance fake timers and assert the wait between attempts),
- an already-aborted / mid-flight `AbortSignal` cancels the pending sleep and
  rejects.

Look at the `RetryOptions` interface and the `sleep()` implementation at the top of
the file for exact semantics.

## Acceptance criteria

- [ ] New `tests/unit/lib/retry.test.ts` covering success, retry, exhaustion,
      `shouldRetry`, backoff growth/cap, and abort.
- [ ] Tests use fake timers (no real delays) and `npm run test:unit` passes.

## Files you'll likely touch

- `tests/unit/lib/retry.test.ts` (new)

## Why this is a good first issue

It introduces a genuinely useful skill — testing async code and backoff with fake
timers — on a small, self-contained module with a clear, documented contract.
