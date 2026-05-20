import { NextResponse } from "next/server";
import { loadReviewPage } from "@/lib/reviews/loadReviewPage";

export async function GET(
  _request: Request,
  routeContext: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await routeContext.params;
  const result = await loadReviewPage({ jobId });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status },
    );
  }

  return NextResponse.json(result.payload);
}
