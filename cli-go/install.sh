#!/bin/sh
# install.sh — fetch a prvodctl release binary and install it locally.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/keep-honest/prvod/main/cli-go/install.sh | sh
#
# Environment variables:
#   PRVODCTL_VERSION       Tag to install (e.g. v0.1.0). Default: latest release.
#   PRVODCTL_INSTALL_DIR   Where to place the binary. Default: /usr/local/bin
#                          (falls back to $HOME/.local/bin if not writable).
#   PRVODCTL_REPO          owner/repo (default: keep-honest/prvod). For forks.
#   PRVODCTL_SKIP_CHECKSUM Set to 1 to skip SHA256 verification (not recommended).

set -eu

REPO="${PRVODCTL_REPO:-keep-honest/prvod}"
VERSION="${PRVODCTL_VERSION:-}"
INSTALL_DIR="${PRVODCTL_INSTALL_DIR:-}"

# Same strict semver pattern enforced by .github/workflows/release.yml. Keep
# in sync.
VERSION_REGEX='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

# --- helpers ---

# Preserves the temp dir whenever the script exits non-zero so users have
# something to attach to bug reports. Preservation is driven by the trap's own
# $? — that way ANY non-zero exit path (err(), set -e tripping a typo, future
# additions) keeps the evidence, not just calls routed through err().
TMP=""

cleanup() {
  rc=$?
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    if [ "$rc" -ne 0 ]; then
      printf 'install.sh: exited with code %s; temp files preserved at %s\n' "$rc" "$TMP" >&2
    else
      rm -rf "$TMP"
    fi
  fi
}
trap cleanup EXIT

err() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

info() { printf '%s\n' "$*"; }
warn() { printf 'install.sh: warning: %s\n' "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || err "missing required command: $1"
}

# Detect OS in Go's GOOS naming.
detect_os() {
  uname_s=$(uname -s)
  case "$uname_s" in
    Linux*)  printf 'linux\n' ;;
    Darwin*) printf 'darwin\n' ;;
    MINGW*|MSYS*|CYGWIN*)
      err "Windows is not supported by this install script. Download the .zip from https://github.com/$REPO/releases/latest and extract prvodctl.exe into a directory on your PATH." ;;
    *) err "unsupported OS: $uname_s" ;;
  esac
}

# Detect arch in Go's GOARCH naming.
detect_arch() {
  uname_m=$(uname -m)
  case "$uname_m" in
    x86_64|amd64) printf 'amd64\n' ;;
    arm64|aarch64) printf 'arm64\n' ;;
    *) err "unsupported architecture: $uname_m" ;;
  esac
}

# Fetch a URL to a file. Returns non-zero on HTTP error (curl -f) or transport
# failure. Prefer curl, fall back to wget. We use a file (not a pipe) so the
# exit code is observable — sh has no portable `set -o pipefail`.
# Captures the downloader's stderr to "$out.err" so callers can surface the
# real diagnostic (DNS, TLS, rate limit, etc.) instead of a generic message.
fetch_to() {
  url=$1
  out=$2
  err_file="${out}.err"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --retry-delay 1 -o "$out" "$url" 2>"$err_file"
  elif command -v wget >/dev/null 2>&1; then
    # --tries=3 --waitretry=1 mirrors curl's retry behavior; we deliberately
    # do NOT use -q so wget's own diagnostic for the failure reaches stderr.
    wget --tries=3 --waitretry=1 -O "$out" "$url" 2>"$err_file"
  else
    err "need curl or wget on PATH"
  fi
}

# Renders the captured downloader error file (if non-empty) as a parenthetical
# detail suitable for splicing into an err() call.
fetch_err_detail() {
  out=$1
  err_file="${out}.err"
  if [ -s "$err_file" ]; then
    # Single-line summary; tail -1 to skip progress chatter from wget.
    tail -1 "$err_file"
  fi
}

# Compute SHA256 of a file. Linux uses sha256sum; macOS uses shasum -a 256.
sha256_of() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    err "need sha256sum or shasum on PATH"
  fi
}

# Pick the install directory: PRVODCTL_INSTALL_DIR > /usr/local/bin (if
# writable) > $HOME/.local/bin (creating it if needed). Surfaces the fallback
# decision so users aren't surprised by the install landing somewhere other
# than they expected.
pick_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    printf '%s\n' "$INSTALL_DIR"
    return
  fi
  if [ -w /usr/local/bin ]; then
    printf '/usr/local/bin\n'
    return
  fi
  # /usr/local/bin missing? Try to create it, but capture the real reason
  # if mkdir fails (ENOSPC, EROFS, SELinux denial — anything other than
  # plain permission-denied) so the fallback note isn't misleading.
  if [ ! -e /usr/local/bin ]; then
    if mkdir_err=$(mkdir -p /usr/local/bin 2>&1); then
      printf '/usr/local/bin\n'
      return
    fi
    warn "could not create /usr/local/bin: $mkdir_err"
  fi
  warn "/usr/local/bin is not writable; falling back to \$HOME/.local/bin"
  warn "  (re-run with sudo, or set PRVODCTL_INSTALL_DIR=/usr/local/bin to override)"
  mkdir -p "$HOME/.local/bin" || err "could not create $HOME/.local/bin"
  printf '%s/.local/bin\n' "$HOME"
}

# --- main ---

require uname
require tar
require gzip
require mkdir
require mv
require chmod
require awk
require grep
require sed

OS=$(detect_os)
ARCH=$(detect_arch)

# Create the tempdir up front so every step can write into it. Cleanup is
# handled by the EXIT trap above (preserves on failure for debugging).
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t prvodctl-install)

if [ -z "$VERSION" ]; then
  info "Resolving latest release..."
  api_url="https://api.github.com/repos/$REPO/releases/latest"
  api_body="$TMP/api.json"
  if ! fetch_to "$api_url" "$api_body"; then
    detail=$(fetch_err_detail "$api_body")
    err "GitHub API request failed: $api_url${detail:+ ($detail)}. Set PRVODCTL_VERSION to skip this lookup."
  fi
  # Anchor on leading whitespace so we only pick up a top-level "tag_name"
  # field, not a substring inside a release body or asset name.
  VERSION=$(grep -E '^[[:space:]]*"tag_name":' "$api_body" | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
  if [ -z "$VERSION" ]; then
    # Surface the API's own message if present (rate limit, not found, etc.).
    api_msg=$(grep -E '^[[:space:]]*"message":' "$api_body" | head -1 | sed -E 's/.*"message": *"([^"]+)".*/\1/' || true)
    if [ -n "$api_msg" ]; then
      err "could not resolve latest release from $api_url: $api_msg"
    else
      err "could not resolve latest release from $api_url (no tag_name in response)"
    fi
  fi
fi

# Strict semver gate — mirror the release workflow's regex. Prevents anything
# unexpected from being spliced into download URLs or the chmod target.
if ! printf '%s' "$VERSION" | grep -Eq "$VERSION_REGEX"; then
  err "version $VERSION does not match $VERSION_REGEX"
fi

ASSET="prvodctl-${VERSION}-${OS}-${ARCH}.tar.gz"
BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
ARCHIVE_URL="$BASE_URL/$ASSET"
CHECKSUMS_URL="$BASE_URL/SHA256SUMS"

info "Downloading $ASSET..."
if ! fetch_to "$ARCHIVE_URL" "$TMP/$ASSET"; then
  detail=$(fetch_err_detail "$TMP/$ASSET")
  err "download failed: $ARCHIVE_URL${detail:+ ($detail)}"
fi

# Validate the file we just downloaded before handing it to tar. The most
# common failure modes are (a) GitHub returning an HTML error page rather
# than the archive, and (b) a truncated download where curl returns 0 but
# the bytes are short. `gzip -t` catches both — it parses the gzip header
# AND verifies the CRC at the end of the stream, so truncation can't slip
# past. We rely on `gzip` instead of a hand-rolled `dd|od` magic check
# because gzip is already a hard dependency of `tar -xzf` below and its
# exit code is unambiguous.
if [ ! -s "$TMP/$ASSET" ]; then
  err "downloaded file is empty: $ARCHIVE_URL"
fi
if ! gzip -t "$TMP/$ASSET" 2>"$TMP/gzip.err"; then
  gz_msg=$(tail -1 "$TMP/gzip.err" 2>/dev/null || true)
  err "downloaded file is not a valid gzip archive${gz_msg:+ ($gz_msg)}. The server may have returned an error page, or the download may have been truncated."
fi

if [ "${PRVODCTL_SKIP_CHECKSUM:-0}" = "1" ]; then
  warn "PRVODCTL_SKIP_CHECKSUM=1; skipping SHA256 verification (NOT RECOMMENDED)"
else
  info "Verifying SHA256..."
  if ! fetch_to "$CHECKSUMS_URL" "$TMP/SHA256SUMS"; then
    detail=$(fetch_err_detail "$TMP/SHA256SUMS")
    err "could not download $CHECKSUMS_URL${detail:+ ($detail)}"
  fi
  # Use awk for exact filename match instead of `grep " $ASSET\$"`, which
  # would treat `.` in tar.gz as a regex any-char and could collide with
  # adjacent filenames in pathological future renames.
  expected=$(awk -v a="$ASSET" '$2 == a { print $1 }' "$TMP/SHA256SUMS")
  if [ -z "$expected" ]; then
    err "no checksum entry for $ASSET in SHA256SUMS"
  fi
  got=$(sha256_of "$TMP/$ASSET")
  if [ "$got" != "$expected" ]; then
    err "checksum mismatch for $ASSET: expected $expected, got $got (possible truncated download or tampered asset)"
  fi
fi

info "Extracting..."
if ! tar -xzf "$TMP/$ASSET" -C "$TMP" 2>"$TMP/tar.err"; then
  tar_msg=$(cat "$TMP/tar.err" 2>/dev/null || true)
  err "tar extraction failed: ${tar_msg:-unknown error}"
fi
BIN_DIR="$TMP/prvodctl-${VERSION}-${OS}-${ARCH}"
if [ ! -x "$BIN_DIR/prvodctl" ]; then
  err "archive did not contain an executable prvodctl binary at $BIN_DIR/prvodctl"
fi

DEST_DIR=$(pick_install_dir)
mkdir -p "$DEST_DIR" || err "could not create install directory: $DEST_DIR"
if ! mv "$BIN_DIR/prvodctl" "$DEST_DIR/prvodctl"; then
  err "failed to install binary to $DEST_DIR/prvodctl (check permissions)"
fi
if ! chmod +x "$DEST_DIR/prvodctl"; then
  err "failed to mark $DEST_DIR/prvodctl executable (filesystem mounted noexec?)"
fi

info "Installed prvodctl to $DEST_DIR/prvodctl"
case ":$PATH:" in
  *":$DEST_DIR:"*) ;;
  *) info "Note: $DEST_DIR is not in your PATH. Add it to use 'prvodctl' directly." ;;
esac

if ! "$DEST_DIR/prvodctl" --version; then
  err "installed binary at $DEST_DIR/prvodctl failed to execute (--version returned non-zero). Check architecture / libc compatibility."
fi
