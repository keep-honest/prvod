#!/usr/bin/env node
/**
 * Postinstall hook: pre-download Chrome Headless Shell when Remotion is the
 * active compositor, so the ~110 MB binary fetch never happens at first render.
 *
 * Gated on VIDEO_COMPOSITOR=remotion to avoid surprising ffmpeg-only installs
 * with a download they will never use.
 *
 * Error policy:
 *  - Transient/operational errors (network blip, DNS, TLS, timeout) → warn and
 *    exit 0. The renderer's lazy download at first render is the fallback, and
 *    we never want a flaky network to break `npm ci` in CI.
 *  - Misconfiguration errors (package missing, permission denied, disk full,
 *    invalid Remotion API) → fail loudly with exit 1. These will recur at
 *    render time as user-facing failures with worse diagnostics, so surface
 *    them at install time when an operator can act.
 *
 * Exports are provided for unit testing of the classification predicate; the
 * side-effecting entry point is gated on `import.meta.url === argv[1]` so the
 * test runner can import this module without triggering the install hook.
 */
import process from "node:process";
import { error as consoleError, log as consoleLog, warn as consoleWarn } from "node:console";
import { pathToFileURL } from "node:url";

/** Error codes that indicate misconfiguration, not transient failure. */
export const FATAL_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
]);

/** Decide whether an error from ensureBrowser should fail the install. */
export function isFatal(err) {
  if (!err) return false;
  if (typeof err.code === "string" && FATAL_CODES.has(err.code)) return true;
  // ensureBrowser API removed / renamed across major Remotion versions. The
  // `typeof !== "function"` guard catches the export-missing case; this branch
  // catches a TypeError thrown from inside Remotion's implementation that
  // references the symbol (defensive overlap, not dead code).
  if (err instanceof TypeError && /ensureBrowser/.test(err.message ?? "")) {
    return true;
  }
  return false;
}

/** Bounds for the recursive cause/errors walk. The depth cap is generous for
 * real AggregateError nesting (typically 1–2). The WeakSet catches cycles,
 * which retry libraries occasionally produce by re-aggregating their own
 * thrown error. Without both guards, a cyclic `.errors` array would blow the
 * call stack from inside the error-handling path — turning a structured warn
 * into an opaque RangeError. */
const MAX_CAUSE_DEPTH = 8;

/** Materialize a non-Array errors collection without sweeping in unrelated
 * iterables. The spec says AggregateError.errors is an Array, but some retry
 * libraries (older p-retry, custom aggregators) attach a Set instead. We
 * accept Array and Set only — broader iterable acceptance would also catch
 * strings, Buffers, and TypedArrays which would produce nonsense errors. */
function toErrorsArray(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  return null;
}

/**
 * Reduce an arbitrary `cause` (or `errors[i]`) payload to something useful in
 * a log line. Node's fetch/undici wraps network failures with `cause` set to
 * a plain object (e.g. `{ code, errno, syscall }`), some libraries pass
 * strings, and AggregateError surfaces inner errors in `.errors` rather than
 * `.message`. Returning `err.cause?.message` alone silently drops all three
 * shapes.
 */
function summarizeCause(cause, seen = new WeakSet(), depth = 0) {
  if (cause == null) return undefined;
  if (depth > MAX_CAUSE_DEPTH) return "[truncated: max depth]";
  if (typeof cause === "object" || typeof cause === "function") {
    if (seen.has(cause)) return "[circular]";
    seen.add(cause);
  }
  if (cause instanceof Error) {
    const summary = {
      code: cause.code,
      name: cause.name,
      message: cause.message,
    };
    const innerErrors = toErrorsArray(cause.errors);
    if (innerErrors) {
      summary.errors = innerErrors.map((e) => summarizeCause(e, seen, depth + 1));
    }
    return summary;
  }
  if (typeof cause === "string") return cause;
  if (typeof cause === "object") {
    try {
      return JSON.stringify(cause, Object.getOwnPropertyNames(cause));
    } catch {
      return String(cause);
    }
  }
  return String(cause);
}

/** Structured one-line log shape so operators can distinguish failure modes later. */
export function describe(err) {
  const seen = new WeakSet();
  if (err != null && (typeof err === "object" || typeof err === "function")) {
    seen.add(err);
  }
  const out = {
    code: err?.code,
    name: err?.name,
    message: err?.message,
    cause: summarizeCause(err?.cause, seen, 1),
  };
  // The thrown error itself may be an AggregateError (Promise.any, mirror
  // retry harnesses) — not wrapped in `cause`. Without this branch, every
  // inner reason is dropped from the log line just as in the cause case.
  const topErrors = toErrorsArray(err?.errors);
  if (topErrors) {
    out.errors = topErrors.map((e) => summarizeCause(e, seen, 1));
  }
  return out;
}

/**
 * Run the postinstall hook. Returns the desired process exit code instead of
 * calling process.exit directly, so callers (including tests) can compose it.
 */
export async function ensureRemotionBrowser() {
  if (process.env.VIDEO_COMPOSITOR !== "remotion") {
    return 0;
  }

  let mod;
  try {
    mod = await import("@remotion/renderer");
  } catch (err) {
    if (isFatal(err)) {
      consoleError(
        "[postinstall] VIDEO_COMPOSITOR=remotion but @remotion/renderer cannot be loaded. " +
          "Install the package or unset VIDEO_COMPOSITOR.",
        describe(err),
      );
      return 1;
    }
    consoleWarn(
      "[postinstall] @remotion/renderer import failed — server boot will retry.",
      describe(err),
    );
    return 0;
  }

  if (typeof mod.ensureBrowser !== "function") {
    consoleError(
      "[postinstall] @remotion/renderer does not export ensureBrowser() — Remotion API drift. " +
        "Pin a compatible @remotion/renderer version.",
    );
    return 1;
  }

  try {
    await mod.ensureBrowser();
    consoleLog("[postinstall] chrome-headless-shell ready");
    return 0;
  } catch (err) {
    if (isFatal(err)) {
      consoleError(
        "[postinstall] remotion browser ensure failed with a non-transient error.",
        describe(err),
      );
      return 1;
    }
    consoleWarn(
      "[postinstall] remotion browser ensure failed — server boot will retry.",
      describe(err),
    );
    return 0;
  }
}

const isEntryPoint =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  process.exit(await ensureRemotionBrowser());
}
