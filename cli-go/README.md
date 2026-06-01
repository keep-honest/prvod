# prvodctl — Go CLI client for the prvod server

`prvodctl` is a self-contained Go CLI that drives the prvod server's jobs API to
generate PR videos. It is a 1:1 port of the Node CLI (`src/cli/local-test.ts`):
it gathers a git diff (or a diff file) locally, submits a job over HTTP, polls
until the job finishes, and prints the resulting script, TTS preview, or video
URL. All heavy lifting (script generation, TTS, video) happens server-side.

## Build

```bash
cd cli-go
go build -o prvodctl .
```

Requires Go 1.22+. Run the tests with `go test ./...`.

## Usage

```bash
prvodctl --server-url http://localhost:3000 --api-key <key> [options]
```

### Modes (mutually exclusive)

- **Normal** (default): builds a job from the current git repo
  (`git diff HEAD~1..HEAD`, origin remote, current branch, last commit subject).
- **`--diff-file <path>`**: streams a local unified-diff file to the server
  instead of using git.
- **`--retry-job <id>`**: retries a previously failed job.

### Flags

| Flag | Default / env | Description |
|------|---------------|-------------|
| `--server-url` | env `SERVER_URL` | Server endpoint (required) |
| `--api-key` | env `API_SECRET_KEY` | Bearer token (required) |
| `--config` | auto-discovered | Path to a YAML config file |
| `--script-only` | false | Skip video, return script JSON only |
| `--tts-only` | false | Stop after TTS, return script + audio |
| `--deepdive` | false | Reviewer-style deepdive narration |
| `--short-dur` | false | Short video (20–60s) |
| `--popcorn` | false | Popcorn video (~5 min) |
| `--output` | stdout | Write result to a file |
| `--uncommitted` | false | Use `git diff HEAD` (working tree) |
| `--pr-number` | 1 | PR number |
| `--title` | last commit subject | PR title |
| `--diff-file` | — | Local unified-diff file |
| `--retry-job` | — | Job ID to retry |
| `--max-polls` | env `CLI_MAX_POLLS`, unlimited | Max polling attempts |
| `--poll-interval-ms` | env `CLI_POLL_INTERVAL_MS`, 5000 | Poll interval (ms) |

`--script-only`/`--tts-only` and `--short-dur`/`--popcorn` are mutually exclusive.

## Configuration file

Settings can be supplied via a YAML file whose keys mirror the flag names:

```yaml
server-url: http://localhost:3000
api-key: pk_abc.secret
script-only: true
poll-interval-ms: 3000
```

### Discovery (first match wins)

1. `--config <path>` (an explicit path that can't be read is a fatal error)
2. `./prvodctl.yaml` or `./prvodctl.yml`
3. `$XDG_CONFIG_HOME/prvodctl/prvodctl.yaml` (or `~/.config/prvodctl/...`)
4. `~/.prvodctl.yaml`

### Precedence

For any setting: **explicit flag > environment variable > config file > default**.
Only `server-url`, `api-key`, `max-polls`, and `poll-interval-ms` have env
fallbacks (`SERVER_URL`, `API_SECRET_KEY`, `CLI_MAX_POLLS`,
`CLI_POLL_INTERVAL_MS`).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic error / job failed / timeout |
| 2 | `--diff-file` combined with a mutually exclusive flag |
| 3 | Diff file missing or empty |
| 4 | Diff file is not a unified diff (must start with `diff --git`) |
| 5 | Server `DIFF_TOO_LARGE` |
| 6 | Server `DIFF_PARSE_ERROR` |
| 7 | Server `DIFF_FETCH_TIMEOUT` |

## Examples

```bash
# Script only, from the last commit
prvodctl --server-url $SERVER_URL --api-key $API_SECRET_KEY --script-only

# TTS preview from the working tree, written to a file
prvodctl --uncommitted --tts-only --output out.json

# Upload a saved diff
prvodctl --diff-file changes.patch --popcorn

# Retry a failed job
prvodctl --retry-job 550e8400-e29b-41d4-a716-446655440000
```
