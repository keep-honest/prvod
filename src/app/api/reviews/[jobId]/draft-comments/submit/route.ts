import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/reviewAuth";
import { getContainer } from "@/config/container";
import { loadReviewPage } from "@/lib/reviews/loadReviewPage";
import { submitDraftCommentsRequestSchema } from "@/lib/reviews/reviewDraftSync";
import { createLogger } from "@/lib/logger";

const logger = createLogger("draft-comments-submit");

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
      { error: "OUTDATED_WALKTHROUGH", message: "Regenerate the walkthrough before submitting drafts" },
      { status: 409 },
    );
  }

  if (!loadResult.payload.canSyncDrafts || !session?.accessToken) {
    return NextResponse.json(
      { error: "AUTH_FORBIDDEN", message: "Draft submission is not available for this viewer" },
      { status: 403 },
    );
  }

  if (!session.user.githubLogin) {
    return NextResponse.json(
      { error: "AUTH_REQUIRED", message: "Sign in with GitHub to submit a review" },
      { status: 401 },
    );
  }

  const container = await getContainer();
  if (!container.githubService.submitPendingReview) {
    return NextResponse.json(
      { error: "SERVICE_UNAVAILABLE", message: "Pending review submission is unavailable" },
      { status: 503 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: "Invalid draft submit payload" },
      { status: 400 },
    );
  }

  const parsed = submitDraftCommentsRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", message: parsed.error.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    logger.info("Submitting pending review", {
      jobId,
      pendingReviewId: body.pendingReviewId,
    });

    const result = await container.githubService.submitPendingReview({
      repoFullName: loadResult.payload.repoFullName,
      prNumber: loadResult.payload.prNumber,
      reviewerAccessToken: session.accessToken,
      pendingReviewId: body.pendingReviewId,
      body: body.body,
    });

    logger.info("Pending review submitted", {
      jobId,
      submittedReviewId: result.submittedReviewId,
    });

    return NextResponse.json({
      submittedReviewId: result.submittedReviewId,
    });
  } catch (err) {
    logger.error("Failed to submit pending review", {
      jobId,
      pendingReviewId: body.pendingReviewId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Failed to submit pending review" },
      { status: 500 },
    );
  }
}
