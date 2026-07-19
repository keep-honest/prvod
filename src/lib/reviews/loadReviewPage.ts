import type { Session } from "next-auth";
import type { Container } from "@/config/container";
import { getContainer } from "@/config/container";
import type { ReviewPageModel } from "@/domain/entities/ReviewPage";
import { videoScriptSchema } from "@/domain/entities/VideoScript";
import { canWriteReviewComments } from "@/lib/reviewAuth";
import { isValidUuid } from "@/lib/validation";
import { createLogger } from "@/lib/logger";
import { verifyToken } from "@/lib/shareToken";

const logger = createLogger("loadReviewPage");

// Discriminated union — error code, status, and message correlate. A
// generic status field would let callers construct nonsense like
// { error: "NOT_FOUND", status: 503 }.
export type LoadReviewPageResult =
  | { ok: true; payload: ReviewPageModel }
  | { ok: false; status: 401; error: "AUTH_REQUIRED"; message: string }
  | { ok: false; status: 404; error: "NOT_FOUND"; message: string }
  | { ok: false; status: 500; error: "INTERNAL_ERROR"; message: string }
  | { ok: false; status: 503; error: "SERVICE_UNAVAILABLE"; message: string };

export async function loadReviewPage(args: {
  jobId: string;
  shareToken?: string | null;
  session?: Session | null;
  container?: Container;
}): Promise<LoadReviewPageResult> {
  const { jobId, shareToken, session } = args;
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

  // Viewing access keeps the share-token model: private-repo reviews require a
  // valid HMAC share token. A GitHub session is only consulted as a commenting
  // credential — except that a session whose token GitHub confirms can view the
  // repository is a strictly stronger credential than a share link, so the
  // draft-comment API routes (which have no share token) can still load the
  // page for verified collaborators. On any failure mode we return 404 rather
  // than 401/403 — revealing the job's existence is itself a leak.
  let sessionRepoAccess: { allowed: boolean } | null = null;
  if (job.repoIsPrivate) {
    const secret = process.env.SHARE_SIGNING_SECRET;
    if (!secret) {
      logger.error("SHARE_SIGNING_SECRET not configured — cannot serve private-repo review", { jobId });
      return {
        ok: false,
        status: 503,
        error: "SERVICE_UNAVAILABLE",
        message: "Review page services are unavailable",
      };
    }

    const tokenPayload = shareToken ? verifyToken(shareToken, secret) : null;
    const shareTokenValid =
      tokenPayload !== null && tokenPayload.jobId === jobId && tokenPayload.type === "full";

    if (!shareTokenValid) {
      if (session?.accessToken) {
        sessionRepoAccess = await canWriteReviewComments(session.accessToken, job.repoFullName);
      }

      // Every failure mode without a valid share token collapses to 404 — a
      // 401/403 (or the re-auth prompt below) would confirm the private job's
      // existence to anyone holding a session, tokenless or not. That includes
      // the "session present but accessToken missing" case: broken sessions
      // are indistinguishable from probing without leaking existence.
      if (!sessionRepoAccess?.allowed) {
        logger.debug("Private-repo review blocked: no valid share token or verified repo access", {
          jobId,
          hasShareToken: Boolean(shareToken),
          hasSession: Boolean(session?.user?.githubLogin),
        });
        return {
          ok: false,
          status: 404,
          error: "NOT_FOUND",
          message: "Review page not found",
        };
      }
    } else if (session?.user?.githubLogin && !session.accessToken) {
      // The valid share token already proves the job's existence, so it is
      // safe to explain WHY commenting won't work: the session lost its
      // GitHub access token (OAuth refresh failed, token stripped from the
      // JWT, or scoped without `repo`). Prompt a re-auth that preserves the
      // share token instead of silently degrading to view-only.
      logger.warn("Session present without GitHub access token — prompting re-auth", {
        jobId,
        githubLogin: session.user.githubLogin,
        errorTag: "REVIEW_SESSION_MISSING_ACCESS_TOKEN",
      });
      return {
        ok: false,
        status: 401,
        error: "AUTH_REQUIRED",
        message: "Your GitHub session is missing repository permissions. Sign in again to continue.",
      };
    }
  }

  // Commenting capability — GitHub session only. Reuse the already-resolved
  // access result when the viewing path resolved it (avoids a duplicate
  // GitHub API call).
  let canSyncDrafts = false;
  if (session?.accessToken) {
    if (job.repoIsPrivate) {
      if (sessionRepoAccess === null) {
        sessionRepoAccess = await canWriteReviewComments(session.accessToken, job.repoFullName);
      }
      canSyncDrafts = sessionRepoAccess.allowed;
    } else {
      // Public repos: any authenticated user can submit a PR review.
      canSyncDrafts = true;
    }
  }
  logger.debug("Review page commenting capability resolved", {
    jobId,
    repoFullName: job.repoFullName,
    userLogin: session?.user?.githubLogin,
    canSyncDrafts,
  });

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

  // Build sceneTimeline from metricsJson (actual probed data) or fallback for old jobs
  const metricsData = job.metricsJson as Record<string, unknown> | null;
  const rawTimeline = metricsData?.sceneTimeline as
    Array<{ sceneNumber: number; durationFrames: number }> | undefined;

  const FPS = 30;
  const sceneTimeline = rawTimeline
    ? rawTimeline.map(e => ({ sceneNumber: e.sceneNumber, durationMs: (e.durationFrames / FPS) * 1000 }))
    : parsedScript.data.scenes.map(s => ({ sceneNumber: s.sceneNumber, durationMs: s.durationSeconds * 1000 }));

  let snapshotStatus: "current" | "outdated" = "current";
  const reviewedHeadSha = typeof metricsData?.reviewDiffSnapshot === "object"
    && metricsData?.reviewDiffSnapshot !== null
    && typeof (metricsData.reviewDiffSnapshot as { headSha?: unknown }).headSha === "string"
    ? (metricsData.reviewDiffSnapshot as { headSha: string }).headSha
    : "";

  if (reviewedHeadSha && job.githubInstallationId && container.githubService) {
    try {
      const prContext = await container.githubService.fetchPRContext(
        job.repoFullName,
        job.prNumber,
        job.githubInstallationId,
      );
      if (prContext.headSha && prContext.headSha !== reviewedHeadSha) {
        snapshotStatus = "outdated";
      }
    } catch (err) {
      // Fail closed. If we can't verify freshness we treat the snapshot as
      // outdated rather than current — otherwise a transient GitHub failure
      // would silently re-enable draft sync against a potentially stale
      // snapshot, and reviewer comments would land on code that no longer
      // exists.
      logger.warn("Could not refresh review workspace freshness state — marking outdated to fail closed", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      snapshotStatus = "outdated";
    }
  }

  try {
    const payload = await container.reviewPageAssembler.build(job, parsedScript.data, sceneTimeline, {
      snapshotStatus,
      canSyncDrafts: canSyncDrafts && snapshotStatus === "current",
      reviewerKey: session?.user?.githubLogin ?? null,
    });
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
