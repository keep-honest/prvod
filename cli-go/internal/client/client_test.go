package client

import (
	"encoding/json"
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

func contains(s, sub string) bool { return strings.Contains(s, sub) }
