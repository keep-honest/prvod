package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// resolve builds the command, applies flag values, loads config, and resolves
// options — mirroring what Execute does up to (but not including) run().
func resolve(t *testing.T, flags map[string]string, configPath string) (*options, error) {
	t.Helper()
	// Isolate config discovery from the host environment.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	cmd, v, cfg := buildRoot()
	if configPath != "" {
		*cfg = configPath
	}
	for k, val := range flags {
		if err := cmd.Flags().Set(k, val); err != nil {
			t.Fatalf("set --%s=%s: %v", k, val, err)
		}
	}
	if err := initConfig(v, cmd, *cfg); err != nil {
		return nil, err
	}
	return resolveOptions(v, cmd)
}

func wantCode(t *testing.T, err error, code int) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %d, got nil", code)
	}
	var ce *CodedError
	if !errors.As(err, &ce) {
		t.Fatalf("error %v is not a *CodedError", err)
	}
	if ce.Code != code {
		t.Fatalf("exit code = %d, want %d (%v)", ce.Code, code, err)
	}
}

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const validDiff = "diff --git a/x b/x\n+line\n"

func TestResolveRequiresServerAndKey(t *testing.T) {
	_, err := resolve(t, map[string]string{"api-key": "k"}, "")
	wantCode(t, err, 1)

	_, err = resolve(t, map[string]string{"server-url": "http://x"}, "")
	wantCode(t, err, 1)
}

func TestResolveMutualExclusionExit1(t *testing.T) {
	base := map[string]string{"server-url": "http://x", "api-key": "k"}

	flags := clone(base, map[string]string{"script-only": "true", "tts-only": "true"})
	wantCode(t, mustErr(resolve(t, flags, "")), 1)

	flags = clone(base, map[string]string{"short-dur": "true", "popcorn": "true"})
	wantCode(t, mustErr(resolve(t, flags, "")), 1)
}

func TestResolveDiffFileExitCodes(t *testing.T) {
	base := map[string]string{"server-url": "http://x", "api-key": "k"}

	// exit 2: mutually exclusive with --pr-number
	ok := writeFile(t, "ok.diff", validDiff)
	wantCode(t, mustErr(resolve(t, clone(base, map[string]string{"diff-file": ok, "pr-number": "5"}), "")), 2)

	// exit 3: missing file
	wantCode(t, mustErr(resolve(t, clone(base, map[string]string{"diff-file": "/no/such.diff"}), "")), 3)

	// exit 3: empty file
	empty := writeFile(t, "empty.diff", "")
	wantCode(t, mustErr(resolve(t, clone(base, map[string]string{"diff-file": empty}), "")), 3)

	// exit 4: not a unified diff
	notdiff := writeFile(t, "notes.txt", "hello world\n")
	wantCode(t, mustErr(resolve(t, clone(base, map[string]string{"diff-file": notdiff}), "")), 4)

	// happy path: resolves to absolute and keeps script-only
	opts, err := resolve(t, clone(base, map[string]string{"diff-file": ok, "script-only": "true"}), "")
	if err != nil {
		t.Fatalf("valid diff-file errored: %v", err)
	}
	if !filepath.IsAbs(opts.diffFile) {
		t.Errorf("diff-file not absolute: %s", opts.diffFile)
	}
	if !opts.scriptOnly {
		t.Errorf("script-only not preserved")
	}
}

func TestResolvePositiveIntValidation(t *testing.T) {
	base := map[string]string{"server-url": "http://x", "api-key": "k"}
	wantCode(t, mustErr(resolve(t, clone(base, map[string]string{"pr-number": "0"}), "")), 1)
	wantCode(t, mustErr(resolve(t, clone(base, map[string]string{"poll-interval-ms": "0"}), "")), 1)
	wantCode(t, mustErr(resolve(t, clone(base, map[string]string{"max-polls": "-1"}), "")), 1)

	// max-polls 0 means unlimited (nil), no error.
	opts, err := resolve(t, base, "")
	if err != nil {
		t.Fatal(err)
	}
	if opts.maxPolls != nil {
		t.Errorf("maxPolls should be nil (unlimited) by default")
	}
}

func TestConfigPrecedence(t *testing.T) {
	cfg := writeFile(t, "prvodctl.yaml", "server-url: http://from-config\napi-key: key-from-config\nscript-only: true\npoll-interval-ms: 1234\n")

	// config only
	opts, err := resolve(t, nil, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.serverURL != "http://from-config" {
		t.Errorf("server-url = %q, want from-config", opts.serverURL)
	}
	if !opts.scriptOnly {
		t.Errorf("script-only should come from config")
	}
	if opts.pollIntervalMs != 1234 {
		t.Errorf("poll-interval-ms = %d, want 1234", opts.pollIntervalMs)
	}

	// flag overrides config
	opts, err = resolve(t, map[string]string{"server-url": "http://from-flag"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if opts.serverURL != "http://from-flag" {
		t.Errorf("flag should override config; got %q", opts.serverURL)
	}

	// env overrides config but loses to an explicit flag
	t.Run("env beats config", func(t *testing.T) {
		t.Setenv("SERVER_URL", "http://from-env")
		opts, err := resolve(t, nil, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if opts.serverURL != "http://from-env" {
			t.Errorf("env should beat config; got %q", opts.serverURL)
		}
	})
	t.Run("flag beats env", func(t *testing.T) {
		t.Setenv("SERVER_URL", "http://from-env")
		opts, err := resolve(t, map[string]string{"server-url": "http://from-flag"}, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if opts.serverURL != "http://from-flag" {
			t.Errorf("flag should beat env; got %q", opts.serverURL)
		}
	})
}

func TestExplicitMissingConfigErrors(t *testing.T) {
	_, err := resolve(t, map[string]string{"server-url": "http://x", "api-key": "k"}, "/no/such/config.yaml")
	wantCode(t, err, 1)
}

func TestTrailingSlashStripped(t *testing.T) {
	opts, err := resolve(t, map[string]string{"server-url": "http://x:3000/", "api-key": "k"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if opts.serverURL != "http://x:3000" {
		t.Errorf("trailing slash not stripped: %q", opts.serverURL)
	}
}

func clone(base, extra map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func mustErr(_ *options, err error) error { return err }
