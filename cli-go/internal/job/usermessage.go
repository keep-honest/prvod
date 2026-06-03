// Mapping from the server's structured error codes to user-facing messages.
//
// Mirrors src/lib/jobErrorMessages.ts on the server. The Node mapper is only
// wired into the GitHub webhook and the dashboard UI; the /api/jobs/{id}
// polling endpoint that the CLI consumes returns the raw errorMessage (which
// may contain provider stack traces and stderr dumps). We re-implement the
// table here so CLI output stays clean.
//
// Keep this in sync with ERROR_CODE_MESSAGES in jobErrorMessages.ts.

package job

var errorCodeMessages = map[string]string{
	"DIFF_TOO_LARGE":             "This pull request is too large for an automated walkthrough. Try splitting it into smaller PRs.",
	"DIFF_FETCH_TIMEOUT":         "Couldn't fetch this pull request's diff in time. Retry to try again.",
	"DIFF_PARSE_ERROR":           "We couldn't read this pull request's diff. Retry, or reach out if it keeps happening.",
	"LLM_RATE_LIMITED_EXHAUSTED": "Our AI provider is at capacity right now. Please retry in a few minutes.",
	"LLM_VALIDATION_EXHAUSTED":   "We couldn't produce a valid walkthrough for this pull request. Retry or simplify the change set.",
}

// UserMessage returns a friendly message for a known error code. When the
// code is empty or unrecognised it returns the raw fallback so callers can
// still surface something specific (raw provider output is better than a
// generic placeholder when we have no mapping).
func UserMessage(code string, raw string) string {
	if msg, ok := errorCodeMessages[code]; ok {
		return msg
	}
	return raw
}
