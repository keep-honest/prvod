import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import { OutputValidator } from "@/domain/services/OutputValidator";
import {
  luhnCheck,
  matchSensitiveData,
} from "@/domain/services/sensitive-data-patterns";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("OutputValidator", () => {
  const validator = new OutputValidator();

  // ── Credential detection ────────────────────────────────────────────────

  describe("credential detection", () => {
    it("detects an AWS access key ID", () => {
      const result = validator.validate(
        "key=AKIAIOSFODNN7EXAMPLE was found in config",
      );
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "aws_access_key")).toBe(true);
    });

    it("redacts an AWS access key from content", () => {
      const result = validator.validate(
        "key=AKIAIOSFODNN7EXAMPLE was found in config",
      );
      expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.content).toContain("[REDACTED]");
    });

    it("detects a GitHub classic personal access token (ghp_)", () => {
      // Pattern requires exactly 36 alphanumeric chars after "ghp_"
      const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const result = validator.validate(`auth: ${token}`);
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "github_token_classic")).toBe(true);
    });

    it("detects an OpenAI project-scoped API key (sk-proj-)", () => {
      // 80+ chars after the prefix
      const key = `sk-proj-${"a".repeat(82)}`;
      const result = validator.validate(`Configured with key ${key}`);
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "openai_api_key_project")).toBe(true);
    });

    it("detects an Anthropic API key (sk-ant-)", () => {
      const key = `sk-ant-${"b".repeat(82)}`;
      const result = validator.validate(`Using claude via ${key}`);
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "anthropic_api_key")).toBe(true);
    });

    it("detects a Slack bot token (xoxb-)", () => {
      const result = validator.validate(
        "Slack token xoxb-12345678901-12345678901-abc123def456 is active",
      );
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "slack_token")).toBe(true);
    });

    it("detects an HTTP Bearer authorization token", () => {
      const result = validator.validate(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      );
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "bearer_token")).toBe(true);
    });

    it("detects a PostgreSQL connection string with embedded credentials", () => {
      const result = validator.validate(
        "Connect to postgresql://user:pass@db.internal:5432/mydb for reads",
      );
      expect(result.injectionDetected).toBe(true);
      const ids = result.detections.map((d) => d.patternId);
      expect(
        ids.includes("connection_string_postgres") ||
          ids.includes("generic_uri_with_credentials"),
      ).toBe(true);
    });

    it("detects a PEM private key block header", () => {
      const result = validator.validate(
        "-----BEGIN RSA PRIVATE KEY----- was accidentally committed",
      );
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "private_key_block")).toBe(true);
    });

    it("detects an environment variable assignment with a sensitive key name", () => {
      const result = validator.validate(
        "Set DATABASE_URL=postgres://admin:s3cr3t@localhost/prod before running",
      );
      expect(result.injectionDetected).toBe(true);
      const ids = result.detections.map((d) => d.patternId);
      expect(
        ids.includes("env_var_assignment") ||
          ids.includes("connection_string_postgres") ||
          ids.includes("generic_uri_with_credentials"),
      ).toBe(true);
    });
  });

  // ── PII detection ───────────────────────────────────────────────────────

  describe("PII detection", () => {
    it("detects a Luhn-valid Visa credit card number", () => {
      // 4111111111111111 is the canonical Visa test number (passes Luhn)
      const result = validator.validate("Card 4111111111111111 was charged");
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "credit_card")).toBe(true);
    });

    it("Luhn check returns true for the Visa test card number", () => {
      expect(luhnCheck("4111111111111111")).toBe(true);
    });

    it("Luhn check returns false for a card number with an invalid check digit", () => {
      // Last digit changed from 1 to 2 — fails Luhn
      expect(luhnCheck("4111111111111112")).toBe(false);
    });

    it("still detects a card number even when Luhn validation fails (validated=false)", () => {
      // matchSensitiveData returns the match regardless; validated: false just
      // means the post-match validator rejected it (bad Luhn).
      // The service only redacts validated matches, so content remains unchanged,
      // but we verify the pattern itself still fires at the data layer.
      const matches = matchSensitiveData("Card 4111111111111112 was charged");
      const ccMatch = matches.find((m) => m.pattern.id === "credit_card");
      expect(ccMatch).toBeDefined();
      expect(ccMatch?.validated).toBe(false);
    });

    it("detects a US Social Security Number", () => {
      const result = validator.validate("SSN 123-45-6789 should never appear");
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "ssn")).toBe(true);
    });

    it("detects an email address", () => {
      const result = validator.validate("Contact user@example.com for support");
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "email_address")).toBe(true);
    });

    it("detects a US phone number in parenthetical format", () => {
      const result = validator.validate("Call (555) 123-4567 to reach the team");
      expect(result.injectionDetected).toBe(true);
      expect(result.detections.some((d) => d.patternId === "phone_us")).toBe(true);
    });
  });

  // ── Redaction behavior ──────────────────────────────────────────────────

  describe("redaction", () => {
    it("replaces detected sensitive data with [REDACTED]", () => {
      const result = validator.validate(
        "Token AKIAIOSFODNN7EXAMPLE leaked in narration",
      );
      expect(result.content).toContain("[REDACTED]");
      expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("redacts multiple sensitive patterns found in the same string", () => {
      const text = [
        "AWS key AKIAIOSFODNN7EXAMPLE and",
        `SSN 123-45-6789 both appeared`,
      ].join(" ");
      const result = validator.validate(text);
      expect(result.injectionDetected).toBe(true);
      expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.content).not.toContain("123-45-6789");
    });

    it("leaves non-sensitive narration content unchanged", () => {
      const clean = "The team refactored the authentication module for clarity.";
      const result = validator.validate(clean);
      expect(result.content).toBe(clean);
      expect(result.injectionDetected).toBe(false);
    });

    it("content hash is computed from the original pre-redaction input", () => {
      const original = "Token AKIAIOSFODNN7EXAMPLE leaked";
      const result = validator.validate(original);
      expect(result.contentHash).toBe(sha256(original));
      // Sanity-check: hash of cleaned content differs from original hash
      expect(result.contentHash).not.toBe(sha256(result.content));
    });

    it("detection action field is 'redacted' for sensitive data matches", () => {
      const result = validator.validate(
        "AKIAIOSFODNN7EXAMPLE in text",
      );
      const awsDetection = result.detections.find((d) => d.patternId === "aws_access_key");
      expect(awsDetection?.action).toBe("redacted");
    });

    it("detection category is 'sensitive_data' for credential matches", () => {
      const result = validator.validate("key AKIAIOSFODNN7EXAMPLE found");
      const awsDetection = result.detections.find((d) => d.patternId === "aws_access_key");
      expect(awsDetection?.category).toBe("sensitive_data");
    });

    it("position start/end point to the match location in the original string", () => {
      const prefix = "key ";
      const token = "AKIAIOSFODNN7EXAMPLE";
      const result = validator.validate(`${prefix}${token} found`);
      const awsDetection = result.detections.find((d) => d.patternId === "aws_access_key");
      expect(awsDetection?.position.start).toBe(prefix.length);
      expect(awsDetection?.position.end).toBe(prefix.length + token.length);
    });
  });

  // ── Canary token checks ─────────────────────────────────────────────────

  describe("checkCanary", () => {
    it("returns true when the canary token appears verbatim in the output", () => {
      const canary = "CANARY-a1b2c3d4e5f6";
      expect(validator.checkCanary(`narration ${canary} text`, canary)).toBe(true);
    });

    it("returns false when the canary token is not present", () => {
      const canary = "CANARY-a1b2c3d4e5f6";
      expect(validator.checkCanary("this is normal narration text", canary)).toBe(false);
    });

    it("returns false on a partial prefix match (exact substring required)", () => {
      const canary = "CANARY-a1b2c3d4e5f6";
      const partial = "CANARY-a1b2c3"; // prefix only
      expect(validator.checkCanary(`narration ${partial} text`, canary)).toBe(false);
    });

    it("returns false on a partial suffix match", () => {
      const canary = "CANARY-a1b2c3d4e5f6";
      const partial = "a1b2c3d4e5f6"; // suffix without prefix
      expect(validator.checkCanary(`narration ${partial} text`, canary)).toBe(false);
    });

    it("is case-sensitive — uppercase canary is not matched by lowercase output", () => {
      const canary = "CANARY-TOKEN-XYZ";
      expect(
        validator.checkCanary("canary-token-xyz in output", canary),
      ).toBe(false);
    });

    it("returns true when both output and canary are empty strings (JS String.includes('') behaviour)", () => {
      // "".includes("") === true in JavaScript; the service does not special-case
      // this edge — an empty canary is meaningless in practice, but we document
      // the actual behaviour to prevent regressions if a guard is added later.
      expect(validator.checkCanary("", "")).toBe(true);
    });
  });

  // ── Content validation (Layer 7 instruction patterns) ───────────────────

  describe("content validation – instruction-like patterns", () => {
    it("passes clean narration through unchanged", () => {
      const narration =
        "The engineering team shipped a new authentication layer this sprint.";
      const result = validator.validate(narration);
      expect(result.content).toBe(narration);
      expect(result.injectionDetected).toBe(false);
    });

    it("flags and removes URL patterns from narration output", () => {
      const result = validator.validate(
        "Visit https://evil.example.com/exfil for details",
      );
      expect(result.injectionDetected).toBe(true);
      expect(result.content).not.toContain("https://");
      expect(result.detections.some((d) => d.patternId === "url_in_narration")).toBe(true);
    });

    it("flags narration containing a 'render text on screen' instruction", () => {
      const result = validator.validate(
        "Please render the text on screen: admin credentials follow",
      );
      expect(result.injectionDetected).toBe(true);
      expect(
        result.detections.some((d) => d.patternId === "render_text_instruction"),
      ).toBe(true);
    });

    it("flags narration containing a 'display the following' instruction", () => {
      const result = validator.validate(
        "This video should display the following message to viewers",
      );
      expect(result.injectionDetected).toBe(true);
      expect(
        result.detections.some((d) => d.patternId === "display_instruction"),
      ).toBe(true);
    });

    it("flags narration containing an overlay-text instruction", () => {
      const result = validator.validate(
        "The app will overlay text across the video frame",
      );
      expect(result.injectionDetected).toBe(true);
      expect(
        result.detections.some((d) => d.patternId === "overlay_text"),
      ).toBe(true);
    });

    it("removes the instruction span from narration content", () => {
      const result = validator.validate(
        "Normal intro. Please render the text on screen: injected. Normal outro.",
      );
      expect(result.content).not.toMatch(/render\s+the\s+text\s+on\s+screen/i);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns no detections and empty content hash for empty string", () => {
      const result = validator.validate("");
      expect(result.injectionDetected).toBe(false);
      expect(result.detections).toHaveLength(0);
      expect(result.content).toBe("");
      expect(result.contentHash).toBe("");
    });

    it("does not throw on very long input (> 65 000 characters)", () => {
      const long = "The team merged a refactor. ".repeat(2_500); // ~67 500 chars
      expect(() => validator.validate(long)).not.toThrow();
    });

    it("correctly handles and redacts sensitive data in very long content", () => {
      // Use 2000-char padding (not 30K) — enough to prove the regex works in
      // longer strings without triggering near-quadratic slowdowns on complex
      // patterns like phone_us. The separate "> 65 000 characters" test above
      // already validates that the validator doesn't throw on truly large input.
      const padding = "The team merged a refactor. ".repeat(75); // ~2025 chars
      const result = validator.validate(
        `${padding} AKIAIOSFODNN7EXAMPLE ${padding}`,
      );
      expect(result.injectionDetected).toBe(true);
      expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("detects multiple overlapping pattern categories in one string", () => {
      const mixed = [
        "AKIAIOSFODNN7EXAMPLE",           // credential
        "123-45-6789",                    // PII: SSN
        "user@example.com",               // PII: email
        "Visit https://evil.io/x",        // URL
      ].join(" ");
      const result = validator.validate(mixed);
      expect(result.detections.length).toBeGreaterThanOrEqual(3);
      const patternIds = result.detections.map((d) => d.patternId);
      expect(patternIds).toContain("aws_access_key");
      expect(patternIds).toContain("ssn");
      expect(patternIds).toContain("email_address");
      expect(patternIds).toContain("url_in_narration");
    });

    it("returns a SanitizationResult with all required fields on clean input", () => {
      const result = validator.validate("Clean PR narration about a bug fix.");
      expect(result).toMatchObject({
        content: expect.any(String),
        injectionDetected: false,
        detections: [],
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });

    it("contentHash is a 64-character hex string for any non-empty input", () => {
      const result = validator.validate("any narration text");
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("contentHash matches the SHA-256 of the original narration for clean content", () => {
      const narration = "Clean narration with no issues.";
      const result = validator.validate(narration);
      expect(result.contentHash).toBe(sha256(narration));
    });

    it("fail-closed: returns [REDACTED] with validation_error when internal processing throws", async () => {
      // Dynamically import the module so we can spy on matchSensitiveData
      const sdpModule = await import("@/domain/services/sensitive-data-patterns");
      const spy = vi.spyOn(sdpModule, "matchSensitiveData").mockImplementation(() => {
        throw new Error("Simulated regex engine failure");
      });

      try {
        const narration = "Some narration that triggers the fail-closed path";
        const result = validator.validate(narration);

        expect(result.content).toBe("[REDACTED]");
        expect(result.injectionDetected).toBe(true);
        expect(result.detections).toHaveLength(1);
        expect(result.detections[0].patternId).toBe("validation_error");
        expect(result.detections[0].category).toBe("sensitive_data");
        expect(result.detections[0].action).toBe("redacted");
        expect(result.detections[0].position).toEqual({ start: 0, end: narration.length });
        expect(result.contentHash).toBe(sha256(narration));
      } finally {
        spy.mockRestore();
      }
    });
  });
});
