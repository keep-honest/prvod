import type {
  IOutputValidator,
  SanitizationResult,
  DetectionDetail,
  SanitizeOptions,
} from "@/interfaces/IPromptInjectionGuard";
import { matchSensitiveData } from "./sensitive-data-patterns";
import { createLogger } from "@/lib/logger";
import { sha256 } from "@/lib/crypto";

const logger = createLogger("OutputValidator");


/** Patterns that suggest injected instructions targeting downstream renderers. */
const INSTRUCTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "render_text_instruction", re: /render\s+(?:the\s+)?(?:following\s+|text\s+)?on\s+screen/gi },
  { id: "display_instruction", re: /display\s+the\s+following/gi },
  { id: "generate_image_text", re: /generate\s+(?:an?\s+)?image\s+containing\s+text/gi },
  { id: "overlay_text", re: /overlay\s+(?:the\s+)?text/gi },
  { id: "show_on_screen", re: /show\s+(?:the\s+following\s+)?on\s+screen/gi },
];

/** URLs should not appear in narration text. */
const URL_RE = /https?:\/\/[^\s)]+/gi;
const URL_PATTERN_ID = "url_in_narration";

/**
 * Layer-2 domain service that scans LLM-generated narration for sensitive data
 * leaks and instruction-like content that may have survived the pipeline.
 */
export class OutputValidator implements IOutputValidator {
  validate(narration: string, options?: SanitizeOptions): SanitizationResult {
    if (narration === "") {
      return { content: "", injectionDetected: false, detections: [], contentHash: "" };
    }

    const contentHash = sha256(narration);

    try {
      const detections: DetectionDetail[] = [];
      let cleaned = narration;

      // ── Layer 6: Sensitive Data Scan ──────────────────────────────────
      const sensitiveMatches = matchSensitiveData(cleaned);

      // Only redact validated matches (validator passed or no validator defined).
      const toRedact = sensitiveMatches
        .filter((m) => m.validated)
        .map((m) => ({
          patternId: m.pattern.id,
          start: m.match.index ?? 0,
          end: (m.match.index ?? 0) + m.match[0].length,
        }));

      // Apply redactions in reverse offset order to preserve positions.
      toRedact.sort((a, b) => b.start - a.start);

      for (const { patternId, start, end } of toRedact) {
        detections.push({
          field: (options?.outputField ?? "prDescription") as DetectionDetail["field"],
          patternId,
          category: "sensitive_data",
          action: "redacted",
          position: { start, end },
        });
        cleaned = cleaned.slice(0, start) + "[REDACTED]" + cleaned.slice(end);
      }

      // ── Layer 7: Content Validation ───────────────────────────────────
      for (const { id, re } of INSTRUCTION_PATTERNS) {
        re.lastIndex = 0;
        let result: RegExpExecArray | null;

        while ((result = re.exec(cleaned)) !== null) {
          const start = result.index;
          const end = start + result[0].length;
          detections.push({
            field: (options?.outputField ?? "prDescription") as DetectionDetail["field"],
            patternId: id,
            category: "injection",
            action: "sanitized",
            position: { start, end },
          });
          cleaned = cleaned.slice(0, start) + cleaned.slice(end);
          re.lastIndex = start; // reset after splice
        }
      }

      // URL check
      {
        URL_RE.lastIndex = 0;
        let result: RegExpExecArray | null;

        while ((result = URL_RE.exec(cleaned)) !== null) {
          const start = result.index;
          const end = start + result[0].length;
          detections.push({
            field: (options?.outputField ?? "prDescription") as DetectionDetail["field"],
            patternId: URL_PATTERN_ID,
            category: "injection",
            action: "sanitized",
            position: { start, end },
          });
          cleaned = cleaned.slice(0, start) + cleaned.slice(end);
          URL_RE.lastIndex = start;
        }
      }

      // Restore ascending position order for callers.
      detections.reverse();

      if (detections.length > 0) {
        const severity = detections.length >= 3 ? "high" : detections.length >= 2 ? "medium" : "low";
        logger.warn("Sensitive data or injection residue detected in output", {
          layer: "output_validation",
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
      logger.error("Output validation failed — fail-closed, redacting content", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        contentHashPrefix: contentHash.substring(0, 12),
      });
      return {
        content: "[REDACTED]",
        injectionDetected: true,
        detections: [{
          field: (options?.outputField ?? "prDescription") as DetectionDetail["field"],
          patternId: "validation_error",
          category: "sensitive_data" as const,
          action: "redacted" as const,
          position: { start: 0, end: narration.length },
        }],
        contentHash,
      };
    }
  }

  checkCanary(output: string, canaryToken: string, jobContext?: SanitizeOptions["jobContext"]): boolean {
    const found = output.includes(canaryToken);
    if (found) {
      logger.error("SECURITY: Canary token leaked in LLM output", {
        layer: "canary_detection",
        severity: "high",
        ...(jobContext && {
          jobId: jobContext.jobId,
          prIdentifier: jobContext.prIdentifier,
          installationId: jobContext.installationId,
        }),
      });
    }
    return found;
  }
}
