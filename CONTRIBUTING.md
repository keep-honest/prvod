# Contributing to prvod

Thanks for your interest in contributing to prvod. This guide covers everything you need to get started.

## License

prvod is licensed under the [Elastic License 2.0 (ELv2)](LICENSE). By submitting a pull request, you agree to license your contribution under the same Elastic License 2.0 terms. See [LICENSING.md](LICENSING.md) for what this means in practice — notably, the ELv2 permits nearly all use except offering prvod as a hosted service to third parties.

## Code of Conduct

All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for how to report them privately through GitHub Security Advisories.

## Getting Started

### Prerequisites

- Node.js 22+ (see `.nvmrc`)
- PostgreSQL (for local development — tests run without it)
- Docker (optional, for `docker compose up -d` to run PostgreSQL)

### Setup

```bash
# Clone and install
git clone https://github.com/keep-honest/prvod.git
cd prvod
npm install

# Start PostgreSQL (skip if you already have one running)
docker compose up -d

# Copy environment config
cp .env.example .env
# Edit .env with your values (see README for required variables)

# Apply database schema
npm run db:push

# Start dev server
npm run dev
```

### Running Tests

Tests run entirely in-memory with mock implementations — no database, API keys, or external services needed.

```bash
npm test              # All tests (1400+)
npm run test:unit     # Unit tests only
npm run test:int      # Integration tests only
npm run test:watch    # Watch mode
```

### Quality Checks

All of these must pass before submitting a PR:

```bash
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
npm test              # Full test suite
```

## Making Changes

### Branch Workflow

1. Fork the repository and create a feature branch from `main`.
2. Make your changes in focused, reviewable commits.
3. Ensure all quality checks pass (lint, typecheck, tests).
4. Open a pull request against `main`.

### Code Standards

- **TypeScript strict mode** with `no-explicit-any` enforced.
- Unused variables prefixed with `_` (ESLint configured).
- **Zod** for all external input validation.
- JSON structured logging via `src/lib/logger.ts`.
- Follow existing patterns — read the code around your change before writing new code.

### Architecture

prvod uses a 4-layer dependency inversion architecture. Dependencies point inward only.

```
Layer 1: src/interfaces/     — Port definitions
Layer 2: src/domain/         — Business logic, entities, services
Layer 3: src/infrastructure/ — Implementations (DB, APIs, video providers)
Layer 4: src/app/api/        — Next.js route handlers
```

For a deep dive, see [FOR_DEVELOPER.md](FOR_DEVELOPER.md).

### Testing

- Add tests for new behavior — the test suite is the project's safety net.
- Tests live in `tests/unit/` and `tests/integration/`, mirroring the `src/` structure.
- Use the 12 mock implementations in `src/mocks/` for dependency injection.
- Path alias: `@/` maps to `src/`.

### Documentation

If your change affects any of these, update them before opening a PR:

- `.env.example` — new or changed environment variables
- `README.md` — user-facing changes, env var table, pipeline overview
- `FOR_DEVELOPER.md` — architecture, technical explanations
- `CLAUDE.md` — pipeline flow, key files table, conventions

## Submitting a Pull Request

1. Fill out the [PR template](.github/pull_request_template.md) — it's short.
2. Link to any related issues.
3. Make sure CI passes (lint, typecheck, tests run automatically).
4. A maintainer will review your PR. We aim to respond within a few days.

## Reporting Bugs

Use the [bug report template](https://github.com/keep-honest/prvod/issues/new?template=bug_report.yml). Include steps to reproduce, expected vs. actual behavior, and your environment.

## Requesting Features

Use the [feature request template](https://github.com/keep-honest/prvod/issues/new?template=feature_request.yml). Describe the problem you're solving and your proposed approach.

## Questions

For general questions and discussion, visit [GitHub Discussions](https://github.com/keep-honest/prvod/discussions).
