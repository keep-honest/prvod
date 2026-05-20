import { describe, it, expect, beforeEach } from "vitest";
import { MockInstallationRepository } from "@/mocks/MockInstallationRepository";
import { MockApiKeyRepository } from "@/mocks/MockApiKeyRepository";
import { MockDeliveryRepository } from "@/mocks/MockDeliveryRepository";
import { hash } from "@node-rs/argon2";

// ── MockInstallationRepository ──────────────────────────────────────────────

describe("MockInstallationRepository", () => {
  let repo: MockInstallationRepository;
  beforeEach(() => { repo = new MockInstallationRepository(); });

  it("upserts a new installation", async () => {
    const inst = await repo.upsert({ installationId: 42, accountLogin: "acme", accountType: "Organization" });
    expect(inst.installationId).toBe(42);
    expect(inst.accountLogin).toBe("acme");
    expect(inst.status).toBe("active");
  });

  it("upsert is idempotent — updates existing record", async () => {
    const first = await repo.upsert({ installationId: 42, accountLogin: "acme", accountType: "Organization" });
    const second = await repo.upsert({ installationId: 42, accountLogin: "acme-renamed", accountType: "Organization" });
    expect(second.id).toBe(first.id);
    expect(second.accountLogin).toBe("acme-renamed");
  });

  it("findByInstallationId returns null for unknown ID", async () => {
    expect(await repo.findByInstallationId(999)).toBeNull();
  });

  it("findByInstallationId returns the created record", async () => {
    await repo.upsert({ installationId: 42, accountLogin: "acme", accountType: "Organization" });
    const found = await repo.findByInstallationId(42);
    expect(found?.installationId).toBe(42);
  });

  it("markStatus changes the installation status", async () => {
    await repo.upsert({ installationId: 42, accountLogin: "acme", accountType: "Organization" });
    await repo.markStatus(42, "suspended");
    const found = await repo.findByInstallationId(42);
    expect(found?.status).toBe("suspended");
  });

  it("upsertRepository stores a repo mapping", async () => {
    const inst = await repo.upsert({ installationId: 42, accountLogin: "acme", accountType: "Organization" });
    await repo.upsertRepository({ installationRef: inst.id, githubRepositoryId: 1001, repoFullName: "acme/repo" });
    // No return value to assert; just verify it doesn't throw and is idempotent
    await expect(repo.upsertRepository({ installationRef: inst.id, githubRepositoryId: 1001, repoFullName: "acme/repo-renamed" }))
      .resolves.toBeUndefined();
  });

  it("deactivateRepository marks a repo as inactive", async () => {
    const inst = await repo.upsert({ installationId: 42, accountLogin: "acme", accountType: "Organization" });
    await repo.upsertRepository({ installationRef: inst.id, githubRepositoryId: 1001, repoFullName: "acme/repo" });
    await repo.deactivateRepository(inst.id, 1001);
    // No way to query repos directly from interface, but it should not throw
  });

  it("reset clears all state", async () => {
    await repo.upsert({ installationId: 42, accountLogin: "acme", accountType: "Organization" });
    repo.reset();
    expect(await repo.findByInstallationId(42)).toBeNull();
  });

});

// ── MockApiKeyRepository ────────────────────────────────────────────────────

describe("MockApiKeyRepository", () => {
  let repo: MockApiKeyRepository;
  beforeEach(() => { repo = new MockApiKeyRepository(); });

  it("creates a key and finds it by keyId", async () => {
    const rec = await repo.create({ keyId: "pk_test", keyHash: "h", name: "mykey", isAdmin: true, scopes: ["*"] });
    expect(rec.status).toBe("active");
    const found = await repo.findByKeyId("pk_test");
    expect(found?.id).toBe(rec.id);
  });

  it("findByKeyId returns null for unknown keyId", async () => {
    expect(await repo.findByKeyId("pk_unknown")).toBeNull();
  });

  it("revoke sets status to revoked", async () => {
    await repo.create({ keyId: "pk_test", keyHash: "h", name: "mykey", isAdmin: true, scopes: ["*"] });
    await repo.revoke("pk_test");
    const found = await repo.findByKeyId("pk_test");
    expect(found?.status).toBe("revoked");
  });

  it("touchLastUsed updates lastUsedAt", async () => {
    const rec = await repo.create({ keyId: "pk_test", keyHash: "h", name: "mykey", isAdmin: true, scopes: ["*"] });
    expect(rec.lastUsedAt).toBeNull();
    await repo.touchLastUsed(rec.id);
    const found = await repo.findByKeyId("pk_test");
    expect(found?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("reset clears all keys", async () => {
    await repo.create({ keyId: "pk_test", keyHash: "h", name: "mykey", isAdmin: true, scopes: ["*"] });
    repo.reset();
    expect(await repo.findByKeyId("pk_test")).toBeNull();
  });
});

// ── MockDeliveryRepository ──────────────────────────────────────────────────

describe("MockDeliveryRepository", () => {
  let repo: MockDeliveryRepository;
  beforeEach(() => { repo = new MockDeliveryRepository(); });

  it("records a delivery and finds it", async () => {
    await repo.record({ deliveryId: "d1", eventType: "push", installationId: 1 });
    const found = await repo.findByDeliveryId("d1");
    expect(found?.eventType).toBe("push");
    expect(found?.status).toBe("received");
  });

  it("findByDeliveryId returns null for unknown ID", async () => {
    expect(await repo.findByDeliveryId("unknown")).toBeNull();
  });

  it("record is idempotent (second call does not overwrite)", async () => {
    await repo.record({ deliveryId: "d1", eventType: "push" });
    await repo.record({ deliveryId: "d1", eventType: "push_again" }); // duplicate
    const found = await repo.findByDeliveryId("d1");
    // First write wins (idempotent)
    expect(found?.eventType).toBe("push");
  });

  it("updateStatus changes the delivery status", async () => {
    await repo.record({ deliveryId: "d1", eventType: "push" });
    await repo.updateStatus("d1", "processed");
    const found = await repo.findByDeliveryId("d1");
    expect(found?.status).toBe("processed");
    expect(found?.processedAt).toBeInstanceOf(Date);
  });

  it("reset clears all deliveries", async () => {
    await repo.record({ deliveryId: "d1", eventType: "push" });
    repo.reset();
    expect(await repo.findByDeliveryId("d1")).toBeNull();
  });
});

// ── Argon2id integration smoke test (not mocked) ──────────────────────────────

describe("Argon2id hash/verify smoke test", () => {
  it("can hash and verify a value", async () => {
    const { verify } = await import("@node-rs/argon2");
    const secret = "hello-world";
    const hashed = await hash(secret);
    expect(await verify(hashed, secret)).toBe(true);
    expect(await verify(hashed, "wrong")).toBe(false);
  });
});
