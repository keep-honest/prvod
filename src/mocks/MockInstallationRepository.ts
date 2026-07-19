import type {
  IInstallationRepository,
  InstallationRecord,
} from "@/interfaces/IInstallationRepository";
import { randomUUID } from "crypto";

export class MockInstallationRepository implements IInstallationRepository {
  private installations: InstallationRecord[] = [];
  private repos: Array<{
    installationRef: string;
    githubRepositoryId: number;
    repoFullName: string;
    isActive: boolean;
  }> = [];

  async upsert(input: {
    installationId: number;
    accountLogin: string;
    accountType: string;
  }): Promise<InstallationRecord> {
    const existing = this.installations.find((i) => i.installationId === input.installationId);
    if (existing) {
      existing.accountLogin = input.accountLogin;
      existing.accountType = input.accountType;
      existing.status = "active";
      existing.updatedAt = new Date();
      return existing;
    }
    const now = new Date();
    const record: InstallationRecord = {
      id: randomUUID(),
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.installations.push(record);
    return record;
  }

  async findById(id: string): Promise<InstallationRecord | null> {
    return this.installations.find((i) => i.id === id) ?? null;
  }

  async findByInstallationId(installationId: number): Promise<InstallationRecord | null> {
    return this.installations.find((i) => i.installationId === installationId) ?? null;
  }

  async findAllActive(): Promise<InstallationRecord[]> {
    // Mirror the real repository's deterministic ordering (accountLogin,
    // then installationId) so consumers relying on [0] behave identically.
    return this.installations
      .filter((i) => i.status === "active")
      .sort(
        (a, b) =>
          a.accountLogin.localeCompare(b.accountLogin) ||
          a.installationId - b.installationId,
      );
  }

  async findByAccountLogins(accountLogins: string[]): Promise<InstallationRecord[]> {
    const normalized = new Set(
      accountLogins
        .map((login) => login.trim().toLowerCase())
        .filter((login) => login.length > 0),
    );

    return this.installations.filter(
      (installation) => normalized.has(installation.accountLogin.toLowerCase()),
    );
  }

  async findActiveByAccountLogins(accountLogins: string[]): Promise<InstallationRecord[]> {
    const rows = await this.findByAccountLogins(accountLogins);
    return rows.filter((installation) => installation.status === "active");
  }

  async markStatus(
    installationId: number,
    status: "active" | "suspended" | "deleted",
  ): Promise<void> {
    const record = this.installations.find((i) => i.installationId === installationId);
    if (record) {
      record.status = status;
      record.updatedAt = new Date();
    }
  }

  async upsertRepository(input: {
    installationRef: string;
    githubRepositoryId: number;
    repoFullName: string;
    permissionsJson?: unknown;
  }): Promise<void> {
    const existing = this.repos.find(
      (r) =>
        r.installationRef === input.installationRef &&
        r.githubRepositoryId === input.githubRepositoryId,
    );
    if (existing) {
      existing.repoFullName = input.repoFullName;
      existing.isActive = true;
    } else {
      this.repos.push({
        installationRef: input.installationRef,
        githubRepositoryId: input.githubRepositoryId,
        repoFullName: input.repoFullName,
        isActive: true,
      });
    }
  }

  async deactivateRepository(installationRef: string, githubRepositoryId: number): Promise<void> {
    const repo = this.repos.find(
      (r) => r.installationRef === installationRef && r.githubRepositoryId === githubRepositoryId,
    );
    if (repo) repo.isActive = false;
  }

  /** Test helper */
  reset(): void {
    this.installations = [];
    this.repos = [];
  }
}
