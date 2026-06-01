package job

import (
	"testing"
	"time"
)

type stubPoller struct {
	responses []*Response
	calls     int
}

func (s *stubPoller) PollJob(string) (*Response, error) {
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
	got, err := AwaitTerminal(p, "id", initial, nil, time.Millisecond)
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
	got, err := AwaitTerminal(p, "id", initial, &max, time.Millisecond)
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
	got, err := AwaitTerminal(p, "id", initial, nil, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "completed" || p.calls != 0 {
		t.Fatalf("should not poll when already terminal; calls=%d status=%s", p.calls, got.Status)
	}
}
