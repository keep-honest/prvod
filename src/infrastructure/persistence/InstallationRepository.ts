import { eq, and, inArray, sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { githubInstallations, installationRepositories } from "@/infrastructure/persistence/schema";
import { createLogger } from "@/lib/logger";
import type { IInstallationRepository, InstallationRecord } from "@/interfaces/IInstallationRepository";

const logger = createLogger("InstallationRepository");

function rowToRecord(row: typeof githubInstallations.$inferSelect): InstallationRecord {
  return {
    id: row.id,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    status: row.status as InstallationRecord["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class InstallationRepository implements IInstallationRepository {
  private db = getDb();

  async upsert(input: {
    installationId: number;
    accountLogin: string;
    accountType: string;
  }): Promise<InstallationRecord> {
    logger.debug("Upserting installation", { installationId: input.installationId });

    const [row] = await this.db
      .insert(githubInstallations)
      .values({
        installationId: input.installationId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        status: "active",
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Installation upsert returned no row for installationId=${input.installationId} — possible DB trigger or constraint issue`);
    }
    logger.info("Installation upserted", { id: row.id, installationId: row.installationId });
    return rowToRecord(row);
  }

  async findById(id: string): Promise<InstallationRecord | null> {
    logger.debug("Finding installation by id", { id });

    const [row] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, id))
      .limit(1);

    return row ? rowToRecord(row) : null;
  }

  async findByInstallationId(installationId: number): Promise<InstallationRecord | null> {
    logger.debug("Finding installation by installationId", { installationId });

    const [row] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);

    return row ? rowToRecord(row) : null;
  }

  async findAllActive(): Promise<InstallationRecord[]> {
    logger.debug("Finding all active installations");

    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.status, "active"));

    return rows.map(rowToRecord);
  }

  async findByAccountLogins(accountLogins: string[]): Promise<InstallationRecord[]> {
    const normalizedLogins = Array.from(
      new Set(
        accountLogins
          .map((login) => login.trim().toLowerCase())
          .filter((login) => login.length > 0),
      ),
    );

    logger.debug("Finding active installations by account logins", {
      accountLoginCount: normalizedLogins.length,
    });

    if (normalizedLogins.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(
        inArray(
          sql<string>`lower(${githubInstallations.accountLogin})`,
          normalizedLogins,
        ),
      );

    return rows.map(rowToRecord);
  }

  async findActiveByAccountLogins(accountLogins: string[]): Promise<InstallationRecord[]> {
    const rows = await this.findByAccountLogins(accountLogins);
    return rows.filter((installation) => installation.status === "active");
  }

  async markStatus(
    installationId: number,
    status: "active" | "suspended" | "deleted",
  ): Promise<void> {
    logger.info("Marking installation status", { installationId, status });

    const result = await this.db
      .update(githubInstallations)
      .set({ status, updatedAt: new Date() })
      .where(eq(githubInstallations.installationId, installationId))
      .returning({ id: githubInstallations.id });
    if (result.length === 0) {
      logger.warn("markStatus matched no rows — installation record may not exist", { installationId, status });
    }
  }

  async upsertRepository(input: {
    installationRef: string;
    githubRepositoryId: number;
    repoFullName: string;
    permissionsJson?: unknown;
  }): Promise<void> {
    logger.debug("Upserting installation repository", {
      installationRef: input.installationRef,
      githubRepositoryId: input.githubRepositoryId,
      repoFullName: input.repoFullName,
    });

    await this.db
      .insert(installationRepositories)
      .values({
        installationRef: input.installationRef,
        githubRepositoryId: input.githubRepositoryId,
        repoFullName: input.repoFullName,
        isActive: true,
        permissionsJson: input.permissionsJson ?? null,
      })
      .onConflictDoUpdate({
        target: [installationRepositories.installationRef, installationRepositories.githubRepositoryId],
        set: {
          repoFullName: input.repoFullName,
          isActive: true,
          permissionsJson: input.permissionsJson ?? null,
          updatedAt: new Date(),
        },
      });
  }

  async deactivateRepository(installationRef: string, githubRepositoryId: number): Promise<void> {
    logger.info("Deactivating repository from installation", {
      installationRef,
      githubRepositoryId,
    });

    const result = await this.db
      .update(installationRepositories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(installationRepositories.installationRef, installationRef),
          eq(installationRepositories.githubRepositoryId, githubRepositoryId),
        ),
      )
      .returning({ id: installationRepositories.id });
    if (result.length === 0) {
      logger.warn("deactivateRepository matched no rows — repository record may not exist", {
        installationRef,
        githubRepositoryId,
      });
    }
  }
}
