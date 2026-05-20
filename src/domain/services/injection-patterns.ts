/**
 * Curated registry of regex patterns for detecting prompt injection attempts
 * in PR content before it reaches the LLM.
 *
 * Sources: OWASP LLM01, Rebuff, HackAPrompt research.
 *
 * Context-aware refinements (v2 — reduced false positives):
 *
 * 1. **Content masking** — Before patterns are tested, `matchInjectionPatterns`
 *    replaces safe regions with harmless placeholder characters so patterns
 *    never match inside:
 *      - Quoted strings (`"..."`, `'...'`, `` `...` ``)
 *      - Markdown code fences (` ``` ... ``` `)
 *      - Lines that are clearly code (starting with `const `, `let `, `var `,
 *        `function `, `class `, `export `, `import `, `//`, `#`, or
 *        assignment `=` before the injection text)
 *      - Diff hunk prefixes (`+` / `-` followed by code-like content)
 *
 * 2. **Regex refinements** — Patterns use word boundaries and sentence-start
 *    anchors to prevent matching inside identifiers and transitional phrases:
 *      - `rh-you-are-now` requires sentence-start or newline, not mid-phrase
 *      - `rh-pretend-as` requires a word boundary, not `function` as keyword
 *      - `io-override-system` excludes `override:` when preceded by `--`
 *      - `ee-base64-block` threshold raised from 50 to 80 chars
 *
 * Positions reported in `InjectionMatch.match.index` refer to the original
 * (unmasked) content, which is safe because masking preserves string length.
 */

export interface InjectionPattern {
  id: string;
  category: string;
  pattern: RegExp;
  description: string;
}

export const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  // ── instruction_override ──────────────────────────────────────────────
  {
    id: "io-ignore",
    category: "instruction_override",
    pattern:
      /\bignore\s+(?:all\s+)?(?:previous|above|prior|preceding)\s+(?:instructions|prompts|rules|guidelines|directives|context)\b/i,
    description: "Attempts to nullify prior instructions via 'ignore previous'",
  },
  {
    id: "io-disregard",
    category: "instruction_override",
    pattern:
      /\bdisregard\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|prompts|rules)\b/i,
    description: "Attempts to nullify prior instructions via 'disregard'",
  },
  {
    id: "io-forget",
    category: "instruction_override",
    pattern:
      /\bforget\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|prompts|rules)\b/i,
    description: "Attempts to nullify prior instructions via 'forget'",
  },
  {
    id: "io-do-not-follow",
    category: "instruction_override",
    pattern:
      /\bdo\s+not\s+follow\s+(?:the\s+)?(?:above|previous|prior)\s+(?:instructions|rules)\b/i,
    description: "Explicit directive to stop following instructions",
  },
  {
    id: "io-new-instructions",
    category: "instruction_override",
    pattern: /^(?:new|updated)\s+instructions\s*:/im,
    description: "Declares replacement instructions at line start",
  },
  {
    id: "io-override-system",
    category: "instruction_override",
    pattern: /^(?!.*--)(?:override|system)\s*:/im,
    description: "Uses 'override:' or 'system:' directive at line start",
  },

  // ── role_hijack ───────────────────────────────────────────────────────
  {
    id: "rh-you-are-now",
    category: "role_hijack",
    // Must be at sentence start: beginning of string, after newline, or after `. `
    // Excludes conditional phrases like "when you are now ready"
    pattern:
      /(?:^|(?<=\.\s)|(?<=\n))you\s+are\s+(?:now|actually|really|henceforth)\b/im,
    description: "Attempts to redefine the model's identity",
  },
  {
    id: "rh-pretend-as",
    category: "role_hijack",
    // \b prevents matching `function` as a JS keyword (caught by code-line masking too)
    pattern:
      /\b(?:pretend|act|behave|operate)\s+(?:as|like)\s+(?:a\b|an\b|the\b)?/i,
    description: "Instructs the model to adopt a different persona",
  },
  {
    id: "rh-switch-mode",
    category: "role_hijack",
    pattern: /\b(?:switch|change)\s+(?:to|into)\s+.{1,40}\s*mode\b/i,
    description: "Attempts to switch the model into an alternate mode",
  },
  {
    id: "rh-new-role",
    category: "role_hijack",
    pattern:
      /\byour\s+(?:new|real|actual|true)\s+(?:role|purpose|function|job|task)\s+is\b/i,
    description: "Redefines the model's role or purpose",
  },

  // ── prompt_extraction ─────────────────────────────────────────────────
  {
    id: "pe-show-prompt",
    category: "prompt_extraction",
    pattern:
      /\b(?:show|reveal|output|repeat|print|display|tell\s+me|give\s+me|what\s+is|what\s+are)\s+(?:your|the|my)?\s*(?:system|initial|original|full|complete)?\s*(?:prompt|instructions|rules|guidelines|directives|configuration)\b/i,
    description: "Requests disclosure of system prompt or instructions",
  },
  {
    id: "pe-how-instructed",
    category: "prompt_extraction",
    pattern:
      /\b(?:what|how)\s+(?:were\s+you|are\s+you)\s+(?:instructed|told|programmed|configured)\b/i,
    description: "Probes how the model was configured or instructed",
  },

  // ── delimiter_escape ──────────────────────────────────────────────────
  {
    id: "de-close-untrusted",
    category: "delimiter_escape",
    pattern: /<\/\s*untrusted[_\s]?pr[_\s]?content\s*>/i,
    description: "Tries to close the untrusted PR content XML wrapper",
  },
  {
    id: "de-system-tags",
    category: "delimiter_escape",
    pattern: /<\/?(?:system|instructions)\s*>/i,
    description: "Injects system/instructions XML tags to break boundaries",
  },
  {
    id: "de-v2-section-tags",
    category: "delimiter_escape",
    pattern:
      /<\/?\s*(?:pr_context|diff_evidence|analysis_summary|diff_analysis|output_contract|coverage_plan|scene_outline|evidence_clusters|word_budget|continuity|pipeline_script|repair_instructions|broken_script|allowed_evidence_per_scene|broken_outline|validation_errors|available_clusters|grounding_errors|word_budget_errors|reviewer_narration_errors|json_shape_reminder)\s*>/i,
    description:
      "Injects V2 pipeline section XML tags to break prompt boundaries",
  },
  {
    id: "de-markdown-delimiter",
    category: "delimiter_escape",
    pattern:
      /---\s*(?:end|begin)\s*(?:of\s+)?(?:system|user|content|instructions)/i,
    description: "Uses markdown-style delimiters to escape content zones",
  },

  // ── encoding_evasion ──────────────────────────────────────────────────
  {
    id: "ee-base64-block",
    category: "encoding_evasion",
    // Raised from 50 to 80 to skip JWTs and short config values
    pattern: /(?:[A-Za-z0-9+/]{80,}={0,2})/,
    description:
      "Suspicious base64 block (>80 chars) that may encode injections",
  },
  {
    id: "ee-llama-tokens",
    category: "encoding_evasion",
    pattern: /\[\/?\s*INST\s*\]|<<\/?SYS>>/i,
    description:
      "Llama-style instruction/system tokens used for boundary escape",
  },
] as const;

/** Pre-compiled global regex variants — avoids recompiling on every scan call. */
const INJECTION_PATTERNS_GLOBAL: ReadonlyArray<{ entry: InjectionPattern; re: RegExp }> =
  INJECTION_PATTERNS.map((entry) => ({
    entry,
    re: new RegExp(entry.pattern.source, entry.pattern.flags.includes("g") ? entry.pattern.flags : entry.pattern.flags + "g"),
  }));

export interface InjectionMatch {
  pattern: InjectionPattern;
  match: RegExpExecArray;
}

// ── Content masking helpers ────────────────────────────────────────────────

const SPACE_CODE = 32; // ' '.charCodeAt(0)

/** All safe-region patterns applied during masking. */
const MASK_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,                                   // 1. Markdown code fences
  /`[^`\n]+`/g,                                        // 2. Inline code backticks
  /"(?:[^"\\]|\\.)*"/g,                                // 3. Double-quoted strings
  /'(?:[^'\\]|\\.)*'/g,                                // 4. Single-quoted strings
  /^[+\- ]*(?:const|let|var|function|class|export|import|return|type|interface|enum)\s.+$/gm, // 5. Code keyword lines
  /^[+\- ]*(?:\/\/|#|\*\s).+$/gm,                     // 6. Comment lines
  /^[+-]\s*\w+.*[=({].+$/gm,                          // 7. Diff code lines
];

/**
 * Masks safe regions in `content` so injection patterns do not match inside
 * quoted strings, code fences, comment lines, or code keyword lines.
 *
 * Uses a mutable Uint16Array for O(N) performance on large inputs instead of
 * repeated string concatenation which is O(N*M) where M = number of matches.
 */
function maskSafeRegions(content: string): string {
  const codes = new Uint16Array(content.length);
  for (let i = 0; i < content.length; i++) {
    codes[i] = content.charCodeAt(i);
  }

  for (const re of MASK_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const end = m.index + m[0].length;
      for (let i = m.index; i < end; i++) {
        codes[i] = SPACE_CODE;
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  // Build string in chunks to avoid call stack overflow with large arrays
  const CHUNK = 8192;
  let result = "";
  for (let i = 0; i < codes.length; i += CHUNK) {
    result += String.fromCharCode(...codes.subarray(i, Math.min(i + CHUNK, codes.length)));
  }
  return result;
}

/**
 * Tests all registered injection patterns against the provided content.
 * Returns every match with the pattern metadata and position information.
 *
 * Content is first passed through `maskSafeRegions()` to suppress matches
 * inside quoted strings, code fences, comment lines, and similar safe
 * contexts. Match positions refer to the original content string.
 */
export function matchInjectionPatterns(content: string): InjectionMatch[] {
  const masked = maskSafeRegions(content);
  const results: InjectionMatch[] = [];

  for (const { entry, re } of INJECTION_PATTERNS_GLOBAL) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(masked)) !== null) {
      // Build a synthetic RegExpExecArray that references the original content
      // so callers can slice the real text for stripping / logging.
      const originalMatch = Object.assign([content.substring(match.index, match.index + match[0].length)], {
        index: match.index,
        input: content,
        groups: match.groups,
      }) as unknown as RegExpExecArray;

      results.push({ pattern: entry, match: originalMatch });

      // Guard against zero-length matches causing infinite loops
      if (match[0].length === 0) re.lastIndex++;
    }
  }

  return results;
}
