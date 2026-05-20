#!/usr/bin/env bash
# Source this file so exports persist in your shell:
#   source scripts/diff/set-diff-test-env.sh

if ! (return 0 2>/dev/null); then
  echo "Source this script so the exports persist in your shell:"
  echo "  source scripts/diff/set-diff-test-env.sh"
  exit 1
fi

# --- Mock providers (no paid API keys required) ---
export SCRIPT_WRITER="${SCRIPT_WRITER:-mock}"
export TTS_PROVIDER="${TTS_PROVIDER:-mock}"
export VIDEO_PROVIDER="${VIDEO_PROVIDER:-mock}"
export STORAGE_PROVIDER="${STORAGE_PROVIDER:-local}"
export SUMMARISER_PROVIDER="${SUMMARISER_PROVIDER:-mock}"

# --- Auth (no real GitHub App needed) ---
export API_SECRET_KEY="${API_SECRET_KEY:-diff-test-secret}"
export APP_ENCRYPTION_KEY="${APP_ENCRYPTION_KEY:-$(openssl rand -hex 32 2>/dev/null || echo "dev-pepper-32-bytes-placeholder00")}"

# --- Diff pipeline knobs ---
# Keeps rolling summariser free (no Anthropic API call) — uses mock script writer so
# the summariser path is never exercised during unit-equivalent manual runs.
export CLAUDE_SUMMARISER_MODEL="${CLAUDE_SUMMARISER_MODEL:-claude-haiku-4-5-20251001}"

# Skip AI judges so mock-writer scripts pass without real LLM evaluation.
export SKIP_JUDGE="${SKIP_JUDGE:-true}"

# --- Server ---
export NODE_ENV="${NODE_ENV:-development}"
export NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-http://localhost:3000}"

echo "Diff-test env exported:"
echo "  SCRIPT_WRITER=$SCRIPT_WRITER"
echo "  TTS_PROVIDER=$TTS_PROVIDER"
echo "  VIDEO_PROVIDER=$VIDEO_PROVIDER"
echo "  STORAGE_PROVIDER=$STORAGE_PROVIDER"
echo "  SUMMARISER_PROVIDER=$SUMMARISER_PROVIDER"
echo "  API_SECRET_KEY=$API_SECRET_KEY"
echo "  SKIP_JUDGE=$SKIP_JUDGE"
echo ""
echo "Start the server with:"
echo "  npm run dev"
echo ""
echo "Then run the CLI with:"
echo "  npm run cli -- --server-url http://localhost:3000 --api-key \$API_SECRET_KEY --diff-file <path> --script-only"
