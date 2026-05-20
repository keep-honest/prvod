/**
 * Pre-renders code snippet overlays as PNG images for ffmpeg compositing.
 *
 * When a scene includes a `codeBroll` (code B-roll), this module syntax-highlights
 * the code with shiki (github-dark theme), renders it into an SVG with GitHub-style
 * line numbers and highlight markers, then rasterizes to PNG via sharp.
 *
 * The resulting PNG is composited onto the video by the filter graph builder using
 * ffmpeg's `overlay` filter with fade-in/fade-out transitions. This replaces the
 * Remotion path's React-based `CodeBrollOverlay` component.
 *
 * Pipeline: CodeBroll -> shiki tokenization -> SVG construction -> sharp PNG rasterization
 *
 * @module code-overlay
 */
import sharp from "sharp";
import { codeToTokens } from "shiki";
import type { ThemedToken } from "shiki";
import type { CodeBroll } from "@/domain/entities/VideoScript";
import {
  getSnippetLineChangeKind,
  getSnippetLineNumbers,
  normalizeSnippetHighlights,
  type SnippetLineChangeKind,
} from "@/infrastructure/video/codeLineMapping";
import { createLogger } from "@/lib/logger";
import { escapeXml } from "@/lib/xml";

const logger = createLogger("code-overlay");

// ── Constants ────────────────────────────────────────────────────────
const MAX_WIDTH = 1500;
const MAX_HEIGHT = 640;
const PADDING_X = 24;
const PADDING_Y = 20;
const FONT_SIZE = 18;
const LINE_HEIGHT = FONT_SIZE * 1.6; // 28.8px
const HEADER_FONT_SIZE = 11;
const HEADER_MARGIN_BOTTOM = 8;
const LINE_NUMBER_MIN_WIDTH = 36;
const LINE_NUMBER_MARGIN_RIGHT = 16;
const LINE_PADDING_X = 8;
const HIGHLIGHT_BORDER_WIDTH = 3;
const BORDER_RADIUS = 12;
/** Approximate monospace character width — SVG text has no layout engine, so we estimate. */
const CHAR_WIDTH_ESTIMATE = FONT_SIZE * 0.6;
const SHIKI_THEME = "github-dark";

// ── Highlighter cache ────────────────────────────────────────────────
let highlighterPromise: Promise<void> | null = null;

/** Warms the shiki WASM highlighter on first use and caches the result. Retries on failure. */
async function ensureHighlighterReady(): Promise<void> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      logger.debug("Warming shiki highlighter cache");
      await codeToTokens("", { lang: "text", theme: SHIKI_THEME });
      logger.debug("Shiki highlighter ready");
    })().catch((err) => {
      highlighterPromise = null; // allow retry on next call
      logger.error("Shiki highlighter warm-up failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
  }
  return highlighterPromise;
}

// ── SVG helpers ──────────────────────────────────────────────────────


/** A single source line with its syntax tokens and highlight state. */
interface LineTokens {
  lineNumber: number;
  changeKind: SnippetLineChangeKind;
  tokens: ThemedToken[];
  /** Whether this line is in the `codeBroll.highlights` set. */
  highlighted: boolean;
}

/** Maps shiki token arrays to LineTokens with correct line numbers and highlight flags. */
function buildTokenLines(
  codeLines: string[],
  tokenLines: ThemedToken[][],
  lineNumbers: number[],
  highlights: Set<number>,
): LineTokens[] {
  return codeLines.map((codeLine, i) => ({
    lineNumber: lineNumbers[i] ?? i + 1,
    changeKind: getSnippetLineChangeKind(codeLine),
    tokens: tokenLines[i] ?? [],
    highlighted: highlights.has(lineNumbers[i] ?? i + 1),
  }));
}

/** Estimates SVG width from the longest line, clamped to MAX_WIDTH. */
function measureContentWidth(lines: LineTokens[]): number {
  const codeAreaLeft =
    PADDING_X + LINE_PADDING_X + HIGHLIGHT_BORDER_WIDTH +
    LINE_NUMBER_MIN_WIDTH + LINE_NUMBER_MARGIN_RIGHT;

  let maxTextWidth = 0;
  for (const line of lines) {
    let lineLen = 0;
    for (const token of line.tokens) {
      lineLen += token.content.length;
    }
    maxTextWidth = Math.max(maxTextWidth, lineLen * CHAR_WIDTH_ESTIMATE);
  }

  return Math.min(MAX_WIDTH, Math.ceil(codeAreaLeft + maxTextWidth + LINE_PADDING_X + PADDING_X));
}

/** Computes SVG height from line count plus header, clamped to MAX_HEIGHT. */
function measureContentHeight(lineCount: number): number {
  const headerHeight = HEADER_FONT_SIZE + HEADER_MARGIN_BOTTOM;
  const linesHeight = lineCount * LINE_HEIGHT;
  return Math.min(MAX_HEIGHT, Math.ceil(PADDING_Y + headerHeight + linesHeight + PADDING_Y));
}

/**
 * Builds the complete SVG string: dark background, file path header, line numbers,
 * syntax-colored tokens, and optional highlight borders for marked lines.
 */
function renderSvg(
  codeBroll: CodeBroll,
  lines: LineTokens[],
  width: number,
  height: number,
): string {
  const headerY = PADDING_Y + HEADER_FONT_SIZE;
  const codeStartY = headerY + HEADER_MARGIN_BOTTOM;
  const innerWidth = width - 2 * PADDING_X;

  let lineElements = "";
  for (let i = 0; i < lines.length; i++) {
    const { lineNumber, tokens, highlighted, changeKind } = lines[i];
    const y = codeStartY + i * LINE_HEIGHT;
    const isRemoved = changeKind === "removed";

    // Line background and left border
    if (isRemoved || highlighted) {
      lineElements += `<rect x="${PADDING_X}" y="${y}" width="${innerWidth}" height="${LINE_HEIGHT}" fill="${isRemoved ? "rgba(248,81,73,0.16)" : "rgba(56,139,253,0.15)"}" rx="0"/>`;
      lineElements += `<rect x="${PADDING_X}" y="${y}" width="${HIGHLIGHT_BORDER_WIDTH}" height="${LINE_HEIGHT}" fill="${isRemoved ? "#f85149" : "#388bfd"}"/>`;
    } else {
      // Transparent border placeholder (keeps alignment consistent)
      lineElements += `<rect x="${PADDING_X}" y="${y}" width="${HIGHLIGHT_BORDER_WIDTH}" height="${LINE_HEIGHT}" fill="transparent"/>`;
    }

    // Line number
    const lineNumX = PADDING_X + HIGHLIGHT_BORDER_WIDTH + LINE_PADDING_X + LINE_NUMBER_MIN_WIDTH;
    const textBaselineY = y + LINE_HEIGHT * 0.75;
    lineElements += `<text x="${lineNumX}" y="${textBaselineY}" ` +
      `font-family="'Source Code Pro','Fira Code',monospace" font-size="${FONT_SIZE}" ` +
      `fill="#484f58" text-anchor="end">${lineNumber}</text>`;

    // Token spans
    let cursorX = lineNumX + LINE_NUMBER_MARGIN_RIGHT;
    for (const token of tokens) {
      const color = token.color ?? "#e6edf3";
      const escaped = escapeXml(token.content);
      // Use xml:space="preserve" on individual tspan-like text elements
      lineElements += `<text x="${cursorX}" y="${textBaselineY}" ` +
        `font-family="'Source Code Pro','Fira Code',monospace" font-size="${FONT_SIZE}" ` +
        `fill="${escapeXml(color)}" xml:space="preserve">${escaped}</text>`;
      cursorX += token.content.length * CHAR_WIDTH_ESTIMATE;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    // Container background — fully opaque so text stays readable over dark video
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${BORDER_RADIUS}" ` +
    `fill="#0d1117" stroke="#30363d" stroke-width="1"/>` +
    // Drop shadow filter
    `<defs><filter id="ds"><feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="rgba(0,0,0,0.5)"/></filter></defs>` +
    // File path header
    `<text x="${PADDING_X}" y="${headerY}" ` +
    `font-family="Inter,sans-serif" font-size="${HEADER_FONT_SIZE}" ` +
    `fill="#8b949e">${escapeXml(codeBroll.filePath)} (${escapeXml(codeBroll.language)})</text>` +
    // Code lines
    lineElements +
    `</svg>`;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Pre-renders a {@link CodeBroll} object as a PNG overlay image.
 *
 * Uses shiki for syntax highlighting (github-dark theme) and sharp for
 * SVG-to-PNG rasterization. The output is sized to fit the code content,
 * clamped to {@link MAX_WIDTH}x{@link MAX_HEIGHT} pixels.
 *
 * Falls back to plain-text tokenization if shiki doesn't recognize the language.
 *
 * @param codeBroll - The code snippet with file path, language, line range, and highlights
 * @returns PNG image buffer suitable for ffmpeg overlay compositing
 * @throws If sharp rasterization fails (e.g., invalid SVG)
 */
export async function generateCodeOverlayPng(codeBroll: CodeBroll): Promise<Buffer> {
  const startMs = Date.now();
  logger.info("Generating code overlay PNG", {
    filePath: codeBroll.filePath,
    language: codeBroll.language,
    lineCount: codeBroll.code.split("\n").length,
    highlightCount: codeBroll.highlights.length,
  });

  await ensureHighlighterReady();

  // Handle empty code
  if (!codeBroll.code.trim()) {
    logger.warn("Empty code provided, generating minimal overlay", {
      filePath: codeBroll.filePath,
    });
    return generateEmptyOverlay(codeBroll);
  }

  // Tokenize with shiki (fall back to plain text for unknown languages)
  let tokenLines: ThemedToken[][];
  try {
    const result = await codeToTokens(codeBroll.code, {
      lang: codeBroll.language as Parameters<typeof codeToTokens>[1]["lang"],
      theme: SHIKI_THEME,
    });
    tokenLines = result.tokens;
  } catch (err) {
    logger.warn("Shiki tokenization failed, falling back to plain text", {
      language: codeBroll.language,
      error: err instanceof Error ? err.message : String(err),
    });
    const result = await codeToTokens(codeBroll.code, {
      lang: "text",
      theme: SHIKI_THEME,
    });
    tokenLines = result.tokens;
  }

  const codeLines = codeBroll.code.split("\n");
  const lineNumbers = getSnippetLineNumbers(codeLines.length, codeBroll.lineRange);
  const highlights = new Set(
    normalizeSnippetHighlights({
      highlights: codeBroll.highlights,
      lineRange: codeBroll.lineRange,
      lineCount: codeLines.length,
    }),
  );
  const lines = buildTokenLines(codeLines, tokenLines, lineNumbers, highlights);

  const width = measureContentWidth(lines);
  const height = measureContentHeight(lines.length);
  const svg = renderSvg(codeBroll, lines, width, height);

  logger.debug("SVG generated", { width, height, svgLength: svg.length });

  const pngBuffer = await sharp(Buffer.from(svg))
    .png()
    .toBuffer();

  const durationMs = Date.now() - startMs;
  logger.info("Code overlay PNG generated", {
    filePath: codeBroll.filePath,
    width,
    height,
    pngSizeBytes: pngBuffer.length,
    durationMs,
  });

  return pngBuffer;
}

/** Generates a minimal overlay showing only the file path header when code is empty. */
async function generateEmptyOverlay(codeBroll: CodeBroll): Promise<Buffer> {
  const width = 400;
  const height = Math.ceil(PADDING_Y * 2 + HEADER_FONT_SIZE + HEADER_MARGIN_BOTTOM + LINE_HEIGHT);
  const headerY = PADDING_Y + HEADER_FONT_SIZE;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${BORDER_RADIUS}" ` +
    `fill="#0d1117" stroke="#30363d" stroke-width="1"/>` +
    `<text x="${PADDING_X}" y="${headerY}" ` +
    `font-family="Inter,sans-serif" font-size="${HEADER_FONT_SIZE}" ` +
    `fill="#8b949e">${escapeXml(codeBroll.filePath)} (${escapeXml(codeBroll.language)})</text>` +
    `</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
