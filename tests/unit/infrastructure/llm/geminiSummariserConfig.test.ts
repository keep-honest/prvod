import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS,
  resolveGeminiSummariserMaxTokens,
} from "@/infrastructure/llm/geminiSummariserConfig";

describe("resolveGeminiSummariserMaxTokens", () => {
  it("uses the default when the env var is missing", () => {
    expect(resolveGeminiSummariserMaxTokens(undefined)).toBe(
      DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS,
    );
  });

  it("uses the default when the env var is the empty string", () => {
    expect(resolveGeminiSummariserMaxTokens("")).toBe(
      DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS,
    );
  });

  it("uses a valid positive-integer override", () => {
    expect(resolveGeminiSummariserMaxTokens("8192")).toBe(8192);
  });

  it.each(["abc", "1.5", "0", "-1", "Infinity"])(
    "falls back for invalid value %s and warns",
    (rawValue) => {
      const warn = vi.fn();
      expect(resolveGeminiSummariserMaxTokens(rawValue, { warn })).toBe(
        DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS,
      );
      expect(warn).toHaveBeenCalledWith(
        "Invalid GEMINI_SUMMARISER_MAX_TOKENS; using default",
        expect.objectContaining({ value: rawValue }),
      );
    },
  );
});
