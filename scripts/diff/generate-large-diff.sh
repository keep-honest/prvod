#!/usr/bin/env bash
# Generate a synthetic unified diff for manual pagination and hard-cap testing.
#
# Usage:
#   scripts/diff/generate-large-diff.sh [--files N] [--lines-per-file N] [--output PATH]
#
# Examples:
#   # Trigger 2-segment pagination (default GitHub page size = 30 files)
#   scripts/diff/generate-large-diff.sh --files 31 --output /tmp/large-31.diff
#
#   # Generate a diff that approaches the hard cap (200k lines)
#   scripts/diff/generate-large-diff.sh --files 100 --lines-per-file 2000 --output /tmp/near-cap.diff
#
#   # Single large file to test oversized-file detection (patch > 64 KB)
#   scripts/diff/generate-large-diff.sh --files 1 --lines-per-file 3000 --output /tmp/oversized-file.diff

set -euo pipefail

FILES=31
LINES_PER_FILE=50
OUTPUT="/tmp/prvod-test-$(date +%s).diff"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --files)        FILES="$2";         shift 2 ;;
    --lines-per-file) LINES_PER_FILE="$2"; shift 2 ;;
    --output)       OUTPUT="$2";        shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "Generating diff: $FILES files × $LINES_PER_FILE lines/file → $OUTPUT"

{
  for i in $(seq 0 $((FILES - 1))); do
    echo "diff --git a/src/module${i}/index.ts b/src/module${i}/index.ts"
    echo "index 000000..$(printf '%06d' $i) 100644"
    echo "--- a/src/module${i}/index.ts"
    echo "+++ b/src/module${i}/index.ts"

    # Use a hunk that has roughly LINES_PER_FILE changed lines
    CONTEXT=3
    ADDED=$((LINES_PER_FILE / 2))
    REMOVED=$((LINES_PER_FILE - ADDED))
    echo "@@ -1,$((CONTEXT + REMOVED)) +1,$((CONTEXT + ADDED)) @@"

    for j in $(seq 1 $CONTEXT); do
      echo " // context line $j of module $i"
    done
    for j in $(seq 1 $REMOVED); do
      echo "-// removed: module=$i line=$j"
    done
    for j in $(seq 1 $ADDED); do
      echo "+// added:   module=$i line=$j"
    done

    # Add a second hunk for files that need more lines to exceed 64KB
    if [[ $LINES_PER_FILE -gt 500 ]]; then
      EXTRA=$((LINES_PER_FILE - ADDED - REMOVED))
      if [[ $EXTRA -gt 0 ]]; then
        HUNK_START=$((CONTEXT + REMOVED + 100))
        echo "@@ -${HUNK_START},1 +${HUNK_START},$((EXTRA + 1)) @@"
        echo " // second hunk context"
        for j in $(seq 1 $EXTRA); do
          echo "+// extra added: module=$i extra=$j padding-padding-padding-padding-padding-padding"
        done
      fi
    fi
  done
} > "$OUTPUT"

TOTAL_LINES=$(wc -l < "$OUTPUT")
FILE_SIZE=$(du -h "$OUTPUT" | cut -f1)
echo ""
echo "Written: $OUTPUT"
echo "  Total lines in diff file: $TOTAL_LINES"
echo "  File size: $FILE_SIZE"
echo ""
echo "Estimated diff stats:"
echo "  Files: $FILES"
echo "  Changed lines (approx): $((FILES * LINES_PER_FILE))"
echo ""

# Warn if near or over the 200k hard cap
CHANGED_TOTAL=$((FILES * LINES_PER_FILE))
if [[ $CHANGED_TOTAL -gt 200000 ]]; then
  echo "WARNING: ~$CHANGED_TOTAL changed lines exceeds the 200k hard cap — DiffTooLargeError expected."
elif [[ $CHANGED_TOTAL -gt 160000 ]]; then
  echo "NOTE: ~$CHANGED_TOTAL changed lines is near the 200k cap."
fi
