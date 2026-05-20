import { describe, expect, it } from "vitest";
import { buildErrorComment } from "@/app/api/webhook/github/errorComment";
import { parseAnnotations } from "@/lib/webhookSignature";

describe("buildErrorComment", () => {
  const GENERIC_MARKER = "😞 Video generation failed";
  const RATE_LIMIT_MARKER = "underlying LLM provider is rate-limited or over capacity";

  it("returns the generic comment for unknown errors", () => {
    expect(buildErrorComment("Unknown error")).toContain(GENERIC_MARKER);
    expect(buildErrorComment("Some random failure")).toContain(GENERIC_MARKER);
  });

  it("returns the rate-limit-specific comment when the error code is LLM_RATE_LIMITED_EXHAUSTED", () => {
    const comment = buildErrorComment(
      "LLM_RATE_LIMITED_EXHAUSTED: LLM call \"coverage_judge\" failed after 5 attempts",
    );
    expect(comment).toContain(RATE_LIMIT_MARKER);
    expect(comment).not.toContain(GENERIC_MARKER);
  });

  it("detects common rate-limit phrases even without the error code", () => {
    const samples = [
      "RESOURCE_EXHAUSTED: upstream capacity",
      "No capacity available for model gemini-2.5-pro",
      "Anthropic API is overloaded",
      "429 Too Many Requests",
    ];
    for (const msg of samples) {
      const comment = buildErrorComment(msg);
      expect(comment).toContain(RATE_LIMIT_MARKER);
    }
  });

  it("falls back to the generic comment for non-rate-limit errors", () => {
    const samples = [
      "Zod schema validation failed",
      "Database connection error",
      "Invalid prompt structure",
      "Checkpoint not found",
    ];
    for (const msg of samples) {
      const comment = buildErrorComment(msg);
      expect(comment).toContain(GENERIC_MARKER);
      expect(comment).not.toContain(RATE_LIMIT_MARKER);
    }
  });

  // ── Webhook loop-guard regression ────────────────────────────────────────
  // GitHub re-delivers every new issue comment as an `issue_comment.created`
  // webhook. The annotation parser (`ANNOTATION_LINE_PATTERN`) is line-
  // anchored (`^...$` with `m` flag) so it only matches when `@prvod` is
  // on its own line. Inside inline prose (e.g. "by commenting `@prvod`")
  // the regex cannot match, so the comment body safely uses the LITERAL
  // `@prvod` for copy-paste — no invisible zero-width space needed.
  //
  // The primary defense is `isBotAuthoredIssueComment` (4 independent
  // checks). These tests verify the SECONDARY defense: even if the bot
  // guard were bypassed, `parseAnnotations` still cannot match the inline
  // mention.
  describe("webhook loop-guard (parseAnnotations cannot match inline @prvod)", () => {
    const cases: Array<[string, string]> = [
      ["generic error", "Some random failure"],
      ["rate-limit error", "LLM_RATE_LIMITED_EXHAUSTED: ..."],
    ];

    it.each(cases)("%s: parseAnnotations must not detect an annotation in the comment body", (_label, msg) => {
      const comment = buildErrorComment(msg);
      const parsed = parseAnnotations(comment);
      expect(parsed.hasAnnotation).toBe(false);
      expect(parsed.scriptOnly).toBe(false);
      expect(parsed.shortDuration).toBe(false);
      expect(parsed.popcornDuration).toBe(false);
    });

    it.each(cases)("%s: comment body contains a copyable '@prvod' mention (no hidden characters)", (_label, msg) => {
      const comment = buildErrorComment(msg);
      // The instruction must contain the LITERAL `@prvod` so copy-paste
      // produces a valid annotation when the user posts it on its own line.
      expect(comment).toContain("@prvod");
      // No hidden zero-width spaces that would break copy-paste.
      expect(comment).not.toContain("\u200B");
    });
  });
});
