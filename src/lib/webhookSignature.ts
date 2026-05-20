import { createHmac, timingSafeEqual } from "crypto";

/**
 * Whole-line annotation regex.
 *
 * The annotation is only recognised when a line of the comment/PR body
 * (ignoring surrounding whitespace and up to one trailing sentence-punct)
 * consists of the literal `@prvod` optionally followed by exactly one
 * mode keyword: `script`, `short`, or `popcorn`.
 *
 * This intentionally rejects drive-by mentions inside longer prose
 * ("this is related to @prvod stuff") so only purposeful commands
 * trigger the pipeline. Two concrete payoffs:
 *   1. Webhook loop-guard defence in depth: our own failure comments
 *      can't accidentally re-trigger the pipeline just because they
 *      mention `@prvod` in their retry instructions.
 *   2. Prevents accidental triggers from PR templates or status
 *      comments that happen to reference the bot by name.
 *
 * The `m` flag turns `^`/`$` into line anchors so a single multi-line
 * body can still carry the command on one of its lines. The `i` flag
 * is case-insensitive. The group captures the optional mode keyword.
 *
 * Negative lookahead `(?!\w)` on the mode keyword guards against
 * `@prvod shortly` / `@prvod scriptwriter` on the rare occasion that
 * whitespace-then-punctuation collapses in unexpected ways.
 */
const ANNOTATION_LINE_PATTERN = "^[ \\t]*@prvod(?:\\s+(script|short|popcorn|deepdive)(?!\\w))?(?:\\s+(script|short|popcorn|deepdive)(?!\\w))?[ \\t]*[.!?]?[ \\t]*$";

/**
 * Global scanner used by `parseAnnotations`. A fresh instance is
 * constructed per call because a shared `g`-flagged regex carries
 * `lastIndex` state across calls, which has historically been a
 * source of impossible-to-reproduce bugs.
 */
function makeAnnotationScanner(): RegExp {
  return new RegExp(ANNOTATION_LINE_PATTERN, "gim");
}

/**
 * @deprecated Kept only so existing call sites can still test the
 * basic `@prvod` command boundary. Prefer `parseAnnotations`, which
 * returns full parsed metadata.
 */
export const ANNOTATION_REGEX: RegExp = new RegExp(ANNOTATION_LINE_PATTERN, "im");

export interface ParsedAnnotation {
  hasAnnotation: boolean;
  scriptOnly: boolean;
  shortDuration: boolean;
  popcornDuration: boolean;
  deepdive: boolean;
}

/**
 * Parse `@prvod` annotation variants from a text body (PR description or
 * comment). Only whole-line commands are recognised — drive-by mentions
 * inside prose are ignored.
 *
 * `deepdive` is a combinable modifier: `@prvod short deepdive` or
 * `@prvod deepdive popcorn` both work (order-independent).
 *
 * Mode precedence when multiple annotation lines appear in the same body:
 *   script > popcorn > short > plain.
 */
export function parseAnnotations(body: string): ParsedAnnotation {
  let hasAnnotation = false;
  let scriptOnly = false;
  let popcornDuration = false;
  let shortDuration = false;
  let deepdive = false;

  // `matchAll` avoids the `lastIndex` pitfall of a shared `g`-flagged
  // regex and keeps the scan purely declarative.
  for (const match of body.matchAll(makeAnnotationScanner())) {
    const tokens = [match[1]?.toLowerCase(), match[2]?.toLowerCase()].filter(Boolean);

    // Reject double-mode on the same line (e.g. `@prvod script short`).
    // Two tokens are only valid when one of them is `deepdive`.
    const modes = tokens.filter((t) => t !== "deepdive");
    if (modes.length > 1) continue;

    hasAnnotation = true;
    if (tokens.includes("deepdive")) deepdive = true;

    if (tokens.includes("script")) {
      scriptOnly = true;
      // Don't break — deepdive may appear on a later line and it's an
      // orthogonal modifier, not a competing mode.
      continue;
    }
    if (tokens.includes("popcorn")) {
      popcornDuration = true;
      continue;
    }
    if (tokens.includes("short")) {
      shortDuration = true;
      continue;
    }
    // else: plain `@prvod` — `hasAnnotation` already set above.
  }

  // Enforce precedence now that the full body has been scanned.
  if (scriptOnly) {
    popcornDuration = false;
    shortDuration = false;
  } else if (popcornDuration) {
    shortDuration = false;
  }

  return { hasAnnotation, scriptOnly, shortDuration, popcornDuration, deepdive };
}

/**
 * Verify a GitHub webhook HMAC-SHA256 signature.
 *
 * @param rawBody   The raw request body string (must be read before JSON.parse).
 * @param signature The value of the X-Hub-Signature-256 header.
 * @param secret    The shared GitHub App webhook secret (GITHUB_APP_WEBHOOK_SECRET).
 * @returns true if the signature is valid, false otherwise.
 */
export function verifyGitHubSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")}`;

  // Buffers must be the same length for timingSafeEqual.
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
}
