import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getContainer } from "@/config/container";
import { createLogger } from "@/lib/logger";
import { eq, desc, inArray, and, sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { videoJobs } from "@/infrastructure/persistence/schema";

const logger = createLogger("dashboard/jobs");

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export const dynamic = "force-dynamic";

interface JobSummary {
  id: string;
  status: string;
  currentStage: string | null;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  createdAt: string;
  completedAt: string | null;
  hasReview: boolean;
  elapsedMs: number | null;
  errorCode: string | null;
}

const STATUS_FILTER_MAP: Record<string, string[]> = {
  in_progress: ["queued", "processing"],
  completed: ["completed"],
  failed: ["failed", "cancelled"],
  all: ["queued", "processing", "completed", "failed", "cancelled"],
};

/**
 * GET /api/dashboard/jobs
 *
 * Returns paginated job list for the selected organization.
 * The OSS build has no auth — every active installation is visible.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const orgParam = searchParams.get("org");
  const statusFilter = searchParams.get("status") ?? "all";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
  const offset = (page - 1) * limit;

  if (!STATUS_FILTER_MAP[statusFilter]) {
    return NextResponse.json(
      { error: "INVALID_STATUS", message: `status must be one of: ${Object.keys(STATUS_FILTER_MAP).join(", ")}` },
      { status: 400, headers: NO_STORE_HEADERS },
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
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // Resolve selected installation (no tenancy: all active installations)
  let installation;
  try {
    const installations = await container.installationRepository.findAllActive();
    installation = orgParam
      ? installations.find((i) => String(i.installationId) === orgParam)
      : installations[0];
  } catch (err) {
    logger.error("Failed to load installations for jobs", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Failed to load organization data" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  if (!installation) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Organization installation not found" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const dbStatuses = STATUS_FILTER_MAP[statusFilter];
  const conditions = [
    eq(videoJobs.installationRef, installation.id),
    inArray(videoJobs.status, dbStatuses),
  ];

  let rows, countResult;
  try {
    const db = getDb();
    [rows, countResult] = await Promise.all([
      db
        .select()
        .from(videoJobs)
        .where(and(...conditions))
        .orderBy(desc(videoJobs.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(videoJobs)
        .where(and(...conditions)),
    ]);
  } catch (err) {
    logger.error("Failed to query jobs", {
      installationRef: installation.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Failed to load walkthroughs" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const total = countResult[0]?.count ?? 0;
  const now = Date.now();

  const jobs: JobSummary[] = rows.map((row) => {
    const metrics = row.metricsJson as Record<string, unknown> | null;
    const prTitle =
      (metrics?.prTitle as string) ??
      (metrics?.title as string) ??
      `#${row.prNumber}`;

    const isInProgress = row.status === "queued" || row.status === "processing";
    const elapsedMs = isInProgress ? now - row.createdAt.getTime() : null;

    return {
      id: row.id,
      status: row.status,
      currentStage: row.currentStage ?? null,
      repoFullName: row.repoFullName,
      prNumber: row.prNumber,
      prTitle,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      hasReview: row.scriptJson !== null,
      elapsedMs,
      errorCode: row.errorCode,
    };
  });

  logger.info("Jobs list returned", {
    org: installation.accountLogin,
    statusFilter,
    total,
    page,
  });

  return NextResponse.json({
    jobs,
    total,
    page,
    limit,
    hasMore: offset + limit < total,
  }, { headers: NO_STORE_HEADERS });
}
