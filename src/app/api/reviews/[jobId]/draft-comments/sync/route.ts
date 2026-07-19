import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/reviewAuth";
import { getContainer } from "@/config/container";
import { loadReviewPage } from "@/lib/reviews/loadReviewPage";
import { buildGitHubDraftComments, syncDraftCommentsRequestSchema } from "@/lib/reviews/reviewDraftSync";
import { createLogger } from "@/lib/logger";

const logger = createLogger("draft-comments-sync");

export async function POST(
  request: NextRequest,
  routeContext: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await routeContext.params;
  const session = await auth();
  const loadResult = await loadReviewPage({ jobId, session });

  if (!loadResult.ok) {
    return NextResponse.json(
      { error: loadResult.error, message: loadResult.message },
      { status: loadResult.status },
    );
  }

  if (loadResult.payload.snapshotStatus === "outdated") {
    return NextResponse.json(
      { error: "OUTDATED_WALKTHROUGH", message: "Regenerate the walkthrough before syncing drafts" },
      { status: 409 },
    );
  }

  if (!loadResult.payload.canSyncDrafts || !session?.accessToken) {
    return NextResponse.json(
      { error: "AUTH_FORBIDDEN", message: "Draft sync is not available for this viewer" },
      { status: 403 },
    );
  }

  if (!session.user.githubLogin) {
    return NextResponse.json(
      { error: "AUTH_REQUIRED", message: "Sign in with GitHub to sync draft comments" },
      { status: 401 },
    );
  }

  const container = await getContainer();
  if (!container.githubService.syncDraftReviewComments) {
    return NextResponse.json(
      { error: "SERVICE_UNAVAILABLE", message: "Draft review sync is unavailable" },
      { status: 503 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: "Invalid draft sync payload" },
      { status: 400 },
    );
  }

  const parsed = syncDraftCommentsRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: parsed.error.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const comments = buildGitHubDraftComments(loadResult.payload, body.drafts ?? []);
    const mappedIds = new Set(comments.map((c) => c.localDraftId));
    const skippedDraftIds = body.drafts
      .map((d) => d.localDraftId)
      .filter((id) => !mappedIds.has(id));

    if (skippedDraftIds.length > 0) {
      // Warn, not debug: these drafts silently never reach GitHub. The ids are
      // also returned to the client so the UI can mark them distinctly.
      logger.warn("Some draft comments skipped — overview precision or missing diff position", {
        jobId,
        skippedCount: skippedDraftIds.length,
        skippedDraftIds,
      });
    }

    // Discard-only path: the user deleted every synced draft tied to a remote
    // pending review. No replacement comments to send — just delete the
    // orphaned pending review on GitHub so submit cannot publish stale text.
    if (comments.length === 0 && body.pendingReviewId) {
      if (!container.githubService.discardPendingReview) {
        return NextResponse.json(
          { error: "SERVICE_UNAVAILABLE", message: "Pending review discard is unavailable" },
          { status: 503 },
        );
      }

      logger.info("Discarding orphaned pending review", {
        jobId,
        pendingReviewId: body.pendingReviewId,
      });

      await container.githubService.discardPendingReview({
        repoFullName: loadResult.payload.repoFullName,
        prNumber: loadResult.payload.prNumber,
        reviewerAccessToken: session.accessToken,
        pendingReviewId: body.pendingReviewId,
      });

      return NextResponse.json({
        pendingReviewId: null,
        commentCount: 0,
        syncedDraftIds: [],
        skippedDraftIds,
        discardedPendingReviewId: body.pendingReviewId,
      });
    }

    logger.info("Syncing draft review comments", {
      jobId,
      draftCount: body.drafts.length,
      mappableCount: comments.length,
      pendingReviewId: body.pendingReviewId,
    });

    const result = await container.githubService.syncDraftReviewComments({
      repoFullName: loadResult.payload.repoFullName,
      prNumber: loadResult.payload.prNumber,
      reviewerAccessToken: session.accessToken,
      commitId: loadResult.payload.reviewedHeadSha,
      pendingReviewId: body.pendingReviewId,
      comments: comments.map((comment) => ({
        path: comment.path,
        body: comment.body,
        position: comment.position,
      })),
      summary: "Drafted from the review walkthrough.",
    });

    logger.info("Draft review comments synced", {
      jobId,
      pendingReviewId: result.pendingReviewId,
      commentCount: result.commentCount,
    });

    return NextResponse.json({
      pendingReviewId: result.pendingReviewId,
      commentCount: result.commentCount,
      syncedDraftIds: comments.map((comment) => comment.localDraftId),
      skippedDraftIds,
    });
  } catch (err) {
    logger.error("Failed to sync draft review comments", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Failed to sync draft comments" },
      { status: 500 },
    );
  }
}
