import { describe, expect, it, vi } from "vitest";
import {
  parseBundleLogLine,
  createBrowserLogForwarder,
} from "@/infrastructure/video/remotionBrowserLogs";

/** JSON line shaped exactly like src/lib/logger.ts console output. */
function loggerLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-07-19T00:00:00.000Z",
    level: "warn",
    message: "Word-synced bindings: something noteworthy",
    requestId: "wordSyncedBindings",
    ...fields,
  });
}

// ── parseBundleLogLine ──────────────────────────────────────────────────

describe("parseBundleLogLine", () => {
  it("parses an errorTag-bearing structured line with level, message, sceneNumber, and context", () => {
    const parsed = parseBundleLogLine(
      loggerLine({
        errorTag: "WORD_TIMING_TOKEN_COUNT_MISMATCH",
        sceneNumber: 3,
        tokenCount: 12,
        wordTimingCount: 10,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.level).toBe("warn");
    expect(parsed?.message).toBe("Word-synced bindings: something noteworthy");
    expect(parsed?.errorTag).toBe("WORD_TIMING_TOKEN_COUNT_MISMATCH");
    expect(parsed?.sceneNumber).toBe(3);
    // Context keeps the structured payload (incl. errorTag/sceneNumber) but
    // drops timestamp/level/message, which the server logger re-adds.
    expect(parsed?.context).toMatchObject({
      errorTag: "WORD_TIMING_TOKEN_COUNT_MISMATCH",
      sceneNumber: 3,
      tokenCount: 12,
      wordTimingCount: 10,
      requestId: "wordSyncedBindings",
    });
    expect(parsed?.context).not.toHaveProperty("timestamp");
    expect(parsed?.context).not.toHaveProperty("level");
    expect(parsed?.context).not.toHaveProperty("message");
  });

  it("preserves the original severity for error-level entries", () => {
    const parsed = parseBundleLogLine(
      loggerLine({ level: "error", errorTag: "SOME_FATAL_TAG" }),
    );
    expect(parsed?.level).toBe("error");
  });

  it("defaults to warn when the level field is missing or unrecognized", () => {
    const noLevel = JSON.parse(loggerLine({ errorTag: "T" })) as Record<string, unknown>;
    delete noLevel.level;
    expect(parseBundleLogLine(JSON.stringify(noLevel))?.level).toBe("warn");
    expect(parseBundleLogLine(loggerLine({ level: "fatal", errorTag: "T" }))?.level).toBe("warn");
  });

  it("returns null for non-JSON browser noise", () => {
    expect(parseBundleLogLine("Warning: Each child in a list should have a unique key prop")).toBeNull();
    expect(parseBundleLogLine("")).toBeNull();
  });

  it("returns null for JSON without a non-empty string errorTag", () => {
    expect(parseBundleLogLine(loggerLine({}))).toBeNull();
    expect(parseBundleLogLine(loggerLine({ errorTag: "" }))).toBeNull();
    expect(parseBundleLogLine(loggerLine({ errorTag: 42 }))).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseBundleLogLine("42")).toBeNull();
    expect(parseBundleLogLine('"a string"')).toBeNull();
    expect(parseBundleLogLine('["array"]')).toBeNull();
    expect(parseBundleLogLine("null")).toBeNull();
  });

  it("normalizes a missing or non-numeric sceneNumber to null", () => {
    expect(parseBundleLogLine(loggerLine({ errorTag: "T" }))?.sceneNumber).toBeNull();
    expect(parseBundleLogLine(loggerLine({ errorTag: "T", sceneNumber: "7" }))?.sceneNumber).toBeNull();
  });
});

// ── createBrowserLogForwarder ───────────────────────────────────────────

describe("createBrowserLogForwarder", () => {
  it("forwards an errorTag-bearing warn exactly once per (errorTag, sceneNumber)", () => {
    const sink = vi.fn();
    const forward = createBrowserLogForwarder(sink);
    const line = loggerLine({ errorTag: "OVERLAPPING_CODE_BINDINGS_DROPPED", sceneNumber: 2 });

    // Concurrent chunked rendering remounts components per chunk — the same
    // once-per-scene warn arrives repeatedly and must be deduped.
    forward({ text: line });
    forward({ text: line });
    forward({ text: line });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      "warn",
      "Word-synced bindings: something noteworthy",
      expect.objectContaining({
        errorTag: "OVERLAPPING_CODE_BINDINGS_DROPPED",
        sceneNumber: 2,
        source: "remotion-bundle",
      }),
    );
  });

  it("does not dedupe across different scenes or different tags", () => {
    const sink = vi.fn();
    const forward = createBrowserLogForwarder(sink);

    forward({ text: loggerLine({ errorTag: "OOB_HIGHLIGHT_LINES_FILTERED", sceneNumber: 1 }) });
    forward({ text: loggerLine({ errorTag: "OOB_HIGHLIGHT_LINES_FILTERED", sceneNumber: 2 }) });
    forward({ text: loggerLine({ errorTag: "WORD_TIMING_TOKEN_COUNT_MISMATCH", sceneNumber: 1 }) });

    expect(sink).toHaveBeenCalledTimes(3);
  });

  it("ignores non-JSON lines and JSON without an errorTag", () => {
    const sink = vi.fn();
    const forward = createBrowserLogForwarder(sink);

    forward({ text: "Download the React DevTools for a better experience" });
    forward({ text: loggerLine({ sceneNumber: 1 }) }); // structured but no errorTag
    forward({ text: "{not json" });

    expect(sink).not.toHaveBeenCalled();
  });

  it("routes the original severity through the sink", () => {
    const sink = vi.fn();
    const forward = createBrowserLogForwarder(sink);
    forward({ text: loggerLine({ level: "error", errorTag: "RENDER_FATAL" }) });
    expect(sink).toHaveBeenCalledWith("error", expect.any(String), expect.any(Object));
  });
});
