# CLAUDE.md

Guidance for Claude Code when working in this repo.

> Also read [`RULES.md`](RULES.md) — mandatory documentation rules before commits.
> For shipping a tagged release of `prvodctl`, follow [`RELEASE.md`](RELEASE.md).

## What is prvod?

Video generation system that turns GitHub PR diffs into narrated code-first walkthroughs (20–120 s). Ships as a GitHub App that auto-comments on PRs. Optional **deepdive mode** produces reviewer-style narration (indirect questions, no verdicts) instead of neutral recaps.

Also ships **`prvodctl`** ([`cli-go/`](cli-go/)) — a self-contained Go CLI that drives the jobs API. 1:1 functional port of [`src/cli/local-test.ts`](src/cli/local-test.ts).

## Commands

```bash
# Node server (Next.js 15 App Router, Node >=22)
npm run dev | build | start
npm test | run test:unit | run test:int | run test:watch
npm run lint | typecheck
npm run db:push | db:generate | db:studio          # Drizzle / Postgres
npm run cli -- --server-url http://localhost:3000 --api-key <key> [--script-only|--retry-job <id>|--no-stream-diff]
npm run admin:create-api-key

# Go CLI (cli-go/)
cd cli-go && make            # → ./prvodctl
make check                   # go vet + go test
make dist                    # cross-compile for the 5 release platforms
./prvodctl --version --help
```

## Architecture

4-layer dependency inversion — deps point inward only; Layer 2 never imports Layer 3.

```
Layer 1: src/interfaces/    — Ports (IScriptWriter, ITTSService, IVideoCompositor, IDiffSource, …)
Layer 2: src/domain/        — Business logic, entities, services
Layer 3: src/infrastructure/— Postgres, R2/S3/local, TTS, FFmpeg/Remotion, github, llm
Layer 4: src/app/api/       — Next.js route handlers
```

**DI container** ([`src/config/container.ts`](src/config/container.ts)): lazy singleton, env-driven wiring, validates critical config at startup. `NODE_ENV=test` or `USE_MOCK_SERVICES=true` → mock container.

### Pipeline (VideoOrchestrator)

1. Analyze PR diff → 2. Generate script → 3. Build code-first scene assets (Remotion) → 4. Synthesize speech (Google TTS or model-native) → 5. Compose final video (FFmpeg or Remotion) → 6. Upload to storage (R2 / S3 / local).

**Prompt Pipeline V2** (`PROMPT_PIPELINE_V2=true`, step 2): coverage planner → coverage judge → scene outline → final script writer → narration judge → word budget → evidence grounding → reviewer narration. Repair loops (`SCRIPT_REPAIR_MAX_ATTEMPTS`, default 2) feed Zod errors / outline failures / over-budget scenes / grounding failures / reviewer-narration violations back to the LLM. Grounding-fatal vs warning: `unknownFileReferences` and any `codeBroll.filePath` mismatch are fatal; `crossSceneFileReferences` warn. `SKIP_JUDGE=true` skips LLM judges only — deterministic validators still run.

**Reviewer-Oriented Narration (deepdive)**: issue-first ordering by review risk; indirect-question framing; no verdicts/confidence; opening establishes review handoff, closing recaps unresolved checks. `validateReviewerNarration()` post-checks; persistent violations fail-closed (`REVIEWER_VIOLATION_WARN=true` to degrade to warn). No new transport fields or routes.

**LLM call retry** ([`src/infrastructure/llm/retryLlmCall.ts`](src/infrastructure/llm/retryLlmCall.ts)): wraps every Claude / Gemini SDK + CLI call. Retries 429 / `RESOURCE_EXHAUSTED` / `MODEL_CAPACITY_EXHAUSTED` / 5xx / network with exp backoff + jitter. After `LLM_MAX_RETRIES` (default 5) throws `LlmRateLimitedError` (`code="LLM_RATE_LIMITED_EXHAUSTED"`). Webhook `runWithRetry` skips pipeline-level retries on this code (same upstream, same budget).

**Checkpointing**: progress saved after each expensive step; retries resume from last checkpoint.

### Streaming diff ingest

`PRContext.diffSource` is a discriminated union (`github_pr | local_diff_file`). Webhook uses `GitHubFilesDiffSource` (paginated, 30 files/page). CLI `--diff-file` / `--stream-diff` uses `LocalFileDiffSource` (server writes upload to `tmpdir` with `0o600`). `DiffCorpusBuilder` enforces a 200 k-line cap; oversized files (>64 KB patch or >2000 changed lines) route through `OversizedFileProcessor` + `SUMMARISER_PROVIDER` (default inherits `SCRIPT_WRITER`).

### Job processing

Fire-and-forget: HTTP handler returns the job ID immediately; `PipelineRunner` runs async. Idempotent: one active job per (installation, repo, PR).

### Review workstation

`/reviews/[jobId]` — interactive workstation: video + diff workspace + transcript + constellation map (pixi.js) + draft-comment composer. Viewing stays share-token gated (private repos need valid HMAC `shareToken`; failures → 404). GitHub session (NextAuth, [`src/lib/reviewAuth.ts`](src/lib/reviewAuth.ts)) only unlocks commenting: `canSyncDrafts` = reviewer OAuth token can view repo AND `snapshotStatus === "current"`. Freshness fail-closed: head SHA moved or GitHub check fails → `outdated`, sync/submit locked. Draft sync/submit routes (`/api/reviews/[jobId]/draft-comments/{sync,submit}`) use reviewer's OAuth token — not installation token — via optional `IGitHubService` methods (`syncDraftReviewComments`, `submitPendingReview`, `discardPendingReview`). Diff snapshot + scene anchors + pins persisted in `metrics_json` at pipeline completion (`buildPersistedReviewWorkspaceMetrics`; diff reconstructed from corpus hunk snippets). Jobs completed before this feature lack snapshot → empty diff pane until re-run. Dev seeding: `POST /api/dev/reviews/seed` (needs `USE_MOCK_SERVICES=true` or `NODE_ENV=test`). Env: `AUTH_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`.

### Auth

API keys are `keyId.secret`, Argon2id-hashed with `APP_ENCRYPTION_KEY` pepper. Middleware tiers: `withBaseAuth` → `withJobsAuth` (admin + trial) → `withJobsReadAuth` (allows consumed keys for polling) → `withAdminAuth`. `/api/jobs` requires `isAdmin || maxUses !== null`. One-time trial keys claim atomically via `UPDATE … WHERE status='active'`; `releaseOrphanedKeys()` at startup recovers from process crashes. GitHub App: JWT + webhook HMAC-SHA256, installation-scoped.

### Prompt injection guard

7-layer defense; local regex/heuristic only, no extra LLM calls.

```
Input:  PR content → InputSanitizer (L1-2) → buildUserPrompt (L3) → Claude/Gemini API (L4)
Output: model response → Schema validation (L5) → OutputValidator (L6-7) → video/TTS prompts
```

- **`InputSanitizer.sanitize()`**: Unicode normalize, zero-width strip, 18 injection-pattern regexes with context-aware masking. Contexts: `strict` (titles), `permissive` (descriptions), `code` (diffs — preserves indentation; suppresses `encoding_evasion` but never `delimiter_escape`). Fail-closed → empty.
- **What gets sanitized**: every PR field (title, description, diff, issues, milestone, branch names) + `analysis.topFileDiffs` + `analysis.topFiles[].filePath`. Hoisted before V2/legacy split.
- **`OutputValidator.validate()`**: credential/PII scan, instruction-pattern stripping, URL removal. Fields: `narration`, `productionAudio`. `codeBroll.filePath` exempt (structured key, grounding guarantees repo-origin). Fail-closed → `[REDACTED]`. Applied inside SDK script writers (`ClaudeScriptWriter`, `GeminiSdkScriptWriter`); CLI writers route output through the same validator path.
- **Canary tokens**: per-job 32-char random hex in system prompt; if found in output → throw.
- **Load-bearing constraints**: `delimiter_escape` patterns are NEVER suppressed (protect the XML boundary in every context). Whitespace normalization skipped for `code` context. V2 section tags renamed to reduce collision surface: `<analysis>` → `<diff_analysis>`, `<script>` → `<pipeline_script>`. All V2 system prompts include `buildSecurityDirective(family)`.

## Testing

- No database, API keys, or external services needed
- Mocks in [`src/mocks/`](src/mocks/) match every interface
- Path alias `@/` → `src/` (vitest + tsconfig)
- Coverage excludes `src/app/` and `src/mocks/`

## Key files

| File | Role |
|---|---|
| [`src/domain/services/PipelineRunner.ts`](src/domain/services/PipelineRunner.ts) | Job orchestration + error state machine |
| [`src/domain/services/VideoOrchestrator.ts`](src/domain/services/VideoOrchestrator.ts) | 6-step video pipeline |
| [`src/config/container.ts`](src/config/container.ts) | DI wiring — start here to see how pieces connect |
| [`src/infrastructure/llm/promptPipelineV2Runner.ts`](src/infrastructure/llm/promptPipelineV2Runner.ts) | V2 multi-step orchestrator + repair loop integration |
| [`src/infrastructure/llm/retryLlmCall.ts`](src/infrastructure/llm/retryLlmCall.ts) | Transient-error retry shared by every LLM call |
| [`src/domain/entities/VideoScript.ts`](src/domain/entities/VideoScript.ts) | Scene schema, duration constraints |
| [`src/infrastructure/persistence/schema.ts`](src/infrastructure/persistence/schema.ts) | Drizzle schema |
| [`src/infrastructure/github/githubFetch.ts`](src/infrastructure/github/githubFetch.ts) | Canonical GitHub fetch wrapper (retry + typed errors) |
| [`src/lib/storage/signLocalUrl.ts`](src/lib/storage/signLocalUrl.ts) | HMAC-SHA256 signed-URL sign/verify/boot-validate |
| [`src/lib/apiMiddleware.ts`](src/lib/apiMiddleware.ts) | Auth middleware tiers |
| [`src/app/api/jobs/route.ts`](src/app/api/jobs/route.ts) | Job creation; handles JSON (5 MB) + `application/x-git-diff` (100 MB) branches |
| [`src/app/api/webhook/github/route.ts`](src/app/api/webhook/github/route.ts) | GitHub App webhook — installation lifecycle, PR events |
| [`src/app/reviews/[jobId]/ReviewPageClient.tsx`](src/app/reviews/[jobId]/ReviewPageClient.tsx) | Review workstation client — playback, diff workspace, draft comments |
| [`src/lib/reviews/loadReviewPage.ts`](src/lib/reviews/loadReviewPage.ts) | Review page loader — share-token viewing gate + session commenting capability |
| [`src/lib/reviewAuth.ts`](src/lib/reviewAuth.ts) | Scoped NextAuth GitHub session + repo-access checks for draft comments |
| [`src/lib/reviews/reviewDiffSnapshot.ts`](src/lib/reviews/reviewDiffSnapshot.ts) | Diff snapshot / scene anchor / pin builders persisted to `metrics_json` |
| [`src/cli/local-test.ts`](src/cli/local-test.ts) | Node CLI; reference implementation for `prvodctl` |
| [`cli-go/cmd/root.go`](cli-go/cmd/root.go) | Go CLI command surface |

## prvodctl Go CLI

- **Modes (mutually exclusive)**: normal (git source, streams by default) · `--no-stream-diff` (legacy JSON, 5 MB, preserves real `--pr-number`) · `--diff-file <path>` · `--retry-job <id>`
- **Exit codes**: 0 success · 1 generic/timeout/failed · 2 mutex/flag conflict · 3 diff missing/empty · 4 not a unified diff · 5 `DIFF_TOO_LARGE` · 6 `DIFF_PARSE_ERROR` · 7 `DIFF_FETCH_TIMEOUT`. Polling-time **and** create-time HTTP 413s map to the same codes.
- **Config**: YAML auto-discovered (`./prvodctl.yaml`, `$XDG_CONFIG_HOME/prvodctl/prvodctl.yaml`, `~/.prvodctl.yaml`) + env vars + flags. Precedence: flag > env > config > default.

## Conventions

- TypeScript strict, `no-explicit-any` enforced. Unused vars prefixed `_`.
- Zod for all external input validation.
- JSON structured logging via [`src/lib/logger.ts`](src/lib/logger.ts) (debug suppressed in prod).
- Remotion / `pg` / webpack are `serverExternalPackages`. Production Dockerfile base: `node:bookworm-slim` (Alpine forbidden by Remotion's chrome-headless-shell). Chrome pre-baked when `VIDEO_COMPOSITOR=remotion`; `RemotionCompositor` passes `chromiumOptions: { enableMultiProcessOnLinux: true }`.
- **GitHub HTTP retry** ([`src/infrastructure/github/githubFetch.ts`](src/infrastructure/github/githubFetch.ts)): all callers route through `githubFetch`. **Method-aware default `maxAttempts`**: GET/HEAD = 3 (exp backoff + jitter); POST/PUT/PATCH/DELETE = 1 because GitHub's mutating endpoints have no idempotency-key support — retrying a lost-response POST creates duplicate PR comments. Throws `GitHubApiError` (`status`/`body`/`method`/`url`/`retryable`) or `GitHubTransportError` (carries `cause` chain). 429 + 5xx + transport faults retried; 4xx + abort not.
- **Local-storage signed URLs** ([`src/lib/storage/`](src/lib/storage/)): when `STORAGE_PROVIDER=local`, container boot calls `readStorageUrlSecret()` and fails loudly if `STORAGE_URL_SECRET` is unset. Rotation invalidates every outstanding link — see [`RULES.md`](RULES.md) for the grace-window procedure. `resolveForStreaming` applies `fs.realpath` + base-dir containment to defeat symlink escape.
- **Pre-commit secret scan**: `.pre-commit-config.yaml` runs `gitleaks` on every commit. Never bypass with `--no-verify`.
