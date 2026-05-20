import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CodeBroll } from "@/domain/entities/VideoScript";

// ── Mock sharp ───────────────────────────────────────────────────────
// sharp is used as: sharp(buffer).png().toBuffer()
const mockToBuffer = vi.hoisted(() => vi.fn());
const mockPng = vi.hoisted(() => vi.fn());
const mockSharp = vi.hoisted(() => vi.fn());

vi.mock("sharp", () => ({
  default: mockSharp,
}));

// ── Mock shiki ───────────────────────────────────────────────────────
const mockCodeToTokens = vi.hoisted(() => vi.fn());

vi.mock("shiki", () => ({
  codeToTokens: mockCodeToTokens,
}));

import { generateCodeOverlayPng } from "@/infrastructure/video/ffmpeg/code-overlay";

// ── Helpers ──────────────────────────────────────────────────────────

const FAKE_PNG = Buffer.from("fake-png-data");

function setupSharpMock() {
  mockToBuffer.mockResolvedValue(FAKE_PNG);
  mockPng.mockReturnValue({ toBuffer: mockToBuffer });
  mockSharp.mockReturnValue({ png: mockPng });
}

function setupShikiMock(lines: string[] = ["const x = 1;"]) {
  mockCodeToTokens.mockResolvedValue({
    tokens: lines.map((line) => [{ content: line, color: "#ffffff" }]),
  });
}

function makeCodeBroll(overrides: Partial<CodeBroll> = {}): CodeBroll {
  return {
    filePath: "src/index.ts",
    code: "const x = 1;",
    language: "typescript",
    lineRange: [1, 1],
    highlights: [],
    ...overrides,
  };
}

function expectCapturedSvg(buffer: Buffer | undefined): string {
  expect(buffer).toBeDefined();
  if (!buffer) {
    throw new Error("Expected sharp to receive an SVG buffer");
  }
  return buffer.toString("utf8");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("generateCodeOverlayPng", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSharpMock();
    setupShikiMock();
  });

  it("returns a PNG buffer for valid code input", async () => {
    const result = await generateCodeOverlayPng(makeCodeBroll());
    expect(result).toBe(FAKE_PNG);
    expect(mockSharp).toHaveBeenCalledOnce();
    expect(mockPng).toHaveBeenCalledOnce();
    expect(mockToBuffer).toHaveBeenCalledOnce();
  });

  it("calls codeToTokens with the provided language", async () => {
    await generateCodeOverlayPng(makeCodeBroll({ language: "typescript" }));
    // First call is the highlighter warmup; subsequent calls use the real language
    const calls = mockCodeToTokens.mock.calls;
    const realCall = calls.find((c) => c[1]?.lang === "typescript");
    expect(realCall).toBeDefined();
  });

  it("handles empty code by returning a buffer without calling codeToTokens for content", async () => {
    const result = await generateCodeOverlayPng(makeCodeBroll({ code: "   " }));
    // Empty code skips the tokenization path and goes straight to generateEmptyOverlay
    expect(result).toBe(FAKE_PNG);
    expect(mockSharp).toHaveBeenCalled();
    // codeToTokens may be called for the warmup no-op, but never for the real content
    const contentCalls = mockCodeToTokens.mock.calls.filter(
      (c) => c[0] !== "" && c[1]?.lang !== "text",
    );
    expect(contentCalls).toHaveLength(0);
  });

  it("falls back to plain text when codeToTokens throws for the given language", async () => {
    // The module-level highlighterPromise singleton may already be resolved from prior tests,
    // so we set up the next two calls: the real language attempt (throws) and the text fallback.
    mockCodeToTokens
      .mockRejectedValueOnce(new Error("Unknown language: brainf"))  // real language fails
      .mockResolvedValueOnce({ tokens: [[{ content: "code", color: "#fff" }]] });  // plain text fallback

    const result = await generateCodeOverlayPng(
      makeCodeBroll({ language: "brainf", code: "+-><" }),
    );

    expect(result).toBe(FAKE_PNG);
    // Verify the fallback call used lang: "text" with the actual code (not the warmup empty string)
    const fallbackCall = mockCodeToTokens.mock.calls.find(
      (c) => c[1]?.lang === "text" && c[0] === "+-><",
    );
    expect(fallbackCall).toBeDefined();
  });

  it("includes filePath and language in the SVG passed to sharp", async () => {
    let capturedSvgBuffer: Buffer | undefined;
    mockSharp.mockImplementation((buf: Buffer) => {
      capturedSvgBuffer = buf;
      return { png: mockPng };
    });

    await generateCodeOverlayPng(
      makeCodeBroll({ filePath: "lib/utils.ts", language: "typescript" }),
    );

    const svgString = expectCapturedSvg(capturedSvgBuffer);
    expect(svgString).toContain("lib/utils.ts");
    expect(svgString).toContain("typescript");
  });

  it("applies highlights to the correct lines", async () => {
    let capturedSvgBuffer: Buffer | undefined;
    mockSharp.mockImplementation((buf: Buffer) => {
      capturedSvgBuffer = buf;
      return { png: mockPng };
    });

    // Two-line code with line 2 highlighted
    const code = "const a = 1;\nconst b = 2;";
    setupShikiMock(["const a = 1;", "const b = 2;"]);
    await generateCodeOverlayPng(
      makeCodeBroll({ code, lineRange: [1, 2], highlights: [2] }),
    );

    const svg = expectCapturedSvg(capturedSvgBuffer);
    // Highlighted lines get a blue border rect (#388bfd)
    expect(svg).toContain("#388bfd");
  });

  it("renders removed diff lines with red review styling instead of blue", async () => {
    let capturedSvgBuffer: Buffer | undefined;
    mockSharp.mockImplementation((buf: Buffer) => {
      capturedSvgBuffer = buf;
      return { png: mockPng };
    });

    const code = " const a = 1;\n-const oldValue = true;";
    setupShikiMock([" const a = 1;", "-const oldValue = true;"]);
    await generateCodeOverlayPng(
      makeCodeBroll({ code, lineRange: [10, 11], highlights: [11] }),
    );

    const svg = expectCapturedSvg(capturedSvgBuffer);
    expect(svg).toContain("#f85149");
    expect(svg).not.toContain("#388bfd");
  });
});
