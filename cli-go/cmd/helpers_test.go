package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/keep-honest/prvod/cli-go/internal/job"
)

// TestDiffJobFailureMapsExitCodes pins down the contract that the README and
// downstream CI consumers rely on: a failed diff-file job's errorCode maps to a
// specific process exit code (5/6/7 for the three server-side diff errors,
// 1 for anything else including a missing or empty code).
//
// It also pins the user-facing message swap: known error codes surface the
// friendly mapping (so callers don't see provider stderr dumps), while
// unknown or empty codes fall back to the raw server message.
func TestDiffJobFailureMapsExitCodes(t *testing.T) {
	cases := []struct {
		name     string
		code     *string
		wantExit int
		// wantMsg is a substring expected in the rendered error. For known
		// codes this is the friendly mapping; for unknown codes it's the
		// raw passthrough.
		wantMsg string
	}{
		{"nil code maps to 1", nil, 1, "boom"},
		{"empty code maps to 1", ptr(""), 1, "boom"},
		{"DIFF_TOO_LARGE maps to 5", ptr("DIFF_TOO_LARGE"), 5, "too large for an automated walkthrough"},
		{"DIFF_PARSE_ERROR maps to 6", ptr("DIFF_PARSE_ERROR"), 6, "couldn't read this pull request's diff"},
		{"DIFF_FETCH_TIMEOUT maps to 7", ptr("DIFF_FETCH_TIMEOUT"), 7, "Couldn't fetch this pull request's diff in time"},
		{"unknown code maps to 1", ptr("WHO_KNOWS"), 1, "boom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg := "boom"
			err := diffJobFailure(&job.Response{
				Status:       "failed",
				ErrorCode:    tc.code,
				ErrorMessage: &msg,
			})
			var ce *CodedError
			if !errors.As(err, &ce) {
				t.Fatalf("expected *CodedError, got %v", err)
			}
			if ce.Code != tc.wantExit {
				t.Errorf("exit = %d, want %d (msg=%q)", ce.Code, tc.wantExit, ce.Err.Error())
			}
			if tc.code != nil && *tc.code != "" {
				if !strings.Contains(ce.Err.Error(), "("+*tc.code+")") {
					t.Errorf("error message %q missing %q", ce.Err.Error(), "("+*tc.code+")")
				}
			}
			if !strings.Contains(ce.Err.Error(), tc.wantMsg) {
				t.Errorf("error message %q missing expected substring %q", ce.Err.Error(), tc.wantMsg)
			}
		})
	}
}

func TestReplaceExtMatchesNodeRegex(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"out.json", "out.txt"},
		{"out.foo.json", "out.foo.txt"},
		// no extension: Node's /\.[^.]+$/ doesn't match, path stays the same.
		{"out", "out"},
		// same extension already: Node's regex still rewrites it; we match.
		{"out.txt", "out.txt"},
		// path with directory components
		{filepath.Join("dir", "out.json"), filepath.Join("dir", "out.txt")},
	}
	for _, tc := range cases {
		got := replaceExt(tc.path, ".txt")
		if got != tc.want {
			t.Errorf("replaceExt(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestEmitNormalResultScriptOnlyStdout(t *testing.T) {
	opts := &options{scriptOnly: true}
	resp := &job.Response{ScriptJSON: json.RawMessage(`{"summary":"hi"}`)}
	var buf bytes.Buffer
	if err := emitNormalResult(opts, resp, &buf); err != nil {
		t.Fatal(err)
	}
	s := buf.String()
	if !strings.Contains(s, "--- Script JSON ---") {
		t.Errorf("missing header marker:\n%s", s)
	}
	if !strings.Contains(s, `"summary": "hi"`) {
		t.Errorf("missing pretty JSON:\n%s", s)
	}
}

func TestEmitNormalResultScriptOnlyFile(t *testing.T) {
	dir := t.TempDir()
	outPath := filepath.Join(dir, "script.json")
	opts := &options{scriptOnly: true, output: outPath}
	resp := &job.Response{ScriptJSON: json.RawMessage(`{"a":1}`)}
	var buf bytes.Buffer
	if err := emitNormalResult(opts, resp, &buf); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "Script written to "+outPath) {
		t.Errorf("missing write notice:\n%s", buf.String())
	}
	body, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"a": 1`) {
		t.Errorf("file body = %q", string(body))
	}
}

func TestEmitNormalResultTTSOnlyStdout(t *testing.T) {
	opts := &options{ttsOnly: true}
	resp := &job.Response{
		ScriptJSON: json.RawMessage(`{"changeType":"feature","summary":"s","scenes":[{"sceneNumber":1,"sceneType":"hook","durationSeconds":3,"narration":"hello"}]}`),
	}
	var buf bytes.Buffer
	if err := emitNormalResult(opts, resp, &buf); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "Scene 1 — hook (3s)") {
		t.Errorf("missing scene header:\n%s", buf.String())
	}
}

func TestEmitNormalResultTTSOnlyFileWritesBothJSONAndTxt(t *testing.T) {
	dir := t.TempDir()
	outPath := filepath.Join(dir, "tts.json")
	opts := &options{ttsOnly: true, output: outPath}
	resp := &job.Response{
		ScriptJSON:   json.RawMessage(`{"summary":"s","scenes":[{"sceneNumber":1,"sceneType":"hook","durationSeconds":3,"narration":"x"}]}`),
		TTSAudioJSON: json.RawMessage(`[{"sceneNumber":1,"audioUrl":"https://a"}]`),
	}
	var buf bytes.Buffer
	if err := emitNormalResult(opts, resp, &buf); err != nil {
		t.Fatal(err)
	}
	jsonBody, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(jsonBody), `"scriptJson"`) || !strings.Contains(string(jsonBody), `"ttsAudio"`) {
		t.Errorf("missing combined keys in JSON:\n%s", string(jsonBody))
	}
	txtPath := filepath.Join(dir, "tts.txt")
	txtBody, err := os.ReadFile(txtPath)
	if err != nil {
		t.Fatalf("readable file not written: %v", err)
	}
	if !strings.Contains(string(txtBody), "Scene 1 — hook") {
		t.Errorf("readable file missing scene:\n%s", string(txtBody))
	}
	out := buf.String()
	if !strings.Contains(out, "TTS JSON written to "+outPath) {
		t.Errorf("missing JSON write notice:\n%s", out)
	}
	if !strings.Contains(out, "Readable script written to "+txtPath) {
		t.Errorf("missing TXT write notice:\n%s", out)
	}
}

func TestEmitNormalResultDefaultStdout(t *testing.T) {
	url := "https://example.com/v.mp4"
	opts := &options{}
	resp := &job.Response{VideoURL: &url}
	var buf bytes.Buffer
	if err := emitNormalResult(opts, resp, &buf); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "\nVideo URL: "+url+"\n") {
		t.Errorf("missing video URL line:\n%s", buf.String())
	}
}

func TestEmitNormalResultDefaultFile(t *testing.T) {
	dir := t.TempDir()
	outPath := filepath.Join(dir, "result.json")
	url := "https://example.com/v.mp4"
	opts := &options{output: outPath}
	resp := &job.Response{VideoURL: &url, ScriptJSON: json.RawMessage(`{"k":1}`)}
	var buf bytes.Buffer
	if err := emitNormalResult(opts, resp, &buf); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["videoUrl"] != url {
		t.Errorf("videoUrl = %v, want %s", parsed["videoUrl"], url)
	}
	if _, ok := parsed["scriptJson"]; !ok {
		t.Errorf("missing scriptJson key")
	}
	if !strings.Contains(buf.String(), "Result written to "+outPath) {
		t.Errorf("missing write notice:\n%s", buf.String())
	}
}

func TestEmitNormalResultDefaultVideoURLNilWritesNullKey(t *testing.T) {
	opts := &options{}
	resp := &job.Response{}
	var buf bytes.Buffer
	if err := emitNormalResult(opts, resp, &buf); err != nil {
		t.Fatal(err)
	}
	// Node prints `Video URL: undefined` here; Go prints empty string from the
	// strVal helper. Just check the prefix is emitted.
	if !strings.Contains(buf.String(), "\nVideo URL: ") {
		t.Errorf("missing video URL line:\n%s", buf.String())
	}
}

func ptr(s string) *string { return &s }
