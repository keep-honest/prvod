import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getContainer } from "@/config/container";
import { createLogger } from "@/lib/logger";
import { eq, desc, inArray, and, sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { videoJobs } from "@/infrastructure/persistence/schema";
import {
  STATUS_FILTER_MAP,
  clampLimit,
  clampPage,
  hasMorePages,
  resolveStatusFilter,
  toJobSummary,
  type JobSummary,
} from "@/app/dashboard/jobSummary";

const logger = createLogger("dashboard/jobs");

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export const dynamic = "force-dynamic";

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
  const page = clampPage(searchParams.get("page"));
  const limit = clampLimit(searchParams.get("limit"));
  const offset = (page - 1) * limit;

  const dbStatuses = resolveStatusFilter(statusFilter);
  if (!dbStatuses) {
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

  const jobs: JobSummary[] = rows.map((row) => toJobSummary(row, now));

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
    hasMore: hasMorePages(offset, limit, total),
  }, { headers: NO_STORE_HEADERS });
}
