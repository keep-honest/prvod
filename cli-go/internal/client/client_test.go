package client

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/keep-honest/prvod/cli-go/internal/job"
)

func TestCreateJob(t *testing.T) {
	var gotAuth, gotPath, gotCT string
	var gotBody job.CreatePayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		gotCT = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"abc","status":"queued"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-key")
	resp, err := c.CreateJob(&job.CreatePayload{RepoFullName: "o/r", PRNumber: 7})
	if err != nil {
		t.Fatal(err)
	}
	if resp.ID != "abc" || resp.Status != "queued" {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if gotAuth != "Bearer secret-key" {
		t.Errorf("auth = %q", gotAuth)
	}
	if gotPath != "/api/jobs" {
		t.Errorf("path = %q", gotPath)
	}
	if gotCT != "application/json" {
		t.Errorf("content-type = %q", gotCT)
	}
	if gotBody.RepoFullName != "o/r" || gotBody.PRNumber != 7 {
		t.Errorf("body = %+v", gotBody)
	}
}

func TestCreateJobError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"RATE_LIMIT"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "k")
	_, err := c.CreateJob(&job.CreatePayload{})
	if err == nil {
		t.Fatal("expected error")
	}
	if want := "POST /api/jobs failed (429)"; !contains(err.Error(), want) {
		t.Errorf("error %q missing %q", err.Error(), want)
	}
}

func TestCreateJobFromDiffFile(t *testing.T) {
	var gotCT, gotSource, gotQuery, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT = r.Header.Get("Content-Type")
		gotSource = r.Header.Get("X-Diff-Source")
		gotQuery = r.URL.RawQuery
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"d1","status":"queued"}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	path := filepath.Join(dir, "x.diff")
	if err := os.WriteFile(path, []byte("diff --git a/x b/x\n+line\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	c := New(srv.URL, "k")
	q := map[string][]string{"scriptOnly": {"true"}, "durationMode": {"short"}}
	resp, err := c.CreateJobFromDiffFile(path, q)
	if err != nil {
		t.Fatal(err)
	}
	if resp.ID != "d1" {
		t.Fatalf("id = %q", resp.ID)
	}
	if gotCT != "application/x-git-diff" {
		t.Errorf("content-type = %q", gotCT)
	}
	if gotSource != "local-file" {
		t.Errorf("x-diff-source = %q", gotSource)
	}
	if !contains(gotQuery, "scriptOnly=true") || !contains(gotQuery, "durationMode=short") {
		t.Errorf("query = %q", gotQuery)
	}
	if gotBody != "diff --git a/x b/x\n+line\n" {
		t.Errorf("streamed body = %q", gotBody)
	}
}

func TestCreateJobFromDiffBytes(t *testing.T) {
	var gotCT, gotSource, gotQuery, gotBody string
	var gotLen int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT = r.Header.Get("Content-Type")
		gotSource = r.Header.Get("X-Diff-Source")
		gotQuery = r.URL.RawQuery
		gotLen = r.ContentLength
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"s1","status":"queued"}`))
	}))
	defer srv.Close()

	body := []byte("diff --git a/x b/x\n+line\n")
	c := New(srv.URL, "k")
	q := map[string][]string{
		"scriptOnly":   {"true"},
		"durationMode": {"popcorn"},
		"prTitle":      {"feat: streaming"},
	}
	resp, err := c.CreateJobFromDiffBytes(body, q)
	if err != nil {
		t.Fatal(err)
	}
	if resp.ID != "s1" {
		t.Errorf("id = %q", resp.ID)
	}
	if gotCT != "application/x-git-diff" {
		t.Errorf("content-type = %q", gotCT)
	}
	if gotSource != "local-stream" {
		t.Errorf("x-diff-source = %q, want local-stream", gotSource)
	}
	if gotLen != int64(len(body)) {
		t.Errorf("Content-Length = %d, want %d", gotLen, len(body))
	}
	if !contains(gotQuery, "scriptOnly=true") || !contains(gotQuery, "durationMode=popcorn") {
		t.Errorf("query = %q", gotQuery)
	}
	if gotBody != string(body) {
		t.Errorf("streamed body = %q", gotBody)
	}
}

func TestPollAndRetryPaths(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		_, _ = w.Write([]byte(`{"id":"j","status":"processing"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "k")
	if _, err := c.PollJob("j"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.RetryJob("j"); err != nil {
		t.Fatal(err)
	}
	want := []string{"GET /api/jobs/j", "POST /api/jobs/j/retry"}
	for i, w := range want {
		if paths[i] != w {
			t.Errorf("call %d = %q, want %q", i, paths[i], w)
		}
	}
}

// A non-2xx response that carries the standardized `{"error": "CODE"}` shape
// must surface that code via APIError so callers can map a create-time 413
// DIFF_TOO_LARGE to exit 5 (matching the README's exit-code contract).
func TestDoSurfacesAPIErrorCodeFromBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte(`{"error":"DIFF_TOO_LARGE","message":"Diff file exceeds 100 MB limit"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "k")
	_, err := c.CreateJob(&job.CreatePayload{})
	if err == nil {
		t.Fatal("expected error")
	}
	var ae *APIError
	if !errors.As(err, &ae) {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if ae.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("StatusCode = %d, want 413", ae.StatusCode)
	}
	if ae.ErrorCode != "DIFF_TOO_LARGE" {
		t.Errorf("ErrorCode = %q, want DIFF_TOO_LARGE", ae.ErrorCode)
	}
}

func TestNewStripsTrailingSlash(t *testing.T) {
	c := New("http://x:3000/", "k")
	if c.ServerURL != "http://x:3000" {
		t.Errorf("trailing slash not stripped: %q", c.ServerURL)
	}
}

// A non-2xx response with an empty body should surface the HTTP Status line so
// the caller is not left with "<empty response body>" for a real failure.
func TestDoEmptyErrorBodyFallsBackToStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := New(srv.URL, "k")
	_, err := c.CreateJob(&job.CreatePayload{})
	if err == nil {
		t.Fatal("expected error")
	}
	if !contains(err.Error(), "(503)") {
		t.Errorf("error %q missing (503) code", err.Error())
	}
	if !contains(err.Error(), "Service Unavailable") {
		t.Errorf("error %q missing reason phrase", err.Error())
	}
	// The numeric code must not appear in the detail portion (Node uses res.statusText only).
	if contains(err.Error(), "503 Service Unavailable") {
		t.Errorf("status code duplicated in detail: %q", err.Error())
	}
}

func TestDoMalformedJSONSuccessSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not-json"))
	}))
	defer srv.Close()

	c := New(srv.URL, "k")
	_, err := c.CreateJob(&job.CreatePayload{})
	if err == nil {
		t.Fatal("expected error")
	}
	if !contains(err.Error(), "invalid JSON response") {
		t.Errorf("error %q missing 'invalid JSON response'", err.Error())
	}
}

func TestCreateJobFromDiffFileSetsContentLength(t *testing.T) {
	var gotLen int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotLen = r.ContentLength
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"x","status":"queued"}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	path := filepath.Join(dir, "x.diff")
	body := []byte("diff --git a/x b/x\n+line\n")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}

	c := New(srv.URL, "k")
	if _, err := c.CreateJobFromDiffFile(path, nil); err != nil {
		t.Fatal(err)
	}
	if gotLen != int64(len(body)) {
		t.Errorf("Content-Length = %d, want %d (chunked upload would be 0/-1)", gotLen, len(body))
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }
