// Package cmd implements the prvodctl command line: a Go client that drives the
// prvod server's jobs API, replicating the behavior of the Node CLI at
// src/cli/local-test.ts.
package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/keep-honest/prvod/cli-go/internal/client"
	"github.com/keep-honest/prvod/cli-go/internal/git"
	"github.com/keep-honest/prvod/cli-go/internal/job"
	"github.com/keep-honest/prvod/cli-go/internal/output"
)

// options holds the fully resolved settings for one invocation.
type options struct {
	serverURL      string
	apiKey         string
	scriptOnly     bool
	ttsOnly        bool
	deepdive       bool
	shortDur       bool
	popcorn        bool
	output         string
	uncommitted    bool
	prNumber       int
	title          string
	diffFile       string
	retryJob       string
	maxPolls       *int
	pollIntervalMs int
}

func (o *options) durationMode() string {
	switch {
	case o.popcorn:
		return "popcorn"
	case o.shortDur:
		return "short"
	default:
		return "default"
	}
}

// Execute runs the root command and is the single entry point from main.
func Execute() error {
	cmd, _, _ := buildRoot()
	return cmd.Execute()
}

// buildRoot constructs the root command together with the Viper instance and a
// pointer to the --config flag value. It returns all three so tests can drive
// configuration resolution directly.
func buildRoot() (*cobra.Command, *viper.Viper, *string) {
	v := viper.New()
	var configFlag string

	cmd := &cobra.Command{
		Use:   "prvodctl",
		Short: "Generate PR videos via the prvod server",
		Long: "prvodctl is a CLI client for the prvod server. It gathers a git diff " +
			"(or a diff file), submits a job to the server, polls until it completes, " +
			"and prints the resulting script, TTS preview, or video URL.",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(c *cobra.Command, _ []string) error {
			return initConfig(v, c, configFlag)
		},
		RunE: func(c *cobra.Command, _ []string) error {
			opts, err := resolveOptions(v, c)
			if err != nil {
				return err
			}
			return run(c, opts)
		},
	}

	f := cmd.Flags()
	f.StringVar(&configFlag, "config", "", "Path to a YAML config file (overrides auto-discovery)")
	f.String("server-url", "", "Server endpoint (or env SERVER_URL)")
	f.String("api-key", "", "Bearer token (or env API_SECRET_KEY)")
	f.Bool("script-only", false, "Skip video generation, return script only")
	f.Bool("tts-only", false, "Stop after TTS synthesis, return script + audio files")
	f.Bool("deepdive", false, "Enable reviewer-style deepdive narration")
	f.Bool("short-dur", false, "Generate a short video (20–60 seconds)")
	f.Bool("popcorn", false, "Generate a popcorn video (~5 minutes, extended depth)")
	f.String("output", "", "Write result to file (default: stdout)")
	f.Bool("uncommitted", false, "Use 'git diff HEAD' instead of 'git diff HEAD~1..HEAD'")
	f.Int("pr-number", 1, "PR number")
	f.String("title", "", "PR title (default: last commit message)")
	f.String("diff-file", "", "Use a local unified-diff file instead of git (mutually exclusive with --pr-number, --title, --uncommitted, --retry-job)")
	f.String("retry-job", "", "Retry a failed job by ID (skips job creation)")
	f.Int("max-polls", 0, "Max polling attempts (or env CLI_MAX_POLLS, default: unlimited)")
	f.Int("poll-interval-ms", 5000, "Poll interval in ms (or env CLI_POLL_INTERVAL_MS)")

	return cmd, v, &configFlag
}

// resolveOptions reads final values from Viper (flag > env > config > default)
// and validates them, returning CodedErrors that map to the Node CLI exit codes.
func resolveOptions(v *viper.Viper, cmd *cobra.Command) (*options, error) {
	opts := &options{
		serverURL:      strings.TrimRight(v.GetString("server-url"), "/"),
		apiKey:         v.GetString("api-key"),
		scriptOnly:     v.GetBool("script-only"),
		ttsOnly:        v.GetBool("tts-only"),
		deepdive:       v.GetBool("deepdive"),
		shortDur:       v.GetBool("short-dur"),
		popcorn:        v.GetBool("popcorn"),
		output:         v.GetString("output"),
		uncommitted:    v.GetBool("uncommitted"),
		prNumber:       v.GetInt("pr-number"),
		title:          v.GetString("title"),
		diffFile:       v.GetString("diff-file"),
		retryJob:       v.GetString("retry-job"),
		pollIntervalMs: v.GetInt("poll-interval-ms"),
	}

	if opts.serverURL == "" {
		return nil, coded(1, "Error: --server-url or SERVER_URL is required")
	}
	if opts.apiKey == "" {
		return nil, coded(1, "Error: --api-key or API_SECRET_KEY is required")
	}
	if opts.prNumber <= 0 {
		return nil, coded(1, "Error: --pr-number must be a positive integer")
	}
	if opts.pollIntervalMs <= 0 {
		return nil, coded(1, "Error: --poll-interval-ms / CLI_POLL_INTERVAL_MS must be a positive integer")
	}

	// max-polls: 0 (the default) means unlimited; a positive value caps polling.
	if mp := v.GetInt("max-polls"); mp > 0 {
		opts.maxPolls = &mp
	} else if mp < 0 {
		return nil, coded(1, "Error: --max-polls / CLI_MAX_POLLS must be a positive integer")
	}

	if opts.scriptOnly && opts.ttsOnly {
		return nil, coded(1, "Error: --script-only and --tts-only are mutually exclusive")
	}
	if opts.shortDur && opts.popcorn {
		return nil, coded(1, "Error: --short-dur and --popcorn are mutually exclusive")
	}

	if opts.diffFile != "" {
		if err := validateDiffFile(cmd, opts); err != nil {
			return nil, err
		}
	}

	return opts, nil
}

// validateDiffFile enforces --diff-file's mutual exclusions (exit 2) and runs
// the file pre-flight (exit 3 missing/empty, exit 4 not a unified diff). It also
// resolves the path to absolute, matching the Node CLI.
func validateDiffFile(cmd *cobra.Command, opts *options) error {
	// Mutual exclusion is based on flags explicitly passed on the command line.
	exclusive := []string{"pr-number", "title", "uncommitted", "retry-job"}
	for _, name := range exclusive {
		if cmd.Flags().Changed(name) {
			return coded(2, "Error: --diff-file is mutually exclusive with --%s", name)
		}
	}

	abs, err := filepath.Abs(opts.diffFile)
	if err != nil {
		return coded(3, "Error: diff file not found: %s", opts.diffFile)
	}

	fi, err := os.Stat(abs)
	if err != nil || fi.IsDir() {
		return coded(3, "Error: diff file not found: %s", abs)
	}
	if fi.Size() == 0 {
		return coded(3, "Error: diff file is empty")
	}

	// Read only the header to confirm it looks like a `diff --git` unified diff.
	f, err := os.Open(abs)
	if err != nil {
		return coded(3, "Error: diff file not found: %s", abs)
	}
	defer f.Close()
	header := make([]byte, 4096)
	// A short read is fine here — io.ReadFull returns however many bytes it got
	// alongside ErrUnexpectedEOF for files smaller than the buffer.
	n, _ := io.ReadFull(f, header)
	firstLine := string(header[:n])
	if idx := strings.IndexByte(firstLine, '\n'); idx >= 0 {
		firstLine = firstLine[:idx]
	}
	if !strings.HasPrefix(firstLine, "diff --git ") {
		return coded(4, "Error: file does not appear to be a unified git diff (must start with 'diff --git')")
	}

	opts.diffFile = abs
	return nil
}

func run(cmd *cobra.Command, opts *options) error {
	c := client.New(opts.serverURL, opts.apiKey)
	pollInterval := time.Duration(opts.pollIntervalMs) * time.Millisecond
	out := cmd.OutOrStdout()

	switch {
	case opts.retryJob != "":
		return runRetry(c, opts, pollInterval, out)
	case opts.diffFile != "":
		return runDiffFile(c, opts, pollInterval, out)
	default:
		return runNormal(c, opts, pollInterval, out)
	}
}

func runRetry(c *client.Client, opts *options, pollInterval time.Duration, out io.Writer) error {
	fmt.Fprintf(out, "Retrying job: %s\n", opts.retryJob)
	fmt.Fprintf(out, "Server:       %s\n\n", opts.serverURL)

	retried, err := c.RetryJob(opts.retryJob)
	if err != nil {
		return coded(1, "%v", err)
	}
	raw, _ := json.Marshal(retried)
	fmt.Fprintf(out, "Retry initiated: %s\n", string(raw))

	current, err := job.AwaitTerminal(c, opts.retryJob, retried, opts.maxPolls, pollInterval)
	if err != nil {
		return coded(1, "%v", err)
	}

	if current.Status == "failed" {
		return coded(1, "\nRetry failed: %s", strVal(current.ErrorMessage))
	}
	if current.Status == "completed" {
		fmt.Fprintf(out, "\nRetry succeeded! Video URL: %s\n", strVal(current.VideoURL))
		return nil
	}
	return coded(1, "\nRetry did not complete in time (status: %s)", current.Status)
}

func runDiffFile(c *client.Client, opts *options, pollInterval time.Duration, out io.Writer) error {
	autoTitle := time.Now().UTC().Format("2006-01-02") + "-git-diff"
	fmt.Fprintf(out, "Diff file:   %s\n", opts.diffFile)
	fmt.Fprintf(out, "PR Title:    %s\n", autoTitle)
	fmt.Fprintf(out, "Script Only: %t\n", opts.scriptOnly)
	fmt.Fprintf(out, "Server:      %s\n\n", opts.serverURL)

	q := url.Values{}
	q.Set("scriptOnly", boolStr(opts.scriptOnly))
	q.Set("ttsOnly", boolStr(opts.ttsOnly))
	q.Set("deepdive", boolStr(opts.deepdive))
	q.Set("durationMode", opts.durationMode())
	q.Set("prTitle", autoTitle)

	created, err := c.CreateJobFromDiffFile(opts.diffFile, q)
	if err != nil {
		return coded(1, "%v", err)
	}
	fmt.Fprintf(out, "Job created: %s (status: %s)\n", created.ID, created.Status)

	current, err := job.AwaitTerminal(c, created.ID, created, opts.maxPolls, pollInterval)
	if err != nil {
		return coded(1, "%v", err)
	}

	if current.Status == "failed" {
		return diffJobFailure(current)
	}
	if current.Status != "completed" {
		return coded(1, "\nJob did not complete in time (status: %s)", current.Status)
	}

	result, _ := json.MarshalIndent(current, "", "  ")
	if opts.output != "" {
		if err := os.WriteFile(opts.output, result, 0o644); err != nil {
			return coded(1, "%v", err)
		}
		fmt.Fprintf(out, "\nResult written to: %s\n", opts.output)
	} else {
		fmt.Fprintln(out, string(result))
	}
	return nil
}

func runNormal(c *client.Client, opts *options, pollInterval time.Duration, out io.Writer) error {
	snap, err := git.GatherInfo(opts.uncommitted, opts.title)
	if err != nil {
		return coded(1, "%v", err)
	}

	fmt.Fprintf(out, "Repo:        %s\n", snap.RepoFullName)
	fmt.Fprintf(out, "Branch:      %s\n", snap.HeadBranch)
	fmt.Fprintf(out, "PR Title:    %s\n", snap.Title)
	fmt.Fprintf(out, "Script Only: %t\n", opts.scriptOnly)
	fmt.Fprintf(out, "TTS Only:    %t\n", opts.ttsOnly)
	fmt.Fprintf(out, "Deepdive:    %t\n", opts.deepdive)
	fmt.Fprintf(out, "Duration:    %s\n", durationLabel(opts))
	fmt.Fprintf(out, "Server:      %s\n\n", opts.serverURL)

	payload := &job.CreatePayload{
		RepoFullName:  snap.RepoFullName,
		PRNumber:      opts.prNumber,
		PRTitle:       snap.Title,
		PRDescription: "",
		Diff:          snap.Diff,
		BaseBranch:    "main",
		HeadBranch:    snap.HeadBranch,
		Issues:        []any{},
		Milestone:     nil,
		IsPrivate:     false,
		ScriptOnly:    opts.scriptOnly,
		TTSOnly:       opts.ttsOnly,
		Deepdive:      opts.deepdive,
		DurationMode:  opts.durationMode(),
	}

	fmt.Fprintln(out, "Creating job...")
	created, err := c.CreateJob(payload)
	if err != nil {
		return coded(1, "%v", err)
	}
	fmt.Fprintf(out, "Job created: %s (status: %s)\n", created.ID, created.Status)

	current, err := job.AwaitTerminal(c, created.ID, created, opts.maxPolls, pollInterval)
	if err != nil {
		return coded(1, "%v", err)
	}

	if current.Status == "failed" {
		code := ""
		if current.ErrorCode != nil && *current.ErrorCode != "" {
			code = fmt.Sprintf(" (%s)", *current.ErrorCode)
		}
		return coded(1, "\nJob failed%s: %s", code, strVal(current.ErrorMessage))
	}
	if current.Status != "completed" {
		return coded(1, "\nJob did not complete in time (status: %s)", current.Status)
	}

	return emitNormalResult(opts, current, out)
}

// emitNormalResult writes the result for the normal mode according to the
// selected output mode (script-only, tts-only, or default video URL).
func emitNormalResult(opts *options, current *job.Response, out io.Writer) error {
	switch {
	case opts.scriptOnly:
		body, _ := json.MarshalIndent(jsonOrNull(current.ScriptJSON), "", "  ")
		if opts.output != "" {
			if err := os.WriteFile(opts.output, body, 0o644); err != nil {
				return coded(1, "%v", err)
			}
			fmt.Fprintf(out, "\nScript written to %s\n", opts.output)
		} else {
			fmt.Fprintln(out, "\n--- Script JSON ---")
			fmt.Fprintln(out, string(body))
		}

	case opts.ttsOnly:
		readable := output.FormatTTSReadable(current.ScriptJSON, current.TTSAudioJSON)
		if opts.output != "" {
			combined := map[string]any{
				"scriptJson": jsonOrNull(current.ScriptJSON),
				"ttsAudio":   jsonOrEmptyArray(current.TTSAudioJSON),
			}
			body, _ := json.MarshalIndent(combined, "", "  ")
			if err := os.WriteFile(opts.output, body, 0o644); err != nil {
				return coded(1, "%v", err)
			}
			txtPath := replaceExt(opts.output, ".txt")
			if err := os.WriteFile(txtPath, []byte(readable), 0o644); err != nil {
				return coded(1, "%v", err)
			}
			fmt.Fprintf(out, "\nTTS JSON written to %s\n", opts.output)
			fmt.Fprintf(out, "Readable script written to %s\n", txtPath)
		} else {
			fmt.Fprintln(out, readable)
		}

	default:
		fmt.Fprintf(out, "\nVideo URL: %s\n", strVal(current.VideoURL))
		if opts.output != "" {
			combined := map[string]any{
				"videoUrl":   nullableStr(current.VideoURL),
				"scriptJson": jsonOrNull(current.ScriptJSON),
			}
			body, _ := json.MarshalIndent(combined, "", "  ")
			if err := os.WriteFile(opts.output, body, 0o644); err != nil {
				return coded(1, "%v", err)
			}
			fmt.Fprintf(out, "Result written to %s\n", opts.output)
		}
	}
	return nil
}

// diffJobFailure maps a failed diff-file job's error code to its exit code.
func diffJobFailure(current *job.Response) error {
	code := ""
	if current.ErrorCode != nil && *current.ErrorCode != "" {
		code = fmt.Sprintf(" (%s)", *current.ErrorCode)
	}
	exit := 1
	if current.ErrorCode != nil {
		switch *current.ErrorCode {
		case "DIFF_TOO_LARGE":
			exit = 5
		case "DIFF_PARSE_ERROR":
			exit = 6
		case "DIFF_FETCH_TIMEOUT":
			exit = 7
		}
	}
	return coded(exit, "\nJob failed%s: %s", code, strVal(current.ErrorMessage))
}

// --- small helpers ---

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func strVal(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func nullableStr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func durationLabel(opts *options) string {
	switch {
	case opts.popcorn:
		return "popcorn (~5 min)"
	case opts.shortDur:
		return "short (20–60s)"
	default:
		return "default"
	}
}

func replaceExt(path, newExt string) string {
	ext := filepath.Ext(path)
	if ext == "" {
		return path + newExt
	}
	return strings.TrimSuffix(path, ext) + newExt
}

// jsonOrNull returns the raw JSON as a decoded value, or nil when empty.
func jsonOrNull(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

// jsonOrEmptyArray decodes the raw JSON, defaulting to an empty array.
func jsonOrEmptyArray(raw json.RawMessage) any {
	if len(raw) == 0 {
		return []any{}
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return []any{}
	}
	return v
}
