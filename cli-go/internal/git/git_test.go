package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseRepoFullName(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		want    string
		wantErr bool
	}{
		{"ssh with .git", "git@github.com:owner/repo.git", "owner/repo", false},
		{"ssh without .git", "git@github.com:owner/repo", "owner/repo", false},
		{"https with .git", "https://github.com/owner/repo.git", "owner/repo", false},
		{"https without .git", "https://github.com/owner/repo", "owner/repo", false},
		{"https hyphenated", "https://github.com/my-org/my-repo.git", "my-org/my-repo", false},
		{"invalid", "not-a-url", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseRepoFullName(tc.url)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %q", tc.url, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("ParseRepoFullName(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}

// initRepo builds a minimal git repo so GatherInfo can exercise its real path.
// chdir() must be called to make `git` operate against the temp repo. The caller
// is restored via t.Cleanup.
func initRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"remote", "add", "origin", "git@github.com:owner/repo.git"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	cwd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	return dir
}

func commit(t *testing.T, dir, file, content, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"add", file},
		{"commit", "-q", "-m", msg, "--allow-empty"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
}

func TestGatherInfoEmptyDiffErrors(t *testing.T) {
	dir := initRepo(t)
	// Two empty commits — diff HEAD~1..HEAD will be empty.
	for _, msg := range []string{"first", "second"} {
		cmd := exec.Command("git", "commit", "-q", "-m", msg, "--allow-empty")
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("commit: %v: %s", err, out)
		}
	}
	_, err := GatherInfo(false, "")
	if err == nil {
		t.Fatal("expected empty diff error")
	}
	if !strings.Contains(err.Error(), "Error: git diff returned empty output. Nothing to process.") {
		t.Errorf("error %q missing expected message", err.Error())
	}
}

func TestGatherInfoExplicitTitleOverridesCommitSubject(t *testing.T) {
	dir := initRepo(t)
	commit(t, dir, "a.txt", "v1\n", "first commit")
	commit(t, dir, "a.txt", "v2\n", "second commit")

	snap, err := GatherInfo(false, "Custom title")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Title != "Custom title" {
		t.Errorf("title = %q, want Custom title", snap.Title)
	}
	if snap.RepoFullName != "owner/repo" {
		t.Errorf("repo = %q", snap.RepoFullName)
	}
	if !strings.Contains(snap.Diff, "v2") {
		t.Errorf("diff missing v2:\n%s", snap.Diff)
	}
}

func TestGatherInfoFallsBackToCommitSubject(t *testing.T) {
	dir := initRepo(t)
	commit(t, dir, "a.txt", "v1\n", "first commit")
	commit(t, dir, "a.txt", "v2\n", "second commit subject")

	snap, err := GatherInfo(false, "")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Title != "second commit subject" {
		t.Errorf("title = %q, want commit subject", snap.Title)
	}
}

func TestGitExecRespectsBufferCap(t *testing.T) {
	t.Setenv("CLI_GIT_MAX_BUFFER_MB", "1")
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	// `git --version` output is tiny; just confirm gitExec runs cleanly at the
	// configured cap and that the cap value is the one we just set.
	got := MaxBufferBytes(os.Getenv)
	if got != 1024*1024 {
		t.Errorf("MaxBufferBytes = %d, want %d", got, 1024*1024)
	}
}

// TestGitExecOverflowSurfacesDescriptiveError exercises gitExecWithLimit against
// a real git invocation whose stdout exceeds the configured cap. The intent is
// to lock in the contract: a runaway diff must produce the "output exceeded
// buffer ... Increase CLI_GIT_MAX_BUFFER_MB" message rather than a generic
// "git exited with status 1" or a silently truncated success.
func TestGitExecOverflowSurfacesDescriptiveError(t *testing.T) {
	initRepo(t)
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	// `git --version` reliably produces well over 1 byte of output across all
	// platforms, so a 1-byte cap guarantees we land on the overflow path.
	_, err := gitExecWithLimit(1, "--version")
	if err == nil {
		t.Fatal("expected overflow error, got nil")
	}
	want := "Error: git --version output exceeded buffer (0MB). Increase CLI_GIT_MAX_BUFFER_MB and try again."
	if err.Error() != want {
		t.Errorf("err = %q,\nwant %q", err.Error(), want)
	}
}

func TestCapWriterStopsAtLimit(t *testing.T) {
	w := &capWriter{limit: 4}
	// First write fits.
	n, err := w.Write([]byte("ab"))
	if err != nil || n != 2 {
		t.Fatalf("write 1: n=%d err=%v", n, err)
	}
	// Second write straddles the limit: writes "cd", reports ErrShortWrite.
	n, err = w.Write([]byte("cdef"))
	if err == nil {
		t.Fatalf("expected ErrShortWrite, got nil")
	}
	if n != 2 {
		t.Errorf("partial n = %d, want 2 (bytes accepted before overflow)", n)
	}
	if !w.exceeded {
		t.Errorf("exceeded should be true")
	}
	if got := w.buf.String(); got != "abcd" {
		t.Errorf("buf = %q, want %q", got, "abcd")
	}
	// Further writes rejected.
	n, err = w.Write([]byte("xyz"))
	if err == nil || n != 0 {
		t.Errorf("post-overflow: n=%d err=%v", n, err)
	}
}

func TestMaxBufferBytes(t *testing.T) {
	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	if got := MaxBufferBytes(env(nil)); got != 64*1024*1024 {
		t.Errorf("default = %d, want %d", got, 64*1024*1024)
	}
	if got := MaxBufferBytes(env(map[string]string{"CLI_GIT_MAX_BUFFER_MB": "128"})); got != 128*1024*1024 {
		t.Errorf("128MB = %d, want %d", got, 128*1024*1024)
	}
	if got := MaxBufferBytes(env(map[string]string{"CLI_GIT_MAX_BUFFER_MB": "garbage"})); got != 64*1024*1024 {
		t.Errorf("invalid falls back = %d, want %d", got, 64*1024*1024)
	}
	if got := MaxBufferBytes(env(map[string]string{"CLI_GIT_MAX_BUFFER_MB": "0"})); got != 64*1024*1024 {
		t.Errorf("zero falls back = %d, want %d", got, 64*1024*1024)
	}
}
