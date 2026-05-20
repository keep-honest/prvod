import { describe, expect, it } from "vitest";
import { __testing, mapJobErrorToUserMessage } from "@/lib/jobErrorMessages";

describe("mapJobErrorToUserMessage", () => {
  it("returns null for non-terminal statuses", () => {
    expect(mapJobErrorToUserMessage("queued", null)).toBeNull();
    expect(mapJobErrorToUserMessage("processing", null)).toBeNull();
    expect(mapJobErrorToUserMessage("completed", null)).toBeNull();
  });

  it("returns the cancelled message for cancelled jobs regardless of errorCode", () => {
    expect(mapJobErrorToUserMessage("cancelled", null)).toBe(__testing.CANCELLED_MESSAGE);
    expect(mapJobErrorToUserMessage("cancelled", "LLM_RATE_LIMITED_EXHAUSTED")).toBe(
      __testing.CANCELLED_MESSAGE,
    );
  });

  it("translates known error codes to user-facing messages", () => {
    for (const [code, expected] of Object.entries(__testing.ERROR_CODE_MESSAGES)) {
      expect(mapJobErrorToUserMessage("failed", code)).toBe(expected);
    }
  });

  it("falls back to the default failure message for unknown or null error codes", () => {
    expect(mapJobErrorToUserMessage("failed", null)).toBe(__testing.DEFAULT_FAILURE_MESSAGE);
    expect(mapJobErrorToUserMessage("failed", undefined)).toBe(__testing.DEFAULT_FAILURE_MESSAGE);
    expect(mapJobErrorToUserMessage("failed", "SOMETHING_UNRECOGNISED")).toBe(
      __testing.DEFAULT_FAILURE_MESSAGE,
    );
  });

  it("never returns raw server text — only the curated message set", () => {
    const allowedMessages = new Set<string>([
      __testing.CANCELLED_MESSAGE,
      __testing.DEFAULT_FAILURE_MESSAGE,
      ...Object.values(__testing.ERROR_CODE_MESSAGES),
    ]);
    const samples = [
      mapJobErrorToUserMessage("failed", "DIFF_TOO_LARGE"),
      mapJobErrorToUserMessage("failed", "anything-else"),
      mapJobErrorToUserMessage("cancelled", null),
    ];
    for (const message of samples) {
      expect(allowedMessages.has(message ?? "")).toBe(true);
    }
  });
});
