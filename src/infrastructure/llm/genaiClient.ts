import { GoogleGenAI } from "@google/genai";
import type { ILLMClient } from "@/interfaces/ILLMClient";
import { retryLlmCall } from "@/infrastructure/llm/retryLlmCall";
import { createLogger } from "@/lib/logger";

const logger = createLogger("genaiClient");

const DEFAULT_GENAI_MODEL = "gemini-2.5-pro";
const DEFAULT_GENAI_MAX_TOKENS = 1024;

/**
 * Minimal shape of a `@google/genai` response for the fields we read.
 * Defining locally keeps callers decoupled from the SDK's deep type tree
 * and lets test fakes return literal objects without casting.
 */
export interface GenAiResponseLike {
  text?: string;
  candidates?: Array<{ finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Extracts the response text from a `generateContent` response, throwing a
 * fail-closed error when the model returned nothing usable. Two distinct
 * failure modes are detected:
 *
 * 1. **Empty / missing text**: safety filter blocked the prompt outright,
 *    or the call errored after the SDK had already resolved.
 * 2. **Truncation** (`finishReason === "MAX_TOKENS"` with non-empty text):
 *    Gemini returned a partial string. JSON-mode callers would see a
 *    cryptic `JSON.parse` error far from the root cause; legacy script
 *    generation would silently ship a script missing trailing scenes.
 *
 * Mirrors the `stop_reason === "max_tokens"` guard ClaudeScriptWriter
 * applies on every Anthropic SDK call.
 */
export function extractGenAiResponseText(
  response: GenAiResponseLike,
  context: { label: string; budget?: number },
): string {
  const text = response.text;
  const finishReason = response.candidates?.[0]?.finishReason ?? "unknown";
  const blockReason = response.promptFeedback?.blockReason ?? null;

  if (typeof text !== "string" || text.length === 0) {
    logger.error("GenAI returned empty text", {
      label: context.label,
      finishReason,
      blockReason,
      budget: context.budget,
    });
    throw new Error(
      `GenAI ${context.label} returned no text (finishReason=${finishReason}` +
      `${blockReason ? `, blockReason=${blockReason}` : ""}` +
      `${context.budget !== undefined ? `, budget=${context.budget}` : ""}). ` +
      `This usually means the response was blocked by safety filters or hit maxOutputTokens.`,
    );
  }

  if (finishReason === "MAX_TOKENS") {
    logger.error("GenAI response truncated at max output tokens", {
      label: context.label,
      finishReason,
      budget: context.budget,
      textLength: text.length,
    });
    throw new Error(
      `GenAI ${context.label} was truncated (finishReason=MAX_TOKENS` +
      `${context.budget !== undefined ? `, budget=${context.budget}` : ""}). ` +
      `Increase the token budget — partial output cannot be parsed safely. ` +
      `Note: Gemini 2.5 models' mandatory thinking budget is counted against ` +
      `maxOutputTokens; raise GEMINI_SCRIPT_MAX_TOKENS / GEMINI_RETIME_MAX_TOKENS ` +
      `(script writer) or GEMINI_SUMMARISER_MAX_TOKENS (oversized-file summariser), ` +
      `set thinkingBudget=0 for non-reasoning workloads, or switch to a non-thinking model.`,
    );
  }

  return text;
}

/**
 * Pulls token counts from `usageMetadata`, warning (not throwing) when the
 * field is absent. The SDK occasionally omits it on degraded responses;
 * silently reporting 0 tokens would mask real spend in observability.
 */
export function readGenAiUsage(
  response: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } },
  label: string,
): { inputTokens: number; outputTokens: number } {
  const usage = response.usageMetadata;
  if (!usage) {
    logger.warn("GenAI response omitted usageMetadata — token counts will be reported as 0", { label });
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

let cachedClient: GoogleGenAI | null = null;

function readGenAiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? undefined;
}

/**
 * Lazy singleton accessor for the @google/genai client.
 *
 * The SDK auto-reads `GEMINI_API_KEY` or `GOOGLE_API_KEY` when given an empty
 * options object. We surface a clear error here so missing credentials fail
 * at startup rather than mid-pipeline with an opaque "API key not valid"
 * message from the upstream service.
 */
export function getGoogleGenAI(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const apiKey = readGenAiApiKey();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY (or GOOGLE_API_KEY) is required to use the @google/genai SDK. " +
      "Set one of these env vars before enabling SCRIPT_WRITER=gemini-sdk or SUMMARISER_PROVIDER=gemini-sdk.",
    );
  }
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

/** Test-only reset hook — clears the singleton between tests. */
export function _resetGoogleGenAIForTesting(): void {
  cachedClient = null;
}

export interface GenAiLlmClientOptions {
  /** Override the model (default: GEMINI_MODEL or gemini-2.5-pro). */
  model?: string;
  /** Override max output tokens (default 1024). */
  maxTokens?: number;
  /** Label for retry/observability. Defaults to "genai.complete". */
  label?: string;
  /** Optional client override — primarily for tests. */
  client?: GoogleGenAI;
  /** Optional cancellation signal, forwarded to the SDK's `config.abortSignal`. */
  abortSignal?: AbortSignal;
  /**
   * Override Gemini 2.5's mandatory thinking budget. Set to `0` for mechanical
   * tasks (e.g. rolling summarisation) where reasoning provides no upside and
   * the thinking allocation would otherwise eat the entire `maxOutputTokens`
   * budget — producing a MAX_TOKENS truncation with no usable text. When
   * omitted, the SDK's default thinking budget is used.
   */
  thinkingBudget?: number;
}

/**
 * ILLMClient backed by `@google/genai`'s `models.generateContent`.
 *
 * Used by:
 * - The visual prompt judge (single-turn JSON evaluation; we let the prompt
 *   define structure rather than coupling this client to a specific schema).
 * - `CliRollingSummariser` for oversized-file summarisation.
 *
 * Calls are wrapped in `retryLlmCall`, which classifies `ApiError.status`
 * (429 / 5xx) as transient and applies exponential backoff with jitter.
 * Empty / truncated responses fail closed via `extractGenAiResponseText`.
 */
export function createGenAiLlmClient(options: GenAiLlmClientOptions = {}): ILLMClient {
  const label = options.label ?? "genai.complete";
  const maxOutputTokens = options.maxTokens ?? DEFAULT_GENAI_MAX_TOKENS;
  const thinkingBudget = options.thinkingBudget;
  const resolveModel = () => options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GENAI_MODEL;

  return {
    complete: async (system: string, userPrompt: string): Promise<string> => {
      const ai = options.client ?? getGoogleGenAI();
      const model = resolveModel();

      const response = await retryLlmCall(
        () => ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: system,
            maxOutputTokens,
            abortSignal: options.abortSignal,
            ...(thinkingBudget !== undefined
              ? { thinkingConfig: { thinkingBudget } }
              : {}),
          },
        }),
        { label },
      );

      return extractGenAiResponseText(response, { label, budget: maxOutputTokens });
    },
  };
}
