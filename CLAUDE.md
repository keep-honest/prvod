# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Important:** Also read [`RULES.md`](RULES.md) — mandatory rules that must be followed (e.g., documentation updates before commits).
>
> For shipping a new release of the Go CLI, follow [`RELEASE.md`](RELEASE.md).

## What is prvod?

A video generation system that transforms GitHub pull request diffs into narrated code-first video walkthroughs (20–120s). It integrates as a GitHub App that auto-comments on PRs. Optional deepdive mode produces reviewer-oriented narration with indirect questions instead of neutral recaps.

The repo also ships **`prvodctl`**, a self-contained Go CLI client for the server's jobs API (see [`cli-go/`](cli-go/)). It's a 1:1 port of the Node CLI at `src/cli/local-test.ts`.

## Commands

### Node server (the main app)

```bash
# Dev server
npm run dev

# Tests (no external services needed)
npm test                          # All tests
npm run test:unit                 # Unit tests only
npm run test:int                  # Integration tests only
npm run test:watch                # Watch mode
npx vitest run tests/unit/domain  # Run a specific directory
npx vitest run tests/unit/lib/auth.test.ts  # Run a single test file

# Quality
npm run lint                      # ESLint (strict TypeScript rules, no-explicit-any)
npm run typecheck                 # tsc --noEmit

# Database (PostgreSQL + Drizzle ORM)
npm run db:push                   # Apply schema to DB
npm run db:generate               # Generate migration files
npm run db:studio                 # Drizzle Studio GUI

# Build & run
npm run build                     # Next.js standalone build
npm run start                     # Production server

# Node CLI for local testing
npm run cli -- --server-url http://localhost:3000 --api-key <key>
npm run cli -- --script-only      # Generate script only (no video)
npm run cli -- --retry-job <uuid> # Retry a failed job
npm run cli -- --stream-diff      # (default) Stream the diff via the 100 MB upload branch
npm run cli -- --no-stream-diff   # Use the legacy JSON branch (5 MB cap; preserves --pr-number)

# Admin
npm run admin:create-api-key      # Mint a long-lived admin API key
```

### Go CLI (`prvodctl`)

```bash
cd cli-go
make            # Build ./prvodctl
make test       # go test ./...
make check      # go vet + go test
make dist       # Cross-compile to dist/ for the 5 release platforms
make help       # Full list of targets
./prvodctl --version
./prvodctl --help
```

For shipping a new tagged release, see [`RELEASE.md`](RELEASE.md).

## Architecture

**4-layer dependency inversion** — dependencies point inward only; Layer 2 never imports Layer 3.

```
Layer 1: src/interfaces/          — Port definitions (IScriptWriter, ITTSService, IVideoCompositor, etc.)
Layer 2: src/domain/              — Business logic, entities, services
Layer 3: src/infrastructure/      — Implementations (Postgres, R2/S3/local, TTS, FFmpeg/Remotion)
Layer 4: src/app/api/             — Next.js route handlers
```

**DI container** (`src/config/container.ts`): Lazy singleton, environment-driven wiring. `NODE_ENV=test` or `USE_MOCK_SERVICES=true` → mock container. Validates critical config at startup.

### Pipeline flow (VideoOrchestrator)

1. Analyze PR diff → 2. Generate script (structured output or text + repair) → 3. Build code-first scene assets (Remotion) → 4. Synthesize speech (Google TTS or model-native) → 5. Compose final video (FFmpeg or Remotion) → 6. Upload to storage (R2 / S3 / local).

**Prompt Pipeline V2** (step 2, feature-flagged via `PROMPT_PIPELINE_V2=true`): Multi-step LLM pipeline — coverage planner → coverage judge → scene outline → final script writer → narration judge → word budget validation → evidence grounding validation → reviewer narration validation. Uses `completeJson<S>()` with native structured output (Claude SDK: `output_config.format` with `json_schema`; Claude CLI: `--json-schema`; Gemini SDK: `responseJsonSchema` + `responseMimeType`; Gemini CLI: prompt-embedded schema fallback). Five repair loops (`SCRIPT_REPAIR_MAX_ATTEMPTS`, default 2): (1) **scene outline repair** — feeds `validateSceneOutlineConsistency` failures (uncovered clusters, missing scenes) back to the LLM; (2) **schema repair** — feeds Zod validation errors back to the LLM; (3) **word budget repair** — feeds over-budget scenes (exceeding 2.5 words/second) back to the LLM with per-scene word limits; non-fatal if all attempts fail; (4) **grounding repair** — feeds evidence grounding failures back with per-scene allowed evidence lists. Validation splits narration file mentions: paths in the corpus but assigned to a different scene → `crossSceneFileReferences` (warning, prose drift), paths absent from the corpus → `unknownFileReferences` (fatal, hallucination). `codeBroll.filePath` mismatch is always fatal regardless of corpus presence (visual-on-screen contract). Backtick-wrapped identifiers outside cluster evidence are fatal. After grounding repair, the narration judge re-runs on the repaired script. (5) **reviewer narration repair** — deepdive-only; feeds verdict/client-facing language violations back to the LLM for rewriting.

**Reviewer-Oriented Narration (deepdive mode)**: Deepdive mode makes prompt pipeline stages produce narration that behaves like an initial engineering review instead of a neutral recap. Standard mode remains the default. Key behavioral changes:
- **Issue-first ordering**: Coverage planner ranks clusters by review risk (correctness > concurrency > data_integrity > security > regression > validation_gap). Scene outline places highest-risk concern first after overview.
- **Reviewer-style question framing**: Final script writer phrases concerns as indirect questions/observations. No second-person blame, no client-facing tone.
- **No verdicts/confidence**: Deepdive prompts forbid merge verdicts, confidence language, and style nits. Deterministic `validateReviewerNarration()` post-checks only deepdive scripts for verdict/client-facing patterns. Violations trigger LLM repair; persistent violations throw (fail-closed). Override with `REVIEWER_VIOLATION_WARN=true` to degrade to warn-only during rollout.
- **Opening/closing posture**: Opening establishes teammate review handoff and names the main risk. Closing summarizes unresolved checks without implying approval.
- **Public contract stable**: No new `VideoScript` transport fields; reviewer posture stays implicit in narration content. No new API routes or DB tables.

**Skipping AI judges** (`SKIP_JUDGE=true`, default `false`): Bypasses the LLM-powered judges in the V2 pipeline (coverage judge, narration quality judge). Deterministic validators (coverage consistency, word budgets, evidence grounding) still run. Useful for local iteration, cost-sensitive environments, and debugging.

**LLM call retry** (`src/infrastructure/llm/retryLlmCall.ts`): Every LLM call — CLI exec (`BaseCliScriptWriter.execCli`, `cliLlmClient.ts`), Anthropic SDK (`ClaudeScriptWriter`), Gemini SDK (`GeminiSdkScriptWriter`) — is wrapped in `retryLlmCall()` which retries transient errors (HTTP 429, `RESOURCE_EXHAUSTED`, `MODEL_CAPACITY_EXHAUSTED`, overload, 5xx, network codes) with exponential backoff + jitter. After `LLM_MAX_RETRIES` (default 5) attempts, it throws `LlmRateLimitedError` with `code="LLM_RATE_LIMITED_EXHAUSTED"`. `PipelineRunner.extractFailureMetadata` classifies this error, webhook `runWithRetry` skips pipeline-level retries (they would burn through the same budget against the same upstream problem), and the user-facing comment explains the provider capacity issue.

**Checkpoint system**: Progress is saved after each expensive step. Retries resume from the last checkpoint, not from scratch.

### Streaming diff ingest

`PRContext.diffSource` is a discriminated union (`github_pr | local_diff_file`). The webhook path uses `GitHubFilesDiffSource` which paginates the GitHub Files API (30 files/page) with retry. The CLI's `--diff-file` and `--stream-diff` modes use `LocalFileDiffSource` (server stores the upload to a tmpdir with `0o600` and synthesizes a PRContext). `DiffCorpusBuilder` merges segments into `DiffMetadataCorpus` with a 200k-line hard cap. Oversized files (>64 KB patch or >2000 changed lines) are routed through `OversizedFileProcessor` + a configurable rolling summariser (`SUMMARISER_PROVIDER=claude-sdk|claude-cli|gemini-sdk|gemini-cli|codex-cli|mock`).

### Job processing

Fire-and-forget: HTTP handler returns the job ID immediately, `PipelineRunner` runs async. Caller polls for completion. Idempotent: one active job per (installation, repo, PR).

### Auth

- **API keys**: `keyId.secret` format, Argon2id hashed with `APP_ENCRYPTION_KEY` pepper, stored in DB
- **One-time trial keys**: Same format, distinguished by `maxUses` column. Lifecycle: active → in_use → consumed (success) or active (failure/preview)
- **Middleware tiers**: `withBaseAuth` → `withJobsAuth` (admin + trial) → `withJobsReadAuth` (allows consumed keys for polling) → `withAdminAuth` (admin only)
- **Authorization**: `/api/jobs` requires `isAdmin || maxUses !== null` — rejects non-admin unlimited keys
- **One-time key claim**: atomic `UPDATE ... WHERE status='active'` for concurrency safety
- **Startup recovery**: `releaseOrphanedKeys()` handles keys stuck in `in_use` after process crash
- **GitHub App**: JWT + webhook HMAC-SHA256 validation, installation-scoped

### Prompt injection guard

7-layer defense-in-depth pipeline protecting all LLM prompts from malicious PR content. No extra LLM API calls — all detection is local regex/heuristic processing.

```
Input path:  PR content → InputSanitizer (L1-2) → buildUserPrompt (L3) → Claude API (L4)
Output path: Claude response → Schema validation (L5) → OutputValidator (L6-7) → video/TTS prompts
```

**Input sanitization** (`InputSanitizer.sanitize()`): Unicode normalization, zero-width char stripping, 18 injection pattern regexes with context-aware masking (quoted strings, code fences, comment lines suppressed). Content context: `strict` (titles), `permissive` (descriptions), `code` (diffs — preserves indentation, suppresses encoding_evasion but never delimiter_escape). Fail-closed on error (returns empty content).

**What gets sanitized**: All PR fields (title, description, diff, issues, milestone, branch names) + `analysis.topFileDiffs` values + `analysis.topFiles[].filePath` (with dedup to prevent key collisions). Hoisted before V2/legacy split — both paths receive sanitized input.

**Output validation** (`OutputValidator.validate()`): Credential/PII scanning (preserves original regex flags including case-insensitive), instruction-pattern stripping, URL removal. Validated fields: `narration`, `productionAudio` (`codeBroll.filePath` exempt — structured key from repo diff, not narration; grounding guarantees repo-origin path). Applied to V2 and legacy paths via the SDK script writers. Fail-closed on error (returns `[REDACTED]`).

**Canary tokens**: Per-job 32-char random hex embedded in system prompt. If found in output → throws (fail-closed).

**Key design constraints**:
- `delimiter_escape` patterns (`</untrusted_pr_content>`, `<system>`, `<instructions>`) are NEVER suppressed — they protect the XML boundary in every context
- Whitespace normalization is skipped for `code` context to preserve diff indentation
- `matchInjectionPatterns()` finds ALL occurrences per pattern (global flag), not just the first
- `matchSensitiveData()` preserves original regex flags when adding global
- Script writers other than `claude-sdk` / `gemini-sdk` (e.g. CLI writers) have no input sanitization — output validation invoked inside the SDK writers is the last line of defense for the V2 paths that route through them
- V2 system prompts include `buildSecurityDirective(family)` in all 7 builders — instructs the model to treat injected section tags as literal text
- V2 section tags renamed to reduce collision surface: `<analysis>` → `<diff_analysis>`, `<script>` → `<pipeline_script>`

| File | Role |
|------|------|
| `src/interfaces/IPromptInjectionGuard.ts` | Port definitions (IInputSanitizer, IOutputValidator) |
| `src/domain/services/InputSanitizer.ts` | Layers 1-2: preprocess + pattern scan |
| `src/domain/services/OutputValidator.ts` | Layers 6-7: credential/PII scan + content validation |
| `src/domain/services/injection-patterns.ts` | Injection regexes + context-aware masking |
| `src/domain/services/sensitive-data-patterns.ts` | Credential + PII patterns with validators |
| `src/infrastructure/llm/script-prompt.ts` | Layer 3: XML wrapping, sandwich defense, canary |
| `src/infrastructure/llm/ClaudeScriptWriter.ts`, `GeminiSdkScriptWriter.ts` | Layer 7: SDK script writers invoke `OutputValidator` on script output before returning |

## Testing patterns

- All tests run without database, API keys, or external services
- Mock implementations in `src/mocks/` match all interfaces
- Path alias: `@/` maps to `src/` (configured in vitest and tsconfig)
- Coverage excludes `src/app/` and `src/mocks/`

## Key files for orientation

| File | What it does |
|------|-------------|
| `src/domain/services/PipelineRunner.ts` | Job orchestration + error state machine |
| `src/domain/services/VideoOrchestrator.ts` | 6-step video pipeline |
| `src/config/container.ts` | DI wiring (read this to understand how pieces connect) |
| `src/infrastructure/llm/ClaudeScriptWriter.ts` | Claude SDK script writer (structured output via `output_config` + repair loop) |
| `src/infrastructure/llm/GeminiSdkScriptWriter.ts` | Gemini SDK script writer via `@google/genai` (native structured output; runs the prompt-injection guard same as ClaudeScriptWriter) |
| `src/infrastructure/llm/genaiClient.ts` | Lazy `GoogleGenAI` singleton + `createGenAiLlmClient()` factory used by the GenAI summariser |
| `src/infrastructure/llm/BaseCliScriptWriter.ts` | CLI script writer base (Claude CLI `--json-schema`, Gemini fallback, Codex `--output-schema`) |
| `src/infrastructure/llm/CodexCliScriptWriter.ts` | Codex CLI script writer (`codex exec` with `--output-schema` + `--full-auto`) |
| `src/infrastructure/llm/promptPipelineV2Runner.ts` | V2 multi-step pipeline orchestrator (planner → judges → outline → script) |
| `src/infrastructure/llm/promptPipelineV2Repair.ts` | Script repair loop — feeds Zod errors back to LLM for correction |
| `src/infrastructure/llm/promptPipelineV2.ts` | Coverage/outline/final-writer/judge prompts (includes reviewer rubric) |
| `src/infrastructure/llm/promptPipelineV2Validators.ts` | Evidence grounding + reviewer narration validation |
| `src/infrastructure/llm/promptPipelineV2Judges.ts` | Coverage + narration quality judges (LLM-backed gates) |
| `src/infrastructure/llm/structuredOutputSchema.ts` | Zod → JSON Schema conversion + Anthropic normalization (WeakMap cached) |
| `src/infrastructure/llm/script-prompt.ts` | System/user prompts for script generation (includes visual derivation rules) |
| `src/infrastructure/llm/retryLlmCall.ts` | Cross-provider transient-error retry with exponential backoff + jitter |
| `src/domain/entities/VideoJob.ts` | Job status FSM + validation |
| `src/domain/entities/VideoScript.ts` | Scene schema, duration constraints |
| `src/infrastructure/persistence/schema.ts` | Drizzle schema |
| `src/infrastructure/video/FFmpegCompositor.ts` | Default video compositor (native ffmpeg) |
| `src/infrastructure/video/ffmpeg/filter-graph-builder.ts` | ffmpeg `filter_complex` graph construction |
| `src/lib/apiMiddleware.ts` | Auth middleware tiers (withBaseAuth, withJobsAuth, withAdminAuth) |
| `src/infrastructure/github/githubFetch.ts` | Canonical GitHub fetch wrapper (retry + transport-vs-API error wrap, method-aware default retry budget) |
| `src/lib/storage/signLocalUrl.ts` | HMAC-SHA256 signing for `/api/local-storage/*` (sign / verify / boot-time secret validator) |
| `src/lib/storage/resolveVideoUrlForJobsApi.ts` | `/api/jobs/:id` URL resolver: re-sign from `objectKey` if completed, fall back, return `signing-unavailable` for 503 |
| `src/lib/storage/normalizeStoredVideoUrl.ts` | Strips unplayable `file://` URLs from persisted job rows |
| `src/app/api/local-storage/[...key]/route.ts` | HTTP streaming route for local storage; verifies signature, supports HTTP Range |
| `src/app/api/jobs/route.ts` | Job creation; handles both JSON (5 MB) and `application/x-git-diff` (100 MB) upload branches |
| `src/app/api/jobs/[id]/retry/route.ts` | Retry a failed job |
| `src/app/api/webhook/github/route.ts` | GitHub App webhook — installation lifecycle, PR events, fire-and-forget pipeline runs |
| `src/cli/local-test.ts` | Node CLI (`npm run cli`) — also the reference implementation for the Go CLI |
| `cli-go/cmd/root.go` | Go CLI command surface; mirrors `local-test.ts` flag for flag |
| `cli-go/internal/client/client.go` | Go HTTP client; `CreateJob`, `CreateJobFromDiffBytes` (streaming), `CreateJobFromDiffFile`, `PollJob`, `RetryJob`; surfaces server `{error, message}` shape as `APIError` |
| `cli-go/internal/git/git.go` | Git plumbing for the CLI's git-source mode |
| `cli-go/install.sh` | POSIX install script for `curl … | sh` deployment |

## prvodctl Go CLI

A self-contained Go CLI that drives the prvod server's jobs API. 1:1 functional port of `src/cli/local-test.ts`.

- **Modes (mutually exclusive)**: normal (git source, streams by default), `--no-stream-diff` (legacy JSON branch, 5 MB cap, preserves real `--pr-number`), `--diff-file <path>` (local diff file, streams), `--retry-job <id>` (retry a failed job).
- **Exit codes**: 0 success, 1 generic/timeout/failed, 2 mutex/flag conflict, 3 diff file missing/empty, 4 diff file not unified, 5 `DIFF_TOO_LARGE`, 6 `DIFF_PARSE_ERROR`, 7 `DIFF_FETCH_TIMEOUT`. These map both polling-time terminal failures **and** create-time HTTP 413s.
- **Config**: YAML file (auto-discovered: `./prvodctl.yaml`, `$XDG_CONFIG_HOME/prvodctl/prvodctl.yaml`, `~/.prvodctl.yaml`) + env vars + flags. Precedence: flag > env > config > default.
- **Tests**: ~95 subtests covering arg parsing, mutex semantics, wire contracts, exit-code mapping, version flow, and end-to-end resolve→run paths.
- **Cutting a release**: see [`RELEASE.md`](RELEASE.md).

## Conventions

- TypeScript strict mode, `no-explicit-any` enforced
- Unused vars prefixed with `_` (ESLint configured)
- Zod for all external input validation (PRContext, API params)
- JSON structured logging via `src/lib/logger.ts` (debug suppressed in production)
- Next.js 15 App Router with standalone output mode; Node `>=22`
- `VIDEO_COMPOSITOR=ffmpeg` (default) uses native ffmpeg; `VIDEO_COMPOSITOR=remotion` uses React/Chromium
- Remotion, pg, webpack marked as `serverExternalPackages` (not bundled by Next.js)
- Production `Dockerfile` base is `node:bookworm-slim` (Debian + glibc — Alpine is forbidden by Remotion's chrome-headless-shell). Chrome is pre-baked via `RUN npx remotion browser ensure` in the deps stage when `VIDEO_COMPOSITOR=remotion`; the runner stage installs the Remotion-required apt libs. `RemotionCompositor` passes `chromiumOptions: { enableMultiProcessOnLinux: true }` to `selectComposition`/`renderMedia`.
- **GitHub HTTP retry**: all four github callers route through `githubFetch` (`src/infrastructure/github/githubFetch.ts`). Default `maxAttempts` is **method-aware**: GET/HEAD default to 3 attempts (exp backoff + jitter); POST/PUT/PATCH/DELETE default to 1 attempt because GitHub's mutating endpoints have no idempotency-key support — retrying a lost-response POST would create duplicate PR comments / pending reviews, retrying a successful DELETE would report failure on the next 404. Throws `GitHubApiError` (carries `status`/`body`/`method`/`url`/`retryable`) for HTTP failures and `GitHubTransportError` (carries `cause` chain) for fetch-level failures. `shouldRetryGitHubError` classifier: 429 + 5xx + transport faults retried, 4xx + abort not retried. Webhook comment-failure logs attach `describeGitHubError(err)` so operators can distinguish transport faults from API status errors.
- **Local storage signed URLs**: `STORAGE_PROVIDER=local` serves video/audio via `/api/local-storage/[...key]`. `LocalStorageService.getSignedUrl` mints HMAC-SHA256 signed paths (`?exp=<unix>&sig=<hex>`). Container boot calls `readStorageUrlSecret()` in the `case "local"` branch — fail-loudly if `STORAGE_URL_SECRET` is unset. Rotating the secret invalidates every outstanding link. `resolveForStreaming` applies `fs.realpath` + base-dir containment to defeat symlink escape. `normalizeStoredVideoUrl` strips legacy `file://` URLs from DB rows at read time so old jobs heal.
- **Pre-commit secret scan**: `.pre-commit-config.yaml` runs `gitleaks` on every commit.

## Active technologies

- TypeScript 5.x (strict mode, `no-explicit-any`) + Next.js 15 (App Router, standalone output), Drizzle ORM, Octokit, Argon2id, Zod 3.25+
- PostgreSQL + Drizzle ORM
- Anthropic SDK 0.90+ (Claude API, structured output via `output_config`), `zod-to-json-schema`, Vitest (testing)
- `@google/genai` 1.51+ (Gemini Developer API SDK — used by `gemini-sdk` script writer / summariser; native structured output via `responseJsonSchema` + `responseMimeType`)
- OpenAI Codex CLI (`codex exec` — structured output via `--output-schema` temp file, non-interactive via `--full-auto`)
- Go 1.25+ for `cli-go/`; cobra + viper; vendored deps
- FFmpeg (native) or Remotion (React + Chromium) for video composition
- Google Cloud Text-to-Speech for narration (with retiming for trailer-style themes)
- Storage backends: Cloudflare R2 / AWS S3 / local filesystem (HMAC-signed HTTP route)

## Reference

- [`README.md`](README.md) — public-facing project overview
- [`CHANGELOG.md`](CHANGELOG.md) — Keep a Changelog format; updated as part of every release
- [`RELEASE.md`](RELEASE.md) — how to cut a new Go CLI release
- [`RULES.md`](RULES.md) — mandatory documentation rules before commits
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — production deployment notes
- [`SECURITY.md`](SECURITY.md) — security policy + disclosure process
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor guide
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
