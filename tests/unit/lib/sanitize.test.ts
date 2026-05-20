import { describe, it, expect } from "vitest";
import { sanitizeErrorBody } from "@/lib/sanitize";

describe("sanitizeErrorBody", () => {
  it("truncates text to maxLen", () => {
    const long = "a".repeat(500);
    expect(sanitizeErrorBody(long)).toHaveLength(200);
  });

  it("respects custom maxLen", () => {
    expect(sanitizeErrorBody("a".repeat(100), 50)).toHaveLength(50);
  });

  it("redacts classic PAT (ghp_)", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(sanitizeErrorBody(`Error: ${token} is invalid`)).toContain("[REDACTED]");
    expect(sanitizeErrorBody(`Error: ${token} is invalid`)).not.toContain("ghp_");
  });

  it("redacts GitHub App token (ghs_)", () => {
    const token = "ghs_" + "B".repeat(36);
    expect(sanitizeErrorBody(`token: ${token}`)).toContain("[REDACTED]");
    expect(sanitizeErrorBody(`token: ${token}`)).not.toContain("ghs_");
  });

  it("redacts user-to-server token (ghu_)", () => {
    const token = "ghu_" + "D".repeat(36);
    expect(sanitizeErrorBody(`token: ${token}`)).toContain("[REDACTED]");
    expect(sanitizeErrorBody(`token: ${token}`)).not.toContain("ghu_");
  });

  it("redacts org token (gho_)", () => {
    const token = "gho_" + "E".repeat(36);
    expect(sanitizeErrorBody(`token: ${token}`)).toContain("[REDACTED]");
    expect(sanitizeErrorBody(`token: ${token}`)).not.toContain("gho_");
  });

  it("redacts fine-grained PAT (github_pat_)", () => {
    const token = "github_pat_" + "c".repeat(82);
    const result = sanitizeErrorBody(token, 200);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("github_pat_");
  });

  it("redacts Bearer tokens", () => {
    const result = sanitizeErrorBody("Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5.payload.sig");
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("eyJhbGci");
  });

  it("returns short text unchanged when no tokens present", () => {
    expect(sanitizeErrorBody("Not Found")).toBe("Not Found");
  });

  it("redacts tokens that would straddle the truncation boundary", () => {
    // Place a token starting near position 190 — would be split by a 200-char truncation
    const prefix = "x".repeat(190);
    const token = "ghp_" + "a".repeat(36);
    const result = sanitizeErrorBody(prefix + token, 200);
    expect(result).not.toContain("ghp_");
  });
});
