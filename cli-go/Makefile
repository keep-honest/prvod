# Makefile for prvodctl — the Go CLI client for the prvod server.
#
# `go build .` inside this directory would otherwise produce a binary named
# `cli-go` (after the working-directory's last path segment). This Makefile
# pins the output name to `prvodctl` everywhere so the build artifact, the
# README usage examples, and `.gitignore` all agree.

BINARY      := prvodctl
PKG         := .
GO          ?= go
GOFLAGS     ?=
BUILD_DIR   := .
DIST_DIR    := dist

# Version stamping. Set VERSION on the command line or via env to override
# (e.g. `make build VERSION=v0.1.0`). The release workflow passes explicit
# values; local builds fall back to `git describe`.
VERSION     ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT      ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE        ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# -s -w strip the symbol/DWARF tables (~30% smaller binary). The -X flags
# inject build-time values into main.{Version,Commit,Date} so `prvodctl
# --version` reports the published release.
LDFLAGS     ?= -s -w \
               -X main.Version=$(VERSION) \
               -X main.Commit=$(COMMIT) \
               -X main.Date=$(DATE)

# Default target: a local build of `prvodctl` in this directory.
.DEFAULT_GOAL := build

.PHONY: build
build: ## Build ./prvodctl for the host platform
	$(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BUILD_DIR)/$(BINARY) $(PKG)

.PHONY: install
install: ## go install prvodctl into $GOBIN / $GOPATH/bin
	$(GO) install $(GOFLAGS) -ldflags '$(LDFLAGS)' $(PKG)

.PHONY: test
test: ## Run all tests
	$(GO) test $(GOFLAGS) ./...

.PHONY: test-race
test-race: ## Run tests with the race detector
	$(GO) test $(GOFLAGS) -race ./...

.PHONY: cover
cover: ## Run tests with coverage and print the summary
	$(GO) test $(GOFLAGS) -coverprofile=coverage.out ./...
	$(GO) tool cover -func=coverage.out | tail -1

.PHONY: vet
vet: ## go vet ./...
	$(GO) vet ./...

.PHONY: fmt
fmt: ## gofmt -w on all Go sources (vendor/ pruned if it ever exists)
	gofmt -w $$(find . -path ./vendor -prune -o -name '*.go' -print)

.PHONY: tidy
tidy: ## go mod tidy
	$(GO) mod tidy

.PHONY: check
check: vet test ## vet + test (CI-friendly aggregate)

# Cross-compile a set of common platforms into dist/. Useful for releases.
PLATFORMS := \
	linux/amd64 \
	linux/arm64 \
	darwin/amd64 \
	darwin/arm64 \
	windows/amd64

.PHONY: dist
dist: ## Cross-compile prvodctl for common platforms into ./dist
	@mkdir -p $(DIST_DIR)
	@for plat in $(PLATFORMS); do \
		os=$${plat%/*}; arch=$${plat#*/}; \
		ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
		out=$(DIST_DIR)/$(BINARY)-$$os-$$arch$$ext; \
		echo "==> $$out"; \
		GOOS=$$os GOARCH=$$arch $(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $$out $(PKG) || exit 1; \
	done

.PHONY: clean
clean: ## Remove the built binary, dist/, and any stray `cli-go` artifact
	rm -f $(BUILD_DIR)/$(BINARY)
	# `go build .` (without -o) names the binary after this directory; sweep
	# it so it can't be accidentally left around or staged.
	rm -f $(BUILD_DIR)/cli-go
	rm -rf $(DIST_DIR)
	rm -f coverage.out

.PHONY: run
run: build ## Build and run prvodctl (pass args via ARGS, e.g. `make run ARGS="--help"`)
	./$(BINARY) $(ARGS)

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Targets:\n"} \
		/^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
