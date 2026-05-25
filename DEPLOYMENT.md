# Deployment Guide

pr-to-video is a Next.js application that generates 60-second video summaries of GitHub pull requests. It uses a hexagonal architecture where every external dependency (LLM, TTS, video generation, storage) is swappable via environment variables. This means the same codebase supports everything from a fully-local laptop setup to a production cloud deployment.

This document covers every deployment option.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Environment Variables Reference](#environment-variables-reference)
- [Deployment Option 1: Docker Compose (Local)](#deployment-option-1-docker-compose-local)
- [Deployment Option 2: Docker (Production)](#deployment-option-2-docker-production)
- [Deployment Option 3: Bare Metal / Direct Node.js](#deployment-option-3-bare-metal--direct-nodejs)
- [Deployment Option 4: Vercel](#deployment-option-4-vercel)
- [Deployment Option 5: Render / Railway / Fly.io](#deployment-option-5-render--railway--flyio)
- [GitHub App Setup](#github-app-setup)
- [API Key Management](#api-key-management)
- [Provider Configurations](#provider-configurations)
- [Database Setup](#database-setup)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The pipeline runs in code-first mode. Each step uses a pluggable provider:

```
PR Diff
  └─> [1. Diff Analyzer]
      └─> [2. Script Writer (LLM)]
          └─> [3. Build code-first scenes (code snippets → PNG overlays)]
              └─> [4. Synthesize narration (Google TTS or built-in)]
                  └─> [5. Video Compositor (FFmpeg or Remotion)]
                      └─> [6. Storage Upload] -> Signed URL
```

| Step | Component | Providers | Toggle |
|------|-----------|-----------|--------|
| 1 | Diff Analyzer | `HeuristicDiffAnalyzer` (always) | — |
| 2 | Script Writer | Anthropic SDK, Claude CLI, Gemini CLI, **or** Codex CLI | `SCRIPT_WRITER` |
| 3 | Scene Builder | Code snippets → PNG overlays (always, no external API) | — |
| 4 | TTS | Google Cloud TTS **or** built-in (silent) | `USE_BUILTIN_TTS`, `TTS_PROVIDER` |
| 5 | Video Compositor | FFmpeg (default) **or** Remotion + FFmpeg | `VIDEO_COMPOSITOR` |
| 6 | Storage | Cloudflare R2, AWS S3, **or** Local filesystem | `STORAGE_PROVIDER` |
| 7 | Persistence | PostgreSQL via Drizzle ORM (always) | — |

---

## Prerequisites

All deployments require:

- **Node.js 22+**
- **FFmpeg** on `PATH` (used directly by the default compositor, or by Remotion when `VIDEO_COMPOSITOR=remotion`)
- **PostgreSQL 16+** (any provider: Neon, Supabase, RDS, local)

Additional per-deployment:
- **Docker Compose (local):** Docker Desktop
- **Claude CLI mode:** `@anthropic-ai/claude-code` installed globally, authenticated via `claude login`
- **Gemini CLI mode:** `@google/gemini-cli` installed globally, authenticated via `gemini login` or `GEMINI_API_KEY`
- **Production:** API keys for chosen providers

---

## Environment Variables Reference

### Required (all deployments)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (e.g. `postgresql://user:pass@host:5432/db`) |
| `PORT` | HTTP listen port (default: `3000`) |

### Authentication

Production deployments use GitHub App mode:

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | Numeric App ID (shown on the app settings page) |
| `GITHUB_APP_PRIVATE_KEY` | RSA private key PEM with literal `\n` line endings. Generate: `openssl genrsa 2048 | tr '\n' '\\n'` |
| `GITHUB_APP_SLUG` | App slug (the part after `github.com/apps/`). Used to prevent the bot from triggering itself. |
| `GITHUB_APP_WEBHOOK_SECRET` | Webhook secret set in the App settings page. Generate: `openssl rand -hex 32` |

### LLM (Script Writer)

| Variable | Required When | Default | Description |
|----------|---------------|---------|-------------|
| `SCRIPT_WRITER` | — | `claude-sdk` | `"claude-sdk"` \| `"claude-cli"` \| `"gemini-cli"` |
| `ANTHROPIC_API_KEY` | `SCRIPT_WRITER=claude-sdk` | — | Anthropic API key (SDK mode) |
| `CLAUDE_MODEL` | — | `claude-sonnet-4-20250514` | Claude model for script generation (both SDK and CLI modes) |
| `CLAUDE_CLI_MODEL` | — | `claude-sonnet-4-20250514` | Legacy alias for `CLAUDE_MODEL` |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | Gemini model for script generation (gemini-cli mode) |
| `GEMINI_CLI_MODEL` | — | `gemini-2.5-flash` | Legacy alias for `GEMINI_MODEL` |
| `SCRIPT_DURATION_GUARD_COEFFICIENT` | — | `1.4` | Multiplier for post-generation script duration guards. Prompts keep the requested target; retry/fail starts after target x coefficient. |
| `USE_CLAUDE_CLI` | — | `false` | **Deprecated.** `true` = Claude Code CLI. Superseded by `SCRIPT_WRITER`. Still works as a fallback when `SCRIPT_WRITER` is unset. |

**Writer selection priority**: `SCRIPT_WRITER` takes precedence. If unset, `USE_CLAUDE_CLI=true` selects `claude-cli`. Otherwise defaults to `claude-sdk`.

When using `claude-cli`, the CLI authenticates via its own OAuth flow (`claude login`), not via `ANTHROPIC_API_KEY`. In Docker, mount `~/.claude` into the container.

When using `gemini-cli`, authenticate via `gemini login` (browser OAuth) or set `GEMINI_API_KEY`. Gemini CLI's free tier supports 1,000 requests/day — great for development.

### TTS (Text-to-Speech)

| Variable | Required When | Default | Description |
|----------|---------------|---------|-------------|
| `USE_BUILTIN_TTS` | — | `false` | `true` = skip Google Cloud TTS entirely; narration word timings are estimated from word count instead |
| `GOOGLE_CLOUD_TTS_KEY` | `USE_BUILTIN_TTS=false` | — | Google Cloud TTS API key |
| `GOOGLE_TTS_VOICE` | — | `en-US-Chirp3-HD-Algenib` | Default TTS voice (overridden by LLM suggestion if valid). Accepts any en-US Neural2, WaveNet, Studio, Chirp HD, or Chirp3 HD voice. Journey voices are retired and no longer accepted. |
| `GOOGLE_TTS_TIMEOUT_MS` | — | `45000` | Per-attempt Google TTS API timeout. |
| `GOOGLE_TTS_MAX_ATTEMPTS` | — | `3` | Max attempts per scene TTS call for transient provider/network failures. |
| `GOOGLE_TTS_RETRY_BASE_DELAY_MS` | — | `1000` | Base delay for TTS retry backoff. |
| `GOOGLE_TTS_RETRY_MAX_DELAY_MS` | — | `10000` | Max individual TTS retry backoff delay. |

Google TTS retries are scoped to each scene synthesis call. Transient Google deadline/timeout, `UNAVAILABLE`, `RESOURCE_EXHAUSTED`, `429`, `5xx`, and common network errors are retried before the scene fails. Empty audio responses, missing keys, invalid voice fallback, and duration measurement fallback are not retried. With defaults, worst-case provider wait is roughly three 45s attempts plus short backoff, rather than the Google client's default 300s wait before the first failure.

### Storage

| Variable | Required When | Default | Description |
|----------|---------------|---------|-------------|
| `STORAGE_PROVIDER` | — | `r2` | `r2`, `s3`, or `local` |
| `USE_LOCAL_STORAGE` | Deprecated | `false` | Backward-compatible shorthand for `STORAGE_PROVIDER=local` |
| `LOCAL_STORAGE_DIR` | `STORAGE_PROVIDER=local` | `.local-storage` | Local storage directory |
| `R2_ACCOUNT_ID` | `STORAGE_PROVIDER=r2` | — | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | `STORAGE_PROVIDER=r2` | — | R2 access key |
| `R2_SECRET_ACCESS_KEY` | `STORAGE_PROVIDER=r2` | — | R2 secret key |
| `R2_BUCKET_NAME` | `STORAGE_PROVIDER=r2` | — | R2 bucket name |
| `R2_PUBLIC_URL` | `STORAGE_PROVIDER=r2` | — | Optional public base URL for the bucket |
| `AWS_ACCESS_KEY_ID` | `STORAGE_PROVIDER=s3` | — | AWS/S3 access key ID |
| `AWS_SECRET_ACCESS_KEY` | `STORAGE_PROVIDER=s3` | — | AWS/S3 secret access key |
| `AWS_REGION` | `STORAGE_PROVIDER=s3` | — | AWS/S3 region |
| `AWS_S3_BUCKET_NAME` | `STORAGE_PROVIDER=s3` | — | S3 bucket name |
| `AWS_S3_ENDPOINT` | `STORAGE_PROVIDER=s3` | — | Optional endpoint for S3-compatible providers |

### Other

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SIGNED_URL_EXPIRY_HOURS` | No | `4` | Hours before signed video URLs expire |
| `NODE_ENV` | No | — | `production` for production builds |
| `SHARE_SIGNING_SECRET` | No (recommended) | — | HMAC secret used to sign `/watch/[jobId]` share-link tokens. Recipients never see it; only set when you need shareable share-link URLs. |

---

## Deployment Option 1: Docker Compose (Local)

The easiest way to run everything locally. Uses `Dockerfile.local` which bundles Claude Code CLI, FFmpeg, and git. Spins up a Postgres alongside the app.

### What you need

- Docker Desktop
- Claude Code CLI authenticated on your host (`claude login`)
### Steps

```bash
# 1. Start Postgres
docker compose up db -d

# 2. Push the database schema
DATABASE_URL=postgresql://dev:dev@localhost:5433/pr_to_video npm run db:push

# 3. Start the app
docker compose up app
```

The app runs at `http://localhost:3000` (note: there is no root page — `GET /` returns 404; use `curl http://localhost:3000/api/health` to verify). Your `~/.claude` directory is mounted into the container so the CLI can authenticate.

### Testing it

From the host (outside Docker):

```bash
# Script-only (fast, no video generation cost)
npm run cli -- --server-url http://localhost:3000 --api-key local-dev-key --script-only

# Full video generation
npm run cli -- --server-url http://localhost:3000 --api-key local-dev-key

# Check output
ls output/videos/
```

### Default provider configuration

| Provider | Setting | Why |
|----------|---------|-----|
| LLM | Claude Code CLI | No API key needed, uses your local auth |
| TTS | Builtin (no-op) | No Google Cloud account needed |
| Storage | Local filesystem | Outputs to `./output/` on host |

### Overriding defaults

All env vars are overridable at `docker compose up`. For example, to use Google TTS:

```bash
USE_BUILTIN_TTS=false GOOGLE_CLOUD_TTS_KEY=<key> docker compose up app
```

---

## Deployment Option 2: Docker (Production)

Uses the multi-stage `Dockerfile` which produces a Debian bookworm-slim runtime image (~300 MB for the FFmpeg compositor, ~1.5 GB when `VIDEO_COMPOSITOR=remotion`) with FFmpeg and the Next.js standalone server. Alpine is not supported because Remotion's `chrome-headless-shell` is glibc-linked and silently fails on musl.

### Build

```bash
docker build -t pr-to-video .
```

### Run

```bash
docker run -p 3000:3000 \
  -e DATABASE_URL=<postgres-url> \
  -e GITHUB_APP_ID=<app-id> \
  -e GITHUB_APP_PRIVATE_KEY=<pem-with-literal-newlines> \
  -e GITHUB_APP_SLUG=<app-slug> \
  -e GITHUB_APP_WEBHOOK_SECRET=<secret> \
  -e ANTHROPIC_API_KEY=<key> \
  -e GOOGLE_CLOUD_TTS_KEY=<key> \
  -e STORAGE_PROVIDER=r2 \
  -e R2_ACCOUNT_ID=<id> \
  -e R2_ACCESS_KEY_ID=<key> \
  -e R2_SECRET_ACCESS_KEY=<secret> \
  -e R2_BUCKET_NAME=<bucket> \
  pr-to-video
```

### What's included

- Node.js 26 (Debian bookworm-slim)
- FFmpeg
- Next.js standalone server (no `node_modules` bloat)
- Optional: Chrome Headless Shell + Remotion render libs (only when built with `VIDEO_COMPOSITOR=remotion`)

### What's NOT included

- Claude Code CLI (production uses the Anthropic SDK)
- git (not needed server-side)

---

## Deployment Option 3: Bare Metal / Direct Node.js

Run directly on a server or VM without Docker.

### Install dependencies

```bash
# Node.js 22+
# FFmpeg
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian/Ubuntu

# (Optional) Claude Code CLI for local dev
npm install -g @anthropic-ai/claude-code
claude login
```

### Build and run

```bash
# Pre-fetch Chrome Headless Shell at install time when using Remotion.
# VIDEO_COMPOSITOR must be exported in the shell for the postinstall hook to
# see it — a value placed only in .env is loaded at runtime by Next.js, not by npm.
VIDEO_COMPOSITOR=remotion npm ci   # or just `npm ci` for the default ffmpeg compositor
npm run build
npm run start
```

If `VIDEO_COMPOSITOR=remotion` is set only via `.env`, the postinstall pre-fetch is skipped and the boot-time `instrumentation.ts` hook will download Chrome Headless Shell (~110 MB) on the first `npm run start` instead. The download still happens before any video is rendered — it just shifts from install-time to first-boot-time.

The server starts on port 3000 (configure via `PORT` env var, standard Next.js).

### Database setup

```bash
DATABASE_URL=<your-postgres-url> npm run db:push
```

---

## Deployment Option 4: Vercel

Next.js is built by Vercel — deployment is straightforward, but with caveats.

### Steps

1. Push the repo to GitHub
2. Import the project in Vercel (set the root directory to `pr-to-video/` if it's in a monorepo)
3. Set all required environment variables in Vercel's dashboard
4. Deploy

### Caveats

| Issue | Impact | Mitigation |
|-------|--------|------------|
| **Serverless function timeout** | Video generation takes 2-5 minutes. Vercel's default is 10s (Hobby) / 60s (Pro). | Use Vercel Pro with max function duration (300s), or use `--script-only` mode for script generation and run video rendering elsewhere. |
| **No FFmpeg** | Remotion requires FFmpeg on PATH. Vercel's runtime doesn't include it. | The current full pipeline is not supported on Vercel. Use `--script-only` mode or move video generation/composition to a separate worker/container. |
| **No Claude CLI** | The CLI binary isn't available in Vercel's runtime. | Use `SCRIPT_WRITER=claude-sdk` (Anthropic SDK mode). |
| **No local storage** | Serverless functions have ephemeral filesystems. | Use `STORAGE_PROVIDER=r2` or `STORAGE_PROVIDER=s3`. |
| **No persistent `/tmp`** | Each invocation gets a fresh `/tmp`. | Remotion's temp files are fine (single invocation), but don't rely on cross-request temp state. |

### Recommended Vercel configuration

```
SCRIPT_WRITER=claude-sdk
USE_BUILTIN_TTS=false    # or true to skip Google TTS
STORAGE_PROVIDER=r2
```

### Vercel is a good fit for

- Script-only mode (`--script-only`) — fast, no FFmpeg needed
- API-only front doors that delegate actual rendering to another system

### Vercel is NOT a good fit for

- The current end-to-end video pipeline
- Claude CLI mode
- Local storage mode

---

## Deployment Option 5: Render / Railway / Fly.io

These platforms support long-running Docker containers, making them better suited than Vercel for the full video pipeline.

### Render

1. Create a new Web Service, point it to your repo
2. Set the Dockerfile path to `pr-to-video/Dockerfile`
3. Set the pre-deploy command to `node scripts/migrate.mjs`
4. Set environment variables in the dashboard
5. Ensure the instance has enough memory (default FFmpeg compositor needs ~512MB; Remotion needs 2GB+)

If an existing Render database was previously managed with `drizzle-kit push`,
run the pre-deploy command once with `MIGRATIONS_BASELINE=1` after confirming
the checked-in `drizzle/*.sql` files match the live schema. The baseline run
records the SQL files in `public.schema_migrations` without executing them.

### Railway

1. Create a new project from your repo
2. Railway auto-detects the Dockerfile
3. Add a PostgreSQL plugin (or use an external DB)
4. Set environment variables

### Fly.io

```bash
cd pr-to-video
fly launch                          # creates fly.toml
fly secrets set API_SECRET_KEY=...  # set env vars
fly secrets set DATABASE_URL=...
fly secrets set ANTHROPIC_API_KEY=...
fly secrets set GOOGLE_CLOUD_TTS_KEY=...
fly deploy
```

### Considerations for all three

| Concern | Recommendation |
|---------|---------------|
| **Memory** | 512MB+ RAM with default FFmpeg compositor; 2GB+ if using `VIDEO_COMPOSITOR=remotion` |
| **Timeout** | Ensure request timeout is >= 5 minutes (video generation is slow) |
| **Health checks** | Point health checks at `/` or a dedicated `/api/health` endpoint, not at `/api/jobs` |
| **Persistent storage** | Use R2 or S3 (`STORAGE_PROVIDER=r2` or `STORAGE_PROVIDER=s3`). Local filesystem is ephemeral on these platforms. |

---

## GitHub App Setup

The GitHub App is the recommended way to use the `@prvod` annotation trigger. It gives the server its own `prvod[bot]` identity, supports multiple repositories under a single installation, and uses short-lived per-installation tokens instead of a long-lived PAT.

### Production setup

#### Step 1: Register the app

Go to **github.com/settings/apps/new** (personal) or **github.com/organizations/ORG/settings/apps/new** (org app).

Fill in the form:

| Field | Value |
|-------|-------|
| App name | `prvod` (becomes `prvod[bot]` in comments) |
| Homepage URL | Your server URL (required but not used) |
| Webhook URL | `https://your-server.com/api/webhook/github` |
| Webhook secret | Generate: `openssl rand -hex 32` |

Under **Repository permissions**, set:

| Permission | Level |
|---|---|
| Contents | Read-only |
| Pull requests | Read & Write |
| Issues | Read & Write |
| Metadata | Read-only |

Under **Subscribe to events**, check:
- Pull request
- Issue comment
- Installation
- Installation repositories

Set **Where can this GitHub App be installed?** to _Any account_ for a multi-tenant/public app, or _Only on this account_ for a self-hosted private setup.

Click **Create GitHub App**.

#### Step 2: Collect credentials

On the app's settings page:

1. Note the **App ID** (e.g. `1234567`)
2. Note the **App slug** (visible in the URL: `github.com/apps/<slug>`)
3. Under _Private keys_, click **Generate a private key** — a `.pem` file downloads
4. Convert the PEM for use as a single-line env var:
   ```bash
   cat your-app.pem | tr '\n' '~' | sed 's/~/\\n/g'
   ```
   The output is the value of `GITHUB_APP_PRIVATE_KEY`. It should start with `-----BEGIN RSA PRIVATE KEY-----\n` and end with `-----END RSA PRIVATE KEY-----\n`.

#### Step 3: Generate the encryption key

```bash
openssl rand -hex 32
```

This is your `APP_ENCRYPTION_KEY` — the pepper added to all API key hashes. Store it as a secret and never rotate it unless you're prepared to re-issue all API keys.

#### Step 4: Set environment variables

```dotenv
# GitHub App
GITHUB_APP_ID=1234567
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n
GITHUB_APP_SLUG=prvod
GITHUB_APP_WEBHOOK_SECRET=<the secret you set in Step 1>

# Database
DATABASE_URL=postgresql://user:pass@host:5432/pr_to_video
```

#### Step 5: Run the database migration

The GitHub App feature adds four tables (`github_installations`, `installation_repositories`, `api_keys`, `webhook_deliveries`) and new columns on `video_jobs`:

```bash
DATABASE_URL=<your-postgres-url> npm run db:push
```

Run this before starting the server for the first time, and again after pulling any schema changes.

#### Step 6: Install the app on repositories

1. Go to `github.com/apps/<your-slug>`
2. Click **Install**
3. Choose your organization or personal account
4. Select _All repositories_ or specific ones
5. Confirm

The server receives an `installation.created` webhook and records the installation automatically. You'll see a log line:
```
info: Installation upserted {"installationId":12345678,"accountLogin":"your-org"}
```

#### Step 7: Verify

Open (or reopen) a pull request in an installed repository and comment `@prvod`. Within a few seconds, the webhook fires. When the video is ready (1–5 minutes), `<your-app>[bot]` posts a comment with the URL.

---

### Local development setup

You need a public URL for GitHub to reach your local machine. Use a webhook proxy.

#### Option A: smee.io (no signup required)

```bash
# 1. Create a channel
open https://smee.io/new
# Copy the channel URL (e.g. https://smee.io/abc123)

# 2. Start the proxy (in a separate terminal)
npx smee-client \
  --url https://smee.io/abc123 \
  --target http://localhost:3000/api/webhook/github

# 3. Set the Webhook URL in your dev GitHub App settings to https://smee.io/abc123
```

#### Option B: ngrok

```bash
ngrok http 3000
# Copy the https:// forwarding URL
# Set it as the Webhook URL in your dev GitHub App settings
```

#### Create a separate dev app

Never point your production GitHub App at localhost. Create a second app named `prvod-dev` (or `prvod-yourname`) with its own credentials:

```dotenv
# .env.local — NOT committed
GITHUB_APP_ID=9999999                # dev app ID
GITHUB_APP_PRIVATE_KEY=...           # dev app private key
GITHUB_APP_SLUG=prvod-dev            # dev app slug
GITHUB_APP_WEBHOOK_SECRET=dev-secret
APP_ENCRYPTION_KEY=<any 32-byte hex> # dev pepper (can be anything)
DATABASE_URL=postgresql://dev:dev@localhost:5433/pr_to_video
```

#### Full local dev workflow

```bash
# 1. Start Postgres
docker compose up db -d

# 2. Run the migration
DATABASE_URL=postgresql://dev:dev@localhost:5433/pr_to_video npm run db:push

# 3. (Optional) set a legacy local API key if you want to use npm run cli
export API_SECRET_KEY=local-dev-key

# 4. Start the webhook proxy
npx smee-client --url https://smee.io/your-channel --target http://localhost:3000/api/webhook/github

# 5. Start the dev server
npm run dev

# 6. On GitHub: comment @prvod on a PR in a repo with your dev app installed
```

#### Testing without a real GitHub App

For pure unit and integration tests, no GitHub App credentials are needed — all tests run against mock implementations:

```bash
npm test
```

To test the webhook handler with real HTTP requests locally (without GitHub):

```bash
# Start the server
npm run dev

# Send a simulated webhook (replace with a valid HMAC for GITHUB_APP_WEBHOOK_SECRET)
curl -X POST http://localhost:3000/api/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -H "X-GitHub-Delivery: test-delivery-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=<hmac>" \
  -d '{"action":"created","installation":{"id":12345},"issue":{"pull_request":{}},"comment":{"body":"@prvod","user":{"login":"testuser"}},"repository":{"full_name":"owner/repo","id":99}}'
```

---

## Automated Releases

The repository includes a GitHub Actions workflow for one-click releases.

### Required GitHub Repository Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value | Where to find it |
|--------|-------|-------------------|
| `RENDER_DEPLOY_HOOK_URL` | `https://api.render.com/deploy/srv-xxx?key=yyy` | Render Dashboard → Service → Settings → Deploy Hook |
| `DEPLOY_HEALTH_URL` | `https://your-app.onrender.com/api/health` | Your Render service URL + `/api/health` |

**Branch protection note**: The workflow pushes a version-bump commit and a Git tag to the default branch using `GITHUB_TOKEN`. If branch protection rules block this, either allow GitHub Actions to bypass protection or use a PAT (`secrets.GH_PAT`) in the checkout step.

### Triggering a Release

1. Go to **Actions** tab → select **"Release prvod"**
2. Click **"Run workflow"** → choose bump type (`patch`, `minor`, or `major`)
3. The workflow validates (test/lint/typecheck), bumps the version, deploys to Render, waits for confirmation, then creates a Git tag and GitHub Release

### Health Endpoint

`GET /api/health` returns the deployed version:

```json
{"version":"1.2.3","status":"ok","uptime":3600.5,"timestamp":"2026-03-22T12:00:00.000Z"}
```

This endpoint is used by the release workflow to confirm deployments and can also be configured as Render's health check path.

---

## API Key Management

API keys are only needed for the non-production `/api/jobs` routes used by local debugging tools such as `npm run cli`. Production webhook usage does not require them. Keys are stored in the `api_keys` table as Argon2id hashes. The raw key is never persisted — it is printed once at creation and never again.

### Create a key

```bash
APP_ENCRYPTION_KEY=<pepper> DATABASE_URL=<url> \
  npx tsx scripts/create-admin-api-key.ts "descriptive-name"
```

The output:
```
=== API Key Created ===
Name   : descriptive-name
Key ID : pk_abc123def456
Full Key (save this — shown only once):
  pk_abc123def456.deadbeef...
======================
```

The full key format is `<keyId>.<secret>`. Use it as:
- `Authorization: Bearer pk_abc123def456.deadbeef...` (local/non-production HTTP API)

The `keyId` prefix (`pk_abc123def456`) is safe to log and reference in support tickets. The secret suffix must be kept private.

### Revoke a key

```bash
DATABASE_URL=<url> npx tsx scripts/revoke-api-key.ts pk_abc123def456
```

The key stops working immediately — no server restart needed. The record is preserved with `status="revoked"` for audit purposes.

### Rotate the encryption key

Changing `APP_ENCRYPTION_KEY` invalidates all existing hashes. Before rotating:

1. Create new keys with the new pepper **before** changing the env var
2. Update `APP_ENCRYPTION_KEY` in your deployment
3. Revoke or re-issue old keys as needed

### Legacy API_SECRET_KEY

If `API_SECRET_KEY` is set, the server seeds it into the `api_keys` table on startup as an admin key named `"legacy API_SECRET_KEY"`. This is intended for local/manual compatibility with the non-production jobs API.

---

## Provider Configurations

Here are pre-built configurations for common scenarios.

### A. Full Cloud Production

Maximum quality, all external services.

```env
SCRIPT_WRITER=claude-sdk
ANTHROPIC_API_KEY=sk-ant-...
USE_BUILTIN_TTS=false
GOOGLE_CLOUD_TTS_KEY=AIza...
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=pr-to-video
```

**Cost per video:** ~$0.05-0.20 (LLM + TTS only)

### B. Local Development (Full Pipeline)

Uses Docker Compose. Generates real videos locally using Claude CLI.

```env
SCRIPT_WRITER=claude-cli
USE_BUILTIN_TTS=true
STORAGE_PROVIDER=local
DATABASE_URL=postgresql://dev:dev@localhost:5432/pr_to_video
API_SECRET_KEY=local-dev-key
```

**Cost per video:** ~$0.01-0.05 (LLM only)

### C. Local Development (Script Only)

Cheapest option. Generates only the JSON script, no video/TTS/storage.

```env
SCRIPT_WRITER=claude-cli
USE_BUILTIN_TTS=true
STORAGE_PROVIDER=local
DATABASE_URL=postgresql://dev:dev@localhost:5432/pr_to_video
API_SECRET_KEY=local-dev-key
```

Run with `--script-only`:
```bash
npm run cli -- --server-url http://localhost:3000 --api-key local-dev-key --script-only
```

**Cost per run:** ~$0.01-0.03 (only Claude usage via CLI)

### D. Budget Cloud (Builtin TTS + Local Storage)

Minimize external dependencies. Suitable for self-hosted VMs.

```env
SCRIPT_WRITER=claude-sdk
ANTHROPIC_API_KEY=sk-ant-...
USE_BUILTIN_TTS=true
STORAGE_PROVIDER=local
```

Serve the `.local-storage/` directory via nginx or a CDN, or switch to `STORAGE_PROVIDER=s3` / `STORAGE_PROVIDER=r2`.

---

## Database Setup

All deployments need PostgreSQL. The schema is managed by Drizzle ORM.

### Push schema (first time or after schema changes)

```bash
DATABASE_URL=<your-postgres-url> npm run db:push
```

### Hosted Postgres providers

| Provider | Free Tier | Connection String Format |
|----------|-----------|--------------------------|
| **Neon** | 0.5GB | `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require` |
| **Supabase** | 500MB | `postgresql://postgres.xxx:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres` |
| **Railway** | $5 credit | `postgresql://postgres:pass@xxx.railway.app:5432/railway` |

### Local Postgres (non-Docker)

```bash
createdb pr_to_video
DATABASE_URL=postgresql://localhost:5432/pr_to_video npm run db:push
```

### Inspect the database

```bash
DATABASE_URL=<url> npm run db:studio
```

Opens Drizzle Studio in your browser.

---

## Troubleshooting

### "FFmpeg not found" or video rendering fails

FFmpeg must be on `PATH`. Both Dockerfiles install it. For bare-metal:
```bash
brew install ffmpeg    # macOS
sudo apt install ffmpeg # Debian/Ubuntu
```

### "claude: command not found" (when `SCRIPT_WRITER=claude-cli`)

Install and authenticate:
```bash
npm install -g @anthropic-ai/claude-code
claude login
```

In Docker, ensure `~/.claude` is mounted (docker-compose.yml does this).

### "gemini: command not found" (when `SCRIPT_WRITER=gemini-cli`)

Install and authenticate:
```bash
npm install -g @google/gemini-cli
gemini login      # browser OAuth
# OR set GEMINI_API_KEY in your environment
```

### Container crashes on startup with "GOOGLE_CLOUD_TTS_KEY not set"

You're running with `USE_BUILTIN_TTS=false` (the default). Either:
- Set `GOOGLE_CLOUD_TTS_KEY`, or
- Set `USE_BUILTIN_TTS=true` to skip Google TTS

### Google TTS times out before any response

Google's client can report `Total timeout ... exceeded 300000 milliseconds before any response was received`. The app bounds each scene TTS attempt with `GOOGLE_TTS_TIMEOUT_MS` and retries transient provider/network failures up to `GOOGLE_TTS_MAX_ATTEMPTS`. Check `docs/operations/google-tts-timeouts.md` for retry policy, expected logs, and troubleshooting steps.

### Video generation times out

Code-first video generation involves LLM script generation (10–60s) and TTS synthesis (~5s per scene). Ensure:
- Your platform's request timeout is >= 5 minutes
- You're not on Vercel Hobby (10s timeout)
- Docker containers aren't being killed by health check timeouts

### "Cannot find module" errors in Docker

The production Dockerfile uses Next.js standalone mode. If you add dependencies that aren't imported in Next.js pages/routes, they won't be included in the standalone bundle. For such cases, use `Dockerfile.local` or add the packages to `serverComponentsExternalPackages` in `next.config.ts`.

### Database connection refused in Docker Compose

The `app` service depends on `db`, but Postgres may not be ready when the app starts. If this happens:
```bash
# Start DB first and wait for it
docker compose up db -d
sleep 3
docker compose up app
```

### Local storage: where are my videos?

With `USE_LOCAL_STORAGE=true`:
- **Docker Compose:** `./output/` on the host (mounted to `/app/.local-storage` in the container)
- **Bare metal:** `./.local-storage/` relative to the working directory (override with `LOCAL_STORAGE_DIR`)
