export interface InstallationRecord {
  id: string;              // UUID PK
  installationId: number;  // GitHub installation ID
  accountLogin: string;
  accountType: string;     // 'User' | 'Organization'
  status: "active" | "suspended" | "deleted";
  createdAt: Date;
  updatedAt: Date;
}

export interface IInstallationRepository {
  upsert(input: {
    installationId: number;
    accountLogin: string;
    accountType: string;
  }): Promise<InstallationRecord>;

  findById(id: string): Promise<InstallationRecord | null>;

  findByInstallationId(installationId: number): Promise<InstallationRecord | null>;

  findAllActive(): Promise<InstallationRecord[]>;

  findByAccountLogins(accountLogins: string[]): Promise<InstallationRecord[]>;

  findActiveByAccountLogins(accountLogins: string[]): Promise<InstallationRecord[]>;

  markStatus(
    installationId: number,
    status: "active" | "suspended" | "deleted",
  ): Promise<void>;

  upsertRepository(input: {
    installationRef: string;
    githubRepositoryId: number;
    repoFullName: string;
    permissionsJson?: unknown;
  }): Promise<void>;

  deactivateRepository(installationRef: string, githubRepositoryId: number): Promise<void>;
}
