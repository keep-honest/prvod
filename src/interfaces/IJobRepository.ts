import type {
  VideoJob,
  NewVideoJob,
  JobStatus,
} from "@/domain/entities/VideoJob";

export interface IJobRepository {
  create(job: NewVideoJob): Promise<VideoJob>;
  findById(id: string): Promise<VideoJob | null>;
  /**
   * installationRef semantics:
   * - string: scope to a specific tenant
   * - null: scope to API-triggered jobs (installation_ref IS NULL)
   * - undefined: no tenant filter (global)
   */
  findActiveByPR(
    repoFullName: string,
    prNumber: number,
    installationRef?: string | null,
  ): Promise<VideoJob | null>;
  /** See installationRef semantics above. */
  findAnyByPR(
    repoFullName: string,
    prNumber: number,
    installationRef?: string | null,
  ): Promise<VideoJob | null>;
  updateStatus(
    id: string,
    status: JobStatus,
    fields?: Partial<VideoJob>,
  ): Promise<VideoJob>;
  /**
   * Compare-and-set update of `currentStage` only. No-ops (returns null) when
   * the row has already moved to a terminal status (completed/failed/cancelled).
   *
   * Use this for fire-and-forget stage progress updates from
   * `VideoOrchestrator.onStageChange`, where a slow in-flight write must not
   * be allowed to resolve after the terminal status write and reset the row
   * back to "processing". Use `updateStatus(..., "processing", ...)` instead
   * for explicit status transitions (initial start, retry from failed, etc.).
   */
  updateProcessingStage(id: string, stage: string): Promise<VideoJob | null>;
  /**
   * Count jobs created after `since` for the given repo.
   * See installationRef semantics above.
   * @param excludeScriptOnly - When true, exclude jobs where script_only = true (so
   *   the count reflects only video-generating jobs for rate-limit purposes).
   */
  countRecentByRepo(repoFullName: string, since: Date, installationRef?: string | null, excludeScriptOnly?: boolean): Promise<number>;
  /** Delete a job that was never processed (e.g., race-condition cleanup). */
  deleteById(id: string): Promise<boolean>;
  /**
   * Mark all "queued"/"processing" jobs as failed if their updated_at is older
   * than `thresholdMinutes`. When thresholdMinutes is 0, fail ALL non-terminal
   * jobs unconditionally (used on server startup to reap orphaned pipelines).
   * Returns the number of jobs reaped.
   */
  failStaleProcessingJobs(thresholdMinutes: number): Promise<number>;
}
