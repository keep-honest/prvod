import type { Container } from "@/config/container";
import { getContainer } from "@/config/container";
import type { ReviewPageModel } from "@/domain/entities/ReviewPage";
import { videoScriptSchema } from "@/domain/entities/VideoScript";
import { isValidUuid } from "@/lib/validation";
import { createLogger } from "@/lib/logger";

const logger = createLogger("loadReviewPage");

export type LoadReviewPageResult =
  | { ok: true; payload: ReviewPageModel }
  | { ok: false; status: 404; error: "NOT_FOUND"; message: string }
  | { ok: false; status: 500; error: "INTERNAL_ERROR"; message: string }
  | { ok: false; status: 503; error: "SERVICE_UNAVAILABLE"; message: string };

export async function loadReviewPage(args: {
  jobId: string;
  container?: Container;
}): Promise<LoadReviewPageResult> {
  const { jobId } = args;
  const container = args.container ?? await getContainer();

  if (!isValidUuid(jobId)) {
    return {
      ok: false,
      status: 404,
      error: "NOT_FOUND",
      message: "Review page not found",
    };
  }

  if (!container.reviewPageAssembler) {
    return {
      ok: false,
      status: 503,
      error: "SERVICE_UNAVAILABLE",
      message: "Review page services are unavailable",
    };
  }

  const job = await container.jobRepository.findById(jobId);
  if (!job || job.status !== "completed") {
    return {
      ok: false,
      status: 404,
      error: "NOT_FOUND",
      message: "Review page not found",
    };
  }

  const parsedScript = videoScriptSchema.safeParse(job.scriptJson);
  if (!parsedScript.success) {
    logger.error("Review page script data failed validation — completed job has corrupted scriptJson", {
      jobId,
      errors: parsedScript.error.flatten().fieldErrors,
    });
    return {
      ok: false,
      status: 500,
      error: "INTERNAL_ERROR",
      message: "Review page data is corrupted",
    };
  }

  const metricsData = job.metricsJson as Record<string, unknown> | null;
  const rawTimeline = metricsData?.sceneTimeline as
    Array<{ sceneNumber: number; durationFrames: number }> | undefined;

  const FPS = 30;
  const sceneTimeline = rawTimeline
    ? rawTimeline.map(e => ({ sceneNumber: e.sceneNumber, durationMs: (e.durationFrames / FPS) * 1000 }))
    : parsedScript.data.scenes.map(s => ({ sceneNumber: s.sceneNumber, durationMs: s.durationSeconds * 1000 }));

  try {
    const payload = await container.reviewPageAssembler.build(job, parsedScript.data, sceneTimeline);
    return { ok: true, payload };
  } catch (err) {
    logger.error("ReviewPageAssembler.build() failed", {
      jobId,
      hasObjectKey: !!job.objectKey,
      hasVideoUrl: !!job.videoUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 500,
      error: "INTERNAL_ERROR",
      message: "Failed to build review page",
    };
  }
}
