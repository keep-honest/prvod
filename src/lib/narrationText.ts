import { createLogger } from "@/lib/logger";

const logger = createLogger("narrationText");

export function normalizeNarrationText(text: string): string {
  return text
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NON_SPOKEN_BRACKETED_PATTERNS = [
  /\[(?:sfx|fx|music|audio|sound|ambience|camera|shot|visual|lighting|beat)[^\]]*]/gi,
  /\((?:sfx|fx|music|audio|sound|ambience|camera|shot|visual|lighting|beat)[^)]*\)/gi,
];

const NON_SPOKEN_LABELS = new Set([
  "sfx",
  "fx",
  "music",
  "audio",
  "sound",
  "ambience",
  "camera",
  "shot",
  "visual",
  "lighting",
  "beat",
]);

const LIKELY_SPOKEN_START_WORDS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "they",
  "their",
  "them",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "i",
  "overall",
  "now",
  "here",
]);

function isLikelySpokenStart(word: string): boolean {
  const normalized = word.replace(/^[`"'([{]+|[`"')\]}:;,.!?]+$/g, "");
  if (normalized.length === 0) {
    return false;
  }

  const lower = normalized.toLowerCase();
  return (
    LIKELY_SPOKEN_START_WORDS.has(lower) ||
    normalized.includes("()") ||
    /[a-z][A-Z]/.test(normalized)
  );
}

function stripLeadingNonSpokenPrefix(text: string): string {
  let remaining = text.trim();

  while (remaining.length > 0) {
    const labelMatch = remaining.match(/^([A-Za-z]+):\s*/);
    if (!labelMatch) {
      return remaining;
    }

    const label = labelMatch[1].toLowerCase();
    if (!NON_SPOKEN_LABELS.has(label)) {
      return remaining;
    }

    remaining = remaining.slice(labelMatch[0].length).trimStart();
    const boundaryMatch = remaining.match(/[.!?]\s+|\n+/);
    if (!boundaryMatch || boundaryMatch.index == null) {
      const words = remaining.split(/\s+/).filter(Boolean);
      const spokenStartIndex = words.findIndex((word) => isLikelySpokenStart(word));
      if (spokenStartIndex < 0) {
        return "";
      }

      return words.slice(spokenStartIndex).join(" ").trim();
    }

    remaining = remaining
      .slice(boundaryMatch.index + boundaryMatch[0].length)
      .trimStart();
  }

  return remaining;
}

function stripStandaloneNonSpokenSentences(text: string): string {
  const segments = text.match(/.+?(?:[.!?](?=\s+|$)|$)/g) ?? [];

  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => {
      const labelMatch = segment.match(/^([A-Za-z]+):\s*/);
      if (!labelMatch) {
        return true;
      }

      return !NON_SPOKEN_LABELS.has(labelMatch[1].toLowerCase());
    })
    .join(" ");
}

/**
 * Replace file paths (containing /) with just the basename.
 * Only matches paths ending with a file extension (word.ext) to avoid
 * corrupting prose like "input/output" or "and/or".
 * e.g. "src/service/module/task.ts" → "task.ts"
 */
function abbreviateFilePaths(text: string): string {
  return text.replace(/(?:[\w./-]+\/)([\w-]+\.[\w]{1,10})\b/g, (_match, basename) => basename);
}

/**
 * Convert dots in the middle of words to " dot " for TTS pronunciation.
 * Handles single dots (Foo.ts) and multiple dots (config.prod.yaml).
 * Preserves decimal numbers (1.5, 2.0) — only digit.digit is left intact.
 * Does not affect sentence-ending dots or ellipses.
 */
function convertMidWordDots(text: string): string {
  // Loop because matches overlap (e.g. "a.b.c" — consuming "a.b" skips "b.c")
  let result = text;
  let prev = "";
  const MAX_ITERATIONS = 100;
  let iterations = 0;
  while (result !== prev) {
    if (++iterations > MAX_ITERATIONS) {
      logger.warn("convertMidWordDots hit MAX_ITERATIONS — input may be partially processed", {
        maxIterations: MAX_ITERATIONS,
        textLength: text.length,
      });
      break;
    }
    prev = result;
    // Skip digit.digit (decimal numbers like 1.5, 2.0) — only convert when at least one side is a letter
    result = result.replace(/([a-zA-Z])\.(\w)/g, "$1 dot $2");
    result = result.replace(/(\w)\.([a-zA-Z])/g, "$1 dot $2");
  }
  return result;
}

/**
 * Reverses the spoken "dot" substitution in a word-timing token stream for
 * caption display. TTS receives "auth dot ts" so it pronounces the dot correctly;
 * captions should display "auth.ts".
 *
 * Scans the token list and, whenever a "dot" token is flanked by word-character
 * tokens (last result token ends with \w, next input token starts with \w),
 * merges the triple into a single token: word1.word2 spanning the full time range.
 * Processes left-to-right against the growing result so chained dots
 * (config.prod.yaml) collapse in a single pass.
 *
 * Skips the merge when the token after "dot" is in DOT_FOLLOWER_STOPWORDS, so
 * legitimate English prose like "use dot notation" or "the dot product" stays
 * as separate tokens in captions instead of becoming "use.notation". The list
 * targets common nouns that follow "dot" in code-walkthrough narration; file
 * extensions and identifiers (ts, tsx, json, yaml, parse, map, etc.) are not
 * in the list and merge normally.
 *
 * The stopword check is bypassed when `last.word` already contains a `.` —
 * that means we're in a chained merge (e.g. `hello.world` looking at the
 * second dot toward `md`, or `api.example` toward `com`). A previously merged
 * compound is strong evidence the run is a file/domain, not English prose, so
 * we let trailing segments like `.com`/`.io`/`.org`/`.md` complete the chain.
 */
import type { WordTiming } from "@/interfaces/ITTSService";

// Prose-only stopwords: words that follow "dot" in English narration but
// almost never appear as a real file extension or domain TLD. TLDs like com,
// net, org, io, gov are deliberately omitted — single-dot domains
// (example.com, socket.io) are common in code walkthroughs and the cost of
// breaking them in captions is higher than the rare "dot com" prose case.
const DOT_FOLLOWER_STOPWORDS: ReadonlySet<string> = new Set([
  "notation",
  "syntax",
  "operator",
  "operators",
  "product",
  "products",
  "accessor",
  "accessors",
  "member",
  "members",
  "reference",
  "references",
  "file",
  "files",
  "path",
  "paths",
  "point",
  "points",
  "matrix",
  "dot", // "dot dot dot" (ellipsis) — skip subsequent dots
]);

function isDotFollowerStopword(token: string): boolean {
  // Strip leading/trailing non-word chars so "notation," / "notation." still matches.
  const normalized = token.toLowerCase().replace(/^\W+|\W+$/g, "");
  return DOT_FOLLOWER_STOPWORDS.has(normalized);
}

export function restoreDotsInWordTimings(timings: WordTiming[]): WordTiming[] {
  const result: WordTiming[] = [];
  for (let i = 0; i < timings.length; i++) {
    const curr = timings[i];
    const last = result[result.length - 1];
    const nextToken = timings[i + 1];
    if (
      curr.word.toLowerCase() === "dot" &&
      last !== undefined &&
      nextToken !== undefined &&
      /\w$/.test(last.word) &&
      /^\w/.test(nextToken.word) &&
      // Bypass stopword check during a chained merge: if `last` already contains
      // a dot, the previous merge marked the run as a file/domain (hello.world,
      // api.example) and trailing segments like `.com`/`.io`/`.md` should complete
      // the chain instead of being treated as English-prose stopwords.
      (last.word.includes(".") || !isDotFollowerStopword(nextToken.word))
    ) {
      result[result.length - 1] = {
        word: last.word + "." + nextToken.word,
        startTimeMs: last.startTimeMs,
        endTimeMs: nextToken.endTimeMs,
      };
      i += 1; // consume nextToken
    } else {
      result.push(curr);
    }
  }
  return result;
}

// ── Data format pronunciation ─────────────────────────────────────────

/**
 * Maps display-form data format names to TTS-friendly spoken forms.
 * All-caps acronyms like YAML/TOML are read letter-by-letter by Google TTS;
 * title-casing them forces word reading ("yam-ul", "tom-ul").
 * Parquet is a French-origin word pronounced "par-KAY", not English "par-KWET".
 *
 * The (?!\.) negative lookahead prevents matching format names used as object
 * method prefixes (e.g. JSON.parse, YAML.load) so captions show JSON.parse
 * rather than Json.parse. Must run BEFORE convertMidWordDots so the lookahead
 * still sees the original dot.
 */
const FORMAT_PRONUNCIATION_MAP: [RegExp, string][] = [
  [/\bYAML(?!\.)\b/gi, "Yaml"],
  [/\bTOML(?!\.)\b/gi, "Toml"],
  [/\bJSON(?!\.)\b/gi, "Json"],
  [/\bParquet(?!\.)\b/gi, "parkay"],
];

/** Reverse of FORMAT_PRONUNCIATION_MAP — restores captions to canonical display form. */
const FORMAT_DISPLAY_MAP: Record<string, string> = {
  yaml: "YAML",
  toml: "TOML",
  json: "JSON",
  parkay: "Parquet",
};

// Invariant: every spoken form in FORMAT_PRONUNCIATION_MAP must have a reverse entry.
// This throws at module load time so a map divergence is caught immediately.
for (const [, spoken] of FORMAT_PRONUNCIATION_MAP) {
  if (!(spoken.toLowerCase() in FORMAT_DISPLAY_MAP)) {
    throw new Error(
      `FORMAT_DISPLAY_MAP is missing reverse entry for spoken form "${spoken}". ` +
      `Add it to keep caption display in sync with TTS pronunciation substitution.`,
    );
  }
}

function normalizeDataFormatPronunciation(text: string): string {
  let result = text;
  for (const [pattern, spoken] of FORMAT_PRONUNCIATION_MAP) {
    result = result.replace(pattern, spoken);
  }
  return result;
}

/**
 * Reverses data-format pronunciation substitutions in a word-timing token stream.
 * "Yaml" → "YAML", "Toml" → "TOML", "parkay" → "Parquet", etc.
 *
 * For compound tokens (e.g. config.Yaml merged by restoreDotsInWordTimings),
 * restores the extension to lowercase (config.yaml) since file extensions are
 * conventionally lowercase. Standalone tokens get canonical all-caps display.
 * Apply after restoreDotsInWordTimings, before buildCaptionCues.
 */
export function restoreDataFormatNamesInWordTimings(timings: WordTiming[]): WordTiming[] {
  return timings.map((t) => {
    if (!t.word.includes(".")) {
      const display = FORMAT_DISPLAY_MAP[t.word.toLowerCase()];
      return display ? { ...t, word: display } : t;
    }
    // Compound token (file path): restore extension to canonical lowercase form
    // e.g. config.Yaml → config.yaml, data.parkay → data.parquet
    const lastDot = t.word.lastIndexOf(".");
    const ext = t.word.substring(lastDot + 1);
    const displayExt = FORMAT_DISPLAY_MAP[ext.toLowerCase()];
    if (displayExt) {
      return { ...t, word: t.word.substring(0, lastDot + 1) + displayExt.toLowerCase() };
    }
    // Warn when a format name appears in a non-final position (e.g. schema.Json.bak).
    // Only the final extension is restored; mid-path format names are left as-is.
    const segments = t.word.split(".");
    const hasMidFormatName = segments.slice(0, -1).some(
      (seg) => seg.toLowerCase() in FORMAT_DISPLAY_MAP,
    );
    if (hasMidFormatName) {
      logger.warn("restoreDataFormatNamesInWordTimings: format name in non-final segment — not restored", {
        word: t.word,
      });
    }
    return t;
  });
}

/** Count words as TTS will actually speak them (after sanitization). */
export function countSpokenWords(text: string): number {
  return sanitizeSpokenNarrationText(text).split(/\s+/).filter(Boolean).length;
}

export function sanitizeSpokenNarrationText(text: string): string {
  let sanitized = normalizeNarrationText(text);
  sanitized = abbreviateFilePaths(sanitized);
  // normalizeDataFormatPronunciation must run BEFORE convertMidWordDots so the
  // (?!\.) lookahead in FORMAT_PRONUNCIATION_MAP can see the original dot and
  // skip compound identifiers like JSON.parse (otherwise convertMidWordDots
  // splits them into standalone tokens that the substitution then incorrectly fires on).
  sanitized = normalizeDataFormatPronunciation(sanitized);
  sanitized = convertMidWordDots(sanitized);

  for (const pattern of NON_SPOKEN_BRACKETED_PATTERNS) {
    sanitized = sanitized.replace(pattern, " ");
  }

  sanitized = stripLeadingNonSpokenPrefix(sanitized);
  sanitized = stripStandaloneNonSpokenSentences(sanitized);

  sanitized = sanitized.replace(/\s+/g, " ").trim();
  return sanitized;
}
