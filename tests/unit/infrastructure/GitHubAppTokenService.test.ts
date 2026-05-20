import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { generateKeyPairSync } from "crypto";
import { GitHubAppTokenService } from "@/infrastructure/github/GitHubAppTokenService";

// Generate a real RSA key pair once for all tests in this file
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const TEST_APP_ID = "12345";
const TEST_INSTALLATION_ID = 999;
const FAKE_TOKEN = "ghs_fakeTOKEN";

// Helper: build a minimal GitHub token response
function mockTokenResponse(expiresAt: string = new Date(Date.now() + 3600 * 1000).toISOString()) {
  return Response.json({ token: FAKE_TOKEN, expires_at: expiresAt });
}

describe("GitHubAppTokenService", () => {
  let service: GitHubAppTokenService;
  let fetchSpy: MockInstance<typeof globalThis.fetch>;

  beforeEach(() => {
    process.env.GITHUB_APP_ID = TEST_APP_ID;
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    service = new GitHubAppTokenService();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(mockTokenResponse()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  describe("getToken", () => {
    it("returns a token from the GitHub API", async () => {
      const token = await service.getToken(TEST_INSTALLATION_ID);
      expect(token).toBe(FAKE_TOKEN);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("sends a well-formed JWT in the Authorization header", async () => {
      await service.getToken(TEST_INSTALLATION_ID);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toContain(`/installations/${TEST_INSTALLATION_ID}/access_tokens`);
      const authHeader = (init as RequestInit).headers as Record<string, string>;
      const bearerJwt = authHeader["Authorization"]?.replace("Bearer ", "") ?? authHeader["authorization"]?.replace("Bearer ", "") ?? "";
      const parts = bearerJwt.split(".");
      expect(parts).toHaveLength(3);

      // Validate header
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");

      // Validate payload
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      expect(payload.iss).toBe(TEST_APP_ID);
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    it("caches the token and avoids a second API call", async () => {
      const t1 = await service.getToken(TEST_INSTALLATION_ID);
      const t2 = await service.getToken(TEST_INSTALLATION_ID);
      expect(t1).toBe(t2);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("re-fetches after evict()", async () => {
      await service.getToken(TEST_INSTALLATION_ID);
      service.evict(TEST_INSTALLATION_ID);
      await service.getToken(TEST_INSTALLATION_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("normalises literal \\n in PEM key", async () => {
      // Replace real newlines with literal \n (as stored in env var)
      const pemWithLiteralNewlines = TEST_PRIVATE_KEY.replace(/\n/g, "\\n");
      process.env.GITHUB_APP_PRIVATE_KEY = pemWithLiteralNewlines;
      const svc = new GitHubAppTokenService();
      // Should not throw — normalisation handles it
      await expect(svc.getToken(TEST_INSTALLATION_ID)).resolves.toBe(FAKE_TOKEN);
    });

    it("throws when GITHUB_APP_ID is not set", () => {
      delete process.env.GITHUB_APP_ID;
      expect(() => new GitHubAppTokenService()).toThrow("GITHUB_APP_ID");
    });

    it("throws when GITHUB_APP_PRIVATE_KEY is not set", () => {
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      expect(() => new GitHubAppTokenService()).toThrow("GITHUB_APP_PRIVATE_KEY");
    });

    it("caches separately for different installation IDs", async () => {
      await service.getToken(100);
      await service.getToken(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("evict", () => {
    it("silently succeeds for unknown installation IDs", () => {
      expect(() => service.evict(999999)).not.toThrow();
    });
  });
});
