import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@/lib/logger";
import { retryLlmCall } from "@/infrastructure/llm/retryLlmCall";
import type { IOversizedFileSummariser } from "@/interfaces/IOversizedFileSummariser";
import type { ILLMClient } from "@/interfaces/ILLMClient";
import type { FileChunk } from "@/domain/entities/FileChunk";
import type { RollingSummary } from "@/domain/entities/RollingSummary";

const logger = createLogger("oversizedFileSummariser");

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_SUMMARY_BYTES = 6_000;
const MAX_TOKENS = 1_024;

const SYSTEM_PROMPT = `You are a code reviewer summarising an oversized file diff chunk by chunk.
You receive the rolling summary of all prior chunks (if any) and a new chunk of the unified diff.

Rules:
- Output ONLY the updated rolling summary text. No preamble, no explanation.
- The summary must be ≤ 1500 tokens (~6000 UTF-8 bytes). Trim from the beginning if needed.
- When isFinal=true, produce the definitive summary of the entire file change.
- Preserve technical accuracy: function names, types, data structures, key invariants.
- Focus on WHAT changed and WHY it matters for code review.`;

function buildUserPrompt(
  priorSummary: RollingSummary | null,
  chunk: FileChunk,
  isFinal: boolean,
): string {
  const parts: string[] = [];

  parts.push(`File: ${chunk.filePath}`);
  parts.push(`Chunk: ${chunk.chunkIndex + 1} of ${chunk.totalChunks}${isFinal ? " (FINAL)" : ""}`);

  if (priorSummary) {
    parts.push(`\nPrior summary (${priorSummary.chunksConsumed} chunks consumed):\n${priorSummary.text}`);
  } else {
    parts.push("\nNo prior summary (first chunk).");
  }

  parts.push(`\nNew chunk patch:\n\`\`\`diff\n${chunk.patch}\n\`\`\``);

  if (isFinal) {
    parts.push("\nThis is the final chunk. Produce the definitive summary of the whole file change.");
  } else {
    parts.push("\nMore chunks follow. Update the rolling summary to include this chunk's changes.");
  }

  return parts.join("\n");
}

/**
 * Truncates a string to at most maxBytes UTF-8 bytes without splitting a multibyte
 * character. Walks back from maxBytes past any continuation bytes (0x80–0xBF) to
 * land on a valid character boundary.
 */
function utf8Truncate(str: string, maxBytes: number): string {
  const encoded = Buffer.from(str, "utf8");
  if (encoded.byteLength <= maxBytes) return str;
  let end = maxBytes;
  // Continuation bytes have pattern 10xxxxxx — walk back to a character start
  while (end > 0) {
    const byte = encoded[end];
    if (byte === undefined || (byte & 0xC0) !== 0x80) break;
    end--;
  }
  return encoded.subarray(0, end).toString("utf8");
}

/**
 * CLI-backed summariser — wraps any ILLMClient (claude-cli, gemini-cli, codex-cli).
 * Applies the same 6KB truncation and structured logging as AnthropicRollingSummariser.
 */
export class CliRollingSummariser implements IOversizedFileSummariser {
  private readonly logger = createLogger("oversizedFileSummariser.cli");

  constructor(private readonly llmClient: ILLMClient) {}

  async update(
    priorSummary: RollingSummary | null,
    chunk: FileChunk,
    isFinal: boolean,
    options: { signal: AbortSignal },
  ): Promise<RollingSummary> {
    options.signal.throwIfAborted();

    const startMs = Date.now();
    this.logger.debug("diff.oversized_file.chunk.summarise", {
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      isFinal,
      priorChunksConsumed: priorSummary?.chunksConsumed ?? 0,
    });

    const userPrompt = buildUserPrompt(priorSummary, chunk, isFinal);
    let summaryText: string;
    try {
      summaryText = await this.llmClient.complete(SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      this.logger.error("diff.oversized_file.chunk.summarise.failed", {
        filePath: chunk.filePath,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    summaryText = utf8Truncate(summaryText, MAX_SUMMARY_BYTES);

    this.logger.debug("diff.oversized_file.chunk.summarise.done", {
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      summaryBytes: Buffer.byteLength(summaryText, "utf8"),
      durationMs: Date.now() - startMs,
    });

    return {
      filePath: chunk.filePath,
      chunksConsumed: (priorSummary?.chunksConsumed ?? 0) + 1,
      text: summaryText,
    };
  }
}

/**
 * No-op summariser for mock/test environments — returns a fixed stub without any LLM call.
 */
export class MockRollingSummariser implements IOversizedFileSummariser {
  async update(
    priorSummary: RollingSummary | null,
    chunk: FileChunk,
    _isFinal: boolean,
    _options: { signal: AbortSignal },
  ): Promise<RollingSummary> {
    logger.warn("diff.oversized_file.mock_summariser.active", {
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      note: "SUMMARISER_PROVIDER=mock — summary is a stub, not real LLM output",
    });
    return {
      filePath: chunk.filePath,
      chunksConsumed: (priorSummary?.chunksConsumed ?? 0) + 1,
      text: `[mock] ${chunk.filePath} chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}`,
    };
  }
}

/**
 * LLM-backed implementation of IOversizedFileSummariser.
 * Uses the cheapest/fastest model (Haiku) since this is high-volume metadata work.
 */
export class AnthropicRollingSummariser implements IOversizedFileSummariser {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = process.env.CLAUDE_SUMMARISER_MODEL ?? DEFAULT_MODEL;
  }

  async update(
    priorSummary: RollingSummary | null,
    chunk: FileChunk,
    isFinal: boolean,
    options: { signal: AbortSignal },
  ): Promise<RollingSummary> {
    options.signal.throwIfAborted();
    const startMs = Date.now();
    logger.debug("diff.oversized_file.chunk.summarise", {
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      isFinal,
      priorChunksConsumed: priorSummary?.chunksConsumed ?? 0,
    });

    const userPrompt = buildUserPrompt(priorSummary, chunk, isFinal);

    let response;
    try {
      response = await retryLlmCall(
        () =>
          this.client.messages.create(
            {
              model: this.model,
              max_tokens: MAX_TOKENS,
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: userPrompt }],
            },
            { signal: options.signal },
          ),
        { label: "oversizedFileSummariser.update" },
      );
    } catch (err) {
      logger.error("diff.oversized_file.chunk.summarise.failed", {
        filePath: chunk.filePath,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        model: this.model,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        `oversizedFileSummariser: no text block for ${chunk.filePath} chunk ${chunk.chunkIndex}`,
      );
    }

    const summaryText = utf8Truncate(textBlock.text.trim(), MAX_SUMMARY_BYTES);

    logger.debug("diff.oversized_file.chunk.summarise.done", {
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      summaryBytes: Buffer.byteLength(summaryText, "utf8"),
      durationMs: Date.now() - startMs,
    });

    return {
      filePath: chunk.filePath,
      chunksConsumed: (priorSummary?.chunksConsumed ?? 0) + 1,
      text: summaryText,
    };
  }
}
