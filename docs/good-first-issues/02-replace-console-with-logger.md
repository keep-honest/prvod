# Replace `console.*` calls with the centralized logger

**Labels:** `good first issue` · `refactor` · `security` · `area: lib`

**Effort:** Small

## Summary

The project ships a structured logger at `src/lib/logger.ts` (`createLogger(name)`),
but a few modules still call `console.log` / `console.error` directly. Route these
through the logger for consistent, structured, filterable output. One of them also
leaks a database credential, which makes this a small security win too.

## The problem

- `src/infrastructure/persistence/db.ts:14`
  ```ts
  console.log(`Connecting to database at ${trimmedUrl}...`);
  ```
  `trimmedUrl` is the full `DATABASE_URL` connection string — **including the
  password**. This both bypasses the logger and writes a secret to stdout.

- `src/instrumentation.ts:22, 30, 36, 62, 64, 88, 95` — startup hook uses
  `console.log/warn/error` throughout instead of the logger.

## Proposed approach

1. In each file, create a logger: `const logger = createLogger("db")` /
   `createLogger("startup")`.
2. Replace `console.log(...)` → `logger.info(...)`, `console.warn` →
   `logger.warn`, `console.error` → `logger.error`, following how other modules
   (e.g. `src/lib/retry.ts`, `src/lib/rateLimit.ts`) already use it.
3. **For `db.ts`, redact the credentials** before logging. Either log only the
   host/database (parse with `new URL(trimmedUrl)` and log `parsed.host`/
   `parsed.pathname`) or reuse the existing `redactUrl()` helper in
   `src/lib/url.ts`. Do **not** log the raw connection string.

> Note: the Remotion video components (`CodeFirstScene.tsx`,
> `ProceduralBackground.tsx`, `ConstellationGraph.tsx`) also use `console.*`, but
> they render in a separate browser/Remotion context where the Node logger may not
> apply. Leave those out of this issue unless you confirm the logger works there;
> they can be a follow-up.

## Acceptance criteria

- [ ] `db.ts` and `instrumentation.ts` use `createLogger(...)` instead of `console.*`.
- [ ] The database connection log no longer contains credentials.
- [ ] `npm run lint` and `npm run typecheck` pass.

## Files you'll likely touch

- `src/infrastructure/persistence/db.ts`
- `src/instrumentation.ts`

## Why this is a good first issue

Small, self-contained, and it teaches the codebase's logging convention while
fixing a real (if minor) credential-leak in logs.
