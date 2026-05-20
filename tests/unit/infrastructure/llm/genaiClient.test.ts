import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GoogleGenAI } from "@google/genai";
import {
  createGenAiLlmClient,
  extractGenAiResponseText,
  getGoogleGenAI,
  readGenAiUsage,
  _resetGoogleGenAIForTesting,
} from "@/infrastructure/llm/genaiClient";
import { isTransientLlmError } from "@/infrastructure/llm/retryLlmCall";

const ORIGINAL_ENV = { ...process.env };

describe("getGoogleGenAI", () => {
  beforeEach(() => {
    _resetGoogleGenAIForTesting();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetGoogleGenAIForTesting();
  });

  it("throws a clear error when neither GEMINI_API_KEY nor GOOGLE_API_KEY is set", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    expect(() => getGoogleGenAI()).toThrow(/GEMINI_API_KEY/);
  });

  it("constructs once and reuses the same instance across calls", () => {
    process.env.GEMINI_API_KEY = "test-key";
    const a = getGoogleGenAI();
    const b = getGoogleGenAI();
    expect(a).toBe(b);
  });

  it("accepts GOOGLE_API_KEY as a fallback", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "test-google";
    expect(() => getGoogleGenAI()).not.toThrow();
  });
});

describe("createGenAiLlmClient", () => {
  type FakeGenerateContent = (args: unknown) => Promise<{
    text?: string;
    candidates?: Array<{ finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  }>;
  function fakeClient(generateContent: FakeGenerateContent): GoogleGenAI {
    return { models: { generateContent } } as unknown as GoogleGenAI;
  }

  it("returns response.text from generateContent", async () => {
    const client = createGenAiLlmClient({
      label: "test.complete",
      client: fakeClient(async () => ({ text: "hello" })),
    });
    const out = await client.complete("system", "user");
    expect(out).toBe("hello");
  });

  it("forwards systemInstruction and userPrompt to generateContent", async () => {
    const seen: unknown[] = [];
    const client = createGenAiLlmClient({
      label: "test.complete",
      model: "gemini-test-model",
      maxTokens: 99,
      client: fakeClient(async (args) => {
        seen.push(args);
        return { text: "ok" };
      }),
    });
    await client.complete("SYS-PROMPT", "USER-PROMPT");
    expect(seen).toHaveLength(1);
    const arg = seen[0] as Record<string, unknown>;
    expect(arg.model).toBe("gemini-test-model");
    expect(arg.contents).toBe("USER-PROMPT");
    const config = arg.config as Record<string, unknown>;
    expect(config.systemInstruction).toBe("SYS-PROMPT");
    expect(config.maxOutputTokens).toBe(99);
  });

  it("throws a descriptive error when the response has no text (blocked or truncated)", async () => {
    const client = createGenAiLlmClient({
      label: "test.complete",
      client: fakeClient(async () => ({
        text: undefined,
        candidates: [{ finishReason: "MAX_TOKENS" }],
        promptFeedback: { blockReason: "SAFETY" },
      })),
    });
    await expect(client.complete("s", "u")).rejects.toThrow(/finishReason=MAX_TOKENS/);
  });

  it("forwards thinkingBudget through as config.thinkingConfig.thinkingBudget", async () => {
    const seen: unknown[] = [];
    const client = createGenAiLlmClient({
      label: "test.complete",
      thinkingBudget: 0,
      client: fakeClient(async (args) => {
        seen.push(args);
        return { text: "ok" };
      }),
    });
    await client.complete("s", "u");
    const config = (seen[0] as { config: Record<string, unknown> }).config;
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("omits thinkingConfig entirely when thinkingBudget is undefined (SDK default applies)", async () => {
    const seen: unknown[] = [];
    const client = createGenAiLlmClient({
      label: "test.complete",
      client: fakeClient(async (args) => {
        seen.push(args);
        return { text: "ok" };
      }),
    });
    await client.complete("s", "u");
    const config = (seen[0] as { config: Record<string, unknown> }).config;
    expect("thinkingConfig" in config).toBe(false);
  });

  it("forwards abortSignal through to generateContent config", async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    const client = createGenAiLlmClient({
      label: "test.complete",
      abortSignal: controller.signal,
      client: fakeClient(async (args) => {
        seen.push(args);
        return { text: "ok" };
      }),
    });
    await client.complete("s", "u");
    const arg = seen[0] as { config: { abortSignal?: AbortSignal } };
    expect(arg.config.abortSignal).toBe(controller.signal);
  });

  it("propagates ApiError-shaped errors so retryLlmCall can classify them as transient", () => {
    // Simulate the @google/genai ApiError shape (status: number on Error subclass).
    class FakeApiError extends Error {
      status = 429;
      constructor(msg: string) {
        super(msg);
        this.name = "ApiError";
      }
    }
    const err = new FakeApiError("Resource has been exhausted (e.g. check quota).");
    expect(isTransientLlmError(err)).toBe(true);

    const err5xx = new FakeApiError("Service unavailable");
    err5xx.status = 503;
    expect(isTransientLlmError(err5xx)).toBe(true);

    const errClient = new FakeApiError("API key not valid. Please pass a valid API key.");
    errClient.status = 400;
    expect(isTransientLlmError(errClient)).toBe(false);
  });
});

describe("extractGenAiResponseText", () => {
  it("returns the text on a normal response", () => {
    const out = extractGenAiResponseText(
      { text: "hello", candidates: [{ finishReason: "STOP" }] },
      { label: "test", budget: 512 },
    );
    expect(out).toBe("hello");
  });

  it("throws (not returns) when text is empty even if finishReason is STOP", () => {
    expect(() =>
      extractGenAiResponseText(
        { text: "", candidates: [{ finishReason: "STOP" }] },
        { label: "test", budget: 512 },
      ),
    ).toThrow(/returned no text/);
  });

  it("includes blockReason in the empty-text error so safety-filter blocks are diagnosable", () => {
    expect(() =>
      extractGenAiResponseText(
        {
          text: undefined,
          candidates: [{ finishReason: "SAFETY" }],
          promptFeedback: { blockReason: "HARM_CATEGORY_DANGEROUS_CONTENT" },
        },
        { label: "test" },
      ),
    ).toThrow(/blockReason=HARM_CATEGORY_DANGEROUS_CONTENT/);
  });

  it("throws on MAX_TOKENS truncation even when text is non-empty (fail-closed)", () => {
    // This is the silent-failure case: Gemini returns a partial JSON string
    // alongside finishReason=MAX_TOKENS. Without this guard, JSON.parse later
    // reports a confusing "Unexpected end of JSON input" far from the budget
    // root cause.
    expect(() =>
      extractGenAiResponseText(
        {
          text: '{"scenes":[{"sceneNumber":1,"narration":"truncated mid-string',
          candidates: [{ finishReason: "MAX_TOKENS" }],
        },
        { label: "completeJson", budget: 100 },
      ),
    ).toThrow(/truncated.*budget=100/);
  });
});

describe("readGenAiUsage", () => {
  it("reads promptTokenCount and candidatesTokenCount when both present", () => {
    const out = readGenAiUsage(
      { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 } },
      "test.label",
    );
    expect(out).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  it("falls back to 0/0 when usageMetadata is missing (warn logged separately)", () => {
    const out = readGenAiUsage({}, "test.label");
    expect(out).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("falls back to 0 for individual missing fields", () => {
    const out = readGenAiUsage(
      { usageMetadata: { promptTokenCount: 5 } },
      "test.label",
    );
    expect(out).toEqual({ inputTokens: 5, outputTokens: 0 });
  });
});
