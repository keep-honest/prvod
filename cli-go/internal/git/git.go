// Package git wraps the local git invocations the CLI needs to assemble a job
// from the current repository. It mirrors the git helpers in
// src/cli/local-test.ts.
package git

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

const defaultGitMaxBufferMB = 64

// MaxBufferBytes resolves the git output buffer cap from CLI_GIT_MAX_BUFFER_MB,
// falling back to 64MB when unset or invalid.
func MaxBufferBytes(env func(string) string) int {
	parsed, err := strconv.Atoi(env("CLI_GIT_MAX_BUFFER_MB"))
	mb := defaultGitMaxBufferMB
	if err == nil && parsed > 0 {
		mb = parsed
	}
	return mb * 1024 * 1024
}

// exec runs `git <args...>` and returns trimmed stdout. It enforces the buffer
// cap so a runaway diff fails loudly rather than exhausting memory.
func gitExec(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), detail)
	}
	maxBytes := MaxBufferBytes(os.Getenv)
	if stdout.Len() > maxBytes {
		return "", fmt.Errorf(
			"git %s output exceeded buffer (%dMB). Increase CLI_GIT_MAX_BUFFER_MB and try again.",
			strings.Join(args, " "), maxBytes/(1024*1024),
		)
	}
	return strings.TrimSpace(stdout.String()), nil
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
	return "", fmt.Errorf("cannot parse repo from remote URL: %s", remoteURL)
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
	diffArgs := []string{"diff", "HEAD~1..HEAD"}
	if uncommitted {
		diffArgs = []string{"diff", "HEAD"}
	}
	diff, err := gitExec(diffArgs...)
	if err != nil {
		return nil, err
	}
	if diff == "" {
		return nil, fmt.Errorf("git diff returned empty output. Nothing to process.")
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
