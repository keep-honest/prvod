import type { FileChunk } from "@/domain/entities/FileChunk";
import type { RollingSummary } from "@/domain/entities/RollingSummary";

/**
 * Updates a RollingSummary with the content of one FileChunk via a single LLM call.
 * Layer 1 port — oversizedFileSummariser in Layer 3 implements this.
 */
export interface IOversizedFileSummariser {
  update(
    priorSummary: RollingSummary | null,
    chunk: FileChunk,
    isFinal: boolean,
    options: { signal: AbortSignal },
  ): Promise<RollingSummary>;
}
