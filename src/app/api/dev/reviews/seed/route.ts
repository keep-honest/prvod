import { NextResponse } from "next/server";
import { getContainer } from "@/config/container";
import {
  buildMockReviewMetrics,
  buildMockReviewScript,
} from "@/lib/reviews/mockReviewFixture";

interface SeedRequestBody {
  visibility?: "public" | "private";
  repoFullName?: string;
  prNumber?: number;
}

function isDevReviewSeedEnabled(): boolean {
  return process.env.USE_MOCK_SERVICES === "true" || process.env.NODE_ENV === "test";
}

export async function POST(request: Request) {
  if (!isDevReviewSeedEnabled()) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Review fixture seeding is unavailable" },
      { status: 404 },
    );
  }

  let body: SeedRequestBody = {};
  try {
    body = (await request.json()) as SeedRequestBody;
  } catch {
    body = {};
  }

  const visibility = body.visibility === "private" ? "private" : "public";
  const repoFullName = body.repoFullName ?? "acme/repo";
  const prNumber = body.prNumber ?? 42;
  const script = buildMockReviewScript();
  const container = await getContainer();

  const job = await container.jobRepository.create({
    repoFullName,
    prNumber,
    repoIsPrivate: visibility === "private",
    installationRef: visibility === "private" ? "00000000-0000-0000-0000-000000000001" : null,
    githubInstallationId: visibility === "private" ? 42 : null,
    triggeredVia: "api",
  });

  const objectKey = `videos/reviews/${job.id}.mp4`;
  await container.storageService.upload(objectKey, Buffer.from("MOCK_VIDEO_DATA"), "video/mp4");
  await container.jobRepository.updateStatus(job.id, "completed", {
    objectKey,
    scriptJson: script,
    durationMs: script.totalDurationSeconds * 1000,
    metricsJson: buildMockReviewMetrics(),
  });

  return NextResponse.json({
    jobId: job.id,
    reviewUrl: `/reviews/${job.id}`,
    visibility,
  });
}
