import { eq, and, inArray, notInArray, gte, lt, count, desc, isNull } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { videoJobs } from "@/infrastructure/persistence/schema";
import { createLogger } from "@/lib/logger";
import type { IJobRepository } from "@/interfaces/IJobRepository";
import type { VideoJob, NewVideoJob, JobStatus } from "@/domain/entities/VideoJob";
import { jobStatusEnum } from "@/domain/entities/VideoJob";

const logger = createLogger("PostgresJobRepository");

const ACTIVE_STATUSES: JobStatus[] = ["queued", "processing"];
const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];
function tenantScopeCondition(installationRef: string | null | undefined) {
  if (installationRef === undefined) return [];
  if (installationRef === null) return [isNull(videoJobs.installationRef)];
  return [eq(videoJobs.installationRef, installationRef)];
}

function rowToVideoJob(row: typeof videoJobs.$inferSelect): VideoJob {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    status: jobStatusEnum.parse(row.status),
    videoUrl: row.videoUrl,
    objectKey: row.objectKey,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    scriptJson: row.scriptJson,
    ttsAudioJson: row.ttsAudioJson,
    durationMs: row.durationMs,
    metricsJson: row.metricsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    installationRef: row.installationRef,
    githubInstallationId: row.githubInstallationId,
    githubRepositoryId: row.githubRepositoryId,
    triggeredVia: (row.triggeredVia ?? "api") as VideoJob["triggeredVia"],
    triggeredBy: row.triggeredBy,
    deliveryId: row.deliveryId,
    apiKeyId: row.apiKeyId,
    statusCommentPosted: row.statusCommentPosted,
    scriptOnly: row.scriptOnly,
    repoIsPrivate: row.repoIsPrivate,
    currentStage: row.currentStage ?? null,
  };
}

export class PostgresJobRepository implements IJobRepository {
  private db = getDb();

  async create(job: NewVideoJob): Promise<VideoJob> {
    logger.debug("Creating video job", {
      repo: job.repoFullName,
      pr: job.prNumber,
    });

    try {
      const [row] = await this.db
        .insert(videoJobs)
        .values({
          repoFullName: job.repoFullName,
          prNumber: job.prNumber,
          triggeredVia: job.triggeredVia ?? "api",
          installationRef: job.installationRef ?? null,
          githubInstallationId: job.githubInstallationId ?? null,
          githubRepositoryId: job.githubRepositoryId ?? null,
          triggeredBy: job.triggeredBy ?? null,
          deliveryId: job.deliveryId ?? null,
          apiKeyId: job.apiKeyId ?? null,
          scriptOnly: job.scriptOnly ?? false,
          repoIsPrivate: job.repoIsPrivate ?? false,
          ...(job.metricsJson ? { metricsJson: job.metricsJson } : {}),
        })
        .returning();

      logger.info("Video job created", { jobId: row.id });
      return rowToVideoJob(row);
    } catch (error: unknown) {
      const pgCode = (error as { code?: string }).code;
      const isDuplicate = pgCode === "23505";

      if (isDuplicate) {
        logger.warn("Duplicate job detected, looking for existing active job", {
          repo: job.repoFullName,
          pr: job.prNumber,
        });

        try {
          const existing = await this.findActiveByPR(
            job.repoFullName,
            job.prNumber,
          );
          if (existing) {
            logger.info("Returning existing active job for duplicate request", {
              repo: job.repoFullName,
              pr: job.prNumber,
              jobId: existing.id,
            });
            return existing;
          }
          logger.warn("Duplicate constraint but no active job found — conflicting job may be in terminal state", {
            repo: job.repoFullName,
            pr: job.prNumber,
          });
        } catch (findError) {
          const findMessage = findError instanceof Error ? findError.message : String(findError);
          logger.error("Failed to look up existing job after duplicate constraint", {
            repo: job.repoFullName,
            pr: job.prNumber,
            originalError: pgCode,
            findError: findMessage,
          });
        }
      }

      logger.error("Failed to create video job", {
        repo: job.repoFullName,
        pr: job.prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async findById(id: string): Promise<VideoJob | null> {
    logger.debug("Finding job by id", { jobId: id });

    const [row] = await this.db
      .select()
      .from(videoJobs)
      .where(eq(videoJobs.id, id))
      .limit(1);

    if (!row) {
      logger.debug("Job not found", { jobId: id });
      return null;
    }

    return rowToVideoJob(row);
  }

  async findActiveByPR(
    repoFullName: string,
    prNumber: number,
    installationRef?: string | null,
  ): Promise<VideoJob | null> {
    logger.debug("Finding active job for PR", {
      repo: repoFullName,
      pr: prNumber,
      installationRef,
    });

    const conditions = [
      eq(videoJobs.repoFullName, repoFullName),
      eq(videoJobs.prNumber, prNumber),
      inArray(videoJobs.status, ACTIVE_STATUSES),
      ...tenantScopeCondition(installationRef),
    ];

    const [row] = await this.db
      .select()
      .from(videoJobs)
      .where(and(...conditions))
      .limit(1);

    if (!row) {
      logger.debug("No active job found for PR", { repo: repoFullName, pr: prNumber });
      return null;
    }

    return rowToVideoJob(row);
  }

  async findAnyByPR(
    repoFullName: string,
    prNumber: number,
    installationRef?: string | null,
  ): Promise<VideoJob | null> {
    logger.debug("Finding any job for PR (all statuses)", {
      repo: repoFullName,
      pr: prNumber,
      installationRef,
    });

    const conditions = [
      eq(videoJobs.repoFullName, repoFullName),
      eq(videoJobs.prNumber, prNumber),
      ...tenantScopeCondition(installationRef),
    ];

    const [row] = await this.db
      .select()
      .from(videoJobs)
      .where(and(...conditions))
      .orderBy(desc(videoJobs.createdAt))
      .limit(1);

    if (!row) {
      logger.debug("No job found for PR", { repo: repoFullName, pr: prNumber });
      return null;
    }

    return rowToVideoJob(row);
  }

  async updateStatus(
    id: string,
    status: JobStatus,
    fields?: Partial<VideoJob>,
  ): Promise<VideoJob> {
    logger.info("Updating job status", { jobId: id, status });

    const now = new Date();
    const isTerminal = TERMINAL_STATUSES.includes(status);

    // updateStatus unconditionally writes the requested transition — including
    // legitimate failed/cancelled → processing retry transitions. The race
    // between fire-and-forget stage updates and terminal writes is handled
    // separately by `updateProcessingStage()` below, which carries the
    // compare-and-set guard that does NOT belong on this method.

    const [row] = await this.db
      .update(videoJobs)
      .set({
        status,
        updatedAt: now,
        ...(isTerminal ? { completedAt: now } : {}),
        ...fields,
      })
      .where(eq(videoJobs.id, id))
      .returning();

    if (!row) {
      logger.error("Job not found during status update", { jobId: id });
      throw new Error(`Job ${id} not found`);
    }

    logger.info("Job status updated", { jobId: id, status });
    return rowToVideoJob(row);
  }

  /**
   * Compare-and-set stage-only update for fire-and-forget progress writes from
   * VideoOrchestrator.onStageChange. Skips the write when the row is already in
   * a terminal status, so a late-arriving stage update can't reset a
   * completed/failed job back to "processing". Returns null on no-match.
   */
  async updateProcessingStage(id: string, stage: string): Promise<VideoJob | null> {
    const now = new Date();
    const [row] = await this.db
      .update(videoJobs)
      .set({ currentStage: stage, updatedAt: now })
      .where(and(eq(videoJobs.id, id), notInArray(videoJobs.status, TERMINAL_STATUSES)))
      .returning();

    if (!row) {
      logger.debug("Skipped stage update on terminal job", { jobId: id, stage });
      return null;
    }
    return rowToVideoJob(row);
  }

  async countRecentByRepo(
    repoFullName: string,
    since: Date,
    installationRef?: string | null,
    excludeScriptOnly?: boolean,
  ): Promise<number> {
    logger.debug("Counting recent jobs for repo", {
      repo: repoFullName,
      since: since.toISOString(),
      installationRef,
      excludeScriptOnly,
    });

    const conditions = [
      eq(videoJobs.repoFullName, repoFullName),
      gte(videoJobs.createdAt, since),
      ...tenantScopeCondition(installationRef),
    ];
    if (excludeScriptOnly) {
      conditions.push(eq(videoJobs.scriptOnly, false));
    }

    const [result] = await this.db
      .select({ value: count() })
      .from(videoJobs)
      .where(and(...conditions));

    const total = result?.value ?? 0;
    logger.debug("Recent job count", { repo: repoFullName, count: total });
    return total;
  }

  async failStaleProcessingJobs(thresholdMinutes: number): Promise<number> {
    logger.debug("Reaping stale processing jobs", { thresholdMinutes });

    const now = new Date();
    const conditions = [inArray(videoJobs.status, ACTIVE_STATUSES)];
    if (thresholdMinutes > 0) {
      const cutoff = new Date(now.getTime() - thresholdMinutes * 60_000);
      conditions.push(lt(videoJobs.updatedAt, cutoff));
    }

    const rows = await this.db
      .update(videoJobs)
      .set({
        status: "failed",
        errorCode: "STALE_PROCESSING",
        errorMessage: "Server restarted while job was processing",
        completedAt: now,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning({ id: videoJobs.id });

    if (rows.length > 0) {
      logger.warn("Reaped stale processing jobs", {
        count: rows.length,
        jobIds: rows.map((r) => r.id),
      });
    }

    return rows.length;
  }

  async deleteById(id: string): Promise<boolean> {
    logger.debug("Deleting job", { jobId: id });
    const rows = await this.db
      .delete(videoJobs)
      .where(eq(videoJobs.id, id))
      .returning({ id: videoJobs.id });
    const deleted = rows.length > 0;
    if (deleted) {
      logger.info("Job deleted", { jobId: id });
    }
    return deleted;
  }
}
