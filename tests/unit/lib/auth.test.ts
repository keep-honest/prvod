import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IApiKeyRepository, ApiKeyRecord } from "@/interfaces/IApiKeyRepository";
import { validateBearerToken, deriveLegacyApiKeyId, unauthorizedResponse } from "@/lib/auth";

// Mock the dynamic import of @node-rs/argon2
vi.mock("@node-rs/argon2", () => ({
  verify: vi.fn(),
}));

// Minimal NextRequest-compatible stub (auth only uses .headers.get)
function makeRequest(authHeader?: string) {
  return {
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "authorization" && authHeader) return authHeader;
        return null;
      },
    },
  } as unknown as import("next/server").NextRequest;
}

function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: "rec-1",
    keyId: "pk_abc123",
    keyHash: "stored-hash",
    name: "test-key",
    isAdmin: true,
    installationRef: null,
    scopes: ["*"],
    status: "active",
    lastUsedAt: null,
    createdAt: new Date(),
    maxUses: null,
    usesCount: 0,
    currentJobId: null,
    label: null,
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeRepo(record: ApiKeyRecord | null = null): IApiKeyRepository {
  return {
    findByKeyId: vi.fn().mockResolvedValue(record),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    revoke: vi.fn(),
    findOneTimeKeys: vi.fn().mockResolvedValue([]),
    claimForJob: vi.fn().mockResolvedValue(false),
    releaseFromJob: vi.fn().mockResolvedValue(false),
    consumeKey: vi.fn().mockResolvedValue(false),
    releaseOrphanedKeys: vi.fn().mockResolvedValue(0),
  };
}

describe("validateBearerToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_SECRET_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
  });

  it("returns UNAUTHORIZED when Authorization header is missing", async () => {
    const result = await validateBearerToken(makeRequest(), makeRepo());
    expect(result.error?.error).toBe("UNAUTHORIZED");
    expect(result.auth).toBeNull();
  });

  it("returns UNAUTHORIZED when Authorization header is not Bearer", async () => {
    const result = await validateBearerToken(makeRequest("Basic abc123"), makeRepo());
    expect(result.error?.error).toBe("UNAUTHORIZED");
    expect(result.auth).toBeNull();
  });

  // ── Legacy path (no dot separator) ───────────────────────────────────────

  describe("legacy path (plain token, no dot)", () => {
    it("returns auth context when token matches API_SECRET_KEY and DB record verifies", async () => {
      process.env.API_SECRET_KEY = "mysecret";
      const repo = makeRepo(makeRecord({ keyId: deriveLegacyApiKeyId("mysecret"), isAdmin: true }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);

      const result = await validateBearerToken(makeRequest("Bearer mysecret"), repo);
      expect(result.error).toBeNull();
      expect(result.auth?.source).toBe("legacy_env");
      expect(result.auth?.isAdmin).toBe(true);
    });

    it("returns UNAUTHORIZED and never hits the DB when token does not match API_SECRET_KEY", async () => {
      process.env.API_SECRET_KEY = "mysecret";
      const repo = makeRepo();
      const result = await validateBearerToken(makeRequest("Bearer wrongsecret"), repo);
      expect(result.error?.error).toBe("UNAUTHORIZED");
      expect(result.auth).toBeNull();
      expect(repo.findByKeyId).not.toHaveBeenCalled();
    });

    it("returns UNAUTHORIZED and never hits the DB when API_SECRET_KEY env var is not set", async () => {
      const repo = makeRepo();
      const result = await validateBearerToken(makeRequest("Bearer anysecret"), repo);
      expect(result.error?.error).toBe("UNAUTHORIZED");
      expect(result.auth).toBeNull();
      expect(repo.findByKeyId).not.toHaveBeenCalled();
    });

    it("returns SERVICE_UNAVAILABLE when Argon2 verify throws on legacy path", async () => {
      process.env.API_SECRET_KEY = "mysecret";
      const repo = makeRepo(makeRecord({ keyId: deriveLegacyApiKeyId("mysecret"), status: "active" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockRejectedValue(new Error("native module missing"));
      const result = await validateBearerToken(makeRequest("Bearer mysecret"), repo);
      expect(result.error?.error).toBe("SERVICE_UNAVAILABLE");
      expect(result.auth).toBeNull();
    });

    it("looks up deterministic legacy keyId in DB", async () => {
      process.env.API_SECRET_KEY = "mysecret";
      const repo = makeRepo(makeRecord({ keyId: deriveLegacyApiKeyId("mysecret"), isAdmin: true }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      await validateBearerToken(makeRequest("Bearer mysecret"), repo);
      expect(repo.findByKeyId).toHaveBeenCalledWith(deriveLegacyApiKeyId("mysecret"));
    });
  });

  // ── New path (keyId.secret format) ───────────────────────────────────────

  describe("new path (keyId.secret format)", () => {
    it("returns UNAUTHORIZED when key not found in DB", async () => {
      const repo = makeRepo(null);
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("UNAUTHORIZED");
      expect(result.auth).toBeNull();
      expect(repo.findByKeyId).toHaveBeenCalledWith("pk_abc123");
    });

    it("returns UNAUTHORIZED when key is revoked", async () => {
      const repo = makeRepo(makeRecord({ status: "revoked" }));
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("UNAUTHORIZED");
      expect(result.auth).toBeNull();
    });

    it("returns UNAUTHORIZED when Argon2id verify returns false", async () => {
      const repo = makeRepo(makeRecord({ status: "active" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(false);
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("UNAUTHORIZED");
      expect(result.auth).toBeNull();
    });

    it("returns auth context and fires touchLastUsed on success", async () => {
      const record = makeRecord();
      const repo = makeRepo(record);
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error).toBeNull();
      expect(result.auth?.keyId).toBe("pk_abc123");
      expect(result.auth?.source).toBe("db");
      // touchLastUsed is fire-and-forget; give the microtask queue a tick
      await new Promise((r) => setTimeout(r, 0));
      expect(repo.touchLastUsed).toHaveBeenCalledWith("rec-1");
    });

    it("passes (pepper + secret) to Argon2id verify", async () => {
      process.env.APP_ENCRYPTION_KEY = "mypepper";
      const repo = makeRepo(makeRecord({ keyHash: "thehash" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(verify).toHaveBeenCalledWith("thehash", "mypepperthesecret");
    });

    it("uses empty string pepper when APP_ENCRYPTION_KEY is not set", async () => {
      const repo = makeRepo(makeRecord());
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(verify).toHaveBeenCalledWith("stored-hash", "thesecret");
    });

    it("returns SERVICE_UNAVAILABLE when Argon2 verify throws", async () => {
      const repo = makeRepo(makeRecord({ status: "active" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockRejectedValue(new Error("native module missing"));
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("SERVICE_UNAVAILABLE");
      expect(result.auth).toBeNull();
    });

    it("extracts keyId correctly when secret contains dots", async () => {
      const repo = makeRepo(makeRecord({ keyId: "pk_abc" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      // Token: "pk_abc.secret.with.dots" — keyId is "pk_abc", secret is "secret.with.dots"
      await validateBearerToken(makeRequest("Bearer pk_abc.secret.with.dots"), repo);
      expect(repo.findByKeyId).toHaveBeenCalledWith("pk_abc");
      expect(verify).toHaveBeenCalledWith("stored-hash", "secret.with.dots");
    });
  });

  // ── One-time key specific auth behavior ──────────────────────────────

  describe("one-time key status enforcement", () => {
    it("rejects a consumed one-time key by default", async () => {
      const repo = makeRepo(makeRecord({ maxUses: 1, status: "consumed" }));
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("KEY_CONSUMED");
      expect(result.auth).toBeNull();
    });

    it("rejects an in_use one-time key by default", async () => {
      const repo = makeRepo(makeRecord({ maxUses: 1, status: "in_use", currentJobId: "job-1" }));
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("KEY_IN_USE");
      expect(result.auth).toBeNull();
    });

    it("allows a consumed one-time key when allowNonActiveOneTimeKey is set", async () => {
      const repo = makeRepo(makeRecord({ maxUses: 1, status: "consumed" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      const result = await validateBearerToken(
        makeRequest("Bearer pk_abc123.thesecret"), repo, { allowNonActiveOneTimeKey: true },
      );
      expect(result.error).toBeNull();
      expect(result.auth?.status).toBe("consumed");
    });

    it("allows an in_use one-time key when allowNonActiveOneTimeKey is set", async () => {
      const repo = makeRepo(makeRecord({ maxUses: 1, status: "in_use", currentJobId: "job-1" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      const result = await validateBearerToken(
        makeRequest("Bearer pk_abc123.thesecret"), repo, { allowNonActiveOneTimeKey: true },
      );
      expect(result.error).toBeNull();
      expect(result.auth?.status).toBe("in_use");
    });

    it("returns KEY_REVOKED for a revoked one-time key", async () => {
      const repo = makeRepo(makeRecord({ maxUses: 1, status: "revoked" }));
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("KEY_REVOKED");
      expect(result.auth).toBeNull();
    });

    it("allows an active one-time key through and returns auth with maxUses", async () => {
      const repo = makeRepo(makeRecord({ maxUses: 1, status: "active" }));
      const { verify } = await import("@node-rs/argon2");
      vi.mocked(verify).mockResolvedValue(true);
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error).toBeNull();
      expect(result.auth?.maxUses).toBe(1);
      expect(result.auth?.status).toBe("active");
    });

    it("rejects a regular key with in_use status", async () => {
      const repo = makeRepo(makeRecord({ maxUses: null, status: "in_use" as "active" }));
      const result = await validateBearerToken(makeRequest("Bearer pk_abc123.thesecret"), repo);
      expect(result.error?.error).toBe("UNAUTHORIZED");
      expect(result.auth).toBeNull();
    });
  });
});

describe("unauthorizedResponse", () => {
  it("returns 401 for UNAUTHORIZED errors", () => {
    const res = unauthorizedResponse({ error: "UNAUTHORIZED", message: "bad token" });
    expect(res.status).toBe(401);
  });

  it("returns 503 for SERVICE_UNAVAILABLE errors", () => {
    const res = unauthorizedResponse({ error: "SERVICE_UNAVAILABLE", message: "argon2 down" });
    expect(res.status).toBe(503);
  });

  it("returns 429 for KEY_IN_USE errors", () => {
    const res = unauthorizedResponse({ error: "KEY_IN_USE", message: "in use" });
    expect(res.status).toBe(429);
  });

  it("returns 403 for KEY_CONSUMED errors", () => {
    const res = unauthorizedResponse({ error: "KEY_CONSUMED", message: "consumed" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for KEY_REVOKED errors", () => {
    const res = unauthorizedResponse({ error: "KEY_REVOKED", message: "revoked" });
    expect(res.status).toBe(403);
  });
});
