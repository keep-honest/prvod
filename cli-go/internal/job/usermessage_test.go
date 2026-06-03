package job

import "testing"

func TestUserMessageReturnsFriendlyForKnownCodes(t *testing.T) {
	cases := []struct {
		code string
		want string
	}{
		{"DIFF_TOO_LARGE", "This pull request is too large for an automated walkthrough. Try splitting it into smaller PRs."},
		{"DIFF_FETCH_TIMEOUT", "Couldn't fetch this pull request's diff in time. Retry to try again."},
		{"DIFF_PARSE_ERROR", "We couldn't read this pull request's diff. Retry, or reach out if it keeps happening."},
		{"LLM_RATE_LIMITED_EXHAUSTED", "Our AI provider is at capacity right now. Please retry in a few minutes."},
		{"LLM_VALIDATION_EXHAUSTED", "We couldn't produce a valid walkthrough for this pull request. Retry or simplify the change set."},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			got := UserMessage(tc.code, "raw stderr dump with stack traces")
			if got != tc.want {
				t.Errorf("UserMessage(%q) = %q, want %q", tc.code, got, tc.want)
			}
		})
	}
}

func TestUserMessageFallsBackToRawForUnknownOrEmptyCodes(t *testing.T) {
	cases := []struct {
		name string
		code string
	}{
		{"empty code", ""},
		{"unknown code", "WHO_KNOWS"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := UserMessage(tc.code, "raw boom")
			if got != "raw boom" {
				t.Errorf("UserMessage(%q, raw) = %q, want raw passthrough", tc.code, got)
			}
		})
	}
}
