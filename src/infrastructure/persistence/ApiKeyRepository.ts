import { eq, and, isNotNull, inArray, sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { apiKeys, videoJobs } from "@/infrastructure/persistence/schema";
import { createLogger } from "@/lib/logger";
import type { IApiKeyRepository, ApiKeyRecord } from "@/interfaces/IApiKeyRepository";

const logger = createLogger("ApiKeyRepository");

function rowToRecord(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
  return {
    id: row.id,
    keyId: row.keyId,
    keyHash: row.keyHash,
    name: row.name,
    isAdmin: row.isAdmin,
    installationRef: row.installationRef,
    scopes: row.scopes ?? [],
    status: row.status as ApiKeyRecord["status"],
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    maxUses: row.maxUses,
    usesCount: row.usesCount,
    currentJobId: row.currentJobId,
    label: row.label,
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
  };
}

export class ApiKeyRepository implements IApiKeyRepository {
  private db = getDb();

  async findByKeyId(keyId: string): Promise<ApiKeyRecord | null> {
    logger.debug("Looking up API key", { keyId });

    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyId, keyId))
      .limit(1);

    return row ? rowToRecord(row) : null;
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(apiKeys.id, id));
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
    logger.info("Creating API key", { keyId: input.keyId, name: input.name, maxUses: input.maxUses });

    const [row] = await this.db
      .insert(apiKeys)
      .values({
        keyId: input.keyId,
        keyHash: input.keyHash,
        name: input.name,
        isAdmin: input.isAdmin,
        scopes: input.scopes,
        installationRef: input.installationRef ?? null,
        status: "active",
        maxUses: input.maxUses ?? null,
        label: input.label ?? null,
      })
      .returning();

    logger.info("API key created", { keyId: row.keyId, maxUses: row.maxUses });
    return rowToRecord(row);
  }

  async revoke(keyId: string): Promise<void> {
    logger.info("Revoking API key", { keyId });

    await this.db
      .update(apiKeys)
      .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date(), currentJobId: null })
      .where(eq(apiKeys.keyId, keyId));
  }

  async findOneTimeKeys(): Promise<ApiKeyRecord[]> {
    logger.debug("Listing one-time API keys");

    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(isNotNull(apiKeys.maxUses))
      .orderBy(apiKeys.createdAt);

    return rows.map(rowToRecord);
  }

  async claimForJob(keyId: string, jobId: string): Promise<boolean> {
    logger.debug("Claiming one-time key for job", { keyId, jobId });

    // Atomic conditional update — only succeeds if key is currently 'active' and has maxUses set
    const result = await this.db
      .update(apiKeys)
      .set({
        status: "in_use",
        currentJobId: jobId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          eq(apiKeys.status, "active"),
          isNotNull(apiKeys.maxUses),
        ),
      );

    const claimed = (result.rowCount ?? 0) > 0;
    logger.info("One-time key claim result", { keyId, jobId, claimed });
    return claimed;
  }

  async releaseFromJob(keyId: string): Promise<boolean> {
    logger.info("Releasing one-time key after failed job", { keyId });

    const result = await this.db
      .update(apiKeys)
      .set({
        status: "active",
        currentJobId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          eq(apiKeys.status, "in_use"),
        ),
      );

    const released = (result.rowCount ?? 0) > 0;
    if (!released) {
      logger.warn("releaseFromJob matched zero rows — key may have been revoked or is in an unexpected state", { keyId });
    }
    return released;
  }

  async consumeKey(keyId: string): Promise<boolean> {
    logger.info("Consuming one-time key after successful job", { keyId });

    const result = await this.db
      .update(apiKeys)
      .set({
        status: "consumed",
        currentJobId: null,
        usesCount: sql`${apiKeys.usesCount} + 1`,
        consumedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          eq(apiKeys.status, "in_use"),
        ),
      );

    const consumed = (result.rowCount ?? 0) > 0;
    if (!consumed) {
      logger.error("consumeKey matched zero rows — key may have been revoked or is in an unexpected state", { keyId });
    }
    return consumed;
  }

  async releaseOrphanedKeys(): Promise<number> {
    logger.info("Recovering orphaned one-time keys (in_use with terminal job)");

    // Find all in_use keys whose currentJobId points to a terminal job.
    // Include job status and objectKey to decide: consume vs release.
    const terminalStatuses = ["failed", "completed", "cancelled"];
    const orphanedKeys = await this.db
      .select({
        keyId: apiKeys.keyId,
        jobStatus: videoJobs.status,
        objectKey: videoJobs.objectKey,
      })
      .from(apiKeys)
      .innerJoin(videoJobs, eq(apiKeys.currentJobId, videoJobs.id))
      .where(
        and(
          eq(apiKeys.status, "in_use"),
          isNotNull(apiKeys.maxUses),
          inArray(videoJobs.status, terminalStatuses),
        ),
      );

    if (orphanedKeys.length === 0) return 0;

    let recovered = 0;
    const now = new Date();
    for (const { keyId, jobStatus, objectKey } of orphanedKeys) {
      // A completed job with an objectKey means a full video was produced.
      // The key should be consumed (not released) to preserve single-use guarantee.
      const isFullVideoSuccess = jobStatus === "completed" && objectKey !== null;

      const result = await this.db
        .update(apiKeys)
        .set(isFullVideoSuccess
          ? {
              status: "consumed" as const,
              currentJobId: null,
              usesCount: sql`${apiKeys.usesCount} + 1`,
              consumedAt: now,
              updatedAt: now,
            }
          : {
              status: "active" as const,
              currentJobId: null,
              updatedAt: now,
            },
        )
        .where(
          and(
            eq(apiKeys.keyId, keyId),
            eq(apiKeys.status, "in_use"),
          ),
        );
      if ((result.rowCount ?? 0) > 0) {
        recovered++;
        logger.info(isFullVideoSuccess
          ? "Consumed orphaned one-time key (full video was produced)"
          : "Released orphaned one-time key",
          { keyId, jobStatus, hasVideo: objectKey !== null },
        );
      }
    }

    if (recovered > 0) {
      logger.warn("Recovered orphaned one-time keys on startup", { count: recovered });
    }
    return recovered;
  }
}
