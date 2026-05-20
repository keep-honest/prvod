import type {
  IInputSanitizer,
  SanitizationResult,
  DetectionDetail,
  SanitizeOptions,
  ContentContext,
} from "@/interfaces/IPromptInjectionGuard";
import { sha256 } from "@/lib/crypto";
import { matchInjectionPatterns } from "./injection-patterns";
import { createLogger } from "@/lib/logger";

const logger = createLogger("InputSanitizer");

/** Characters that hide payloads in plain sight. */
// eslint-disable-next-line no-misleading-character-class -- intentional zero-width char matching
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF\u2060]/g;

/** Control chars 0x00-0x1F except \n (0x0A) and \t (0x09). */
// eslint-disable-next-line no-control-regex -- intentional control character stripping
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** Consecutive horizontal whitespace (spaces / tabs). */
const MULTI_SPACE_RE = /[^\S\n]{2,}/g;

/**
 * Fields containing code (diffs, issue bodies) are more permissive —
 * encoding_evasion patterns are suppressed because base64 is common in code.
 */
const PERMISSIVE_FIELDS = new Set<DetectionDetail["field"]>([
  "diff",
  "issueBody",
  "milestoneDescription",
]);

/** Derive content context from field when not explicitly provided. */
function inferContentContext(field: DetectionDetail["field"]): ContentContext {
  switch (field) {
    case "prTitle":
    case "issueTitle":
    case "milestoneTitle":
      return "strict";
    case "diff":
      return "code";
    default:
      return "permissive";
  }
}


/**
 * Layer-2 domain service that preprocesses untrusted PR content and strips
 * known injection patterns before content reaches the LLM.
 */
export class InputSanitizer implements IInputSanitizer {
  sanitize(
    content: string,
    field: DetectionDetail["field"],
    options?: SanitizeOptions,
  ): SanitizationResult {
    if (content === "") {
      return { content: "", injectionDetected: false, detections: [], contentHash: "" };
    }

    const contentHash = sha256(content);

    try {
      // ── Layer 1: Input Preprocessing ────────────────────────────────────
      const contentContext = options?.contentContext ?? inferContentContext(field);
      let cleaned = content
        .normalize("NFC")
        .replace(ZERO_WIDTH_RE, "")
        .replace(CONTROL_CHAR_RE, "");

      // Preserve indentation for code/diff content (Python, YAML, Makefiles)
      if (contentContext !== "code") {
        cleaned = cleaned.replace(MULTI_SPACE_RE, " ");
      }

      // ── Layer 2: Pattern-Based Scanning ─────────────────────────────────
      const allMatches = matchInjectionPatterns(cleaned);
      // Code/permissive context skips encoding_evasion (base64 common in code/config)
      // delimiter_escape is NEVER suppressed — these patterns target our XML
      // boundary tags and must always be stripped regardless of content context
      const matches = allMatches.filter((m) => {
        if (contentContext === "code" || contentContext === "permissive" || PERMISSIVE_FIELDS.has(field)) {
          return m.pattern.category !== "encoding_evasion";
        }
        return true;
      });
      const detections: DetectionDetail[] = [];

      // Strip matches in reverse offset order to keep positions stable.
      const sorted = [...matches].sort(
        (a, b) => (b.match.index ?? 0) - (a.match.index ?? 0),
      );

      for (const { pattern, match } of sorted) {
        const start = match.index ?? 0;
        const end = start + match[0].length;

        detections.push({
          field,
          patternId: pattern.id,
          category: "injection",
          action: "sanitized",
          position: { start, end },
        });

        cleaned = cleaned.slice(0, start) + cleaned.slice(end);
      }

      // Restore natural ordering (by position ascending) for callers.
      detections.reverse();

      if (detections.length > 0) {
        const severity = detections.length >= 3 ? "high" : detections.length >= 2 ? "medium" : "low";
        logger.warn("Prompt injection pattern detected in input", {
          layer: "input_sanitization",
          field,
          contentContext,
          severity,
          detectionCount: detections.length,
          patternIds: detections.map((d) => d.patternId),
          contentHashPrefix: contentHash.substring(0, 12),
          ...(options?.jobContext && {
            jobId: options.jobContext.jobId,
            prIdentifier: options.jobContext.prIdentifier,
            installationId: options.jobContext.installationId,
          }),
        });
      }

      return {
        content: cleaned,
        injectionDetected: detections.length > 0,
        detections,
        contentHash,
      };
    } catch (error) {
      logger.error("Sanitization failed — fail-closed, rejecting content", {
        field,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        contentHashPrefix: contentHash.substring(0, 12),
      });
      return {
        content: "",
        injectionDetected: true,
        detections: [{
          field,
          patternId: "sanitization_error",
          category: "injection" as const,
          action: "sanitized" as const,
          position: { start: 0, end: content.length },
        }],
        contentHash,
      };
    }
  }
}
