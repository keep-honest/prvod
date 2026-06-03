# Releasing prvod

This document is the canonical release procedure for this repository. It covers
the **`prvodctl` Go CLI** (the only artifact published via GitHub Releases
today). The Next.js server app is deployed separately and is not versioned via
this process; only the CLI gets tagged releases.

If you're cutting a release, follow this end-to-end. If you only want to
understand the process, read sections 1 and 2.

---

## 1. What gets released

**Artifact:** `prvodctl`, the Go CLI client for the prvod server
([`cli-go/`](cli-go/)).

**Trigger:** pushing a git tag matching `v*` (or running the
`Release prvodctl` workflow manually for an already-existing tag).

**Output:** a published GitHub Release at
<https://github.com/keep-honest/prvod/releases> containing:

- 5 platform archives (one per build-matrix entry):
  - `prvodctl-vX.Y.Z-linux-amd64.tar.gz`
  - `prvodctl-vX.Y.Z-linux-arm64.tar.gz`
  - `prvodctl-vX.Y.Z-darwin-amd64.tar.gz`
  - `prvodctl-vX.Y.Z-darwin-arm64.tar.gz`
  - `prvodctl-vX.Y.Z-windows-amd64.zip`

  Each contains the binary, the CLI's `README.md`, and the repo `LICENSE`.
- `SHA256SUMS` covering every archive.
- Auto-generated release notes (PR titles since the previous tag).

The Next.js server is **not** built or pushed by this workflow.

---

## 2. Versioning rules

We follow [Semantic Versioning](https://semver.org/) with a leading `v`:

| Bump | When | Example |
|---|---|---|
| **Major** (`v1.0.0` → `v2.0.0`) | Breaking change to flags, exit codes, env vars, or the CLI's contract with the server | Renaming `--stream-diff`, changing exit code 5 to mean something else |
| **Minor** (`v1.0.0` → `v1.1.0`) | New backwards-compatible feature (new flag, new mode, new output format opt-in) | Adding a `--json` output mode |
| **Patch** (`v1.0.0` → `v1.0.1`) | Bug fix, doc fix, dependency update | Fixing a regression where `--retry-job` exited 0 on failure |

Pre-releases use a suffix: `v1.2.0-rc1`, `v1.2.0-beta2`, `v1.2.0-alpha.1`,
`v1.2.0-pre.5`. The release workflow auto-detects these (`-rc/-beta/-alpha/-pre`)
and publishes them as **pre-releases** rather than the latest release. The
install script (`cli-go/install.sh`) calls GitHub's
`/repos/<owner>/<repo>/releases/latest` endpoint, which by definition
excludes pre-releases, so pre-release tags are not picked up by default.
Users opting into a pre-release set `PRVODCTL_VERSION=vX.Y.Z-rcN` explicitly.

The strict regex enforced by both the workflow and the install script is:

```
^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$
```

Tags that don't match are rejected before any artifacts are built.

---

## 3. Pre-release checklist

Run these against the commit you intend to tag, **on `main`**.

```bash
# 1. Working tree is clean and you're on the right commit.
git fetch origin && git status && git log -1 --oneline

# 2. Full test sweep — both the Node server and the Go CLI must be green.
npm ci
npm run lint
npm run typecheck
npm test

cd cli-go
go vet ./...
gofmt -l $(find . -path ./vendor -prune -o -name '*.go' -print) | (! grep .)
go test -race ./...

# 3. Sanity-check the build locally.
make clean && make
./prvodctl --version
./prvodctl --help

# 4. Confirm the CHANGELOG entry for this version is ready (see §4).
```

The PR CI workflow (`.github/workflows/ci.yml`) runs the same checks on every
PR, so if `main` is green these should all pass.

---

## 4. Update the CHANGELOG

[`CHANGELOG.md`](CHANGELOG.md) follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses its
canonical bucket headings. Every release moves the staged `## [Unreleased]`
section into a new dated section, then leaves a fresh empty `## [Unreleased]`
block at the top.

The buckets you'll use most often, and what each one maps to from the user's
vantage:

- **`#### Added`** — new features. New flags, new modes, new env vars, new
  install paths, new endpoints — anything that lets a user do something
  they couldn't do in the previous release.
- **`#### Changed`** — behavior changes to existing features that aren't
  bug fixes. Default flips, renamed flags (paired with deprecation notes),
  output format tweaks. Always note the migration if there's one.
- **`#### Fixed`** — bug fixes. Includes wrong exit codes, wrong defaults,
  misleading errors, silent failures — anything that was broken and now
  isn't.
- **`#### Deprecated`**, **`#### Removed`**, **`#### Security`** — use
  exactly as Keep a Changelog defines them. Most releases won't need these.

Skip any bucket that's empty for a release. **Internal refactors, test
additions, CI tweaks, and dependency bumps without behavior changes do not
belong in the CHANGELOG** — they don't change what a user can do.

### Examples

Under `#### Added`:

- "**`--stream-diff` default**: the CLI now streams the diff via the 100 MB
  upload branch by default; pass `--no-stream-diff` to fall back to the 5 MB
  JSON branch."
- "**Install script** at `cli-go/install.sh` for `curl … | sh` installs with
  SHA256 verification and OS/arch autodetection."
- "**`prvodctl --version`** prints the release version, commit short SHA, and
  build date."

Under `#### Fixed`:

- "**Create-time `DIFF_TOO_LARGE` now exits 5** (was 1) so CI tooling sees
  the same exit code regardless of whether the failure happened before or
  after the job was created."
- "**`--stream-diff=false`** now coexists with `--diff-file` (parity with
  `--no-stream-diff`)."
- "**Stray `cli-go/cli-go` binary** is now gitignored and cleaned by
  `make clean`."

Lead with what changed from the user's vantage, not the code path that
implements it.

### Format

```markdown
## [v1.2.0] - 2026-06-15

#### Added

- **One-line summary.** A longer sentence or two if the change has a
  non-obvious gotcha. Link to the relevant flag/file when useful.

#### Changed

- **One-line summary.** Note the migration if there is one.

#### Fixed

- **One-line summary.** Same pattern.
```

**Breaking changes** (new exit codes, removed flags, default flips) go under
`#### Changed` with a `**BREAKING:**` prefix on the summary, and require a
**major** version bump per §2 — never a minor or patch.

---

## 5. Cut the release

### 5a. Pure tag-push path (the normal case)

```bash
# 1. Make sure your local main matches the remote.
git checkout main
git pull --ff-only origin main

# 2. Update CHANGELOG: move [Unreleased] into [vX.Y.Z] - YYYY-MM-DD,
#    add a fresh empty [Unreleased] above it. Commit the change.
$EDITOR CHANGELOG.md
git add CHANGELOG.md
git commit -m "docs(changelog): release vX.Y.Z"
git push origin main

# 3. Wait for CI on the changelog commit to go green (or check Actions).
gh run watch  # optional; or just visit Actions in the browser

# 4. Tag the commit and push the tag. The release workflow fires on the
#    tag-push event; nothing else is required.
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

That's it. The workflow does the rest:

1. Validates `vX.Y.Z` against the strict semver regex (fails closed).
2. Checks out at the tagged commit (not `main`) so the binaries match the tag.
3. Cross-builds 5 platforms with `-trimpath` and `-ldflags '-X main.Version=…'`.
4. Packages tarballs/zip, generates `SHA256SUMS`.
5. Publishes the GitHub Release with `generate_release_notes: true`.

You should see the release appear at
<https://github.com/keep-honest/prvod/releases> within ~3 minutes.

### 5b. Re-running a release for an existing tag

If the workflow failed midway and the tag is already correct, you can re-run
it manually from the Actions UI:

1. Open **Actions → Release prvodctl → Run workflow**.
2. Enter the existing tag (e.g. `v0.1.0`) in the `version` input.
3. Click **Run workflow**.

The workflow refuses to run if the tag doesn't already exist; this is
intentional so you can't accidentally publish from `main`.

If a previous attempt half-published the release (some assets uploaded, some
missing), **delete the existing Release first** from the Releases UI, then
re-run. The workflow will recreate it.

---

## 6. Post-release verification

Within a couple of minutes of the workflow completing, run these against the
**exact tag you just published** — not against `latest`, which has
propagation lag and could fool you with the previous release.

```bash
set -euo pipefail

# 0. Auto-clean the throwaway directories we'll create below so a stale
#    binary can't be re-invoked accidentally on a later verification pass.
tmp=$(mktemp -d) && tmp2=$(mktemp -d)
trap 'rm -rf "$tmp" "$tmp2"' EXIT

# 1. The Release page shows all 5 archives + SHA256SUMS.
gh release view vX.Y.Z

# 2. Install script picks up the new tag and runs.
#    Important: pin the version explicitly and install into a temp dir so a
#    stale `prvodctl` already on $PATH cannot mask a broken release.
#    Download the install script to a file (not `curl | sh`) so its exit
#    code is observable; piping into sh swallows the install-script exit
#    code unless `set -o pipefail` is in effect.
curl -fsSL https://raw.githubusercontent.com/keep-honest/prvod/main/cli-go/install.sh \
  -o "$tmp/install.sh"
PRVODCTL_VERSION=vX.Y.Z PRVODCTL_INSTALL_DIR="$tmp" sh "$tmp/install.sh"

# The install script ends with `prvodctl --version`; confirm the printed
# version matches the tag you just shipped:
"$tmp/prvodctl" --version | grep -qF "vX.Y.Z" || { echo "VERSION MISMATCH"; exit 1; }

# 3. SHA256SUMS verifies cleanly. Use whichever tool the host has —
#    macOS ships shasum; Linux ships sha256sum.
gh release download vX.Y.Z -p '*' -D "$tmp2"

# Assert the expected asset count BEFORE running the checksum check.
# `gh release download` exits 0 even when zero assets match, and
# `sha256sum -c` on an empty directory would otherwise just print failures
# that look like checksum mismatches when the real problem is missing
# archives. Expected: 5 archives + SHA256SUMS = 6 files.
got=$(ls -1 "$tmp2" | wc -l | tr -d ' ')
if [ "$got" -ne 6 ]; then
  echo "FAIL: expected 6 release assets (5 archives + SHA256SUMS), got $got"
  ls -la "$tmp2"
  exit 1
fi

(
  cd "$tmp2"
  if command -v sha256sum >/dev/null; then
    sha256sum -c SHA256SUMS
  else
    shasum -a 256 -c SHA256SUMS
  fi
)
# Expected output: one "OK" line per archive (5 OKs). Anything else is a
# release-level problem, not a workstation problem.
```

If any step fails, treat the release as broken and follow §7 to recover.
Before re-running §5b, **identify what actually failed**:

- **Workflow / upload failure** (transient build error, network blip, action
  bug). Re-run §5b.
- **Built-binary regression** (the binaries are wrong for the tagged commit).
  Do **not** re-run §5b — the same commit will produce the same broken
  binaries. Bump the patch version and ship a new tag with the fix.
- **Wrong tag pointed at the wrong commit.** See §7.

---

## 7. Common mistakes and how to recover

For any recovery that involves deleting a tag, **always delete the GitHub
Release first** (it's the user-visible artifact; you want install.sh users
to stop getting the bad binaries before you touch the tag). Use `;` instead
of `&&` between the tag deletions so a failed local delete doesn't leave
the remote tag intact.

| Mistake | Recovery |
|---|---|
| Tagged the wrong commit | 1) Delete the GitHub Release in the UI. 2) Confirm `gh release view vX.Y.Z` reports "release not found". 3) `git push origin :refs/tags/vX.Y.Z` (remote first, so install.sh can't resolve it). 4) `git tag -d vX.Y.Z` (local). 5) `git tag -a vX.Y.Z <correct-sha> -m "vX.Y.Z" && git push origin vX.Y.Z`. |
| Tag format rejected (workflow fails at the regex gate) | No Release exists yet, so just clean up the tag: `git push origin :refs/tags/<bad-tag>; git tag -d <bad-tag>`. Then retag with the right form (`vMAJOR.MINOR.PATCH[-prerelease]`) and push. |
| Half-published release (workflow failed during upload) | 1) Delete the partial Release in the UI. 2) Confirm `gh release view vX.Y.Z` reports "release not found" before re-running. 3) Re-run §5b with the same tag. If §5b fails a second time, read the workflow log — don't loop without diagnosing. |
| Forgot the CHANGELOG | **Do not retag.** The published binaries are correct; only the audit trail is wrong. Three steps: (a) update `CHANGELOG.md` on `main` and commit (`docs(changelog): backfill vX.Y.Z`). (b) Edit the GitHub Release description in the UI to paste the entries. (c) Verify the paste actually persisted — UI saves occasionally no-op on stale CSRF / network drops: `gh release view vX.Y.Z --json body -q .body \| grep -qF '<a distinctive phrase from your entry>'` must succeed. The tag itself stays as it was; `git show vX.Y.Z:CHANGELOG.md` won't contain the entries — the canonical user-facing notes live on the Release page. If this matters for audit reasons, bump a patch and retag instead. |
| Published a pre-release as stable (or vice versa) | Edit the Release in the UI to toggle the "This is a pre-release" box. install.sh resolves through GitHub's `releases/latest` endpoint. Verify the change took effect: `curl -fsSL https://api.github.com/repos/keep-honest/prvod/releases/latest \| jq -r .tag_name` must return the tag you expect to be "latest" (which may not be the one you toggled — it's whichever non-prerelease tag has the highest semver order). Propagation is typically seconds; if it doesn't reflect after a minute, double-check the UI save persisted. |

After any recovery that modifies the tag **or the Release body / prerelease
flag**, re-run §6 verification end-to-end against the new tag. Don't skip
— the cleanup may have left a stale CDN cache for the install script or
for a release asset, and UI-only edits can silently no-op on a stale
session.

---

## 8. What is intentionally out of scope

- **Homebrew, Docker, Snap distribution.** Only GitHub Releases + the
  install script today. If we add these, document them here.
- **Signed releases (GPG / cosign / sigstore).** SHA256 is the only
  integrity check in the install script. Worth revisiting once we have a
  signing key story.
- **Server / web-app releases.** Only the Go CLI is versioned via this
  process. Deployments to whatever hosts `prvod.dev` happen via that
  platform's own deploy pipeline, not via tag pushes.
- **CI matrix on macOS / Windows for PRs.** The PR CI runs on
  `ubuntu-latest` only. Cross-platform binaries are exercised on every
  release; PRs don't need that overhead.
- **End-to-end automated tests for `cli-go/install.sh`.** Syntax is checked
  with `sh -n` and behavior is exercised manually as part of §6 on each
  release. There is no containerized install-rehearsal test on PRs. This is
  the only doc-tracked exemption from the "tested manually is not a
  substitute" rule in [`RULES.md`](RULES.md) — see "Test discipline" there.
  Changes to `install.sh` still need a §6 verification rehearsal on the
  next release.

---

## 9. Reference

- Release workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- PR CI workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
- Install script: [`cli-go/install.sh`](cli-go/install.sh)
- Build orchestration: [`cli-go/Makefile`](cli-go/Makefile)
- Version stamping: [`cli-go/main.go`](cli-go/main.go),
  [`cli-go/cmd/root.go`](cli-go/cmd/root.go) (`BuildInfo`)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog format)
