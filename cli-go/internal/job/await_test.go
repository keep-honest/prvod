package job

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type stubPoller struct {
	responses []*Response
	errs      []error
	calls     int
	gotID     string
}

func (s *stubPoller) PollJob(jobID string) (*Response, error) {
	s.gotID = jobID
	if s.calls < len(s.errs) && s.errs[s.calls] != nil {
		err := s.errs[s.calls]
		s.calls++
		return nil, err
	}
	r := s.responses[s.calls]
	s.calls++
	return r, nil
}

func TestAwaitTerminalStopsOnCompletion(t *testing.T) {
	p := &stubPoller{responses: []*Response{
		{Status: "processing"},
		{Status: "completed"},
	}}
	initial := &Response{Status: "queued"}
	got, err := AwaitTerminal(io.Discard, p, "id", initial, nil, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "completed" {
		t.Fatalf("status = %q, want completed", got.Status)
	}
	if p.calls != 2 {
		t.Fatalf("polled %d times, want 2", p.calls)
	}
}

func TestAwaitTerminalRespectsMaxPolls(t *testing.T) {
	p := &stubPoller{responses: []*Response{
		{Status: "processing"},
		{Status: "processing"},
		{Status: "processing"},
	}}
	max := 2
	initial := &Response{Status: "queued"}
	got, err := AwaitTerminal(io.Discard, p, "id", initial, &max, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "processing" {
		t.Fatalf("status = %q, want processing", got.Status)
	}
	if p.calls != 2 {
		t.Fatalf("polled %d times, want 2 (max)", p.calls)
	}
}

func TestAwaitTerminalAlreadyTerminal(t *testing.T) {
	p := &stubPoller{}
	initial := &Response{Status: "completed"}
	got, err := AwaitTerminal(io.Discard, p, "id", initial, nil, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "completed" || p.calls != 0 {
		t.Fatalf("should not poll when already terminal; calls=%d status=%s", p.calls, got.Status)
	}
}

func TestAwaitTerminalPropagatesPollError(t *testing.T) {
	wantErr := errors.New("network down")
	p := &stubPoller{
		responses: []*Response{nil},
		errs:      []error{wantErr},
	}
	initial := &Response{Status: "queued"}
	got, err := AwaitTerminal(io.Discard, p, "id", initial, nil, time.Millisecond)
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
	if got != nil {
		t.Fatalf("expected nil response on error, got %+v", got)
	}
}

func TestAwaitTerminalTransitionsToFailed(t *testing.T) {
	p := &stubPoller{responses: []*Response{
		{Status: "processing"},
		{Status: "processing"},
		{Status: "failed"},
	}}
	var buf bytes.Buffer
	initial := &Response{Status: "queued"}
	got, err := AwaitTerminal(&buf, p, "id", initial, nil, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "failed" {
		t.Fatalf("status = %q, want failed", got.Status)
	}
	if p.calls != 3 {
		t.Fatalf("polled %d times, want 3", p.calls)
	}
	out := buf.String()
	for _, want := range []string{
		"  Poll 1: status=processing\n",
		"  Poll 2: status=processing\n",
		"  Poll 3: status=failed\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in output:\n%s", want, out)
		}
	}
}

func TestAwaitTerminalForwardsJobID(t *testing.T) {
	p := &stubPoller{responses: []*Response{{Status: "completed"}}}
	initial := &Response{Status: "queued"}
	if _, err := AwaitTerminal(io.Discard, p, "abc-123", initial, nil, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if p.gotID != "abc-123" {
		t.Errorf("PollJob called with %q, want abc-123", p.gotID)
	}
}

func TestAwaitTerminalWritesPollLineToWriter(t *testing.T) {
	p := &stubPoller{responses: []*Response{{Status: "completed"}}}
	var buf bytes.Buffer
	initial := &Response{Status: "queued"}
	if _, err := AwaitTerminal(&buf, p, "id", initial, nil, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); got != "  Poll 1: status=completed\n" {
		t.Errorf("writer output = %q", got)
	}
}
