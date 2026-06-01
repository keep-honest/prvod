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

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = res.Status
		}
		if detail == "" {
			detail = "<empty response body>"
		}
		return nil, fmt.Errorf("%s failed (%d): %s", label, res.StatusCode, detail)
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
