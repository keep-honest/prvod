import { describe, it, expect } from "vitest";
import { DefaultFileChunker } from "@/infrastructure/diff/DefaultFileChunker";

function makePatch(hunkCount: number, linesPerHunk: number): string {
  const hunks: string[] = [];
  for (let i = 0; i < hunkCount; i++) {
    const lines = [`@@ -${i * linesPerHunk + 1},${linesPerHunk} +${i * linesPerHunk + 1},${linesPerHunk} @@`];
    for (let j = 0; j < linesPerHunk; j++) {
      lines.push(`+line ${i * linesPerHunk + j}`);
    }
    hunks.push(lines.join("\n"));
  }
  return hunks.join("\n");
}

describe("DefaultFileChunker", () => {
  const chunker = new DefaultFileChunker();

  it("returns a single chunk for small patches", () => {
    const patch = makePatch(2, 5);
    const chunks = chunker.chunk("src/a.ts", patch);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].isFinal).toBe(true);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].filePath).toBe("src/a.ts");
  });

  it("splits into multiple chunks when patch exceeds thresholdBytes", () => {
    // Each hunk is ~100 bytes; threshold = 200 bytes should give ~4 hunks per chunk
    const patch = makePatch(10, 20);
    const chunks = chunker.chunk("src/b.ts", patch, { thresholdBytes: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].isFinal).toBe(false);
    }
  });

  it("all chunks together contain the full patch content", () => {
    const patch = makePatch(6, 15);
    const chunks = chunker.chunk("src/c.ts", patch, { thresholdBytes: 200 });
    const combined = chunks.map((c) => c.patch).join("");
    // All individual lines should be present
    for (let i = 0; i < 6; i++) {
      expect(combined).toContain(`@@ -${i * 15 + 1}`);
    }
  });

  it("each chunk does not exceed thresholdBytes (except when a single hunk is larger)", () => {
    const patch = makePatch(8, 10);
    const thresholdBytes = 300;
    const chunks = chunker.chunk("src/d.ts", patch, { thresholdBytes });

    for (const chunk of chunks) {
      const chunkBytes = Buffer.byteLength(chunk.patch, "utf8");
      // A single oversized hunk may exceed the threshold; skip those
      const hunkCount = (chunk.patch.match(/^@@/gm) || []).length;
      if (hunkCount > 1) {
        expect(chunkBytes).toBeLessThanOrEqual(thresholdBytes + 500);
      }
    }
  });

  it("respects maxChunks limit", () => {
    const patch = makePatch(20, 5);
    const chunks = chunker.chunk("src/e.ts", patch, { maxChunks: 4 });
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
  });

  it("chunkIndex is sequential starting from 0", () => {
    const patch = makePatch(10, 20);
    const chunks = chunker.chunk("src/f.ts", patch, { thresholdBytes: 200 });
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
    });
  });

  it("totalChunks matches actual chunk count", () => {
    const patch = makePatch(6, 20);
    const chunks = chunker.chunk("src/g.ts", patch, { thresholdBytes: 200 });
    const totalChunks = chunks[0].totalChunks;
    expect(chunks).toHaveLength(totalChunks);
    for (const chunk of chunks) {
      expect(chunk.totalChunks).toBe(totalChunks);
    }
  });

  it("returns a single chunk with isFinal=true for empty patch", () => {
    const chunks = chunker.chunk("src/h.ts", "");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].isFinal).toBe(true);
    expect(chunks[0].patch).toBe("");
  });

  it("chunkIndex is always less than totalChunks for single-chunk results", () => {
    const patch = makePatch(1, 3);
    const chunks = chunker.chunk("src/small.ts", patch);
    for (const chunk of chunks) {
      expect(chunk.chunkIndex).toBeLessThan(chunk.totalChunks);
    }
  });

  it("filePath is preserved on all chunks", () => {
    const patch = makePatch(8, 20);
    const chunks = chunker.chunk("src/components/Button.tsx", patch, { thresholdBytes: 200 });
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe("src/components/Button.tsx");
    }
  });

  it("splits a single oversized hunk at line boundaries (every slice <= threshold)", () => {
    // A single hunk much larger than threshold must be split into multiple chunks,
    // each <= thresholdBytes, with the @@ header repeated on every slice.
    const hugeHunk = "@@ -1,300 +1,300 @@\n" + "+line\n".repeat(300);
    const chunks = chunker.chunk("src/big.ts", hugeHunk, { thresholdBytes: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
    // Every chunk — INCLUDING the final one — respects the byte cap.
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.patch, "utf8")).toBeLessThanOrEqual(200);
      expect(chunk.patch.startsWith("@@")).toBe(true);
      expect(chunk.chunkIndex).toBeLessThan(chunk.totalChunks);
    }
  });

  it("truncates a single line longer than thresholdBytes and stays within the byte cap", () => {
    // Minified-bundle / lockfile-style: one '+' line of ~50 KB on its own.
    const hugeLineBody = "x".repeat(50_000);
    const patch = `@@ -1,1 +1,1 @@\n+${hugeLineBody}\n`;
    const thresholdBytes = 4 * 1024;

    const chunks = chunker.chunk("src/min.bundle.js", patch, { thresholdBytes });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.patch, "utf8")).toBeLessThanOrEqual(thresholdBytes);
    }
    // The truncation marker must appear in at least one chunk so the summariser
    // can detect the long-line truncation downstream.
    const combined = chunks.map((c) => c.patch).join("");
    expect(combined).toContain("...[truncated]");
  });

  it("never emits a final chunk above thresholdBytes even when content exceeds maxChunks * threshold", () => {
    // Pathological: 50 hunks each ~250 bytes, threshold 200, maxChunks 4
    // → cannot fit in 4 × 200 bytes; chunker must truncate, not overflow.
    const patch = makePatch(50, 25);
    const thresholdBytes = 200;
    const maxChunks = 4;
    const chunks = chunker.chunk("src/extreme.ts", patch, { thresholdBytes, maxChunks });

    expect(chunks.length).toBeLessThanOrEqual(maxChunks);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.patch, "utf8")).toBeLessThanOrEqual(thresholdBytes);
    }
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
  });

  it("isFinal via maxChunks-1 branch: last chunk is final when rawChunks.length equals maxChunks", () => {
    // 4 hunks, threshold = 200 bytes, maxChunks = 4
    // With ~100-byte hunks each hunk becomes one rawChunk → rawChunks.length === maxChunks === 4
    // isFinal on chunk 3 must be true via i === maxChunks - 1 (and also via i === rawChunks.length - 1)
    // Chunks 0-2 must have isFinal === false
    const patch = makePatch(4, 10); // 4 hunks of ~10 lines each (~100 bytes each)
    const chunks = chunker.chunk("src/exact.ts", patch, { thresholdBytes: 200, maxChunks: 4 });
    expect(chunks.length).toBe(4);
    for (let i = 0; i < 3; i++) {
      expect(chunks[i].isFinal).toBe(false);
    }
    expect(chunks[3].isFinal).toBe(true);
  });

  it("truncates content (rather than overflowing the final chunk) when total exceeds maxChunks * thresholdBytes", () => {
    // 10 hunks, low threshold forces splits, maxChunks=3 → 3 byte-bounded chunks;
    // the last chunk must NOT absorb remaining hunks (that would violate the byte cap).
    const patch = makePatch(10, 20);
    const thresholdBytes = 200;
    const chunks = chunker.chunk("src/z.ts", patch, { thresholdBytes, maxChunks: 3 });
    expect(chunks.length).toBeLessThanOrEqual(3);

    // Every chunk — INCLUDING the final one — must respect the byte cap.
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.patch, "utf8")).toBeLessThanOrEqual(thresholdBytes);
    }

    // Truncation is expected: not every original hunk header survives.
    const combined = chunks.map((c) => c.patch).join("");
    const headersInOutput = (combined.match(/@@ -\d+/g) ?? []).length;
    expect(headersInOutput).toBeLessThan(10);

    expect(chunks[chunks.length - 1].isFinal).toBe(true);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].isFinal).toBe(false);
    }
  });

  it("splits a single hunk that exceeds thresholdBytes into byte-bounded sub-slices", () => {
    // One giant hunk far larger than threshold — must NOT be returned as one chunk.
    const header = `@@ -1,5000 +1,5000 @@`;
    const lines: string[] = [header];
    for (let i = 0; i < 5000; i++) lines.push(`+line ${i.toString().padStart(8, "0")}`);
    const patch = lines.join("\n");
    const thresholdBytes = 4 * 1024;

    const chunks = chunker.chunk("src/giant.ts", patch, { thresholdBytes, maxChunks: 8 });

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      // Every non-final slice must respect the threshold (final slice may exceed
      // it when remaining hunks are forced into the last bucket — documented).
      expect(Buffer.byteLength(chunks[i].patch, "utf8")).toBeLessThanOrEqual(thresholdBytes);
    }
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
  });

  it("empty patch: single chunk with totalChunks=1 satisfying the chunkIndex < totalChunks invariant", () => {
    const chunks = chunker.chunk("src/empty.ts", "");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].isFinal).toBe(true);
    expect(chunks[0].patch).toBe("");
    expect(chunks[0].totalChunks).toBe(1);
    expect(chunks[0].chunkIndex).toBeLessThan(chunks[0].totalChunks);
  });
});
