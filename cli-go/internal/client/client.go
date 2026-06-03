// Package client is a thin HTTP client for the prvod jobs API. It mirrors the
// API client in src/cli/local-test.ts: Bearer auth on every call, descriptive
// errors on non-2xx responses, and a streaming upload path for diff files.
package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/keep-honest/prvod/cli-go/internal/job"
)

// Client talks to a single prvod server with a fixed API key.
type Client struct {
	ServerURL  string
	APIKey     string
	HTTPClient *http.Client
}

// APIError is returned by Client methods when the server responds with a non-2xx
// status. The structured ErrorCode (e.g. "DIFF_TOO_LARGE") is parsed from the
// response body when the server emits the standard {error, message} shape, so
// callers can map create-time failures to the same exit codes the polling path
// uses for terminal job failures.
type APIError struct {
	Label      string
	StatusCode int
	ErrorCode  string
	Detail     string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s failed (%d): %s", e.Label, e.StatusCode, e.Detail)
}

// New returns a Client. The trailing slash on serverURL is stripped so paths
// join cleanly.
func New(serverURL, apiKey string) *Client {
	return &Client{
		ServerURL:  strings.TrimRight(serverURL, "/"),
		APIKey:     apiKey,
		HTTPClient: http.DefaultClient,
	}
}

func (c *Client) authHeader(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
}

// do executes a request and decodes a job.Response, returning a descriptive
// error on non-2xx — matching apiFetch's "<label> failed (<status>): <detail>".
func (c *Client) do(req *http.Request, label string) (*job.Response, error) {
	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", label, err)
	}
	defer res.Body.Close()

	body, readErr := io.ReadAll(res.Body)
	if readErr != nil {
		return nil, fmt.Errorf("%s: reading response body: %w", label, readErr)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			// Node uses res.statusText (the reason phrase only). Go's res.Status
			// is "404 Not Found" — strip the leading numeric code so the message
			// doesn't repeat it after the "(404):" we add below.
			detail = strings.TrimSpace(strings.TrimPrefix(res.Status, fmt.Sprintf("%d", res.StatusCode)))
		}
		if detail == "" {
			detail = "<empty response body>"
		}
		// Best-effort: extract the standardized {"error": "CODE"} shape so
		// callers can map e.g. a create-time 413 DIFF_TOO_LARGE to exit 5.
		var parsed struct {
			Error string `json:"error"`
		}
		errorCode := ""
		if jsonErr := json.Unmarshal(body, &parsed); jsonErr == nil {
			errorCode = parsed.Error
		}
		return nil, &APIError{
			Label:      label,
			StatusCode: res.StatusCode,
			ErrorCode:  errorCode,
			Detail:     detail,
		}
	}

	var jr job.Response
	if err := json.Unmarshal(body, &jr); err != nil {
		return nil, fmt.Errorf("%s: invalid JSON response: %w", label, err)
	}
	return &jr, nil
}

// CreateJob posts a JSON payload to /api/jobs (normal git-diff mode).
func (c *Client) CreateJob(payload *job.CreatePayload) (*job.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encoding payload: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, c.ServerURL+"/api/jobs", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.authHeader(req)
	return c.do(req, "POST /api/jobs")
}

// CreateJobFromDiffBytes streams an in-memory diff buffer to /api/jobs?<query>
// with Content-Type application/x-git-diff. Used by `--stream-diff`, which
// gathers the diff from `git` like normal mode but uploads via the 100 MB
// streaming branch instead of the 5 MB legacy JSON body.
func (c *Client) CreateJobFromDiffBytes(diff []byte, query url.Values) (*job.Response, error) {
	u := c.ServerURL + "/api/jobs?" + query.Encode()
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(diff))
	if err != nil {
		return nil, err
	}
	req.ContentLength = int64(len(diff))
	req.Header.Set("Content-Type", "application/x-git-diff")
	req.Header.Set("X-Diff-Source", "local-stream")
	c.authHeader(req)
	return c.do(req, "POST /api/jobs (stream-diff)")
}

// CreateJobFromDiffFile streams a local unified-diff file to
// /api/jobs?<query> with Content-Type application/x-git-diff. The file is sent
// as the request body without being buffered fully in memory.
func (c *Client) CreateJobFromDiffFile(path string, query url.Values) (*job.Response, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("opening diff file: %w", err)
	}
	// http.Client closes the request body.
	u := c.ServerURL + "/api/jobs?" + query.Encode()
	req, err := http.NewRequest(http.MethodPost, u, f)
	if err != nil {
		f.Close()
		return nil, err
	}
	if fi, statErr := f.Stat(); statErr == nil {
		req.ContentLength = fi.Size()
	}
	req.Header.Set("Content-Type", "application/x-git-diff")
	req.Header.Set("X-Diff-Source", "local-file")
	c.authHeader(req)
	return c.do(req, "POST /api/jobs (diff-file)")
}

// PollJob fetches the current state of a job. It satisfies job.Poller.
func (c *Client) PollJob(jobID string) (*job.Response, error) {
	req, err := http.NewRequest(http.MethodGet, c.ServerURL+"/api/jobs/"+jobID, nil)
	if err != nil {
		return nil, err
	}
	c.authHeader(req)
	return c.do(req, "GET /api/jobs/"+jobID)
}

// RetryJob retries a previously failed job.
func (c *Client) RetryJob(jobID string) (*job.Response, error) {
	req, err := http.NewRequest(http.MethodPost, c.ServerURL+"/api/jobs/"+jobID+"/retry", nil)
	if err != nil {
		return nil, err
	}
	c.authHeader(req)
	return c.do(req, "POST /api/jobs/"+jobID+"/retry")
}
