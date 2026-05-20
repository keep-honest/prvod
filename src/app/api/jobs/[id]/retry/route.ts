import { NextResponse } from "next/server";
import { isValidUuid } from "@/lib/validation";
import { withAdminJobsAuth } from "@/lib/apiMiddleware";
import { createPipelineRunner } from "@/app/api/pipelineFactory";

export const POST = withAdminJobsAuth(async (
  _request,
  { container, logger },
  routeContext: { params: Promise<{ id: string }> },
) => {
  const { id: jobId } = await routeContext.params;
  logger.info("POST /api/jobs/:id/retry", { jobId });

  if (!isValidUuid(jobId)) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Job not found" },
      { status: 404 },
    );
  }

  const job = await container.jobRepository.findById(jobId);

  if (!job) {
    logger.warn("Job not found", { jobId });
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Job not found" },
      { status: 404 },
    );
  }

  if (job.status !== "failed") {
    logger.warn("Job is not in failed state", { jobId, status: job.status });
    return NextResponse.json(
      { error: "BAD_REQUEST", message: `Job is ${job.status}, only failed jobs can be retried` },
      { status: 400 },
    );
  }

  // Check for checkpoint
  const checkpoint = await container.checkpointStore.load(jobId);
  if (!checkpoint) {
    logger.warn("No checkpoint found for retry", { jobId });
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "No checkpoint available for retry" },
      { status: 400 },
    );
  }

  // Move the job back to an in-flight state before reclaiming retry resources.
  await container.jobRepository.updateStatus(job.id, "processing", {});

  // Re-claim one-time key for retry if this job was created with one.
  let retryApiKeyId: string | undefined;
  if (job.apiKeyId) {
    const claimed = await container.apiKeyRepository.claimForJob(job.apiKeyId, jobId);
    if (claimed) {
      retryApiKeyId = job.apiKeyId;
      logger.info("One-time key re-claimed for retry", { apiKeyId: job.apiKeyId, jobId });
    } else {
      logger.warn("Retry blocked — one-time key cannot be re-claimed", {
        apiKeyId: job.apiKeyId, jobId,
      });
      try {
        await container.jobRepository.updateStatus(job.id, "failed", {});
      } catch (statusErr) {
        logger.error("Failed to revert job to failed after key re-claim failure — job may be stuck in processing", {
          jobId,
          error: statusErr instanceof Error ? statusErr.message : String(statusErr),
        });
      }
      return NextResponse.json(
        { error: "KEY_UNAVAILABLE", message: "The one-time key for this job is no longer available (consumed, revoked, or in use by another job)" },
        { status: 409 },
      );
    }
  }

  // Fire-and-forget retry
  const runner = createPipelineRunner(container, {
    apiKeyRepository: !!retryApiKeyId,
    githubService: true,
    diffSource: true,
  });
  runner.retry(jobId, { apiKeyId: retryApiKeyId }).catch((e) => {
    logger.error("Retry runner error", {
      error: e instanceof Error ? e.message : "Unknown",
    });
  });

  logger.info("Retry initiated", { jobId, resumeFromStep: checkpoint.completedStep });

  return NextResponse.json({
    id: job.id,
    status: "processing",
    message: `Retrying from step ${checkpoint.completedStep + 1}`,
  });
});
