// Command prvodctl is a Go CLI client for the prvod server. It mirrors the
// functionality of the Node CLI (src/cli/local-test.ts), talking to the server's
// HTTP API instead of invoking server functions directly.
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/keep-honest/prvod/cli-go/cmd"
)

// Build-time variables. Overridden via -ldflags '-X main.Version=...' by the
// release workflow / Makefile so `prvodctl --version` reports the published
// release. Defaults reflect a from-source build.
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

func main() {
	info := cmd.BuildInfo{Version: Version, Commit: Commit, Date: Date}
	if err := cmd.Execute(info); err != nil {
		if msg := err.Error(); msg != "" {
			fmt.Fprintln(os.Stderr, msg)
		}
		code := 1
		var ce *cmd.CodedError
		if errors.As(err, &ce) {
			code = ce.Code
		}
		os.Exit(code)
	}
}
