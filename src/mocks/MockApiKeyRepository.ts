import type { IApiKeyRepository, ApiKeyRecord } from "@/interfaces/IApiKeyRepository";
import { randomUUID } from "crypto";

export class MockApiKeyRepository implements IApiKeyRepository {
  private keys: ApiKeyRecord[] = [];

  async findByKeyId(keyId: string): Promise<ApiKeyRecord | null> {
    return this.keys.find((k) => k.keyId === keyId) ?? null;
  }

  async touchLastUsed(id: string): Promise<void> {
    const key = this.keys.find((k) => k.id === id);
    if (key) key.lastUsedAt = new Date();
  }

  async create(input: {
    keyId: string;
    keyHash: string;
    name: string;
    isAdmin: boolean;
    scopes: string[];
    installationRef?: string;
    maxUses?: number;
    label?: string;
  }): Promise<ApiKeyRecord> {
    const record: ApiKeyRecord = {
      id: randomUUID(),
      keyId: input.keyId,
      keyHash: input.keyHash,
      name: input.name,
      isAdmin: input.isAdmin,
      installationRef: input.installationRef ?? null,
      scopes: input.scopes,
      status: "active",
      lastUsedAt: null,
      createdAt: new Date(),
      maxUses: input.maxUses ?? null,
      usesCount: 0,
      currentJobId: null,
      label: input.label ?? null,
      consumedAt: null,
      revokedAt: null,
    };
    this.keys.push(record);
    return record;
  }

  async revoke(keyId: string): Promise<void> {
    const key = this.keys.find((k) => k.keyId === keyId);
    if (key) {
      key.status = "revoked";
      key.revokedAt = new Date();
      key.currentJobId = null;
    }
  }

  async findOneTimeKeys(): Promise<ApiKeyRecord[]> {
    return this.keys.filter((k) => k.maxUses !== null);
  }

  async claimForJob(keyId: string, jobId: string): Promise<boolean> {
    const key = this.keys.find(
      (k) => k.keyId === keyId && k.status === "active" && k.maxUses !== null,
    );
    if (!key) return false;
    key.status = "in_use";
    key.currentJobId = jobId;
    return true;
  }

  async releaseFromJob(keyId: string): Promise<boolean> {
    const key = this.keys.find(
      (k) => k.keyId === keyId && k.status === "in_use",
    );
    if (!key) return false;
    key.status = "active";
    key.currentJobId = null;
    return true;
  }

  async consumeKey(keyId: string): Promise<boolean> {
    const key = this.keys.find(
      (k) => k.keyId === keyId && k.status === "in_use",
    );
    if (!key) return false;
    key.status = "consumed";
    key.currentJobId = null;
    key.usesCount += 1;
    key.consumedAt = new Date();
    return true;
  }

  async releaseOrphanedKeys(): Promise<number> {
    // In mock, we don't have the job repository to check terminal status,
    // so this is a simplified version that releases all in_use one-time keys.
    let count = 0;
    for (const key of this.keys) {
      if (key.status === "in_use" && key.maxUses !== null) {
        key.status = "active";
        key.currentJobId = null;
        count++;
      }
    }
    return count;
  }

  /** Test helper */
  reset(): void {
    this.keys = [];
  }

  /** Test helper — direct access to internal state */
  getKeys(): ApiKeyRecord[] {
    return this.keys;
  }
}
