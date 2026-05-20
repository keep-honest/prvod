import { describe, it, expect, vi, afterEach } from "vitest";
import { signToken, verifyToken, makeShareUrl } from "@/lib/shareToken";
import type { ShareTokenPayload } from "@/lib/shareToken";

const SECRET = "test-secret-that-is-at-least-32-chars-long-ok";
const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";

function futureExp(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function pastExp(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) - seconds;
}

describe("shareToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("signToken + verifyToken round-trip", () => {
    it("signs and verifies a full share token", () => {
      const payload: ShareTokenPayload = {
        jobId: JOB_ID,
        type: "full",
        exp: futureExp(),
      };
      const token = signToken(payload, SECRET);
      const result = verifyToken(token, SECRET);
      expect(result).toEqual(payload);
    });

    it("signs and verifies a video share token", () => {
      const payload: ShareTokenPayload = {
        jobId: JOB_ID,
        type: "video",
        exp: futureExp(),
      };
      const token = signToken(payload, SECRET);
      const result = verifyToken(token, SECRET);
      expect(result).toEqual(payload);
    });
  });

  describe("verifyToken rejects invalid tokens", () => {
    it("rejects expired token", () => {
      const payload: ShareTokenPayload = {
        jobId: JOB_ID,
        type: "video",
        exp: pastExp(120), // 2 minutes ago (beyond 60s clock skew tolerance)
      };
      const token = signToken(payload, SECRET);
      expect(verifyToken(token, SECRET)).toBeNull();
    });

    it("accepts token within clock skew tolerance (60s)", () => {
      const payload: ShareTokenPayload = {
        jobId: JOB_ID,
        type: "video",
        exp: pastExp(30), // 30 seconds ago (within 60s tolerance)
      };
      const token = signToken(payload, SECRET);
      expect(verifyToken(token, SECRET)).toEqual(payload);
    });

    it("rejects tampered payload", () => {
      const payload: ShareTokenPayload = {
        jobId: JOB_ID,
        type: "video",
        exp: futureExp(),
      };
      const token = signToken(payload, SECRET);
      // Tamper with the payload part (first segment before the dot)
      const parts = token.split(".");
      const tamperedPayload = Buffer.from(
        JSON.stringify({ ...payload, jobId: "00000000-0000-0000-0000-000000000000" }),
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const tamperedToken = `${tamperedPayload}.${parts[1]}`;
      expect(verifyToken(tamperedToken, SECRET)).toBeNull();
    });

    it("rejects token signed with different secret", () => {
      const payload: ShareTokenPayload = {
        jobId: JOB_ID,
        type: "full",
        exp: futureExp(),
      };
      const token = signToken(payload, "wrong-secret-wrong-secret-wrong!");
      expect(verifyToken(token, SECRET)).toBeNull();
    });

    it("rejects token with invalid format (no dot)", () => {
      expect(verifyToken("nodothere", SECRET)).toBeNull();
    });

    it("rejects token with too many parts", () => {
      expect(verifyToken("a.b.c", SECRET)).toBeNull();
    });

    it("rejects token with invalid base64 payload", () => {
      expect(verifyToken("!!!invalid!!!.alsoInvalid", SECRET)).toBeNull();
    });

    it("rejects token with missing required fields", async () => {
      // Sign a payload missing `type`
      const badPayload = JSON.stringify({ jobId: JOB_ID, exp: futureExp() });
      const encoded = Buffer.from(badPayload)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      // Create valid signature for this bad payload
      const { createHmac } = await import("crypto");
      const sig = createHmac("sha256", SECRET)
        .update(encoded, "utf-8")
        .digest()
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      expect(verifyToken(`${encoded}.${sig}`, SECRET)).toBeNull();
    });
  });

  describe("makeShareUrl", () => {
    it("generates full walkthrough share URL", () => {
      const result = makeShareUrl(JOB_ID, "full", "https://prvod.dev", SECRET);
      expect(result.url).toContain(`/reviews/${JOB_ID}?shareToken=`);
      expect(result.url.startsWith("https://prvod.dev/reviews/")).toBe(true);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("generates video-only share URL", () => {
      const result = makeShareUrl(JOB_ID, "video", "https://prvod.dev", SECRET);
      expect(result.url).toContain(`/watch/${JOB_ID}?token=`);
      expect(result.url.startsWith("https://prvod.dev/watch/")).toBe(true);
    });

    it("strips trailing slash from baseUrl", () => {
      const result = makeShareUrl(JOB_ID, "video", "https://prvod.dev/", SECRET);
      expect(result.url.startsWith("https://prvod.dev/watch/")).toBe(true);
      expect(result.url).not.toContain("//watch");
    });

    it("generates token that passes verification", () => {
      const result = makeShareUrl(JOB_ID, "video", "https://prvod.dev", SECRET);
      const tokenParam = new URL(result.url).searchParams.get("token");
      expect(tokenParam).toBeTruthy();
      const payload = verifyToken(tokenParam as string, SECRET);
      expect(payload).not.toBeNull();
      expect(payload?.jobId).toBe(JOB_ID);
      expect(payload?.type).toBe("video");
    });

    it("sets expiry approximately 7 days in the future", () => {
      const before = Date.now();
      const result = makeShareUrl(JOB_ID, "video", "https://prvod.dev", SECRET);
      const after = Date.now();
      const sevenDaysMs = 7 * 24 * 3600 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
    });
  });
});
