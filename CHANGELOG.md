# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Since initial public release

#### Added

- **`prvodctl` Go CLI** (`cli-go/`) — a self-contained Go client for the prvod jobs API. 1:1 functional port of `src/cli/local-test.ts` built on cobra + viper, distributed via tagged GitHub Releases for linux/darwin/{amd64,arm64} + windows/amd64. `prvodctl --version` reports the release version, commit short SHA, and build date. See [`cli-go/README.md`](cli-go/README.md).
- **`cli-go/install.sh`** — POSIX `curl … | sh` installer with OS/arch autodetection, SHA256 verification against the release's `SHA256SUMS`, gzip integrity check, and `$HOME/.local/bin` fallback when `/usr/local/bin` isn't writable. Pin a specific release with `PRVODCTL_VERSION=vX.Y.Z`.
- **GitHub Release workflow** for `prvodctl` ([`.github/workflows/release.yml`](.github/workflows/release.yml)) — tag-push (`v*`) or `workflow_dispatch`-triggered, cross-builds 5 platforms, generates `SHA256SUMS`, attaches archives to the Release with auto-generated notes. Strict semver regex gate (`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`); pre-release tags (`-rc`, `-beta`, `-alpha`, `-pre`) auto-marked. See [`RELEASE.md`](RELEASE.md) for the cut-a-release procedure.
- **`--stream-diff` flag (default on)** in the Node CLI (`src/cli/local-test.ts`) and `prvodctl`. Streams the git diff via `application/x-git-diff` (100 MB cap) so diffs larger than 5 MB no longer hit `DIFF_TOO_LARGE`. Independent of `--diff-file`, which already streamed from disk.
- **`--no-stream-diff` opt-out** (alias: `--stream-diff=false`). Routes through the legacy JSON branch. Required when `--pr-number` fidelity matters, since the streaming branch synthesizes `prNumber=1`.
- **Friendly user-facing error messages** for terminal job failures. `prvodctl` (and the Node CLI's analogous path) now surface curated explanations for known error codes (`LLM_RATE_LIMITED_EXHAUSTED`, `DIFF_TOO_LARGE`, `DIFF_PARSE_ERROR`, `DIFF_FETCH_TIMEOUT`) instead of the raw server `errorMessage`, which may contain provider stack traces or stderr dumps.
- **HMAC-signed local-storage streaming route** at `/api/local-storage/[...key]` for `STORAGE_PROVIDER=local`. URLs carry `?exp=<unix>&sig=<hex>` matching the S3 adapter's presigned-URL semantics (HMAC-SHA256, constant-time verify, expiry baked in, tamper-resistant). Replaces the previous `file://` URLs that browsers refused to load. HTTP Range support (200 / 206 / 416). Strict path-traversal + symlink-escape guards; `videos/` prefix allowlist.
- **`STORAGE_URL_SECRET` env var and boot-time guard**: the container refuses to start when `STORAGE_PROVIDER=local` without a secret. Generate with `openssl rand -hex 32`; rotation invalidates every outstanding URL.
- **`IStorageService.tryGetLocalPath(key)`** (optional method): in-process consumers (the video compositor stitching per-scene audio) bypass the HTTP route via a direct absolute path, while the streaming route stays restricted to the `videos/` prefix.
- **`StructuredOutputValidationError` + `completeJsonWithRepair`** wrapper for the LLM pipeline. Five runner call sites (`coverage_plan`, `scene_outline`, `video_script`, `batch_envelope`, `batch_scenes`) now run `repairLoop` on Zod failures instead of crashing the seven-stage video pipeline. JSON-syntax errors and structured-output failures in all three writers (BaseCliScriptWriter, GeminiSdkScriptWriter, ClaudeScriptWriter) carry an Error `cause` chain.
- **Centralised `githubFetch`** with typed errors (`GitHubApiError`, `GitHubTransportError`) and shared retry-with-backoff. Consolidates three ad-hoc fetch helpers across `AppGitHubService`, `GitHubAppTokenService`, and `GitHubFilesDiffSource`. Webhook failure logs now include `describeGitHubError()` output so operators can distinguish transport faults from API status errors.
- **Three-layer Chrome Headless Shell pre-fetch** when `VIDEO_COMPOSITOR=remotion`: postinstall script (`scripts/ensure-remotion-browser.mjs`), Docker build-time `npx remotion browser ensure` with a directory probe, and a defence-in-depth `ensureBrowser()` call in `src/instrumentation.ts` at boot. Fatal-vs-transient classification (network blips warn, `ENOSPC`/`EACCES`/missing-module fail loudly).
- **gitleaks pre-commit hook** (`.pre-commit-config.yaml`) to catch accidentally-committed secrets.

#### Changed

- **BREAKING (CLIs): streaming is now the default diff upload path.** The Node CLI and `prvodctl` upload via `application/x-git-diff` (100 MB cap) by default; the legacy JSON branch (5 MB cap) is opt-in via `--no-stream-diff` or `--stream-diff=false`. Users passing `--pr-number` without `--no-stream-diff` now exit 2 with a migration hint, since the streaming branch synthesizes `prNumber=1` server-side. To preserve the real PR number, add `--no-stream-diff`.
- **CLI exit-code contract: create-time `DIFF_TOO_LARGE` / `DIFF_PARSE_ERROR` / `DIFF_FETCH_TIMEOUT` now map to exit 5/6/7** in both CLIs (was generic exit 1). Polling-time terminal failures already mapped this way; the create-time path now matches, so CI tooling sees the same exit code regardless of whether the failure happens before or after the job is created.
- **Postgres dev port**: `docker-compose.yml` exposes Postgres on `127.0.0.1:5434` to avoid local collisions.

#### Fixed

- **CLI silent 64 MB cap on large diffs**: the local `git diff` buffer (`CLI_GIT_MAX_BUFFER_MB`) now auto-raises to 110 MB when `--stream-diff` is active (the default) so users targeting the 100 MB streaming branch don't silently hit the legacy 64 MB cap. The env var still overrides if you need to tighten or loosen it explicitly.
- **Unplayable local videos**: `LocalStorageService.getSignedUrl()` now returns the new signed HTTP URL instead of `file://`, which browsers refuse to load from any `http(s)://` origin. Legacy `file://` rows in the jobs table normalise to `null` so the watch page renders the expired-state UI instead of a broken `<video>` element.
- **macOS symlink containment**: `LocalStorageService` constructor walks symlink-bearing parent chains so `LOCAL_STORAGE_DIR=/tmp/x` on macOS (`/tmp` → `/private/tmp`) survives the realpath containment check after the first upload.
- **Transient signing failure UX**: `GET /api/jobs/:id` returns `503 SIGNING_UNAVAILABLE` when re-signing fails and no usable fallback URL exists, so the client can distinguish a transient backend problem from a missing asset instead of rendering a confusing "expired" UI.
- **Stream error handler**: mid-response I/O failures on `/api/local-storage/` (file deleted, permissions changed, disk error) now log at error rather than escalating to `uncaughtException`.

### Initial public release

Capabilities present in the initial open-source commit (`f18f38b`, 2026-05-20):

- Video generation pipeline: PR diff → script → video clips → narration → compose → upload.
- Multiple video providers: fal.ai and Runware.
- Multiple themes: talk show, sports studio, standup show, action trailer, comedy trailer.
- Script writers: Claude SDK, Claude CLI, Codex CLI, Gemini CLI, Gemini SDK — all with structured output.
- Prompt Pipeline V2: multi-step LLM pipeline (coverage planner → judge → scene outline → script writer → narration judge → evidence grounding).
- Visual prompt judge: AI quality gate for scene visuals using the Self-Refine pattern.
- Iterative LLM script repair loop for schema and grounding failures.
- Multi-layer prompt injection defense (input sanitisation, XML sandboxing, canary tokens, output validation).
- GitHub App integration with webhook-driven video generation and PR status comments.
- One-time trial API keys with atomic claim and crash recovery.
- API key authentication with Argon2id hashing and pepper.
- FFmpeg compositor (default) and Remotion compositor.
- Checkpoint system for pipeline resilience and retry from last successful step.
- Google Cloud Text-to-Speech integration with retiming for trailer themes.
- Docker support: production image and local development compose.
- CLI for local testing with script-only and retry modes.
- PostgreSQL persistence via Drizzle ORM.
- Theme capability system enforcing model/voice/lip-sync requirements.
- Comprehensive test suite (no external services required).
