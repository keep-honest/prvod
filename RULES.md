# Rules

Mandatory rules for Claude Code when working in this repository. Referenced from [`CLAUDE.md`](CLAUDE.md).

## Documentation before commits

Before generating commit messages or creating any commit, verify that all changes are reflected in the documentation listed below. **Update the docs first**, then commit. If the change is purely internal (refactor, test addition, dependency bump, CI tweak) and touches nothing a user or operator would see, note "no doc updates needed" in the commit message and proceed.

### Server / Node code (`src/`, `tests/`, `scripts/`, root configs)

| Doc | Update when |
|---|---|
| [`.env.example`](.env.example) | A new env var is read, an existing var's name changes, or its default/format changes |
| [`README.md`](README.md) | A user-visible feature changes (env-var table, supported providers, pipeline overview, install steps) |
| [`CLAUDE.md`](CLAUDE.md) | Pipeline flow, key files table, architecture, or "Active technologies" section changes |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | A deployment step or runtime requirement changes (Docker, Postgres, R2/S3, Remotion browser) |
| [`SECURITY.md`](SECURITY.md) | The disclosure process or a security-sensitive surface (auth, signed URLs, prompt-injection guard) changes |

### Go CLI (`cli-go/`)

| Doc | Update when |
|---|---|
| [`cli-go/README.md`](cli-go/README.md) | A flag, exit code, env var, config key, or example changes |
| [`CHANGELOG.md`](CHANGELOG.md) | Adding a user-facing CLI change to the `## [Unreleased]` section (see below) |
| [`CLAUDE.md`](CLAUDE.md) (prvodctl section) | The CLI's mode set or exit-code contract changes |

### Both server and CLI

| Doc | Update when |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Any user-facing feature or bug fix lands on `main` |
| [`CLAUDE.md`](CLAUDE.md) | The architecture, key-files table, or conventions move |

## CHANGELOG discipline

[`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses its canonical bucket headings — `#### Added`, `#### Changed`, `#### Fixed`, plus `#### Deprecated`, `#### Removed`, `#### Security` when relevant. The unreleased work-in-progress section lives at the top under `## [Unreleased]`. Add to it as soon as a user-facing change lands on `main`; don't wait for the release.

### What belongs in CHANGELOG

- **`#### Added`** — new features. New flags, new modes, new env vars, new output formats, new install paths — anything that lets a user do something they couldn't do in the previous release.
- **`#### Changed`** — behavior changes to existing features that aren't bug fixes. Default flips, renamed flags, output format tweaks. Note the migration if there is one. For **breaking** changes prefix the entry with `**BREAKING:**` and pair the release with a major bump per [`RELEASE.md`](RELEASE.md) §2.
- **`#### Fixed`** — bug fixes. Includes wrong exit codes, wrong defaults, misleading errors, silent failures — anything that was broken and now isn't.

### What does NOT belong

- Internal refactors with no user-visible effect
- Test additions or coverage improvements
- CI / workflow tweaks (unless they change how a user releases or installs — those go under `#### Added` / `#### Fixed` as appropriate)
- Dependency bumps that don't change behavior
- Documentation-only changes

When in doubt, ask: **would a user notice this if they upgraded from the previous version?** If yes, it's a CHANGELOG entry.

**Heightened bar for the Go CLI.** Any change touching `cli-go/cmd/`, `cli-go/internal/client/`, exit code constants, flag parsing, or the `--stream-diff` / `--no-stream-diff` / `--diff-file` / `--retry-job` dispatch — assume it is user-visible until you can prove otherwise. The bar to skip a CHANGELOG entry for these areas is a one-line note in the PR body explaining why ("internal-only constant rename, no exit-code or flag impact") — not silence.

### Format

```markdown
## [Unreleased]

#### Added

- **One-line summary.** A sentence or two if the change has a non-obvious gotcha. Link to the relevant flag, file, or PR when useful.

#### Changed

- **One-line summary.** Note the migration if there is one.
- **BREAKING: One-line summary.** Required to call out at the start of the entry; pair with a major version bump.

#### Fixed

- **One-line summary.** Same pattern.
```

Releases freeze `## [Unreleased]` into `## [vX.Y.Z] - YYYY-MM-DD` and leave a fresh empty `## [Unreleased]` above it. See [`RELEASE.md`](RELEASE.md) for the full procedure.

## Release discipline

A new tagged release of `prvodctl` (the Go CLI) **only** ships through [`.github/workflows/release.yml`](.github/workflows/release.yml). Do not build and upload binaries by hand; the workflow is the source of truth for cross-compilation, version stamping, archive packaging, and SHA256SUMS generation.

Before tagging:

1. The pre-release checklist in [`RELEASE.md`](RELEASE.md) §3 must be green.
2. `CHANGELOG.md`'s `## [Unreleased]` section accurately reflects everything since the previous tag, has been moved into a `## [vX.Y.Z] - YYYY-MM-DD` section, and that change has been pushed to `main`.
3. The version bump (major/minor/patch) follows [`RELEASE.md`](RELEASE.md) §2.

The tag itself is the trigger — pushing `vX.Y.Z` to `origin` runs the workflow automatically. The manual `workflow_dispatch` path exists only to re-run a release for an **existing** tag if the first attempt failed midway; it refuses to create new tags.

## No secrets in commits

The repo runs `gitleaks` via `.pre-commit-config.yaml`. If gitleaks blocks a commit, **investigate the finding** — don't bypass with `--no-verify`. If the finding is a false positive (test fixture, example value, public key), add a `.gitleaksignore` entry naming the path and the rule, then commit that alongside the code.

Never commit:

- API keys (Anthropic, Google, OpenAI/Codex, fal.ai, Runware)
- GitHub App private keys or webhook secrets
- `STORAGE_URL_SECRET` or any HMAC secret
- Personal access tokens (GitHub PAT, etc.)
- Database URLs that include credentials
- `.env`, `.env.local`, or any populated env file (only `.env.example` should be in git)

### If a secret slips through

**Treat the leaked value as permanently compromised.** Force-pushing rewritten history does **not** unleak the secret — GitHub keeps reflog entries, forks and mirrors retain the original blobs, and anyone who already pulled has a local copy. Rotation at the provider is the only real remediation. History rewriting is hygiene, not security.

The rotation procedure depends on the secret class:

- **Provider API keys** (Anthropic, Google, OpenAI / Codex, fal.ai, Runware, GitHub App private key, GitHub PATs). Rotate at the provider's UI immediately. Then force-push to scrub history.
- **HMAC secrets** (`STORAGE_URL_SECRET`, webhook signing secrets). **Do not hot-rotate.** Per [`CLAUDE.md`](CLAUDE.md), rotating `STORAGE_URL_SECRET` invalidates every outstanding signed video URL. The correct sequence is:
  1. **Measure** the longest-lived currently-issued signed URL by inspecting the `exp=` clamp in `signLocalUrl` config. Record it. The grace window in step 3 must exceed `max(exp) - now()`.
  2. Stage a new secret value alongside the old.
  3. Deploy a verifier that accepts either old or new for the grace window measured in step 1.
  4. Wait for in-flight URLs to expire (poll, don't guess).
  5. Retire the old secret value.
  6. **Verify the retirement landed**: issue a test URL signed with the retired secret and assert the verifier returns 401/403. If it succeeds, rotation is incomplete — some code path is still accepting the old secret and the leaked value remains a live attack surface.
  7. Only then force-push to scrub history.

  If you skip the grace window you'll break user playback. If this is a real incident and breakage is acceptable, hot-rotate and accept the URL-blast — but log it, and still run step 6 to confirm the old value is dead.
- **Database credentials.** Rotate at the database, redeploy with the new connection string, verify the app reconnected cleanly, then force-push.

Force-pushing the cleaned history is the **last** step in each case, not the first.

## Test discipline

- `npm test` must be green before opening a PR. The Node CI job blocks merges otherwise.
- For Go CLI changes, `cd cli-go && go vet ./... && go test -race ./...` must be green. The `cli-go` CI job blocks merges otherwise.
- Don't skip or disable failing tests to land a PR. If a test is genuinely wrong, fix the test in the same PR and explain why in the commit message. If a test is flaky and the root cause isn't in this PR's scope, open an issue first and link it from a `// FIXME(issue/N):` comment, then mark the test `t.Skip(...)` (Go) or `it.skip(...)` (vitest) — never silent skip.
- New features without tests block review. "Tested manually" is not a substitute except for the install script (which is explicitly out of automated-test scope per [`RELEASE.md`](RELEASE.md) §8).

## Style and formatting

- TypeScript: `npm run lint` (ESLint) and `npm run typecheck` (`tsc --noEmit`) must be clean before commit. `no-explicit-any` is enforced.
- Go: `gofmt -l` must report nothing (excluding `cli-go/vendor/`). `go vet ./...` must be clean. CI fails on either.
- Shell scripts: `sh -n <file>` must parse cleanly. Prefer POSIX `sh` over bash unless a specific bashism is justified in a comment.
- YAML workflows: every untrusted GitHub Actions input (`github.event.inputs.*`, `github.event.head_commit.*`, `github.event.pull_request.title`, etc.) must flow through an `env:` block with shell-quoted expansion in `run:`. Never splice these directly into a `run:` script.

## Commit message conventions

- Subject line `<type>(<scope>): <summary>` where `<type>` is one of `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`. Examples: `feat(cli): add --stream-diff default`, `fix(jobs): map create-time DIFF_TOO_LARGE to exit 5`.
- Imperative mood: "add", "fix", "remove" — not "added" / "fixes" / "removes".
- Body explains *why*, not *what* the diff already shows. Mention the issue or PR if relevant.
- Reference the CHANGELOG entry by quoting it if the commit is the one that lands a user-facing change.
