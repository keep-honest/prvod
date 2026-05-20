import { describe, it, expect } from "vitest";
import { prContextSchema } from "@/domain/entities/PRContext";

describe("prContextSchema", () => {
  const validBase = {
    repoFullName: "owner/repo",
    prNumber: 1,
    prTitle: "Test",
    diffSource: { kind: "github_pr" as const, repoFullName: "owner/repo", prNumber: 1, installationId: 1 },
    baseBranch: "main",
    headBranch: "feature",
    isPrivate: false,
  };

  describe("durationMode field", () => {
    it("accepts durationMode 'short'", () => {
      const result = prContextSchema.safeParse({ ...validBase, durationMode: "short" });
      expect(result.success).toBe(true);
    });

    it("accepts durationMode 'default'", () => {
      const result = prContextSchema.safeParse({ ...validBase, durationMode: "default" });
      expect(result.success).toBe(true);
    });

    it("defaults durationMode to 'default' when omitted", () => {
      const result = prContextSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.durationMode).toBe("default");
      }
    });

    it('accepts durationMode "popcorn"', () => {
      const result = prContextSchema.safeParse({ ...validBase, durationMode: "popcorn" });
      expect(result.success).toBe(true);
    });

    it("rejects invalid durationMode", () => {
      const result = prContextSchema.safeParse({ ...validBase, durationMode: "long" });
      expect(result.success).toBe(false);
    });
  });

  describe("deepdive field", () => {
    it("defaults deepdive to false when omitted", () => {
      const result = prContextSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deepdive).toBe(false);
      }
    });

    it("accepts deepdive true", () => {
      const result = prContextSchema.safeParse({ ...validBase, deepdive: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deepdive).toBe(true);
      }
    });
  });
});
