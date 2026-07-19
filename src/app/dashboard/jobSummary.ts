/**
 * Shared row→JobSummary mapping, status-filter validation, and pagination
 * clamping for the dashboard jobs API route and the walkthroughs RSC page.
 *
 * Pure module (no DB/framework imports) so both consumers stay in lockstep
 * and the logic is unit-testable without a container.
 */

export interface JobSummary {
  id: string;
  status: string;
  currentStage: string | null;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  createdAt: string;
  completedAt: string | null;
  hasReview: boolean;
  elapsedMs: number | null;
  errorCode: string | null;
}

/** Structural subset of a `videoJobs` row needed to build a JobSummary. */
export interface JobSummaryRow {
  id: string;
  status: string;
  currentStage: string | null;
  repoFullName: string;
  prNumber: number;
  createdAt: Date;
  completedAt: Date | null;
  scriptJson: unknown;
  metricsJson: unknown;
  errorCode: string | null;
}

export const STATUS_FILTER_MAP: Record<string, string[]> = {
  in_progress: ["queued", "processing"],
  completed: ["completed"],
  failed: ["failed", "cancelled"],
  all: ["queued", "processing", "completed", "failed", "cancelled"],
};

/** Returns the DB statuses for a filter name, or null when unknown. */
export function resolveStatusFilter(statusFilter: string): string[] | null {
  // Object.hasOwn guards against inherited keys ("toString", …) resolving.
  return Object.hasOwn(STATUS_FILTER_MAP, statusFilter)
    ? STATUS_FILTER_MAP[statusFilter]
    : null;
}

/** Clamp a raw `page` query value to an integer >= 1 (default 1). */
export function clampPage(raw: string | null): number {
  return Math.max(1, parseInt(raw ?? "1", 10) || 1);
}

/** Clamp a raw `limit` query value to 1..100 (default 20). */
export function clampLimit(raw: string | null): number {
  return Math.min(100, Math.max(1, parseInt(raw ?? "20", 10) || 20));
}

/** True when rows beyond the current page remain. */
export function hasMorePages(offset: number, limit: number, total: number): boolean {
  return offset + limit < total;
}

export function toJobSummary(row: JobSummaryRow, now: number): JobSummary {
  const metrics =
    row.metricsJson && typeof row.metricsJson === "object"
      ? (row.metricsJson as Record<string, unknown>)
      : null;

  const prTitle =
    typeof metrics?.prTitle === "string"
      ? metrics.prTitle
      : typeof metrics?.title === "string"
        ? metrics.title
        : `#${row.prNumber}`;

  const isInProgress = row.status === "queued" || row.status === "processing";

  return {
    id: row.id,
    status: row.status,
    currentStage: row.currentStage ?? null,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    prTitle,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    hasReview: row.scriptJson !== null,
    elapsedMs: isInProgress ? now - row.createdAt.getTime() : null,
    errorCode: row.errorCode,
  };
}
