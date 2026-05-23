import { describe, expect, it } from "vitest";
import {
  FATAL_CODES,
  describe as describeError,
  isFatal,
} from "../../../scripts/ensure-remotion-browser.mjs";

describe("ensure-remotion-browser: isFatal predicate", () => {
  it("treats each fatal code as fatal", () => {
    // One named assertion per code so a future drop produces a named failure,
    // not a coverage delta. The set is the gatekeeper between exit-1 (operator
    // must act) and exit-0 (server boot will retry); silently shrinking it
    // erases the safety net the postinstall script is supposed to provide.
    for (const code of FATAL_CODES) {
      expect(isFatal({ code }), `expected ${code} to be fatal`).toBe(true);
    }
  });

  it("treats transient network/operational codes as non-fatal", () => {
    const transient = [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
    ];
    for (const code of transient) {
      expect(isFatal({ code }), `expected ${code} to be non-fatal`).toBe(false);
    }
  });

  it("treats a TypeError referencing ensureBrowser as fatal (Remotion API drift)", () => {
    expect(isFatal(new TypeError("ensureBrowser is not a function"))).toBe(true);
    expect(isFatal(new TypeError("foo bar ensureBrowser baz"))).toBe(true);
  });

  it("does not classify unrelated TypeErrors as fatal", () => {
    expect(isFatal(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isFatal(new TypeError(""))).toBe(false);
  });

  it("returns false for nullish and shape-less inputs", () => {
    expect(isFatal(null)).toBe(false);
    expect(isFatal(undefined)).toBe(false);
    expect(isFatal({})).toBe(false);
    expect(isFatal({ code: 42 })).toBe(false);
  });

  it("does not promote errno to code (regression guard)", () => {
    // Node attaches `errno` on many syscall errors as a separate field from
    // `code`. The predicate intentionally reads only `code` — promoting
    // `errno` would let a fatal-looking errno string misclassify a transient
    // syscall hiccup as fatal and break `npm ci` on flaky CI machines. This
    // test guards against a careless refactor like `err.errno ?? err.code`.
    expect(isFatal({ errno: "EACCES" })).toBe(false);
    expect(isFatal({ errno: "ENOSPC" })).toBe(false);
    expect(isFatal({ errno: -13 })).toBe(false);
  });

  it("includes the documented misconfiguration codes", () => {
    // Lock the set membership so the documented error policy in the script
    // header stays in sync with the predicate. If a code is removed here,
    // either the policy comment must be updated or the test must fail.
    expect(FATAL_CODES.has("ERR_MODULE_NOT_FOUND")).toBe(true);
    expect(FATAL_CODES.has("MODULE_NOT_FOUND")).toBe(true);
    expect(FATAL_CODES.has("EACCES")).toBe(true);
    expect(FATAL_CODES.has("EPERM")).toBe(true);
    expect(FATAL_CODES.has("EROFS")).toBe(true);
    expect(FATAL_CODES.has("ENOSPC")).toBe(true);
  });
});

describe("ensure-remotion-browser: describe()", () => {
  it("extracts code, name, message, and an Error cause", () => {
    const cause = Object.assign(new Error("network down"), { code: "ENOTFOUND" });
    const err = Object.assign(new Error("wrapper"), {
      code: "ETIMEDOUT",
      cause,
    });
    expect(describeError(err)).toEqual({
      code: "ETIMEDOUT",
      name: "Error",
      message: "wrapper",
      cause: { code: "ENOTFOUND", name: "Error", message: "network down" },
    });
  });

  it("preserves a plain-object cause (undici style)", () => {
    // Node's fetch/undici surfaces network failures with cause set to a plain
    // object carrying { code, errno, syscall }. Earlier versions of describe()
    // returned err.cause?.message and silently dropped the entire payload.
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED", errno: -61, syscall: "connect" },
    });
    const out = describeError(err);
    expect(out.cause).toContain("ECONNREFUSED");
    expect(out.cause).toContain("connect");
  });

  it("preserves a string cause", () => {
    const err = Object.assign(new Error("wrapped"), { cause: "raw reason" });
    expect(describeError(err).cause).toBe("raw reason");
  });

  it("recurses into AggregateError.errors when carried as cause", () => {
    // AggregateError carries inner failures in `.errors`, not `.message`.
    // Without recursion, the diagnostic value (which specific inner error
    // happened) is silently dropped from the log line.
    const inner1 = Object.assign(new Error("dns down"), { code: "ENOTFOUND" });
    const inner2 = Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" });
    const agg = new AggregateError([inner1, inner2], "all attempts failed");
    const err = Object.assign(new Error("wrapper"), { cause: agg });
    const out = describeError(err);
    expect(out.cause).toMatchObject({
      name: "AggregateError",
      message: "all attempts failed",
      errors: [
        { code: "ENOTFOUND", name: "Error", message: "dns down" },
        { code: "ECONNREFUSED", name: "Error", message: "conn refused" },
      ],
    });
  });

  it("preserves errors[] when the thrown error itself is an AggregateError", () => {
    // Promise.any and some mirror-retry harnesses throw AggregateError
    // directly with no wrapper, so describe() must surface `.errors` from the
    // top-level error too — not only from `.cause`.
    const inner1 = Object.assign(new Error("primary mirror down"), { code: "ETIMEDOUT" });
    const inner2 = Object.assign(new Error("fallback refused"), { code: "ECONNREFUSED" });
    const agg = new AggregateError([inner1, inner2], "All promises were rejected");
    const out = describeError(agg);
    expect(out).toMatchObject({
      name: "AggregateError",
      message: "All promises were rejected",
      errors: [
        { code: "ETIMEDOUT", name: "Error", message: "primary mirror down" },
        { code: "ECONNREFUSED", name: "Error", message: "fallback refused" },
      ],
    });
  });

  it("bounds the recursive walk on cyclic .errors without crashing", () => {
    // A retry harness that re-aggregates its own thrown error can produce a
    // cycle. Without the WeakSet seen-tracker, summarizeCause would recurse
    // until the call stack exhausts, turning the structured warn into a
    // RangeError that loses every operator-actionable signal.
    const a = new AggregateError([], "outer");
    const b = new AggregateError([], "inner");
    (a as unknown as { errors: unknown[] }).errors = [b];
    (b as unknown as { errors: unknown[] }).errors = [a];
    const err = Object.assign(new Error("wrapper"), { cause: a });
    expect(() => describeError(err)).not.toThrow();
    const out = describeError(err);
    // Outer cycle node was visited first; the back-edge from b to a must be
    // sentinelled, not recursed.
    const innerErrors = (out.cause as unknown as { errors: unknown[] }).errors;
    expect(innerErrors[0]).toMatchObject({ errors: ["[circular]"] });
  });

  it("accepts a Set as .errors (non-spec AggregateError-like aggregators)", () => {
    // Some retry libraries attach a Set instead of an Array. Accepting only
    // Array would silently drop these inner reasons; accepting any iterable
    // would sweep in strings/Buffers and produce nonsense. Array + Set is the
    // pragmatic middle.
    const inner = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
    const aggregator = Object.assign(new Error("custom agg"), {
      errors: new Set([inner]),
    });
    const out = describeError(aggregator) as { errors?: unknown[] };
    expect(out.errors).toEqual([
      { code: "ENOTFOUND", name: "Error", message: "dns" },
    ]);
  });

  it("caps recursion depth on deeply nested AggregateErrors", () => {
    // Builds a 20-deep chain of AggregateErrors. The default MAX_CAUSE_DEPTH
    // is 8, so the deeper levels must collapse to the truncation sentinel
    // rather than risking a stack-blow on adversarial input.
    let head = new AggregateError([], "leaf");
    for (let i = 0; i < 20; i++) {
      head = new AggregateError([head], `level-${i}`);
    }
    const err = Object.assign(new Error("wrapper"), { cause: head });
    const out = describeError(err);
    // Walk down the structure following `.errors[0]` and check we hit the
    // truncation sentinel before reaching the leaf.
    let node: unknown = out.cause;
    let saw = false;
    for (let i = 0; i < 30 && node && typeof node === "object"; i++) {
      if ((node as { errors?: unknown[] }).errors?.[0] === "[truncated: max depth]") {
        saw = true;
        break;
      }
      node = (node as { errors?: unknown[] }).errors?.[0];
    }
    expect(saw).toBe(true);
  });

  it("handles missing cause and non-Error inputs safely", () => {
    expect(describeError(new Error("bare"))).toEqual({
      code: undefined,
      name: "Error",
      message: "bare",
      cause: undefined,
    });
    expect(describeError(null)).toEqual({
      code: undefined,
      name: undefined,
      message: undefined,
      cause: undefined,
    });
  });
});
