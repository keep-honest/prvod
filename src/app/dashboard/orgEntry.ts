import type { InstallationRecord } from "@/interfaces/IInstallationRepository";

/**
 * Slim organization entry surfaced in the dashboard UI.
 *
 * The OSS build has no per-user tenancy: every active GitHub App
 * installation is visible, so this is a straight projection of
 * `InstallationRecord` without billing or access metadata.
 */
export interface OrgEntry {
  installationId: number;
  orgLogin: string;
  accountType: string;
}

export function toOrgEntry(record: InstallationRecord): OrgEntry {
  return {
    installationId: record.installationId,
    orgLogin: record.accountLogin,
    accountType: record.accountType,
  };
}
