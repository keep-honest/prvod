// Package git wraps the local git invocations the CLI needs to assemble a job
// from the current repository. It mirrors the git helpers in
// src/cli/local-test.ts.
package git

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

const defaultGitMaxBufferMB = 64

// StreamDiffDefaultMaxBufferMB is the default buffer cap when --stream-diff is
// active. The streaming server branch accepts up to 100 MB; we give the local
// git capture 10 MB of headroom so the diff actually fits before the server
// cap fires. CLI_GIT_MAX_BUFFER_MB still wins when set.
const StreamDiffDefaultMaxBufferMB = 110

// MaxBufferBytes resolves the git output buffer cap from CLI_GIT_MAX_BUFFER_MB,
// falling back to 64MB when unset or invalid.
func MaxBufferBytes(env func(string) string) int {
	return MaxBufferBytesWithDefault(env, defaultGitMaxBufferMB)
}

// MaxBufferBytesWithDefault is the variant of MaxBufferBytes that lets the
// caller override the fallback used when CLI_GIT_MAX_BUFFER_MB is unset or
// invalid. The env value still takes precedence.
func MaxBufferBytesWithDefault(env func(string) string, defaultMB int) int {
	parsed, err := strconv.Atoi(env("CLI_GIT_MAX_BUFFER_MB"))
	mb := defaultMB
	if err == nil && parsed > 0 {
		mb = parsed
	}
	return mb * 1024 * 1024
}

// gitExec runs `git <args...>` and returns trimmed stdout. Stdout is captured
// through a bounded writer so a runaway diff fails before exhausting memory,
// mirroring the Node CLI's pipe-level maxBuffer guard.
func gitExec(args ...string) (string, error) {
	return gitExecWithLimit(MaxBufferBytes(os.Getenv), args...)
}

// gitExecWithDefault behaves like gitExec but uses defaultMB as the fallback
// buffer cap when CLI_GIT_MAX_BUFFER_MB is unset. Used by --stream-diff so the
// local git buffer matches the 100 MB upload branch by default.
func gitExecWithDefault(defaultMB int, args ...string) (string, error) {
	return gitExecWithLimit(MaxBufferBytesWithDefault(os.Getenv, defaultMB), args...)
}

// gitExecWithLimit is the limit-injectable form of gitExec, separated so tests
// can exercise the buffer-overflow path without producing megabytes of output.
func gitExecWithLimit(maxBytes int, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	stdout := &capWriter{limit: maxBytes}
	var stderr bytes.Buffer
	cmd.Stdout = stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if stdout.exceeded {
		// Overflow can land on either the success or failure side of cmd.Run
		// (depending on git's exit ordering vs. the bounded write), so surface
		// the same descriptive error in both cases.
		return "", fmt.Errorf(
			"Error: git %s output exceeded buffer (%dMB). Increase CLI_GIT_MAX_BUFFER_MB and try again.",
			strings.Join(args, " "), maxBytes/(1024*1024),
		)
	}
	if runErr != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = runErr.Error()
		}
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), detail)
	}
	return strings.TrimSpace(stdout.buf.String()), nil
}

// capWriter buffers up to `limit` bytes and reports an error to the child once
// the limit is exceeded so the kernel/Go runtime can tear down the pipe. The
// underlying buffer is left at exactly `limit` bytes so a final read can still
// drain its tail without unbounded growth.
type capWriter struct {
	buf      bytes.Buffer
	limit    int
	exceeded bool
}

// Write honors the io.Writer contract: n reflects bytes accepted into the
// buffer before the limit was hit. Once exceeded, subsequent writes are
// rejected to back-pressure the child process and stop it producing output.
func (w *capWriter) Write(p []byte) (int, error) {
	if w.exceeded {
		return 0, io.ErrShortWrite
	}
	remaining := w.limit - w.buf.Len()
	if len(p) <= remaining {
		return w.buf.Write(p)
	}
	n := 0
	if remaining > 0 {
		written, _ := w.buf.Write(p[:remaining])
		n = written
	}
	w.exceeded = true
	return n, io.ErrShortWrite
}

var (
	// SSH: git@github.com:owner/repo.git
	sshRe = regexp.MustCompile(`:([^/]+/[^/]+?)(?:\.git)?$`)
	// HTTPS: https://github.com/owner/repo.git
	httpsRe = regexp.MustCompile(`/([^/]+/[^/]+?)(?:\.git)?$`)
)

// ParseRepoFullName extracts "owner/repo" from a git remote URL (SSH or HTTPS).
func ParseRepoFullName(remoteURL string) (string, error) {
	if m := sshRe.FindStringSubmatch(remoteURL); m != nil {
		return m[1], nil
	}
	if m := httpsRe.FindStringSubmatch(remoteURL); m != nil {
		return m[1], nil
	}
	return "", fmt.Errorf("Cannot parse repo from remote URL: %s", remoteURL)
}

// Snapshot is the git context used to build a create-job payload.
type Snapshot struct {
	Diff         string
	RepoFullName string
	HeadBranch   string
	Title        string
}

// GatherInfo collects the diff, repo, branch and title from the local repo.
// When uncommitted is true it diffs the working tree (git diff HEAD) instead of
// the last commit (git diff HEAD~1..HEAD). An explicit title overrides the last
// commit subject. An empty diff is reported as an error.
func GatherInfo(uncommitted bool, title string) (*Snapshot, error) {
	return GatherInfoWithDiffMaxMB(uncommitted, title, defaultGitMaxBufferMB)
}

// GatherInfoWithDiffMaxMB is GatherInfo with a configurable default cap for the
// `git diff` invocation only; metadata commands (remote/branch/log) stay on
// the standard default. Used by --stream-diff to size the diff buffer to the
// 100 MB upload branch without raising caps that don't need raising.
func GatherInfoWithDiffMaxMB(uncommitted bool, title string, diffDefaultMB int) (*Snapshot, error) {
	diffArgs := []string{"diff", "HEAD~1..HEAD"}
	if uncommitted {
		diffArgs = []string{"diff", "HEAD"}
	}
	diff, err := gitExecWithDefault(diffDefaultMB, diffArgs...)
	if err != nil {
		return nil, err
	}
	if diff == "" {
		return nil, fmt.Errorf("Error: git diff returned empty output. Nothing to process.")
	}

	remoteURL, err := gitExec("remote", "get-url", "origin")
	if err != nil {
		return nil, err
	}
	repoFullName, err := ParseRepoFullName(remoteURL)
	if err != nil {
		return nil, err
	}
	headBranch, err := gitExec("branch", "--show-current")
	if err != nil {
		return nil, err
	}
	if title == "" {
		title, err = gitExec("log", "-1", "--pretty=%s")
		if err != nil {
			return nil, err
		}
	}

	return &Snapshot{
		Diff:         diff,
		RepoFullName: repoFullName,
		HeadBranch:   headBranch,
		Title:        title,
	}, nil
}
