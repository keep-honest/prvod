// Package job defines the job request/response shapes exchanged with the prvod
// server and the polling loop that waits for a job to reach a terminal state.
package job

import (
	"encoding/json"
	"fmt"
	"time"
)

// Response mirrors the JSON returned by POST /api/jobs, GET /api/jobs/{id} and
// POST /api/jobs/{id}/retry. scriptJson and ttsAudioJson are kept as raw JSON so
// the CLI can pass through whatever shape the server emits without coupling to it.
type Response struct {
	ID           string          `json:"id"`
	RepoFullName string          `json:"repoFullName,omitempty"`
	PRNumber     int             `json:"prNumber,omitempty"`
	Status       string          `json:"status"`
	VideoURL     *string         `json:"videoUrl"`
	ScriptJSON   json.RawMessage `json:"scriptJson"`
	TTSAudioJSON json.RawMessage `json:"ttsAudioJson"`
	ErrorCode    *string         `json:"errorCode,omitempty"`
	ErrorMessage *string         `json:"errorMessage"`
	CreatedAt    string          `json:"createdAt,omitempty"`
	CompletedAt  *string         `json:"completedAt,omitempty"`
	// Message is returned by the retry endpoint (e.g. "Retrying from step 3").
	Message string `json:"message,omitempty"`
}

// CreatePayload is the JSON body for POST /api/jobs in normal (git diff) mode.
// Field order and defaults match buildCreateJobPayload in src/cli/local-test.ts.
type CreatePayload struct {
	RepoFullName  string `json:"repoFullName"`
	PRNumber      int    `json:"prNumber"`
	PRTitle       string `json:"prTitle"`
	PRDescription string `json:"prDescription"`
	Diff          string `json:"diff"`
	BaseBranch    string `json:"baseBranch"`
	HeadBranch    string `json:"headBranch"`
	Issues        []any  `json:"issues"`
	Milestone     any    `json:"milestone"`
	IsPrivate     bool   `json:"isPrivate"`
	ScriptOnly    bool   `json:"scriptOnly"`
	TTSOnly       bool   `json:"ttsOnly"`
	Deepdive      bool   `json:"deepdive"`
	DurationMode  string `json:"durationMode"`
}

// IsTerminal reports whether a status will not change further.
func IsTerminal(status string) bool {
	return status == "completed" || status == "failed"
}

// Poller fetches the current state of a job by ID.
type Poller interface {
	PollJob(jobID string) (*Response, error)
}

// AwaitTerminal polls a job until it reaches a terminal state or the poll budget
// is exhausted. A nil maxPolls means poll indefinitely. It mirrors awaitTerminal
// in src/cli/local-test.ts, including the per-poll status log line.
func AwaitTerminal(p Poller, jobID string, initial *Response, maxPolls *int, pollInterval time.Duration) (*Response, error) {
	current := initial
	for i := 0; maxPolls == nil || i < *maxPolls; i++ {
		if IsTerminal(current.Status) {
			break
		}
		time.Sleep(pollInterval)
		next, err := p.PollJob(jobID)
		if err != nil {
			return nil, err
		}
		current = next
		fmt.Printf("  Poll %d: status=%s\n", i+1, current.Status)
	}
	return current, nil
}
