export interface ApiKeyRecord {
  id: string;
  keyId: string;
  keyHash: string;
  name: string;
  isAdmin: boolean;
  installationRef: string | null;
  scopes: string[];
  status: "active" | "in_use" | "consumed" | "revoked";
  lastUsedAt: Date | null;
  createdAt: Date;
  maxUses: number | null;
  usesCount: number;
  currentJobId: string | null;
  label: string | null;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

export interface IApiKeyRepository {
  /** Look up a key by its public keyId prefix. */
  findByKeyId(keyId: string): Promise<ApiKeyRecord | null>;

  /** Asynchronously update last_used_at (fire-and-forget in auth flow). */
  touchLastUsed(id: string): Promise<void>;

  create(input: {
    keyId: string;
    keyHash: string;
    name: string;
    isAdmin: boolean;
    scopes: string[];
    installationRef?: string;
    maxUses?: number;
    label?: string;
  }): Promise<ApiKeyRecord>;

  revoke(keyId: string): Promise<void>;

  /** List all one-time keys (where maxUses IS NOT NULL). */
  findOneTimeKeys(): Promise<ApiKeyRecord[]>;

  /**
   * Atomically claim a one-time key for a job.
   * Transitions status from 'active' to 'in_use' and sets currentJobId.
   * Returns true if the claim succeeded, false if the key was already in-use/consumed/revoked.
   */
  claimForJob(keyId: string, jobId: string): Promise<boolean>;

  /**
   * Release a one-time key after a failed job.
   * Transitions status from 'in_use' back to 'active' and clears currentJobId.
   * Returns true if the release succeeded (row was updated), false if no matching row found.
   */
  releaseFromJob(keyId: string): Promise<boolean>;

  /**
   * Consume a one-time key after a successful job.
   * Transitions status from 'in_use' to 'consumed', increments usesCount, sets consumedAt.
   * Returns true if the consumption succeeded (row was updated), false if no matching row found.
   */
  consumeKey(keyId: string): Promise<boolean>;

  /**
   * Release all one-time keys stuck in 'in_use' whose currentJobId points to
   * a terminal job (failed/completed/cancelled). Called on startup after reaping
   * stale jobs to recover keys from process crashes.
   * Returns the number of keys released.
   */
  releaseOrphanedKeys(): Promise<number>;
}
