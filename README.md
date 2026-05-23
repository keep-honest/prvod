# PRVOD

**Turn any GitHub pull request into a narrated video summary.**

> **Prefer not to run the infra?** Get a hosted version at [prvod.dev](https://prvod.dev). The free tier comes with 10 credits a month; paid plans add private repos, team controls, and features that build on the open-source core. [Sign up free →](https://prvod.dev)

Feed it a PR — diff, title, linked issues — and get back a 20–120 second MP4 with AI-generated visuals, syntax-highlighted code overlays, word-by-word captions, and spoken narration of what changed and why. Standard mode scales duration by PR size (20–120s); short mode (`@prvod short`) produces a focused 20–60 second summary; popcorn mode (`@prvod popcorn`) generates an extended ~5-minute mini documentary (240–320s) that covers every changed file in depth. Reviewer-style narration is opt-in through deepdive mode (`@prvod deepdive`, `@prvod <mode> deepdive`, or CLI/API deepdive flags).

The supported production trigger is the GitHub App webhook: users add `@prvod` to a PR description or comment, the server generates the video, and the app posts the result back as a bot comment. Completed jobs render a minimal video review page (`/reviews/[jobId]`) and a public share player (`/watch/[jobId]`).

## Table of Contents

- [What It Produces](#what-it-produces)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [API](#api)
- [Providers](#providers)
- [Configuration](#configuration)
- [GitHub App Webhook](#github-app-webhook)
- [Testing](#testing)
- [Security](#security)
- [Known Limitations](#known-limitations)
- [Project Structure](#project-structure)
- [One-Time Trial Keys](#one-time-trial-keys)

---

## What It Produces

Each video contains 4–16 scenes. When narration exceeds a model's maximum clip duration, the scene automatically splits into multiple sequential clips. Every scene layers three elements:

1. **AI-generated video clip** — a visual interpretation of the code change (a data pipeline flowing, a security lock engaging, an architecture diagram assembling)
2. **Code B-roll overlay** — syntax-highlighted snippets from the actual diff, rendered with [Shiki](https://shiki.matsu.io/)
3. **Word-by-word captions** — synchronized to the narration at sub-second precision

Videos are composed entirely from code snippets and code-centric presentation surfaces (code-first mode), preserving a cinematic feel through pacing, framing, focus shifts, motion, and soundtrack timing. Optional deepdive mode produces reviewer-oriented narration with indirect questions instead of neutral recaps.

An LLM writes the entire script: scene structure, narration text, visual prompts, and which code to highlight. The pipeline executes the script mechanically — no human intervention between PR and finished video.

---

## How It Works

```
PR diff + metadata
     │
     ▼
 1. Parse diff           — score files by importance, classify change type
 2. Write script (LLM)   — 4–16 scenes via Claude or Gemini, validated by Zod
 2b. Judge visual prompts — LLM evaluates each scene's visuals against 7 quality
                            rules, rewrites failures (optional, graceful degradation)
 3. Build code-first scenes — Remotion compositions from code snippets
 4. Synthesize speech      — Google TTS or model-native voice
 5. Compose final video    — FFmpeg (default) or Remotion renders code + captions at 1080p/30fps
 5. Upload & deliver      — signed URL returned to the caller
```

The visual prompt judge (step 2b) uses the [Self-Refine](https://arxiv.org/abs/2303.17651) pattern: a single LLM call evaluates all scenes against quality rules. Only failing scenes receive revised prompts — passing scenes emit minimal JSON to stay within output token limits.

Checkpoints are saved after script generation. Retry resumes from the latest checkpoint instead of rerunning the entire pipeline.

---

## Architecture

The codebase follows a 4-layer dependency inversion pattern. Dependencies point inward only — Layer 2 never imports Layer 3, Layer 3 never imports Layer 4.

```
Layer 1: src/interfaces/          Port definitions (IScriptWriter, ITTSService, IVideoCompositor, ...)
Layer 2: src/domain/              Business logic, entities, services (PipelineRunner, VideoOrchestrator)
Layer 3: src/infrastructure/      Implementations (Postgres, R2, Google TTS, FFmpeg, Remotion, Claude, Gemini)
Layer 4: src/app/api/             Next.js route handlers, CLI entrypoints
```

**DI container** (`src/config/container.ts`): Lazy singleton, environment-driven wiring. Setting `NODE_ENV=test` or `USE_MOCK_SERVICES=true` swaps every binding for an in-memory mock — the full pipeline runs without a database, LLM, or storage backend.

**Job processing**: HTTP handlers return a job ID immediately, `PipelineRunner` runs async. Callers poll for completion. One active job per (installation, repo, PR) is enforced atomically at the DB layer.

**Checkpoint resume**: After expensive steps (script generation, scene compositing), `PipelineRunner` writes a `PipelineCheckpoint`. Failed jobs can be retried via `POST /api/jobs/:id/retry` and resume from the last checkpoint instead of re-running the pipeline.

**Prompt injection guard**: A 7-layer defense-in-depth pipeline protects all LLM prompts from malicious PR content (input sanitization, XML sandboxing, canary tokens, output validation). See `src/domain/services/InputSanitizer.ts` and `src/domain/services/OutputValidator.ts`.

---

## Quick Start

**Prerequisites:** Node.js 22+, PostgreSQL 16+, FFmpeg on PATH.

<details>
<summary><b>Docker Compose</b> — everything in containers, minimal setup</summary>

```bash
cd pr-to-video

# 1. Start Postgres (host port 5433 → container 5432)
docker compose up db -d

# 2. Apply the schema
DATABASE_URL=postgresql://dev:dev@localhost:5433/pr_to_video npm run db:push

# 3. Start the app (uses Dockerfile.local — bundles Claude CLI + FFmpeg)
docker compose up app
# → http://localhost:3000
```

`docker-compose.yml` ships sensible defaults: `SCRIPT_WRITER=claude-cli` (mounts your host `~/.claude` for auth), `USE_BUILTIN_TTS=true` (no Google Cloud key needed), and `USE_LOCAL_STORAGE=true` (outputs at `./output/` on the host). Override any of these by exporting the env var before `docker compose up app`.

</details>

<details>
<summary><b>Bare metal</b> — run directly with Node.js</summary>

```bash
# Install FFmpeg
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian/Ubuntu

cd pr-to-video
npm ci
npm run build

# Set up database
DATABASE_URL=<your-postgres-url> npm run db:push

# Configure
cp .env.example .env
# Edit .env with your provider keys

# Start
npm run start
# → http://localhost:3000
```

</details>

<details>
<summary><b>Script only</b> — no video generation, no TTS</summary>

Generates the JSON script (scene structure, narration, visual prompts) without producing a video. Useful for testing the LLM pipeline or feeding into a custom renderer.

```bash
npm run cli -- \
  --server-url http://localhost:3000 \
  --api-key your-secret \
  --script-only
```

</details>

---

## CLI

The CLI reads your local git diff, posts it to the server, and polls until the job finishes.

```bash
# Full video from the last commit
npm run cli -- --server-url http://localhost:3000 --api-key <key>

# Script only (skip video generation)
npm run cli -- --server-url http://localhost:3000 --api-key <key> --script-only

# Short video (20–60 seconds instead of full-length)
npm run cli -- --server-url http://localhost:3000 --api-key <key> --short-dur

# Popcorn mode (~5 minutes, extended-depth mini documentary)
npm run cli -- --server-url http://localhost:3000 --api-key <key> --popcorn

# Reviewer-style deepdive walkthrough
npm run cli -- --server-url http://localhost:3000 --api-key <key> --deepdive

# Reviewer-style script-only deepdive
npm run cli -- --server-url http://localhost:3000 --api-key <key> --script-only --deepdive

# TTS only (generate script + synthesize audio, skip video)
npm run cli -- --server-url http://localhost:3000 --api-key <key> --tts-only

# Use uncommitted changes instead of HEAD~1..HEAD
npm run cli -- --server-url http://localhost:3000 --api-key <key> --uncommitted

# Retry a previously failed job
npm run cli -- --server-url http://localhost:3000 --api-key <key> --retry-job <uuid>
```

Set `SERVER_URL` and `API_SECRET_KEY` as environment variables to skip repeating the flags.

---

## API

These routes are for local debugging and manual testing only. They return `404` when `NODE_ENV=production`; production usage is expected to flow through the GitHub App webhook instead.

All endpoints require `Authorization: Bearer <api-key>` (a DB-backed key from `scripts/create-admin-api-key.ts` or the legacy `API_SECRET_KEY`).

### `POST /api/jobs`

Create a video generation job. Returns immediately; poll `GET /api/jobs/:id` for status. Idempotent — if an active job exists for the same repo + PR number, it returns the existing job.

**Rate limit:** 50 jobs per repo per 24 hours.

<details>
<summary>Request body</summary>

```typescript
{
  repoFullName: string;      // "owner/repo"
  prNumber: number;
  prTitle: string;           // max 500 chars
  prDescription?: string;
  diff: string;              // unified diff, max 5MB
  baseBranch: string;
  headBranch: string;
  issues?: Array<{ number: number; title: string; body: string }>;
  milestone?: { title: string; description: string } | null;
  isPrivate: boolean;
  durationMode?: "default" | "short" | "popcorn"; // "short" = 20–60s, "popcorn" = ~5 min extended
  deepdive?: boolean;       // opt-in reviewer-style narration
  scriptOnly?: boolean;      // true = return script JSON, skip video
  ttsOnly?: boolean;         // true = return script + synthesized audio, skip video
}
```

</details>

<details>
<summary>Response (201 created / 200 existing)</summary>

```typescript
{
  id: string;                // UUID
  repoFullName: string;
  prNumber: number;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  videoUrl: string | null;
  scriptJson: VideoScript | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;         // ISO 8601
  completedAt: string | null;
}
```

</details>

### `GET /api/jobs/:id`

Poll job status by UUID. Completed jobs always return a freshly signed URL.

### Review Pages

Completed video jobs can be viewed at `/reviews/:jobId`, a server-rendered page that plays the walkthrough video and lists the scenes with jump-to-timestamp links. The page is open-access — no authentication. For a public share player at `/watch/[jobId]`, links are HMAC-signed with `SHARE_SIGNING_SECRET` so tampered or expired links return a generic "Link Expired" page.

### `POST /api/jobs/:id/retry`

Resume a failed job from its last checkpoint. Returns `400` if no checkpoint exists or the job isn't in `failed` status. Admin-only.

### One-Time Trial Keys

Create single-use API keys for potential clients to try the service once. The key works for one successful full video generation, then self-destructs. Failed jobs preserve the key for retry.

**Admin endpoints** (require admin API key):

| Endpoint | Description |
|---|---|
| `POST /api/admin/keys/one-time` | Create a one-time key. Pass optional `{"label": "..."}`. Returns the full key once — store it securely. |
| `GET /api/admin/keys/one-time` | List all one-time keys with status, usage count, and timestamps. |
| `DELETE /api/admin/keys/one-time/:keyId` | Revoke a key. Idempotent — revoking consumed keys succeeds silently. |

**Trial user flow:**

1. Admin creates a key and shares it with the trial user
2. Trial user calls `POST /api/jobs` with `Authorization: Bearer <one-time-key>` — same as a regular key
3. Trial user polls `GET /api/jobs/:id` until the video is ready (works even after the key is consumed)
4. After one successful full video generation, the key is permanently consumed

**Key states:** `active` → `in_use` (during job) → `consumed` (success) or back to `active` (failure/preview). Admin can `revoke` at any time.

**Error codes for trial users:**

| Status | Code | Meaning |
|---|---|---|
| 403 | `KEY_CONSUMED` | Key was already used for a successful video |
| 403 | `KEY_REVOKED` | Key was revoked by admin |
| 429 | `KEY_IN_USE` | A job is already running with this key |

See [specs/001-one-time-api-key/contracts/admin-one-time-keys.md](specs/001-one-time-api-key/contracts/admin-one-time-keys.md) for full API contract details.

## Providers

Every external dependency is swappable via environment variables. Mix and match based on what API keys you have and what trade-offs you want.

| Component | Options | Toggle |
|-----------|---------|--------|
| Script writer | Anthropic SDK, Claude CLI, Google GenAI SDK, Gemini CLI, Codex CLI, Mock | `SCRIPT_WRITER` |
| TTS | Google Cloud TTS or Mock external TTS | `TTS_PROVIDER`, `USE_BUILTIN_TTS` |
| Storage | Cloudflare R2, AWS S3, Local filesystem | `STORAGE_PROVIDER` |

**Common configurations:**

| Setup | LLM | TTS | Storage |
|-------|-----|-----|---------|
| Full cloud | Anthropic SDK | Google TTS | R2 / S3 |
| Local dev | Claude CLI | Built-in | Local |
| Script only | Claude CLI | Built-in | Local |
| Pure local mock | Mock | Mock | Local |

---

## Configuration

Copy `.env.example` for a documented starting point:

```bash
cp .env.example .env
```

<details>
<summary><b>Server</b></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP listen port |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `LOG_LEVEL` | No | `info` (prod) / `debug` (dev) | Log verbosity: `debug` \| `info` \| `warn` \| `error`. Invalid values fall back to default with a warning. |

</details>

<details>
<summary><b>LLM (script writer)</b></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `SCRIPT_WRITER` | No | `claude-sdk` | `claude-sdk` \| `claude-cli` \| `gemini-sdk` \| `gemini-cli` \| `codex-cli` \| `mock` |
| `ANTHROPIC_API_KEY` | When `claude-sdk` | — | Anthropic API key |
| `GEMINI_API_KEY` | When `gemini-sdk` | — | Google AI Studio key (the `@google/genai` SDK also accepts `GOOGLE_API_KEY`) |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-20250514` | Claude model override |
| `GEMINI_MODEL` | No | `gemini-2.5-pro` | Gemini model override (shared by `gemini-sdk` and `gemini-cli`) |
| `GEMINI_SCRIPT_MAX_TOKENS` | No | `32768` | Max output tokens for `gemini-sdk` script generation. Larger than the Anthropic equivalent because Gemini 2.5 Pro's mandatory thinking budget counts against this. |
| `GEMINI_RETIME_MAX_TOKENS` | No | `16384` | Max output tokens for `gemini-sdk` narration retime |
| `GEMINI_SUMMARISER_MAX_TOKENS` | No | `4096` | Max output tokens for the `gemini-sdk` oversized-file summariser. Higher than the GenAI client's 1024 default. The summariser path also sets `thinkingBudget: 0` in code so the full budget is available for the actual summary instead of being eaten by Gemini 2.5's mandatory thinking budget. |
| `CODEX_MODEL` | No | `o4-mini` | Codex model override |
| `CODEX_REASONING_EFFORT` | No | `medium` | Reasoning effort (`low`, `medium`, `high`) |
| `SCRIPT_REPAIR_MAX_ATTEMPTS` | No | `2` | Max LLM repair attempts per repair loop (scene outline, schema validation, word budget, evidence grounding). Set to `0` to disable all repair. |
| `SCRIPT_DURATION_GUARD_COEFFICIENT` | No | `1.4` | Multiplier for post-generation duration guards. Prompts still ask for the mode target; retry/fail only starts after target x coefficient. |

</details>

<details>
<summary><b>TTS</b></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `TTS_PROVIDER` | No | `google` | `google` \| `mock` for the external-TTS path |
| `USE_BUILTIN_TTS` | No | `false` | `true` = use model-native TTS when available |
| `GOOGLE_CLOUD_TTS_KEY` | When USE_BUILTIN_TTS is false | — | Google Cloud TTS API key |
| `GOOGLE_TTS_VOICE` | No | `en-US-Chirp3-HD-Algenib` | Global TTS voice override. Valid families: Neural2, WaveNet, Studio, Chirp HD, Chirp3 HD (Journey is retired). |
| `TTS_SPEED_MULTIPLIER` | No | `1.0` | Scales the computed speaking rate. `1.2` = 20% faster, `0.8` = 20% slower. Must be positive. |
| `GOOGLE_TTS_TIMEOUT_MS` | No | `45000` | Per-attempt Google TTS API timeout. Prevents the Google client default 300s wait from blocking scene synthesis. |
| `GOOGLE_TTS_MAX_ATTEMPTS` | No | `3` | Max attempts per scene TTS call for transient provider/network errors. Set to `1` to disable retries. |
| `GOOGLE_TTS_RETRY_BASE_DELAY_MS` | No | `1000` | Base delay for TTS retry backoff. |
| `GOOGLE_TTS_RETRY_MAX_DELAY_MS` | No | `10000` | Max individual TTS retry backoff delay. |

See [`docs/operations/google-tts-timeouts.md`](docs/operations/google-tts-timeouts.md) for timeout failure modes, retry policy, expected logs, and troubleshooting.

</details>

<details>
<summary><b>Storage</b></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `STORAGE_PROVIDER` | No | `r2` | `r2` \| `s3` \| `local` |
| `USE_LOCAL_STORAGE` | Deprecated | `false` | Backward-compatible shorthand for `STORAGE_PROVIDER=local` |
| `LOCAL_STORAGE_DIR` | No | `.local-storage` | Override local storage path |
| `R2_ACCOUNT_ID` | When `r2` | — | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | When `r2` | — | R2 access key |
| `R2_SECRET_ACCESS_KEY` | When `r2` | — | R2 secret key |
| `R2_BUCKET_NAME` | When `r2` | — | Bucket name |
| `R2_PUBLIC_URL` | When `r2` | — | Public base URL for the bucket |
| `AWS_ACCESS_KEY_ID` | When `s3` | — | AWS/S3 access key ID |
| `AWS_SECRET_ACCESS_KEY` | When `s3` | — | AWS/S3 secret access key |
| `AWS_REGION` | When `s3` | — | AWS/S3 region |
| `AWS_S3_BUCKET_NAME` | When `s3` | — | AWS/S3 bucket name |
| `AWS_S3_ENDPOINT` | When `s3` | — | Optional endpoint for S3-compatible providers |

</details>

<details>
<summary><b>Other</b></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `SIGNED_URL_EXPIRY_HOURS` | No | `4` | Hours before signed video URLs expire |
| `CAPTION_OFFSET_MS` | No | `0` | Shift captions by N milliseconds. Positive = delay captions, negative = advance. |
| `REMOTION_RENDERER_PORT` | No | `3300` | Fixed internal Remotion renderer server port when `VIDEO_COMPOSITOR=remotion`. Avoids the default 3000-3100 scan colliding with Next/Render ports. |
| `REMOTION_RENDER_TIMEOUT_MS` | No | `600000` | Hard deadline for a single render section (bundle + selectComposition + renderMedia). A wedged browser rejects with `RemotionRenderTimeoutError` and releases `withRemotionRendererLock` so the queue drains. |

</details>

<details>
<summary><b>GitHub App (Recommended)</b></summary>

Required when using the [GitHub App webhook trigger](#github-app-webhook). Comments are posted by `prvod[bot]` (your app's identity). Multi-tenant: one server installation handles all repositories.

| Variable | Required | Description |
|---|---|---|
| `GITHUB_APP_ID` | Yes | Numeric App ID — found on your app's settings page under "App ID". |
| `GITHUB_APP_PRIVATE_KEY` | Yes | RSA private key PEM with literal `\n` between lines. Generate: `openssl genrsa 2048 | tr '\n' '\\n'`. |
| `GITHUB_APP_SLUG` | Yes | Your app's slug (e.g. `prvod`). Prevents the bot from triggering itself in comment loops. |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes | Secret used to validate `X-Hub-Signature-256` on App webhooks. Generate: `openssl rand -hex 32`. |
| `APP_ENCRYPTION_KEY` | Yes | 32-byte hex pepper for Argon2id API key hashing. Generate: `openssl rand -hex 32`. Changing this invalidates all existing keys. |

</details>

<details>
<summary><b>Local/Admin API Security</b></summary>

Only needed if you use the local/debug `/api/jobs` endpoints outside production.

| Variable | Required | Description |
|---|---|---|
| `APP_ENCRYPTION_KEY` | Recommended | 32-byte hex pepper for Argon2id API key hashing. Generate: `openssl rand -hex 32`. |
| `API_SECRET_KEY` | Optional | Deprecated legacy single-key auth for local/manual calls to `/api/jobs`. |

</details>


<details>
<summary><b>Feature Flags</b></summary>

| Variable | Default | Description |
|---|---|---|
| `PROMPT_PIPELINE_V2` | `false` | Enable multi-step V2 prompt pipeline (coverage plan → scene outline → judges → script) |
| `MODEL_PROMPT_ADAPTERS_V1` | `false` | Enable model-specific prompt adapters (structured promptSegments, negativePrompt, nativeAudioDirective) |
| `PROMPT_PIPELINE_V2_COMPARE_V1` | `false` | Run both V1 and V2 pipelines side-by-side and log a metrics comparison |
| `BATCH_SCENE_GENERATION` | `false` | Generate the final script in small sequential batches (2-3 scenes each) instead of one monolithic call. Reduces context pressure for weaker models on large PRs. |
| `GROUNDING_FAILURE_WARN` | `false` | Treat evidence grounding validation failures as warnings instead of fatal errors. Useful for models (e.g. Gemini Flash) that struggle with cross-reference constraints. |
| `POST_GROUNDING` | `false` | Re-run narration judge after a successful grounding repair to restore narrative quality. Adds 1-3 extra LLM calls when grounding repair fires. |
| `REVIEWER_VIOLATION_WARN` | `false` | Treat deepdive reviewer narration validation failures (verdict language, client-facing tone) as warnings instead of fatal errors. Ignored in standard mode. |
| `SKIP_JUDGE` | `false` | Bypass all AI judges (visual prompt judge, V2 coverage judge, V2 narration quality judge). Deterministic validators still run. Useful for local iteration and cost-sensitive environments. |
| `LLM_MAX_RETRIES` | `5` | Max retry attempts per LLM call on transient errors (429, `RESOURCE_EXHAUSTED`, overload, 5xx, network). Each call — not the pipeline — is retried with exponential backoff. When exhausted, the pipeline fails with `LLM_RATE_LIMITED_EXHAUSTED` and posts a dedicated PR comment. Set to `1` to disable. |
| `LLM_RETRY_BASE_DELAY_MS` | `1000` | Base delay (ms) for the first backoff between LLM retries. Each subsequent attempt doubles, capped at 30s, with jitter. |
| `CLAUDE_SUMMARISER_MODEL` | `claude-haiku-4-5-20251001` | Anthropic model used by the oversized-file rolling summariser. Change to a larger model for higher-fidelity summaries of large files at higher token cost. |
| `CLI_GIT_MAX_BUFFER_MB` | `64` | Max buffer (MB) for `git diff` commands in the local CLI (`--uncommitted`, `--diff-file`). Increase if your monorepo generates diffs larger than 64 MB. |

</details>

---

## GitHub App Webhook

The supported production trigger: install a GitHub App on your organization or repositories. Comments are posted by `your-app[bot]` — a clean bot identity rather than a personal account. A single server handles all your repositories as one multi-tenant installation.

### How it works

1. A user writes `@prvod` in a PR description or comment
2. GitHub delivers a webhook event to your server
3. The server verifies the `X-Hub-Signature-256` header
4. It exchanges a JWT for an installation-scoped token and fetches the PR diff + metadata
5. It creates a video job and immediately posts an acknowledgement comment on the PR (e.g. "Generating a video walkthrough of this PR — hang tight, it'll be ready in a few minutes")
6. The pipeline runs in the background (fire-and-forget)
7. When the video is ready, it posts a second comment as `prvod[bot]` with the signed URL

### Create the GitHub App

1. Go to **github.com/settings/apps/new** (personal account) or **github.com/organizations/YOUR-ORG/settings/apps/new** (organization app).

2. Fill in the registration form:
   - **App name**: `prvod` (or any name — your users will see `<name>[bot]`)
   - **Homepage URL**: your server URL (required but not used)
   - **Webhook URL**: `https://your-server.com/api/webhook/github`
   - **Webhook secret**: generate with `openssl rand -hex 32` and paste here
   - **Permissions** (under _Repository permissions_):
     | Permission | Level |
     |---|---|
     | Contents | Read-only |
     | Pull requests | Read & Write |
     | Issues | Read & Write |
     | Metadata | Read-only (auto-selected) |
   - **Subscribe to events**: `Pull request`, `Issue comment`, `Installation`, `Installation repositories`
   - **Where can this GitHub App be installed?**: _Any account_ (for multi-tenant use) or _Only on this account_ (self-hosted)

3. Click **Create GitHub App**.

4. On the app settings page:
   - Note the **App ID** (a number like `1234567`)
   - Note the **App slug** (shown in the URL: `github.com/apps/<slug>`)
   - Under _Private keys_, click **Generate a private key** — a `.pem` file downloads
   - Convert the PEM for use as an env var (no literal newlines):
     ```bash
     cat your-app.pem | tr '\n' '\\n'
     ```

### Configure your server

Set these environment variables (add them to your `.env` or deployment secrets):

```bash
# GitHub App identity
GITHUB_APP_ID=1234567               # the numeric App ID
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n
GITHUB_APP_SLUG=prvod               # the slug shown in github.com/apps/<slug>
GITHUB_APP_WEBHOOK_SECRET=<secret>  # the secret you entered in the App settings

# API key security (Argon2id pepper)
APP_ENCRYPTION_KEY=<openssl rand -hex 32>
```

The server expects GitHub App credentials in production and verifies every webhook against `GITHUB_APP_WEBHOOK_SECRET`.

### Run the database migration

The GitHub App feature requires new tables. Apply the migration before starting the server:

```bash
DATABASE_URL=<your-postgres-url> npm run db:push
```

### Local/admin API keys

The annotation-triggered production flow does not use API keys. If you want to exercise the `/api/jobs` routes or create one-time trial keys, first create an admin API key:

```bash
APP_ENCRYPTION_KEY=<pepper> DATABASE_URL=<url> npx tsx scripts/create-admin-api-key.ts "local-admin"
```

Then use that admin key to create one-time trial keys via `POST /api/admin/keys/one-time` (see [One-Time Trial Keys](#one-time-trial-keys)).

### Install the app

After creating the app, install it on the repositories you want it to monitor:
1. Go to `github.com/apps/<your-slug>`
2. Click **Install** → choose your org or personal account
3. Select _All repositories_ or pick specific ones
4. Confirm the installation

The server receives an `installation.created` webhook and records the installation in its database automatically.

### Annotation syntax

| Comment or PR description | What happens |
|---|---|
| `@prvod` | Full video generated (20–120s). Standard narration mode. Once per PR — subsequent annotations on the same PR are ignored. |
| `@prvod short` | Short video (20–60s). Standard narration mode. Allowed even if a standard video already exists for the same PR. |
| `@prvod popcorn` | Extended-depth mini documentary (~5 minutes, 240–320s). Standard narration mode. Covers every changed file — significant changes get 2–3 dedicated scenes, minor changes are grouped. Follows a three-act story arc. Mutually exclusive with `short`. |
| `@prvod deepdive` | Reviewer-style narration. Opt-in only. Can be combined with `short`, `popcorn`, or `script` in either order. |
| `@prvod script` | Script-only mode: generates the video script JSON, skips TTS/clips/composition. Allowed multiple times per PR. |
| `@prvod script deepdive` | Script-only output with reviewer-style deepdive narration. `script` still overrides duration modifiers. |

```
# In a PR description or comment:
Reviewed the auth changes. Ready to merge!

@prvod
```

```
# Or for a shorter video:
@prvod short
```

```
# Or opt into reviewer-style narration:
@prvod deepdive
```

```
# Combine a mode with reviewer-style narration:
@prvod short deepdive
```

```
# Or request a script-only reviewer deepdive:
@prvod script deepdive
```

```
# Or for an extended deep-dive:
@prvod popcorn
```

```
# Or for a quick script preview:
@prvod script
```

The server immediately posts an acknowledgement comment so PR participants know the request was received. After generation completes, it posts a second comment with the video URL or an error message. If the repo has hit its daily video limit (50/day), a rate-limit comment is posted instead.

### Popcorn mode (extended-depth videos)

Popcorn mode produces a ~5-minute mini documentary (240–320 seconds) instead of the standard 20–120 second summary. It's designed for large or significant PRs where a quick overview isn't enough.

**How it differs from standard mode:**

| Aspect | Standard (20–120s) | Popcorn (240–320s) |
|---|---|---|
| File coverage | Top 1–2 changes in depth, rest summarized | Every changed file mentioned or grouped |
| Scene count | 4–16 scenes | Up to the model's max scene limit |
| Diff context | Up to 15 file summaries, 10 diffs (3KB each) | Up to 80 file summaries, 40 diffs (4KB each) |
| Script structure | Linear walkthrough | Three-act story arc |
| Significant changes | 1 scene each | 2–3 scenes each (mechanism, implications, tests) |
| Minor changes | Often omitted | Grouped into a summary scene |
| Minimum duration | None enforced | 240s — the script writer retries once if the first attempt is shorter |

**Story arc:** Popcorn scripts follow a narrative structure — Act 1 (discovery/context), Act 2 (technical deep dive with escalating complexity), Act 3 (resolution/validation).

**Triggering popcorn mode:**

- GitHub App: `@prvod popcorn` in a PR description or comment
- CLI: `--popcorn` flag
- API: `durationMode: "popcorn"` in the request body

`--popcorn` and `--short-dur` are mutually exclusive — the CLI exits with an error if both are passed. On the webhook side, `@prvod popcorn` takes precedence over `@prvod short` if both somehow appear in the same body.

**Triggering deepdive mode:**

- GitHub App: `@prvod deepdive`, `@prvod short deepdive`, `@prvod popcorn deepdive`, or `@prvod script deepdive`
- CLI: `--deepdive` flag
- API: `deepdive: true` in the request body

Deepdive is opt-in. Standard mode remains the default for plain `@prvod`, `@prvod short`, `@prvod popcorn`, and API/CLI requests without `deepdive`.

### Local development with the GitHub App

You need a public URL for GitHub to deliver webhooks to your local machine. Use a proxy:

```bash
# Option 1: smee.io (free, no signup)
npx smee-client --url https://smee.io/your-channel-id --target http://localhost:3000/api/webhook/github

# Option 2: ngrok (requires account for static domain)
ngrok http 3000
```

Set the **Webhook URL** in your app's settings to the proxy URL, then run your local server normally. GitHub delivers events to the proxy, which forwards them to localhost.

> **Tip:** Create a separate GitHub App for development (e.g. `prvod-dev`) so you can point it at your local machine without affecting production. Use different `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_SLUG` values.

---

## Testing

```bash
npm test              # all 1400+ tests
npm run test:unit     # unit tests only
npm run test:int      # integration tests
npm run test:watch    # re-run on file changes
```

All tests run against mock implementations in `src/mocks/` — no external services, API keys, or database required.

<details>
<summary>What's covered</summary>

| Area | Tests |
|------|-------|
| Pipeline orchestration | Full pipeline variants with mocks, including clip-authoritative external-TTS retiming and multi-clip scene support |
| Job lifecycle | Status transitions, error handling, retry from checkpoint |
| Schema validation | Zod validation for PRContext and VideoScript |
| Diff analysis | Parsing, file scoring, change type classification |
| Script writers | Anthropic SDK, Claude CLI, Gemini CLI, and Codex CLI variants |
| Visual prompt judge | All-pass, partial-fail, all-fail, LLM errors, invalid JSON, markdown fences, compact output, string "false" parsing, graceful degradation |
| Persistence | Checkpoint save/load/delete, local storage upload/URL |
| One-time keys | Auth status gates, key consume/release lifecycle, PipelineRunner integration |
| Integration | Full job lifecycle, idempotency, rate limit enforcement |
| Prompt injection guard | 694 tests: pattern detection, false-positive prevention (25 fixture corpus), red-team attacks (74 OWASP LLM01 scenarios), performance benchmarks, audit logging |

</details>

---

## Security

PR content (titles, descriptions, diffs, linked issues, milestone text, branch names) is untrusted user input that flows into LLM prompts and downstream video/TTS API calls. A 7-layer defense-in-depth pipeline prevents prompt injection attacks from manipulating generated output.

### Defense layers

| Layer | What | Where |
|-------|------|-------|
| 1 | **Input preprocessing** — Unicode normalization, zero-width char stripping, control char removal | `InputSanitizer` |
| 2 | **Pattern scanning** — 17 injection regex patterns with context-aware masking to reduce false positives | `InputSanitizer` + `injection-patterns.ts` |
| 3 | **Structural prompt architecture** — XML boundary wrapping, sandwich defense, explicit framing | `script-prompt.ts` |
| 4 | **Canary token** — per-job random hex embedded in system prompt; detection aborts the job (fail-closed) | `ClaudeScriptWriter` |
| 5 | **Schema validation** — Zod constrains Claude's output to the VideoScript structure | Existing |
| 6 | **Output scanning** — credential/PII detection with `[REDACTED]` replacement | `OutputValidator` |
| 7 | **Content validation** — strips instruction-like patterns and URLs before video/TTS prompts | `OutputValidator` + `buildGroundedClipPrompt` |

### Key properties

- **Fail-closed on error**: If the sanitizer or validator crashes, content is rejected (empty or `[REDACTED]`), never passed through unsanitized.
- **No extra LLM calls**: All detection is local regex/heuristic processing. Adds <10ms for typical PR content.
- **Context-aware**: Code diffs preserve indentation and suppress encoding-evasion false positives. Delimiter-escape patterns (XML boundary tags) are never suppressed in any context.
- **All interpolated content sanitized**: PR fields, diff hunks, filenames (with dedup), branch names, and all LLM output fields (`narration`, `aiVisualPrompt`, `codeBroll.filePath`, `productionAudio`).

### Limitations

- Non-English injection patterns are not detected (English-only regexes)
- `claude-cli`, `gemini-cli`, and `codex-cli` script writers bypass input sanitization; only output validation in `buildGroundedClipPrompt` protects them
- Performance degrades on inputs >500KB due to `maskSafeRegions()` complexity

For implementation details, see [FOR_DEVELOPER.md](FOR_DEVELOPER.md) and `specs/001-prompt-injection-guard/plan.md`.

---

## Known Limitations

**Remotion bundling takes 20–40 seconds on first render** (only when `VIDEO_COMPOSITOR=remotion`). The default FFmpeg compositor has no cold start. If using Remotion, the webpack bundle is cached in memory and the renderer uses `REMOTION_RENDERER_PORT` (`3300` by default) instead of scanning the usual 3000-3100 range. The ~110 MB Chrome Headless Shell binary is pre-fetched in three layers so it never blocks the first render: (1) the `postinstall` script runs `ensureBrowser()` when `VIDEO_COMPOSITOR=remotion` was set in the shell during `npm ci`; (2) the Docker image additionally bakes the binary at build time via `npx remotion browser ensure` and validates the artifact with a directory probe; (3) the Next.js `instrumentation.ts` hook re-runs `ensureBrowser()` at server boot as defence-in-depth (covers volume-mounted `node_modules`, or `.env`-only `VIDEO_COMPOSITOR` configurations where the postinstall did not fire). Alpine variants are forbidden by Remotion because chrome-headless-shell is linked against glibc.

**No job queue.** Jobs run as fire-and-forget promises in the Next.js process. For production scale, swap `PipelineRunner.run()` for a worker queue (BullMQ, Trigger.dev) that runs outside the HTTP process.

**Checkpoints are local filesystem.** In multi-instance deployments, retry requests must hit the same instance that wrote the checkpoint. Replace `LocalCheckpointStore` with a database-backed implementation for horizontal scaling.

**Signed URLs expire.** Default 4 hours. `GET /api/jobs/:id` always regenerates a fresh URL, but links shared directly with users will stop working after expiry.

---

<details>
<summary><b>Project Structure</b></summary>

```
pr-to-video/
├── src/
│   ├── app/api/admin/keys/       # Admin key management (one-time trial keys)
│   ├── app/api/jobs/             # Next.js route handlers (POST, GET, retry)
│   ├── app/api/webhook/github/  # GitHub App webhook handler (acknowledgement + pipeline dispatch)
│   ├── config/container.ts       # DI container: reads env vars, wires services
│   ├── domain/
│   │   ├── entities/             # PRContext, VideoJob, VideoScript (Zod schemas)
│   │   └── services/             # VideoOrchestrator, PipelineRunner
│   ├── infrastructure/
│   │   ├── diff/                 # HeuristicDiffAnalyzer
│   │   ├── llm/                  # ClaudeScriptWriter, CLI variants, prompt builders, visual prompt judge
│   │   ├── persistence/          # PostgresJobRepository, LocalCheckpointStore
│   │   ├── storage/              # R2StorageService, LocalStorageService
│   │   ├── tts/                  # GoogleTTSService
│   │   └── video/
│   │       ├── remotion/         # React compositions (clips, captions, code overlay)
│   │       ├── ffmpeg/            # FFmpeg compositor modules (captions, overlays, filter graph)
│   │       ├── FFmpegCompositor.ts
│   │       └── RemotionCompositor.ts
│   ├── interfaces/               # TypeScript interfaces (ports)
│   └── mocks/                    # Test doubles for all interfaces
├── tests/
│   ├── unit/                     # Per-module unit tests
│   └── integration/              # Full pipeline end-to-end
├── .env.example                  # All env vars, documented inline
├── docker-compose.yml            # Local PostgreSQL
├── Dockerfile                    # Production (Debian Bookworm slim + pre-baked Chrome for Remotion)
├── Dockerfile.local              # Dev (includes Claude CLI, git)
└── vitest.config.ts
```

</details>

---

## Tech Stack

| Library | Role |
|---|---|
| Next.js 15 | HTTP server (App Router route handlers) |
| `@anthropic-ai/sdk` | Claude API for script generation (structured output via `output_config.format`) |
| `@google-cloud/text-to-speech` | Neural TTS with SSML word-timing marks |
| FFmpeg (native) | Default video composition at 1080p / 30fps via filter graphs |
| Remotion / `@remotion/renderer` | Alternative video composition via React/Chromium (optional) |
| Sharp | Code overlay PNG rendering from SVG |
| `drizzle-orm` + `pg` | PostgreSQL job tracking |
| `@aws-sdk/client-s3` | Cloudflare R2 storage (S3-compatible) |
| Zod + `zod-to-json-schema` | Runtime schema validation + LLM structured output schema generation |
| Shiki | Syntax highlighting for code B-roll overlays |
| Vitest | Unit and integration test runner |

---

## Further Reading

- **[DEPLOYMENT.md](DEPLOYMENT.md)** — Production deployment guides for Docker, Vercel, Render, Railway, and Fly.io. Includes provider configuration recipes and troubleshooting.
- **[.env.example](.env.example)** — Every environment variable with inline documentation.
