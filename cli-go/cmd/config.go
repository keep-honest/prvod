package cmd

import (
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// initConfig wires up the Viper instance for one invocation: it locates and
// reads a config file (explicit --config, then conventional locations), binds
// the four supported environment variables, and binds every command flag.
//
// The resulting precedence for any setting is: explicit flag > env var >
// config file > built-in default.
func initConfig(v *viper.Viper, cmd *cobra.Command, configFlag string) error {
	v.SetConfigType("yaml")

	if configFlag != "" {
		// An explicit --config that can't be read is a hard error.
		v.SetConfigFile(configFlag)
		if err := v.ReadInConfig(); err != nil {
			return coded(1, "failed to read config file %s: %v", configFlag, err)
		}
	} else if path := findConfigFile(); path != "" {
		v.SetConfigFile(path)
		if err := v.ReadInConfig(); err != nil {
			return coded(1, "failed to read config file %s: %v", path, err)
		}
	}

	// Env vars don't share a prefix, so bind each one explicitly. These mirror
	// the fallbacks the Node CLI honors.
	_ = v.BindEnv("server-url", "SERVER_URL")
	_ = v.BindEnv("api-key", "API_SECRET_KEY")
	_ = v.BindEnv("max-polls", "CLI_MAX_POLLS")
	_ = v.BindEnv("poll-interval-ms", "CLI_POLL_INTERVAL_MS")

	return v.BindPFlags(cmd.Flags())
}

// findConfigFile returns the first existing config file in discovery order, or
// "" if none is found:
//  1. ./prvodctl.yaml | ./prvodctl.yml
//  2. $XDG_CONFIG_HOME/prvodctl/ (or ~/.config/prvodctl/)
//  3. ~/.prvodctl.yaml | ~/.prvodctl.yml
func findConfigFile() string {
	var candidates []string
	candidates = append(candidates, "prvodctl.yaml", "prvodctl.yml")

	cfgHome := os.Getenv("XDG_CONFIG_HOME")
	if cfgHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cfgHome = filepath.Join(home, ".config")
		}
	}
	if cfgHome != "" {
		candidates = append(candidates,
			filepath.Join(cfgHome, "prvodctl", "prvodctl.yaml"),
			filepath.Join(cfgHome, "prvodctl", "prvodctl.yml"),
		)
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".prvodctl.yaml"),
			filepath.Join(home, ".prvodctl.yml"),
		)
	}

	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}
