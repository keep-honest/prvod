import { createLogger } from "@/lib/logger";

const logger = createLogger("geminiSummariserConfig");

/**
 * Default max output tokens for the `gemini-sdk` oversized-file summariser.
 *
 * The shared `createGenAiLlmClient` default is 1024, which is fine for non-
 * thinking models but is consumed almost entirely by Gemini 2.5's mandatory
 * thinking budget — leaving so few tokens for actual output that every
 * rolling-summary chunk truncates at MAX_TOKENS. Bumping the summariser
 * default to 4096 (combined with `thinkingBudget: 0`) gives the summary
 * a generous margin without spending headroom on reasoning we don't need.
 */
export const DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS = 4096;

interface WarnLogger {
  warn: (message: string, extra?: Record<string, unknown>) => void;
}

export function resolveGeminiSummariserMaxTokens(
  rawValue = process.env.GEMINI_SUMMARISER_MAX_TOKENS,
  warnLogger: WarnLogger = logger,
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warnLogger.warn("Invalid GEMINI_SUMMARISER_MAX_TOKENS; using default", {
      value: rawValue,
      defaultTokens: DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS,
    });
    return DEFAULT_GEMINI_SUMMARISER_MAX_TOKENS;
  }
  return parsed;
}
