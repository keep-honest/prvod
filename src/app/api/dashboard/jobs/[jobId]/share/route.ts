import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getContainer } from "@/config/container";
import { ShareLinkService } from "@/domain/services/ShareLinkService";
import type { ShareType } from "@/lib/shareToken";
import { createLogger } from "@/lib/logger";

const logger = createLogger("dashboard/jobs/share");

/**
 * GET /api/dashboard/jobs/[jobId]/share?type=full|video
 *
 * Generates a time-limited (7-day) HMAC-signed share link for a completed job.
 * The OSS build has no auth or tenancy — any completed job is shareable.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const typeParam = request.nextUrl.searchParams.get("type") ?? "full";

  if (typeParam !== "full" && typeParam !== "video") {
    return NextResponse.json(
      { error: "INVALID_TYPE", message: "type must be 'full' or 'video'" },
      { status: 400 },
    );
  }

  const shareType: ShareType = typeParam;

  const secret = process.env.SHARE_SIGNING_SECRET;
  if (!secret) {
    logger.error("SHARE_SIGNING_SECRET not configured");
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Share links are not configured" },
      { status: 500 },
    );
  }

  let container;
  try {
    container = await getContainer();
  } catch (err) {
    logger.error("Container initialization failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Service initialization failed" },
      { status: 500 },
    );
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;

  const service = new ShareLinkService(container.jobRepository, secret);

  const result = await service.generateLink(jobId, shareType, baseUrl);

  if (!result) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Job not found or not yet completed" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    url: result.url,
    type: shareType,
    expiresAt: result.expiresAt.toISOString(),
  });
}
