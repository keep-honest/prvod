import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { MockRollingSummariser, CliRollingSummariser } from "@/infrastructure/llm/oversizedFileSummariser";
import { createGenAiLlmClient } from "@/infrastructure/llm/genaiClient";
import type { FileChunk } from "@/domain/entities/FileChunk";
import type { ILLMClient } from "@/interfaces/ILLMClient";
import type { GoogleGenAI } from "@google/genai";

const signal = new AbortController().signal;

function makeChunk(overrides?: Partial<FileChunk>): FileChunk {
  return {
    filePath: "src/big.ts",
    chunkIndex: 0,
    totalChunks: 2,
    isFinal: false,
    patch: "@@ -1,3 +1,4 @@\n context\n+added\n-removed",
    ...overrides,
  };
}

// --- MockRollingSummariser ---

describe("MockRollingSummariser", () => {
  const summariser = new MockRollingSummariser();

  it("returns a stub summary without an LLM call", async () => {
    const result = await summariser.update(null, makeChunk(), false, { signal });
    expect(result.filePath).toBe("src/big.ts");
    expect(result.chunksConsumed).toBe(1);
    expect(result.text).toContain("[mock]");
  });

  it("increments chunksConsumed on each call", async () => {
    const first = await summariser.update(null, makeChunk({ chunkIndex: 0 }), false, { signal });
    const second = await summariser.update(first, makeChunk({ chunkIndex: 1 }), true, { signal });
    expect(second.chunksConsumed).toBe(2);
  });
});

// --- CliRollingSummariser ---

describe("CliRollingSummariser", () => {
  it("calls llmClient.complete and returns the summary", async () => {
    const fakeClient: ILLMClient = {
      complete: async () => "summary of changes",
    };
    const summariser = new CliRollingSummariser(fakeClient);
    const result = await summariser.update(null, makeChunk(), false, { signal });
    expect(result.text).toBe("summary of changes");
    expect(result.filePath).toBe("src/big.ts");
    expect(result.chunksConsumed).toBe(1);
  });

  it("truncates summaries that exceed 6000 UTF-8 bytes at a character boundary", async () => {
    // Build a string that, when UTF-8 encoded, slightly exceeds 6000 bytes.
    // Use 3-byte euro signs (€ = E2 82 AC) to force multibyte boundary checks.
    const euro = "€"; // 3 bytes each
    // 2000 euros = 6000 bytes exactly — should NOT be truncated
    const exact6k = euro.repeat(2000);
    // 2001 euros = 6003 bytes — should be truncated, but cut must land on a boundary
    const over6k = euro.repeat(2001);

    let captured = "";
    const fakeClient: ILLMClient = {
      complete: async (_system, _user) => captured,
    };
    const summariser = new CliRollingSummariser(fakeClient);

    // Exactly 6k bytes — returned as-is
    captured = exact6k;
    const resultExact = await summariser.update(null, makeChunk(), false, { signal });
    expect(Buffer.byteLength(resultExact.text, "utf8")).toBeLessThanOrEqual(6000);
    // Verify it's still a valid string (no replacement characters)
    expect(resultExact.text).not.toContain("�");

    // Over 6k bytes — truncated to character boundary
    captured = over6k;
    const resultOver = await summariser.update(null, makeChunk(), false, { signal });
    expect(Buffer.byteLength(resultOver.text, "utf8")).toBeLessThanOrEqual(6000);
    // Result must be valid UTF-8 (no replacement chars from slicing mid-codepoint)
    expect(resultOver.text).not.toContain("�");
    // The truncated text should be a valid prefix of full euro signs (divisible by 3 bytes)
    expect(Buffer.byteLength(resultOver.text, "utf8") % 3).toBe(0);
  });

  it("truncates 4-byte emoji at a character boundary", async () => {
    // 🚀 = F0 9F 9A 80 (4 bytes each)
    const rocket = "🚀";
    // 1499 rockets = 5996 bytes, then 1 more byte to go over 6000
    const _almostFull = rocket.repeat(1499); // 5996 bytes
    // Add a 3-byte char to push it to 5999, then a rocket that starts at 5999 (would need 4 bytes)
    // Actually: 1500 rockets = 6000 bytes exactly — at boundary
    // 1501 rockets = 6004 bytes — over
    const over = rocket.repeat(1501);

    const fakeClient: ILLMClient = {
      complete: async () => over,
    };
    const summariser = new CliRollingSummariser(fakeClient);
    const result = await summariser.update(null, makeChunk(), false, { signal });
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(6000);
    expect(result.text).not.toContain("�");
  });

  it("propagates abort signal via throwIfAborted before the LLM call", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    const fakeClient: ILLMClient = {
      complete: async () => { throw new Error("should not be called"); },
    };
    const summariser = new CliRollingSummariser(fakeClient);
    await expect(
      summariser.update(null, makeChunk(), false, { signal: ctrl.signal }),
    ).rejects.toThrow("cancelled");
  });

  it("rethrows and logs errors from llmClient.complete", async () => {
    const fakeClient: ILLMClient = {
      complete: async () => { throw new Error("LLM call failed"); },
    };
    const summariser = new CliRollingSummariser(fakeClient);
    await expect(
      summariser.update(null, makeChunk(), false, { signal }),
    ).rejects.toThrow("LLM call failed");
  });
});

// --- GenAI-backed summariser (createGenAiLlmClient + CliRollingSummariser) ---
//
// The gemini-sdk provider plugs `createGenAiLlmClient(...)` into the
// `CliRollingSummariser`. Confirms the composition produces a summary, that
// MAX_TOKENS truncation surfaces (does not silently store partial output),
// and that empty-text safety blocks fail closed.

describe("CliRollingSummariser + createGenAiLlmClient (gemini-sdk path)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function fakeGenAi(text: string | undefined, finishReason = "STOP"): GoogleGenAI {
    return {
      models: {
        generateContent: async () => ({
          text,
          candidates: [{ finishReason }],
        }),
      },
    } as unknown as GoogleGenAI;
  }

  it("returns the GenAI completion as the rolling summary", async () => {
    const llmClient = createGenAiLlmClient({
      label: "gemini-sdk.summariser",
      client: fakeGenAi("rolling summary text"),
    });
    const summariser = new CliRollingSummariser(llmClient);
    const result = await summariser.update(null, makeChunk(), false, { signal });
    expect(result.text).toBe("rolling summary text");
    expect(result.filePath).toBe("src/big.ts");
  });

  it("fails closed when GenAI truncates the summary at MAX_TOKENS", async () => {
    const llmClient = createGenAiLlmClient({
      label: "gemini-sdk.summariser",
      client: fakeGenAi("partial summary cut off mid-", "MAX_TOKENS"),
    });
    const summariser = new CliRollingSummariser(llmClient);
    await expect(summariser.update(null, makeChunk(), false, { signal }))
      .rejects.toThrow(/truncated.*MAX_TOKENS/);
  });

  it("fails closed when GenAI safety filter blocks output", async () => {
    const llmClient = createGenAiLlmClient({
      label: "gemini-sdk.summariser",
      client: fakeGenAi(undefined, "SAFETY"),
    });
    const summariser = new CliRollingSummariser(llmClient);
    await expect(summariser.update(null, makeChunk(), false, { signal }))
      .rejects.toThrow(/returned no text/);
  });
});
