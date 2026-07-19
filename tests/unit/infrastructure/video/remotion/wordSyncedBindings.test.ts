import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildHeuristicBindings,
  resolveBindings,
  findActiveBinding,
} from "@/infrastructure/video/remotion/wordSyncedBindings";
import type { Scene, CodeBroll } from "@/domain/entities/VideoScript";
import type { WordTiming } from "@/interfaces/ITTSService";

/** Parse the JSON log emitted by `createLogger` from a console spy call. */
function parseLogCall(call: unknown[]): Record<string, unknown> | null {
  try {
    return JSON.parse(call[0] as string);
  } catch {
    return null;
  }
}

function makeWordTimings(words: string[]): WordTiming[] {
  return words.map((word, i) => ({
    word,
    startTimeMs: i * 500,
    endTimeMs: (i + 1) * 500,
  }));
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    sceneNumber: 1,
    sceneType: "code_walkthrough",
    durationSeconds: 10,
    narration: "",
    codeBroll: [],
    ...overrides,
  } as Scene;
}

const cb = (filePath: string, code: string, lineRange?: [number, number]): CodeBroll => ({
  filePath,
  code,
  language: "typescript",
  lineRange: lineRange ?? null,
  highlights: [],
});

// ── buildHeuristicBindings ──────────────────────────────────────────────

describe("buildHeuristicBindings", () => {
  it("returns empty for empty codeBroll", () => {
    const result = buildHeuristicBindings({
      narration: "the file validates input",
      wordTimings: makeWordTimings(["the", "file", "validates", "input"]),
      codeBroll: [],
    });
    expect(result).toEqual([]);
  });

  it("matches by file basename (with extension)", () => {
    const codeBroll = [cb("src/auth.ts", "function login() {}")];
    const result = buildHeuristicBindings({
      narration: "auth.ts holds the login function",
      wordTimings: makeWordTimings(["auth", "dot", "ts", "holds", "the", "login", "function"]),
      codeBroll,
    });
    // basename with extension matches first word; subsequent matches are
    // separate (collapse only when adjacent same-index).
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((b) => b.codeBrollIndex === 0)).toBe(true);
  });

  it("matches by file basename without extension", () => {
    const codeBroll = [cb("src/payments.ts", "x")];
    const result = buildHeuristicBindings({
      narration: "the payments module exports the handler",
      wordTimings: makeWordTimings(["the", "payments", "module", "exports", "the", "handler"]),
      codeBroll,
    });
    expect(result.length).toBe(1);
    expect(result[0].codeBrollIndex).toBe(0);
    expect(result[0].wordStartIndex).toBe(1);
    expect(result[0].wordEndIndex).toBe(1);
  });

  it("matches backtick-quoted identifiers when they appear in code", () => {
    const codeBroll = [cb("src/x.ts", "function validateJWT() { return true; }")];
    const result = buildHeuristicBindings({
      narration: "we call `validateJWT` before the route runs",
      wordTimings: makeWordTimings(["we", "call", "validateJWT", "before", "the", "route", "runs"]),
      codeBroll,
    });
    const validateBinding = result.find((b) => b.codeBrollIndex === 0);
    expect(validateBinding).toBeDefined();
    expect(validateBinding!.wordStartIndex).toBe(2);
  });

  it("tie-breaks toward lowest codeBrollIndex when multiple snippets contain the same identifier", () => {
    const codeBroll = [
      cb("src/a.ts", "function shared() {}"),
      cb("src/b.ts", "function shared() {}"),
    ];
    const result = buildHeuristicBindings({
      narration: "shared appears twice",
      wordTimings: makeWordTimings(["shared", "appears", "twice"]),
      codeBroll,
    });
    expect(result[0].codeBrollIndex).toBe(0);
  });

  it("collapses adjacent same-index hits into a single span", () => {
    const codeBroll = [cb("src/auth.ts", "function authMiddleware() { auth() }")];
    const result = buildHeuristicBindings({
      narration: "authMiddleware wraps auth",
      wordTimings: makeWordTimings(["authMiddleware", "wraps", "auth"]),
      codeBroll,
    });
    // Both words match codeBroll[0] (one as backtick-style identifier, one
    // as basename-no-ext "auth"). "wraps" doesn't match — span breaks.
    expect(result.length).toBeGreaterThanOrEqual(1);
    // First span should be just word 0 (authMiddleware) because "wraps" breaks.
    expect(result[0].wordStartIndex).toBe(0);
    expect(result[0].wordEndIndex).toBe(0);
  });

  it("emits no binding for words that don't match any snippet", () => {
    const codeBroll = [cb("src/x.ts", "function foo() {}")];
    const result = buildHeuristicBindings({
      narration: "completely unrelated narration text here",
      wordTimings: makeWordTimings(["completely", "unrelated", "narration", "text", "here"]),
      codeBroll,
    });
    expect(result).toEqual([]);
  });

  it("never synthesises relatesToCodeBrollIndices (arrows are LLM-only)", () => {
    const codeBroll = [
      cb("src/a.ts", "function alpha() {}"),
      cb("src/b.ts", "function beta() { alpha() }"),
    ];
    const result = buildHeuristicBindings({
      narration: "alpha is called by beta",
      wordTimings: makeWordTimings(["alpha", "is", "called", "by", "beta"]),
      codeBroll,
    });
    for (const b of result) {
      expect(b.relatesToCodeBrollIndices).toEqual([]);
    }
  });
});

// ── resolveBindings ─────────────────────────────────────────────────────

describe("resolveBindings", () => {
  // Shared console spies for every log-asserting block below. Created once at
  // collection time — a second vi.spyOn on the same method would shadow the
  // first spy and stop it from recording calls.
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

  afterEach(() => {
    consoleWarnSpy.mockClear();
    consoleDebugSpy.mockClear();
  });

  it("returns empty for no codeBroll", () => {
    const scene = makeScene({ narration: "anything", codeBroll: [] });
    expect(resolveBindings({ scene, wordTimings: makeWordTimings(["any"]) })).toEqual([]);
  });

  it("returns empty for empty narration", () => {
    const scene = makeScene({ narration: "", codeBroll: [cb("a.ts", "x")] });
    expect(resolveBindings({ scene, wordTimings: [] })).toEqual([]);
  });

  it("prefers LLM bindings over heuristic when codeBindings is non-empty", () => {
    const scene = makeScene({
      narration: "the auth module is loaded",
      codeBroll: [
        cb("src/auth.ts", "function validateJWT() {}"),
        cb("src/other.ts", "function foo() {}"),
      ],
      codeBindings: [
        { wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 1, highlightLines: [], relatesToCodeBrollIndices: [] },
      ],
    });
    const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["the", "auth", "module", "is", "loaded"]) });
    expect(resolved).toHaveLength(1);
    // LLM said index 1 even though heuristic would pick 0 (auth basename match).
    expect(resolved[0].codeBrollIndex).toBe(1);
  });

  it("strips bindings with out-of-range codeBrollIndex", () => {
    const scene = makeScene({
      narration: "x y z",
      codeBroll: [cb("a.ts", "x")],
      codeBindings: [
        { wordStartIndex: 0, wordEndIndex: 0, codeBrollIndex: 5, highlightLines: [], relatesToCodeBrollIndices: [] },
        { wordStartIndex: 1, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
      ],
    });
    const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["x", "y", "z"]) });
    // First binding's codeBrollIndex 5 is OOB → dropped. Second survives.
    expect(resolved).toHaveLength(1);
    expect(resolved[0].codeBrollIndex).toBe(0);
  });

  it("attaches start/end ms from wordTimings", () => {
    const scene = makeScene({
      narration: "alpha beta gamma",
      codeBroll: [cb("a.ts", "function alpha() {}")],
      codeBindings: [
        { wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
      ],
    });
    const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["alpha", "beta", "gamma"]) });
    expect(resolved[0].startMs).toBe(0);
    expect(resolved[0].endMs).toBe(1000); // word 1 endTime
  });

  it("falls back to heuristic when codeBindings is empty/absent", () => {
    const scene = makeScene({
      narration: "alpha runs first",
      codeBroll: [cb("src/alpha.ts", "function alpha() {}")],
      codeBindings: [],
    });
    const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["alpha", "runs", "first"]) });
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].codeBrollIndex).toBe(0);
  });

  it("falls back to heuristic when all LLM bindings get stripped by sanitization", () => {
    // Regression guard for codex review on PR #37: persisted scripts may
    // carry stale/OOB indices that sanitizeBindings strips entirely.
    // Returning [] in that case would leave the stage stuck on the default
    // snippet forever — contradicts the documented malformed-binding
    // fallback. Heuristic now fires when EITHER no LLM bindings were
    // emitted OR sanitization stripped them all.
    const scene = makeScene({
      narration: "alpha runs first",
      codeBroll: [cb("src/alpha.ts", "function alpha() {}")],
      codeBindings: [
        // All bindings have OOB codeBrollIndex → all stripped.
        { wordStartIndex: 0, wordEndIndex: 0, codeBrollIndex: 99, highlightLines: [], relatesToCodeBrollIndices: [] },
        { wordStartIndex: 1, wordEndIndex: 1, codeBrollIndex: 42, highlightLines: [], relatesToCodeBrollIndices: [] },
      ],
    });
    const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["alpha", "runs", "first"]) });
    // Heuristic recovers a binding on the basename match for "alpha".
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].codeBrollIndex).toBe(0);
  });

  it("sorts bindings by wordStartIndex for binary-search lookup", () => {
    const scene = makeScene({
      narration: "a b c d e",
      codeBroll: [cb("x.ts", "x"), cb("y.ts", "y")],
      codeBindings: [
        { wordStartIndex: 3, wordEndIndex: 4, codeBrollIndex: 1, highlightLines: [], relatesToCodeBrollIndices: [] },
        { wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
      ],
    });
    const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["a", "b", "c", "d", "e"]) });
    expect(resolved.map((b) => b.wordStartIndex)).toEqual([0, 3]);
  });

  // ── Observability for the silent-fallback path ─────────────────────
  // The heuristic-fallback path is the only signal operators have when
  // WORD_SYNCED_CODE is enabled but nothing is showing on-screen. The
  // structured `errorTag` strings and warn/debug routing are part of
  // the public observability contract — refactors that swap log levels
  // or drop the errorTag must break a test, not surface as a
  // production incident.

  describe("heuristic-fallback observability", () => {
    it("emits WORD_SYNCED_HEURISTIC_PRODUCED_NO_BINDINGS warn when heuristic returns zero", () => {
      // No backtick identifiers, no basename hits, no camel-cased symbol
      // overlaps → heuristic produces nothing.
      const scene = makeScene({
        sceneNumber: 7,
        narration: "and the of an then",
        codeBroll: [cb("src/unrelated.ts", "function zzz() {}")],
        codeBindings: [],
      });
      const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["and", "the", "of", "an", "then"]) });
      expect(resolved).toEqual([]);

      const warnEntry = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .find((e) => e && e.errorTag === "WORD_SYNCED_HEURISTIC_PRODUCED_NO_BINDINGS");
      expect(warnEntry).toBeDefined();
      expect(warnEntry?.sceneNumber).toBe(7);
      expect(warnEntry?.codeBrollCount).toBe(1);
      expect(warnEntry?.emittedBindingCount).toBe(0);
    });

    it("emits LLM_BINDINGS_FULLY_STRIPPED_HEURISTIC_FALLBACK warn when sanitization strips all LLM bindings", () => {
      const scene = makeScene({
        sceneNumber: 4,
        narration: "alpha runs first",
        codeBroll: [cb("src/alpha.ts", "function alpha() {}")],
        codeBindings: [
          { wordStartIndex: 0, wordEndIndex: 0, codeBrollIndex: 99, highlightLines: [], relatesToCodeBrollIndices: [] },
          { wordStartIndex: 1, wordEndIndex: 1, codeBrollIndex: 42, highlightLines: [], relatesToCodeBrollIndices: [] },
        ],
      });
      resolveBindings({ scene, wordTimings: makeWordTimings(["alpha", "runs", "first"]) });

      const warnEntry = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .find((e) => e && e.errorTag === "LLM_BINDINGS_FULLY_STRIPPED_HEURISTIC_FALLBACK");
      expect(warnEntry).toBeDefined();
      expect(warnEntry?.sceneNumber).toBe(4);
      expect(warnEntry?.emittedBindingCount).toBe(2);
    });

    it("emits debug breadcrumb (no warn) when heuristic produces a non-empty mapping", () => {
      const scene = makeScene({
        sceneNumber: 9,
        narration: "alpha runs first",
        codeBroll: [cb("src/alpha.ts", "function alpha() {}")],
        codeBindings: [],
      });
      const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["alpha", "runs", "first"]) });
      expect(resolved.length).toBeGreaterThan(0);

      // No "produced no bindings" warn fired — success path.
      const noBindingsWarn = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .find((e) => e && e.errorTag === "WORD_SYNCED_HEURISTIC_PRODUCED_NO_BINDINGS");
      expect(noBindingsWarn).toBeUndefined();

      // The success-path debug breadcrumb DID fire.
      const debugEntry = consoleDebugSpy.mock.calls
        .map(parseLogCall)
        .find((e) => e && e.message === "Word-synced bindings: heuristic produced bindings" && e.sceneNumber === 9);
      expect(debugEntry).toBeDefined();
    });
  });

  // ── Sanitization guards: overlaps, OOB highlightLines, timing mismatch ──
  // Non-runner paths (checkpoint resume of persisted scripts) reach the
  // resolver without going through validateCodeBindings, so sanitizeBindings
  // must be deterministic on its own and surface what it changed.

  describe("sanitization guards", () => {
    it("drops the later-starting overlapping (nested) binding deterministically and warns with OVERLAPPING_CODE_BINDINGS_DROPPED", () => {
      // Without the guard, findActiveBinding (rightmost startMs, sticky-forward)
      // would permanently shadow the outer binding once the nested one starts.
      const scene = makeScene({
        sceneNumber: 3,
        narration: "aa bb cc dd ee ff",
        codeBroll: [cb("x.ts", "x"), cb("y.ts", "y")],
        codeBindings: [
          { wordStartIndex: 0, wordEndIndex: 5, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
          { wordStartIndex: 2, wordEndIndex: 3, codeBrollIndex: 1, highlightLines: [], relatesToCodeBrollIndices: [] },
        ],
      });
      const resolved = resolveBindings({
        scene,
        wordTimings: makeWordTimings(["aa", "bb", "cc", "dd", "ee", "ff"]),
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].codeBrollIndex).toBe(0);
      expect(resolved[0].wordStartIndex).toBe(0);
      expect(resolved[0].wordEndIndex).toBe(5);

      const warnEntries = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .filter((e) => e && e.errorTag === "OVERLAPPING_CODE_BINDINGS_DROPPED");
      expect(warnEntries).toHaveLength(1);
      expect(warnEntries[0]?.sceneNumber).toBe(3);
      expect(warnEntries[0]?.droppedBindingCount).toBe(1);
      expect(warnEntries[0]?.keptBindingCount).toBe(1);
    });

    it("keeps disjoint bindings intact without an overlap warn", () => {
      const scene = makeScene({
        narration: "aa bb cc dd",
        codeBroll: [cb("x.ts", "x"), cb("y.ts", "y")],
        codeBindings: [
          { wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
          { wordStartIndex: 2, wordEndIndex: 3, codeBrollIndex: 1, highlightLines: [], relatesToCodeBrollIndices: [] },
        ],
      });
      const resolved = resolveBindings({
        scene,
        wordTimings: makeWordTimings(["aa", "bb", "cc", "dd"]),
      });
      expect(resolved).toHaveLength(2);
      const warnEntries = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .filter((e) => e && e.errorTag === "OVERLAPPING_CODE_BINDINGS_DROPPED");
      expect(warnEntries).toHaveLength(0);
    });

    it("filters out-of-range highlightLines while keeping the binding, warning with OOB_HIGHLIGHT_LINES_FILTERED", () => {
      const scene = makeScene({
        sceneNumber: 5,
        narration: "alpha beta gamma",
        codeBroll: [cb("a.ts", "line one\nline two", [10, 11])],
        codeBindings: [
          { wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [10, 99], relatesToCodeBrollIndices: [] },
        ],
      });
      const resolved = resolveBindings({
        scene,
        wordTimings: makeWordTimings(["alpha", "beta", "gamma"]),
      });
      // Binding survives — only the OOB line is filtered (mirrors the
      // runner validator's range logic without dropping the whole binding).
      expect(resolved).toHaveLength(1);
      expect(resolved[0].highlightLines).toEqual([10]);

      const warnEntries = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .filter((e) => e && e.errorTag === "OOB_HIGHLIGHT_LINES_FILTERED");
      expect(warnEntries).toHaveLength(1);
      expect(warnEntries[0]?.sceneNumber).toBe(5);
      expect(warnEntries[0]?.filteredLineCount).toBe(1);
    });

    it("emits WORD_TIMING_TOKEN_COUNT_MISMATCH once per scene with both counts", () => {
      const scene = makeScene({
        sceneNumber: 6,
        narration: "alpha beta gamma",
        codeBroll: [cb("a.ts", "function alpha() {}")],
        codeBindings: [],
      });
      // 3 narration tokens vs 2 wordTimings — schema declares 1:1 alignment.
      resolveBindings({ scene, wordTimings: makeWordTimings(["alpha", "beta"]) });

      const warnEntries = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .filter((e) => e && e.errorTag === "WORD_TIMING_TOKEN_COUNT_MISMATCH");
      expect(warnEntries).toHaveLength(1);
      expect(warnEntries[0]?.sceneNumber).toBe(6);
      expect(warnEntries[0]?.tokenCount).toBe(3);
      expect(warnEntries[0]?.wordTimingCount).toBe(2);
    });

    it("does not emit WORD_TIMING_TOKEN_COUNT_MISMATCH when counts align", () => {
      const scene = makeScene({
        narration: "alpha beta gamma",
        codeBroll: [cb("a.ts", "function alpha() {}")],
        codeBindings: [],
      });
      resolveBindings({ scene, wordTimings: makeWordTimings(["alpha", "beta", "gamma"]) });

      const warnEntries = consoleWarnSpy.mock.calls
        .map(parseLogCall)
        .filter((e) => e && e.errorTag === "WORD_TIMING_TOKEN_COUNT_MISMATCH");
      expect(warnEntries).toHaveLength(0);
    });
  });

  it("filters relatesToCodeBrollIndices to valid OTHER indices", () => {
    const scene = makeScene({
      narration: "a b",
      codeBroll: [cb("a.ts", "x"), cb("b.ts", "y")],
      codeBindings: [
        {
          wordStartIndex: 0,
          wordEndIndex: 0,
          codeBrollIndex: 0,
          highlightLines: [],
          relatesToCodeBrollIndices: [0, 1, 99], // self + valid + OOB
        },
      ],
    });
    const resolved = resolveBindings({ scene, wordTimings: makeWordTimings(["a", "b"]) });
    expect(resolved[0].relatesToCodeBrollIndices).toEqual([1]);
  });
});

// ── findActiveBinding ───────────────────────────────────────────────────

describe("findActiveBinding", () => {
  const resolved = [
    { wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [], startMs: 0, endMs: 1000 },
    { wordStartIndex: 3, wordEndIndex: 4, codeBrollIndex: 1, highlightLines: [], relatesToCodeBrollIndices: [], startMs: 1500, endMs: 2500 },
    { wordStartIndex: 6, wordEndIndex: 7, codeBrollIndex: 2, highlightLines: [], relatesToCodeBrollIndices: [], startMs: 3000, endMs: 4000 },
  ];

  it("returns null when bindings list is empty", () => {
    expect(findActiveBinding([], 1000)).toBeNull();
  });

  it("returns null when currentTimeMs is before the first binding", () => {
    expect(findActiveBinding(resolved, -100)).toBeNull();
  });

  it("returns the binding whose range contains currentTimeMs", () => {
    const active = findActiveBinding(resolved, 500);
    expect(active?.codeBrollIndex).toBe(0);
  });

  it("returns the rightmost past binding when currentTimeMs is between two bindings (sticky-forward)", () => {
    // Time 1200ms is between binding 0 (ends 1000) and binding 1 (starts 1500).
    const active = findActiveBinding(resolved, 1200);
    expect(active?.codeBrollIndex).toBe(0); // sticky: previous stays visible
  });

  it("returns the last binding when currentTimeMs is past the end", () => {
    const active = findActiveBinding(resolved, 10000);
    expect(active?.codeBrollIndex).toBe(2);
  });

  it("handles single-binding list correctly", () => {
    const single = [resolved[0]];
    expect(findActiveBinding(single, 500)?.codeBrollIndex).toBe(0);
    expect(findActiveBinding(single, -1)).toBeNull();
    expect(findActiveBinding(single, 10000)?.codeBrollIndex).toBe(0);
  });
});
