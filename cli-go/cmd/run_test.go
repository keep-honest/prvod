package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/keep-honest/prvod/cli-go/internal/client"
)

// fakeJobServer is a minimal httptest harness for run* tests. It records every
// call and lets the test specify per-endpoint JSON bodies and status codes.
type fakeJobServer struct {
	mu            sync.Mutex
	calls         []string
	createBody    []byte
	createCT      string
	createDiffSrc string
	createQuery   string
	createCLen    int64
	create        string
	retry         string
	pollSeq       []string
	pollNext      int
	status        int
}

func newFakeJobServer(t *testing.T) (*fakeJobServer, *httptest.Server) {
	t.Helper()
	f := &fakeJobServer{status: http.StatusOK}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path)
		var body string
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/retry"):
			body = f.retry
		case r.Method == http.MethodPost && r.URL.Path == "/api/jobs":
			f.createCT = r.Header.Get("Content-Type")
			f.createDiffSrc = r.Header.Get("X-Diff-Source")
			f.createQuery = r.URL.RawQuery
			f.createCLen = r.ContentLength
			f.createBody, _ = io.ReadAll(r.Body)
			body = f.create
		default:
			if f.pollNext < len(f.pollSeq) {
				body = f.pollSeq[f.pollNext]
				f.pollNext++
			} else if len(f.pollSeq) > 0 {
				body = f.pollSeq[len(f.pollSeq)-1]
			}
		}
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(body))
	}))
	return f, srv
}

func TestRunRetrySuccess(t *testing.T) {
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.retry = `{"id":"j1","status":"queued"}`
	f.pollSeq = []string{
		`{"id":"j1","status":"processing"}`,
		`{"id":"j1","status":"completed","videoUrl":"https://v"}`,
	}

	c := client.New(srv.URL, "k")
	var buf bytes.Buffer
	err := runRetry(c, &options{serverURL: srv.URL, apiKey: "k", retryJob: "j1"}, time.Millisecond, &buf)
	if err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if !strings.Contains(out, "Retry initiated:") {
		t.Errorf("missing initiated line:\n%s", out)
	}
	if !strings.Contains(out, "Retry succeeded! Video URL: https://v") {
		t.Errorf("missing success line:\n%s", out)
	}
}

func TestRunRetryFailed(t *testing.T) {
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.retry = `{"id":"j1","status":"processing"}`
	f.pollSeq = []string{`{"id":"j1","status":"failed","errorMessage":"boom"}`}

	c := client.New(srv.URL, "k")
	err := runRetry(c, &options{serverURL: srv.URL, apiKey: "k", retryJob: "j1"}, time.Millisecond, io.Discard)
	var ce *CodedError
	if !errors.As(err, &ce) || ce.Code != 1 {
		t.Fatalf("expected coded error code=1, got %v", err)
	}
	if !strings.Contains(ce.Err.Error(), "Retry failed: boom") {
		t.Errorf("wrong message: %v", ce.Err)
	}
}

// TestRunRetryFailedSwapsKnownCodeForFriendlyMessage verifies that when the
// server reports a known errorCode, the CLI surfaces the user-facing mapping
// instead of the raw errorMessage (which may contain provider stack traces).
func TestRunRetryFailedSwapsKnownCodeForFriendlyMessage(t *testing.T) {
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.retry = `{"id":"j1","status":"processing"}`
	f.pollSeq = []string{`{"id":"j1","status":"failed","errorCode":"LLM_RATE_LIMITED_EXHAUSTED","errorMessage":"gemini CLI exited 0 ... stack trace ..."}`}

	c := client.New(srv.URL, "k")
	err := runRetry(c, &options{serverURL: srv.URL, apiKey: "k", retryJob: "j1"}, time.Millisecond, io.Discard)
	var ce *CodedError
	if !errors.As(err, &ce) || ce.Code != 1 {
		t.Fatalf("expected coded error code=1, got %v", err)
	}
	if !strings.Contains(ce.Err.Error(), "AI provider is at capacity") {
		t.Errorf("expected friendly message, got: %v", ce.Err)
	}
	if strings.Contains(ce.Err.Error(), "stack trace") {
		t.Errorf("raw provider message leaked through: %v", ce.Err)
	}
	// The structured errorCode must still appear in parens so the user can
	// quote it to support and correlate with server logs (mirrors the
	// diffJobFailure path).
	if !strings.Contains(ce.Err.Error(), "(LLM_RATE_LIMITED_EXHAUSTED)") {
		t.Errorf("expected errorCode parenthetical in message, got: %v", ce.Err)
	}
}

func TestRunRetryTimesOut(t *testing.T) {
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.retry = `{"id":"j1","status":"processing"}`
	f.pollSeq = []string{`{"id":"j1","status":"processing"}`}
	max := 1
	c := client.New(srv.URL, "k")
	err := runRetry(c, &options{
		serverURL: srv.URL, apiKey: "k", retryJob: "j1", maxPolls: &max,
	}, time.Millisecond, io.Discard)
	var ce *CodedError
	if !errors.As(err, &ce) || ce.Code != 1 {
		t.Fatalf("expected coded error code=1, got %v", err)
	}
	if !strings.Contains(ce.Err.Error(), "did not complete in time") {
		t.Errorf("wrong message: %v", ce.Err)
	}
}

func TestRunDiffFileSuccess(t *testing.T) {
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.create = `{"id":"d1","status":"queued"}`
	f.pollSeq = []string{`{"id":"d1","status":"completed","videoUrl":"https://v"}`}

	dir := t.TempDir()
	diffPath := filepath.Join(dir, "x.diff")
	if err := os.WriteFile(diffPath, []byte("diff --git a/x b/x\n+line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	outPath := filepath.Join(dir, "out.json")

	c := client.New(srv.URL, "k")
	err := runDiffFile(c, &options{
		serverURL: srv.URL, apiKey: "k", diffFile: diffPath, output: outPath,
	}, time.Millisecond, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("invalid JSON written: %v", err)
	}
	if parsed["videoUrl"] != "https://v" {
		t.Errorf("videoUrl = %v", parsed["videoUrl"])
	}
}

func TestRunDiffFileMapsServerErrorCodes(t *testing.T) {
	cases := []struct {
		code     string
		wantExit int
	}{
		{"DIFF_TOO_LARGE", 5},
		{"DIFF_PARSE_ERROR", 6},
		{"DIFF_FETCH_TIMEOUT", 7},
		{"WHATEVER", 1},
	}
	dir := t.TempDir()
	diffPath := filepath.Join(dir, "x.diff")
	if err := os.WriteFile(diffPath, []byte("diff --git a/x b/x\n+line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			f, srv := newFakeJobServer(t)
			defer srv.Close()
			f.create = `{"id":"d1","status":"queued"}`
			f.pollSeq = []string{`{"id":"d1","status":"failed","errorCode":"` + tc.code + `","errorMessage":"x"}`}
			c := client.New(srv.URL, "k")
			err := runDiffFile(c, &options{
				serverURL: srv.URL, apiKey: "k", diffFile: diffPath,
			}, time.Millisecond, io.Discard)
			var ce *CodedError
			if !errors.As(err, &ce) {
				t.Fatalf("expected *CodedError, got %v", err)
			}
			if ce.Code != tc.wantExit {
				t.Errorf("exit = %d, want %d", ce.Code, tc.wantExit)
			}
		})
	}
}

func TestResolveMaxPollsRejectsExplicitZero(t *testing.T) {
	base := map[string]string{"server-url": "http://x", "api-key": "k"}
	// Flag explicitly set to 0 must error (matches Node CLI exit 1).
	_, err := resolve(t, clone(base, map[string]string{"max-polls": "0"}), "")
	wantCode(t, err, 1)
}

func TestResolveMaxPollsRejectsZeroFromEnv(t *testing.T) {
	t.Setenv("CLI_MAX_POLLS", "0")
	_, err := resolve(t, map[string]string{"server-url": "http://x", "api-key": "k"}, "")
	wantCode(t, err, 1)
}

func TestResolveDiffFileAllMutuallyExclusiveFlags(t *testing.T) {
	dir := t.TempDir()
	ok := filepath.Join(dir, "ok.diff")
	if err := os.WriteFile(ok, []byte(validDiff), 0o644); err != nil {
		t.Fatal(err)
	}
	base := map[string]string{"server-url": "http://x", "api-key": "k", "diff-file": ok}
	cases := []struct {
		flag  string
		value string
	}{
		{"pr-number", "5"},
		{"title", "Custom"},
		{"uncommitted", "true"},
		{"retry-job", "job-123"},
	}
	for _, tc := range cases {
		t.Run(tc.flag, func(t *testing.T) {
			_, err := resolve(t, clone(base, map[string]string{tc.flag: tc.value}), "")
			wantCode(t, err, 2)
			if !strings.Contains(err.Error(), "--"+tc.flag) {
				t.Errorf("error %q missing flag name --%s", err.Error(), tc.flag)
			}
		})
	}
}

// initRepoForRunNormal builds a minimal git repo with two commits so the
// `git diff HEAD~1..HEAD` invocation in runNormal returns non-empty output.
// The caller's cwd is restored via t.Cleanup.
func initRepoForRunNormal(t *testing.T) string {
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
		c := exec.Command("git", args...)
		c.Dir = dir
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	for _, step := range []struct{ file, content, msg string }{
		{"a.txt", "v1\n", "first commit"},
		{"a.txt", "v2\n", "second commit subject"},
	} {
		if err := os.WriteFile(filepath.Join(dir, step.file), []byte(step.content), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{
			{"add", step.file},
			{"commit", "-q", "-m", step.msg},
		} {
			c := exec.Command("git", args...)
			c.Dir = dir
			if out, err := c.CombinedOutput(); err != nil {
				t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
			}
		}
	}
	cwd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	return dir
}

func TestRunNormalSuccessPostsContractPayload(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.create = `{"id":"n1","status":"queued"}`
	f.pollSeq = []string{`{"id":"n1","status":"completed","videoUrl":"https://v"}`}

	c := client.New(srv.URL, "k")
	var buf bytes.Buffer
	opts := &options{
		serverURL: srv.URL, apiKey: "k",
		prNumber: 7,
		popcorn:  true,
	}
	if err := runNormal(c, opts, time.Millisecond, &buf); err != nil {
		t.Fatal(err)
	}

	// Verify the payload field set + defaults match the Node CLI contract.
	var payload map[string]any
	if err := json.Unmarshal(f.createBody, &payload); err != nil {
		t.Fatalf("invalid posted JSON: %v\nbody=%s", err, string(f.createBody))
	}
	wantStrings := map[string]string{
		"repoFullName":  "owner/repo",
		"prTitle":       "second commit subject",
		"prDescription": "",
		"baseBranch":    "main",
		"headBranch":    "main",
		"durationMode":  "popcorn",
	}
	for k, want := range wantStrings {
		if got, _ := payload[k].(string); got != want {
			t.Errorf("payload[%q] = %v, want %q", k, payload[k], want)
		}
	}
	if got, _ := payload["prNumber"].(float64); got != 7 {
		t.Errorf("prNumber = %v, want 7", payload["prNumber"])
	}
	for _, k := range []string{"scriptOnly", "ttsOnly", "deepdive", "isPrivate"} {
		if got, _ := payload[k].(bool); got {
			t.Errorf("payload[%q] = true, want false", k)
		}
	}
	if _, ok := payload["issues"].([]any); !ok {
		t.Errorf("payload.issues should be empty array, got %T", payload["issues"])
	}
	if payload["milestone"] != nil {
		t.Errorf("payload.milestone = %v, want nil", payload["milestone"])
	}
	if diff, _ := payload["diff"].(string); !strings.Contains(diff, "v2") {
		t.Errorf("payload.diff missing v2 marker: %q", diff)
	}

	out := buf.String()
	if !strings.Contains(out, "\nVideo URL: https://v\n") {
		t.Errorf("missing video URL line:\n%s", out)
	}
	if !strings.Contains(out, "Repo:        owner/repo") {
		t.Errorf("missing repo header:\n%s", out)
	}
}

func TestRunNormalFailedWithErrorCode(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.create = `{"id":"n1","status":"queued"}`
	f.pollSeq = []string{`{"id":"n1","status":"failed","errorCode":"OOPS","errorMessage":"server explosion"}`}

	c := client.New(srv.URL, "k")
	err := runNormal(c, &options{
		serverURL: srv.URL, apiKey: "k", prNumber: 1,
	}, time.Millisecond, io.Discard)

	var ce *CodedError
	if !errors.As(err, &ce) || ce.Code != 1 {
		t.Fatalf("expected coded error code=1, got %v", err)
	}
	if !strings.Contains(ce.Err.Error(), "Job failed (OOPS): server explosion") {
		t.Errorf("wrong message: %v", ce.Err)
	}
}

func TestRunNormalTimesOut(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.create = `{"id":"n1","status":"queued"}`
	f.pollSeq = []string{`{"id":"n1","status":"processing"}`}
	max := 1

	c := client.New(srv.URL, "k")
	err := runNormal(c, &options{
		serverURL: srv.URL, apiKey: "k", prNumber: 1, maxPolls: &max,
	}, time.Millisecond, io.Discard)

	var ce *CodedError
	if !errors.As(err, &ce) || ce.Code != 1 {
		t.Fatalf("expected coded error code=1, got %v", err)
	}
	if !strings.Contains(ce.Err.Error(), "did not complete in time") {
		t.Errorf("wrong message: %v", ce.Err)
	}
}

// --- --stream-diff tests ---

func TestResolveStreamDiffMutex(t *testing.T) {
	dir := t.TempDir()
	okDiff := filepath.Join(dir, "ok.diff")
	if err := os.WriteFile(okDiff, []byte(validDiff), 0o644); err != nil {
		t.Fatal(err)
	}
	base := map[string]string{"server-url": "http://x", "api-key": "k"}

	cases := []struct {
		name   string
		extras map[string]string
	}{
		{"stream-diff + diff-file", map[string]string{"stream-diff": "true", "diff-file": okDiff}},
		{"stream-diff + retry-job", map[string]string{"stream-diff": "true", "retry-job": "abc"}},
		{"stream-diff + pr-number", map[string]string{"stream-diff": "true", "pr-number": "5"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := resolve(t, clone(base, tc.extras), "")
			wantCode(t, err, 2)
		})
	}
}

func TestResolveStreamDiffCompatibleFlags(t *testing.T) {
	base := map[string]string{"server-url": "http://x", "api-key": "k", "stream-diff": "true"}
	for _, extras := range []map[string]string{
		{"title": "Custom"},
		{"uncommitted": "true"},
		{"script-only": "true"},
		{"tts-only": "true"},
		{"short-dur": "true"},
		{"popcorn": "true"},
	} {
		opts, err := resolve(t, clone(base, extras), "")
		if err != nil {
			t.Fatalf("unexpected error for extras %v: %v", extras, err)
		}
		if !opts.streamDiff {
			t.Errorf("streamDiff should be true for extras %v", extras)
		}
	}
}

// --- default-streaming semantics ---

func TestResolveStreamDiffIsDefaultTrue(t *testing.T) {
	opts, err := resolve(t, map[string]string{"server-url": "http://x", "api-key": "k"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !opts.streamDiff {
		t.Errorf("streamDiff should default to true; got false")
	}
}

func TestResolveNoStreamDiffOptsOut(t *testing.T) {
	opts, err := resolve(t, map[string]string{
		"server-url":     "http://x",
		"api-key":        "k",
		"no-stream-diff": "true",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if opts.streamDiff {
		t.Errorf("--no-stream-diff should produce streamDiff=false")
	}
}

func TestResolveStreamDiffAndNoStreamDiffConflict(t *testing.T) {
	_, err := resolve(t, map[string]string{
		"server-url":     "http://x",
		"api-key":        "k",
		"stream-diff":    "true",
		"no-stream-diff": "true",
	}, "")
	wantCode(t, err, 2)
}

func TestResolvePrNumberWithDefaultStreamingErrors(t *testing.T) {
	// User didn't pass --stream-diff but default is true, so --pr-number
	// must error with the --no-stream-diff hint.
	_, err := resolve(t, map[string]string{
		"server-url": "http://x",
		"api-key":    "k",
		"pr-number":  "5",
	}, "")
	wantCode(t, err, 2)
	if err != nil && !strings.Contains(err.Error(), "--no-stream-diff") {
		t.Errorf("error should mention --no-stream-diff as the fix: %v", err)
	}
}

func TestResolvePrNumberWithNoStreamDiffOK(t *testing.T) {
	opts, err := resolve(t, map[string]string{
		"server-url":     "http://x",
		"api-key":        "k",
		"no-stream-diff": "true",
		"pr-number":      "42",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if opts.streamDiff {
		t.Errorf("streamDiff should be false")
	}
	if opts.prNumber != 42 {
		t.Errorf("prNumber = %d, want 42", opts.prNumber)
	}
}

func TestResolveDiffFileAloneOKWithDefaultStreaming(t *testing.T) {
	dir := t.TempDir()
	okDiff := filepath.Join(dir, "ok.diff")
	if err := os.WriteFile(okDiff, []byte(validDiff), 0o644); err != nil {
		t.Fatal(err)
	}
	// Plain --diff-file invocations should not be broken by the new
	// streaming default; the default-true streamDiff is irrelevant in
	// diff-file mode.
	opts, err := resolve(t, map[string]string{
		"server-url": "http://x",
		"api-key":    "k",
		"diff-file":  okDiff,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if opts.diffFile == "" {
		t.Errorf("diffFile should be set")
	}
}

func TestResolveRetryJobAloneOKWithDefaultStreaming(t *testing.T) {
	opts, err := resolve(t, map[string]string{
		"server-url": "http://x",
		"api-key":    "k",
		"retry-job":  "abc-123",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if opts.retryJob != "abc-123" {
		t.Errorf("retryJob = %q, want abc-123", opts.retryJob)
	}
}

// --stream-diff=false (the opt-out form) must coexist with --diff-file and
// --retry-job, matching --no-stream-diff. Round-2 caught these treating
// "explicit anything" as a conflict instead of "explicit ON".
func TestResolveStreamDiffEqualsFalseCoexistsWithDiffFile(t *testing.T) {
	dir := t.TempDir()
	okDiff := filepath.Join(dir, "ok.diff")
	if err := os.WriteFile(okDiff, []byte(validDiff), 0o644); err != nil {
		t.Fatal(err)
	}
	opts, err := resolve(t, map[string]string{
		"server-url":  "http://x",
		"api-key":     "k",
		"stream-diff": "false",
		"diff-file":   okDiff,
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.streamDiff {
		t.Errorf("streamDiff should be false")
	}
	if opts.diffFile == "" {
		t.Errorf("diffFile should be set")
	}
}

func TestResolveStreamDiffEqualsFalseCoexistsWithRetryJob(t *testing.T) {
	opts, err := resolve(t, map[string]string{
		"server-url":  "http://x",
		"api-key":     "k",
		"stream-diff": "false",
		"retry-job":   "abc-123",
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.streamDiff {
		t.Errorf("streamDiff should be false")
	}
	if opts.retryJob != "abc-123" {
		t.Errorf("retryJob = %q", opts.retryJob)
	}
}

func TestResolveNoStreamDiffCoexistsWithDiffFile(t *testing.T) {
	dir := t.TempDir()
	okDiff := filepath.Join(dir, "ok.diff")
	if err := os.WriteFile(okDiff, []byte(validDiff), 0o644); err != nil {
		t.Fatal(err)
	}
	opts, err := resolve(t, map[string]string{
		"server-url":     "http://x",
		"api-key":        "k",
		"no-stream-diff": "true",
		"diff-file":      okDiff,
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.streamDiff {
		t.Errorf("streamDiff should be false")
	}
}

func TestResolveStreamDiffEqualsFalseOptsOut(t *testing.T) {
	// --stream-diff=false is the pflag-native opt-out form; should behave
	// identically to --no-stream-diff.
	opts, err := resolve(t, map[string]string{
		"server-url":  "http://x",
		"api-key":     "k",
		"stream-diff": "false",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if opts.streamDiff {
		t.Errorf("--stream-diff=false should produce streamDiff=false")
	}
}

func TestResolvePrNumberFromConfigErrorsUnderDefaultStreaming(t *testing.T) {
	// `pr-number: 42` in YAML must be detected as explicit and rejected the
	// same way an explicit --pr-number flag is, so a real PR number can't
	// be silently dropped by the streaming default.
	cfg := writeFile(t, "prvodctl.yaml",
		"server-url: http://x\napi-key: k\npr-number: 42\n")
	_, err := resolve(t, nil, cfg)
	wantCode(t, err, 2)
	if err != nil && !strings.Contains(err.Error(), "--no-stream-diff") {
		t.Errorf("error should mention --no-stream-diff: %v", err)
	}
}

// TestRunNormalDefaultStreamsViaResolveOptions verifies the end-to-end flow:
// with zero stream-related flags, resolveOptions resolves to streamDiff=true
// and runNormal posts to the streaming wire branch.
func TestRunNormalDefaultStreamsViaResolveOptions(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.create = `{"id":"s1","status":"queued"}`
	f.pollSeq = []string{`{"id":"s1","status":"completed","videoUrl":"https://v"}`}

	opts, err := resolve(t, map[string]string{
		"server-url": srv.URL,
		"api-key":    "k",
	}, "")
	if err != nil {
		t.Fatalf("resolveOptions failed: %v", err)
	}
	if !opts.streamDiff {
		t.Fatalf("expected default streamDiff=true after resolveOptions")
	}

	c := client.New(opts.serverURL, opts.apiKey)
	if err := runNormal(c, opts, time.Millisecond, io.Discard); err != nil {
		t.Fatal(err)
	}

	if f.createCT != "application/x-git-diff" {
		t.Errorf("Content-Type = %q, want application/x-git-diff (streaming was not used by default)", f.createCT)
	}
	if f.createDiffSrc != "local-stream" {
		t.Errorf("X-Diff-Source = %q, want local-stream", f.createDiffSrc)
	}
}

// TestRunNormalNoStreamDiffUsesJSONBranch verifies that --no-stream-diff
// resolves through to the legacy JSON wire path.
func TestRunNormalNoStreamDiffUsesJSONBranch(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.create = `{"id":"n1","status":"queued"}`
	f.pollSeq = []string{`{"id":"n1","status":"completed","videoUrl":"https://v"}`}

	opts, err := resolve(t, map[string]string{
		"server-url":     srv.URL,
		"api-key":        "k",
		"no-stream-diff": "true",
		"pr-number":      "7",
	}, "")
	if err != nil {
		t.Fatalf("resolveOptions failed: %v", err)
	}
	if opts.streamDiff {
		t.Fatalf("expected streamDiff=false after --no-stream-diff")
	}
	if opts.prNumber != 7 {
		t.Fatalf("prNumber = %d, want 7 (--no-stream-diff should preserve --pr-number)", opts.prNumber)
	}

	c := client.New(opts.serverURL, opts.apiKey)
	if err := runNormal(c, opts, time.Millisecond, io.Discard); err != nil {
		t.Fatal(err)
	}

	if f.createCT != "application/json" {
		t.Errorf("Content-Type = %q, want application/json (--no-stream-diff should use legacy JSON)", f.createCT)
	}
	var payload map[string]any
	if err := json.Unmarshal(f.createBody, &payload); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if pn, _ := payload["prNumber"].(float64); pn != 7 {
		t.Errorf("payload.prNumber = %v, want 7", payload["prNumber"])
	}
}

func TestRunStreamDiffSuccessPostsStreamingBody(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.create = `{"id":"s1","status":"queued"}`
	f.pollSeq = []string{`{"id":"s1","status":"completed","videoUrl":"https://v"}`}

	c := client.New(srv.URL, "k")
	var buf bytes.Buffer
	opts := &options{
		serverURL: srv.URL, apiKey: "k",
		prNumber:   1,
		streamDiff: true,
		popcorn:    true,
	}
	if err := runNormal(c, opts, time.Millisecond, &buf); err != nil {
		t.Fatal(err)
	}

	if f.createCT != "application/x-git-diff" {
		t.Errorf("Content-Type = %q, want application/x-git-diff", f.createCT)
	}
	if f.createDiffSrc != "local-stream" {
		t.Errorf("X-Diff-Source = %q, want local-stream", f.createDiffSrc)
	}
	if f.createCLen <= 0 {
		t.Errorf("Content-Length = %d, want > 0", f.createCLen)
	}
	for _, want := range []string{
		"scriptOnly=false",
		"ttsOnly=false",
		"deepdive=false",
		"durationMode=popcorn",
		// prTitle uses URL encoding for the space.
		"prTitle=second+commit+subject",
	} {
		if !strings.Contains(f.createQuery, want) {
			t.Errorf("query %q missing %q", f.createQuery, want)
		}
	}
	if !strings.Contains(string(f.createBody), "v2") {
		t.Errorf("body missing v2 marker:\n%s", string(f.createBody))
	}

	out := buf.String()
	if !strings.Contains(out, "Creating job (streaming diff)...") {
		t.Errorf("missing streaming-mode banner:\n%s", out)
	}
	if !strings.Contains(out, "Repo:        owner/repo") {
		t.Errorf("missing normal-mode header:\n%s", out)
	}
	if !strings.Contains(out, "\nVideo URL: https://v\n") {
		t.Errorf("missing video URL line:\n%s", out)
	}
}

func TestRunStreamDiffMapsServerErrorCodes(t *testing.T) {
	initRepoForRunNormal(t)
	cases := []struct {
		code     string
		wantExit int
	}{
		{"DIFF_TOO_LARGE", 5},
		{"DIFF_PARSE_ERROR", 6},
		{"DIFF_FETCH_TIMEOUT", 7},
		{"WHATEVER", 1},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			f, srv := newFakeJobServer(t)
			defer srv.Close()
			f.create = `{"id":"s1","status":"queued"}`
			f.pollSeq = []string{`{"id":"s1","status":"failed","errorCode":"` + tc.code + `","errorMessage":"x"}`}
			c := client.New(srv.URL, "k")
			err := runNormal(c, &options{
				serverURL: srv.URL, apiKey: "k", prNumber: 1, streamDiff: true,
			}, time.Millisecond, io.Discard)
			var ce *CodedError
			if !errors.As(err, &ce) {
				t.Fatalf("expected *CodedError, got %v", err)
			}
			if ce.Code != tc.wantExit {
				t.Errorf("exit = %d, want %d", ce.Code, tc.wantExit)
			}
		})
	}
}

// A 413 returned by POST /api/jobs (before the job exists) must surface as
// exit code 5, matching the README's DIFF_TOO_LARGE contract. Before the fix
// this exited with the generic code 1 because diff-error mapping only ran on
// post-create polling failures.
func TestRunStreamDiffMapsCreateTime413ToExit5(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.status = http.StatusRequestEntityTooLarge
	f.create = `{"error":"DIFF_TOO_LARGE","message":"Diff file exceeds 100 MB limit"}`

	c := client.New(srv.URL, "k")
	err := runNormal(c, &options{
		serverURL: srv.URL, apiKey: "k", prNumber: 1, streamDiff: true,
	}, time.Millisecond, io.Discard)

	var ce *CodedError
	if !errors.As(err, &ce) {
		t.Fatalf("expected *CodedError, got %v", err)
	}
	if ce.Code != 5 {
		t.Errorf("exit = %d, want 5 (DIFF_TOO_LARGE)", ce.Code)
	}
}

// Same contract for the legacy JSON branch (5 MB cap) — a 413 at create time
// from --no-stream-diff must also map to exit 5.
func TestRunNormalNoStreamDiffMapsCreateTime413ToExit5(t *testing.T) {
	initRepoForRunNormal(t)
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.status = http.StatusRequestEntityTooLarge
	f.create = `{"error":"DIFF_TOO_LARGE","message":"Legacy diff body exceeds 5242880 bytes."}`

	c := client.New(srv.URL, "k")
	err := runNormal(c, &options{
		serverURL: srv.URL, apiKey: "k", prNumber: 1, streamDiff: false,
	}, time.Millisecond, io.Discard)

	var ce *CodedError
	if !errors.As(err, &ce) {
		t.Fatalf("expected *CodedError, got %v", err)
	}
	if ce.Code != 5 {
		t.Errorf("exit = %d, want 5 (DIFF_TOO_LARGE)", ce.Code)
	}
}

// --diff-file mode: a 413 at upload time must also map to exit 5.
func TestRunDiffFileMapsCreateTime413ToExit5(t *testing.T) {
	f, srv := newFakeJobServer(t)
	defer srv.Close()
	f.status = http.StatusRequestEntityTooLarge
	f.create = `{"error":"DIFF_TOO_LARGE","message":"Diff file exceeds 100 MB limit"}`

	dir := t.TempDir()
	diffPath := filepath.Join(dir, "x.diff")
	if err := os.WriteFile(diffPath, []byte("diff --git a/x b/x\n+line\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	c := client.New(srv.URL, "k")
	err := runDiffFile(c, &options{
		serverURL: srv.URL, apiKey: "k", diffFile: diffPath,
	}, time.Millisecond, io.Discard)

	var ce *CodedError
	if !errors.As(err, &ce) {
		t.Fatalf("expected *CodedError, got %v", err)
	}
	if ce.Code != 5 {
		t.Errorf("exit = %d, want 5 (DIFF_TOO_LARGE)", ce.Code)
	}
}
