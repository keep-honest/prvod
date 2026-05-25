/**
 * Parse a single-range HTTP Range header against a known content size.
 *
 * Returns:
 *   - `null` if no header (caller should serve 200 full body)
 *   - `{ kind: "ok" }` for a valid single range → 206
 *   - `{ kind: "unsatisfiable" }` → 416 with `Content-Range: bytes *\/size`
 *   - `{ kind: "malformed" }` → also 416 (uniform handling)
 *
 * Multi-range (`bytes=0-100,200-300`) is rejected as unsatisfiable —
 * browsers very rarely emit it and supporting it would require a
 * multipart/byteranges response body.
 *
 * Lives in `src/lib/storage/` (not the route file) because Next.js
 * disallows non-HTTP-method exports from route handlers — declaring
 * `export function parseRange` next to `export async function GET`
 * fails the `.next/types` route validator with a TS2344.
 */

export type ParsedRange =
  | { kind: "ok"; start: number; end: number }
  | { kind: "unsatisfiable" }
  | { kind: "malformed" };

export function parseRange(
  header: string | null,
  size: number,
): null | ParsedRange {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith("bytes=")) return { kind: "malformed" };
  const spec = trimmed.slice("bytes=".length);
  if (spec.includes(",")) return { kind: "unsatisfiable" };

  const dashIdx = spec.indexOf("-");
  if (dashIdx === -1) return { kind: "malformed" };

  const startStr = spec.slice(0, dashIdx);
  const endStr = spec.slice(dashIdx + 1);
  const hasStart = startStr.length > 0;
  const hasEnd = endStr.length > 0;
  if (!hasStart && !hasEnd) return { kind: "malformed" };

  if (size === 0) return { kind: "unsatisfiable" };

  let start: number;
  let end: number;
  if (!hasStart) {
    // Suffix range: `bytes=-N` → last N bytes
    if (!/^[0-9]+$/.test(endStr)) return { kind: "malformed" };
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: "malformed" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (!hasEnd) {
    // Open-ended: `bytes=N-` → from N to EOF
    if (!/^[0-9]+$/.test(startStr)) return { kind: "malformed" };
    start = Number(startStr);
    end = size - 1;
  } else {
    if (!/^[0-9]+$/.test(startStr) || !/^[0-9]+$/.test(endStr)) {
      return { kind: "malformed" };
    }
    start = Number(startStr);
    end = Number(endStr);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { kind: "malformed" };
  }
  if (start < 0 || end < 0 || start > end || start >= size) {
    return { kind: "unsatisfiable" };
  }
  // Cap end at size-1; browsers send `bytes=N-` open-ended on first
  // seek and expect the server to clamp.
  if (end >= size) end = size - 1;

  return { kind: "ok", start, end };
}
