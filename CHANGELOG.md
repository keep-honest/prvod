# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Removed

- **Billing system**: LemonSqueezy integration, subscriptions, credit ledger, `EntitlementGuard`, dev billing provider, billing scripts (`scripts/billing/`), and the `billing_entities` / `git_accounts` / `customers` / `subscriptions` / `credit_balances` / `credit_transactions` / `billing_events` tables (migration `0013_drop_billing_and_user_mgmt.sql`). Also removed the `subscription_id` / `estimated_credits` / `actual_credits` columns from `video_jobs`.
- **User-management dashboard**: `/dashboard/*` routes, dashboard layout/components, `/setup`, `/signin`, `/api/auth/[...nextauth]`, `/api/dashboard/*`, GitHub OAuth integration (next-auth), and `sender_github_id` / `git_account_ref` on `github_installations`.
- **Review-page interactive UI**: Constellation graph viewer (PixiJS), diff workspace, draft-comment composer, file rail, transcript timeline, mobile review tray, virtualized scroll list, `/api/reviews/:jobId/draft-comments/*`, `ReviewAccessPolicy`, `ReviewDiffSnapshot`, and the `reviewGraphRenderModel` / `reviewGraphMath` / `reviewDraftSync` / `reviewPageMetrics` libraries. The data structures behind the constellation graph stay because the Remotion video scene depends on them.
- **Internal documentation**: `specs/`, `docs/manual-testing/`, `docs/cinematic-*`, `FOR_DEVELOPER.md`, `CLAUDE.md`, `AGENTS.md`, `RULES.md`. Public docs (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`, `LICENSING.md`, `DEPLOYMENT.md`, `docs/operations/`) are kept and scrubbed.
- **Frontend dependencies**: `@lemonsqueezy/lemonsqueezy.js`, `next-auth`, `@radix-ui/*`, `lucide-react`, `motion`, `pixi.js`, `react-force-graph-2d`, `react-resizable-panels`, `@tanstack/react-virtual`, `class-variance-authority`, `@playwright/test`.
- **Environment variables**: `BILLING_PROVIDER`, `ALLOW_DEV_BILLING`, `APP_ENV`, `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`, `LS_VARIANT_STARTER`, `LS_VARIANT_TEAM`, `LS_VARIANT_BUSINESS`, `AUTH_SECRET`, `AUTH_URL`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `RESEND_API_KEY`, `CONTACT_EMAIL_TO`.

### Added

- **Architecture overview** section in `README.md` covering the 4-layer DI pattern, container wiring, job processing, checkpoint resume, and the prompt-injection guard.
- **Mock video provider**: Full local pipeline execution without API keys (`MockVideoProvider`)
- **Code-first walkthrough variation**: New `WalkthroughVariation` entity, `codeBroll` array schema (backward-compatible via `z.preprocess`), code-first Remotion compositions (`MultiCodeCard`), and orchestrator pipeline that skips the visual judge for code-first scenes
- **Cinematic review page**: Theater-mode UI with playback state machine, review page data model/assembler/access policy, react-resizable-panels layout
- **Constellation graph**: Interactive file-relationship graph modal with PiP video handoff, UML edge classification engine, PixiJS/Canvas renderer (replaced d3-force/SVG), spatial index, selected-node labels, and camera utilities
- **Review file graph**: File-centric layout engine (`reviewFileGraph`) with full-source UML edge derivation, multi-scene node model, canonical source capture via `headSha`
- **Remotion animations**: Finale reveal animation, multi-card parallel shrink, finale staggered build, procedural background, constellation suffix for multi-snippet scenes
- **Shiki syntax highlighting**: `github-dark` theme in `CinematicCodeFrame` for code-first video compositions
- **Codex CLI script writer**: OpenAI-compatible schema normalization, read-only sandbox integration via `createCodexCliLlmClient`
- **Scene outline repair loop**: Validation failures in scene outlines trigger an LLM repair pass before falling through to error
- **Code-first duration policy**: Total word budget enforcement, duration-from-wordcount computation, mandatory overview scene 1, tuned popcorn targets
- **LLM resilience**: Per-call exponential backoff retry for all LLM invocations, `SKIP_JUDGE` flag, TTS-aware word budget calculation, `POST_GROUNDING` flag
- **Word budget enforcement**: Batched scene generation with stage logging in V2 pipeline
- **LOG_LEVEL env var**: Priority-based log filtering for observability

### Fixed

- **Caption sync**: Eliminated scene-boundary drift via float-precision timing; calibrated caption word timings from measured audio duration
- **Pipeline**: Skip retry for deterministic LLM validation failures; fetch canonical files via `headSha`; load checkpoint before resume
- **Claude CLI**: Fixed stdin delivery; extract structured-output envelope `result` field instead of falling through to raw text
- **LLM pipeline**: Route all schema parses through `deriveScriptFromTransport` for type safety; use transport schema for code-first in narration judge; allow batch-specific shape hint and system prompt in repair loop; use TTS-sanitized word counts in budget validation
- **Billing**: Expire stale cancelled subs before pending link; cap balance at period allowance on release/reconcile; resolve dev portal/checkout URLs against forwarded host; dark theme; fail-fast env validation and startup order
- **Webhooks**: Harden GitHub race recovery, orphan cleanup, and billing-options guard; LemonSqueezy safe date parsing, typed updates, unknown variant sync; persist variant before credit top-up
- **Schema**: Enforce positive scene numbers instead of nonnegative
- **Orchestrator**: Skip execution profile alignment for code-first; use entity-level `isCodeFirstVariation`

### Changed

- **Graph identity**: Switched from `sceneNumber` to `nodeId` (filePath) for graph node identity; `collectNodes` iterates all `codeBroll` entries
- **Review graph**: Rewritten `ConstellationGraphView` with per-object PixiJS graphics and spatial index; replaced d3-drag/d3-zoom/d3-selection with pixi.js
- **Domain model**: `PRContext` extended with `headSha`, `headRepoFullName`, and walkthrough variation support; `ReviewGraph` entity and `GraphEdgeRelationship` moved to domain layer
- **LLM pipeline**: Extracted `RefinementContext`, consolidated pipeline stages and repair logic; code-first context passed to narration judge, CLI writer, and TTS
- **Infrastructure**: Extracted `pipelineFactory`, `jobResponse`; consolidated webhook and container wiring
- **Video**: Extracted `compositorUtils`; consolidated FFmpeg overlay and clip logic
- **Webhook parser**: Rewritten `@prvod` annotation parser with whole-line matching

## [0.1.0] - 2026-03-29

### Added

- Video generation pipeline: PR diff → script → video clips → narration → compose → upload
- Multiple video providers: fal.ai, kie.ai, Runware with 14 models across 3 providers
- Multiple themes: talk show, sports studio, standup show, action trailer, comedy trailer
- Claude SDK, Claude CLI, and Gemini CLI script writers with structured output
- Prompt Pipeline V2: multi-step LLM pipeline (coverage planner → judge → scene outline → script writer → narration judge → evidence grounding)
- Visual prompt judge: AI quality gate for scene visuals using the Self-Refine pattern
- Iterative LLM script repair loop for schema and grounding failures
- 7-layer prompt injection defense (input sanitization, XML sandboxing, canary tokens, output validation)
- GitHub App integration with webhook-driven video generation and PR status comments
- One-time trial API keys with atomic claim and crash recovery
- API key authentication with Argon2id hashing and pepper
- FFmpeg compositor (default) and Remotion compositor
- Checkpoint system for pipeline resilience and retry from last successful step
- Google Cloud Text-to-Speech integration with retiming for trailer themes
- Docker support: production Alpine image and local development compose
- CLI for local testing with script-only and retry modes
- PostgreSQL persistence via Drizzle ORM (5 tables)
- Theme capability system enforcing model/voice/lip-sync requirements
- Comprehensive test suite (1400+ tests, no external services required)

[Unreleased]: https://github.com/keep-honest/prvod/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/keep-honest/prvod/releases/tag/v0.1.0
