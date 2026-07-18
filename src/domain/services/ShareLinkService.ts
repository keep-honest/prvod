import { makeShareUrl, type ShareType, type ShareTokenResult } from "@/lib/shareToken";
import type { IJobRepository } from "@/interfaces/IJobRepository";
import { createLogger } from "@/lib/logger";

const logger = createLogger("ShareLinkService");

export class ShareLinkService {
  constructor(
    private readonly jobRepository: IJobRepository,
    private readonly signingSecret: string,
  ) {}

  /**
   * Generate a signed share link for a completed job.
   *
   * The OSS build has no per-user tenancy, so any completed job with a
   * rendered video is shareable — there is no caller-ownership check.
   *
   * @param jobId - Target job UUID
   * @param type - `"full"` (interactive walkthrough) or `"video"` (public branded player)
   * @param baseUrl - App origin (e.g. `https://prvod.dev`)
   * @returns Signed share URL and expiry, or null if job not found/not completed
   */
  async generateLink(
    jobId: string,
    type: ShareType,
    baseUrl: string,
  ): Promise<ShareTokenResult | null> {
    const job = await this.jobRepository.findById(jobId);

    if (!job) {
      logger.debug("Share link rejected: job not found", { jobId });
      return null;
    }

    if (job.status !== "completed" || !job.videoUrl) {
      logger.debug("Share link rejected: job not completed or missing video", {
        jobId,
        status: job.status,
        hasVideo: !!job.videoUrl,
      });
      return null;
    }

    const result = makeShareUrl(jobId, type, baseUrl, this.signingSecret);

    logger.info("Share link generated", {
      jobId,
      type,
      expiresAt: result.expiresAt.toISOString(),
    });

    return result;
  }
}
