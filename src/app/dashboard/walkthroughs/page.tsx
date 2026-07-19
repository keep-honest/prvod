import { getContainer } from "@/config/container";
import { createLogger } from "@/lib/logger";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { videoJobs } from "@/infrastructure/persistence/schema";
import {
  WalkthroughJobsPoller,
  type DashboardJob,
} from "@/app/dashboard/_components/WalkthroughJobsPoller";
import { toJobSummary } from "@/app/dashboard/jobSummary";

const logger = createLogger("dashboard/walkthroughs/page");

interface WalkthroughsPageProps {
  searchParams: Promise<{ org?: string }>;
}

export default async function WalkthroughsPage({ searchParams }: WalkthroughsPageProps) {
  const { org: orgParam } = await searchParams;

  let container;
  try {
    container = await getContainer();
  } catch (err) {
    logger.error("Failed to initialize container for walkthroughs page", {
      error: err instanceof Error ? err.message : String(err),
    });
    return <ErrorState />;
  }

  let installations;
  try {
    installations = await container.installationRepository.findAllActive();
  } catch (err) {
    logger.error("Failed to load installations for walkthroughs page", {
      error: err instanceof Error ? err.message : String(err),
    });
    return <ErrorState />;
  }

  const selectedInstallation = orgParam
    ? installations.find((i) => String(i.installationId) === orgParam)
    : installations[0];

  if (!selectedInstallation) {
    return <EmptyState />;
  }

  // Load jobs — return ErrorState on any DB failure
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(videoJobs)
      .where(eq(videoJobs.installationRef, selectedInstallation.id))
      .orderBy(desc(videoJobs.createdAt))
      .limit(50);

    const now = Date.now();
    const jobs: DashboardJob[] = rows.map((row) => toJobSummary(row, now));

    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 font-[family-name:var(--font-display)] text-2xl font-bold text-[var(--foreground)]">
          Walkthroughs
        </h1>
        <WalkthroughJobsPoller
          initialJobs={jobs}
          orgInstallationId={selectedInstallation.installationId}
        />
      </div>
    );
  } catch (err) {
    logger.error("Failed to load walkthroughs", {
      installationId: selectedInstallation.installationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return <ErrorState />;
  }
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 font-[family-name:var(--font-display)] text-2xl font-bold text-[var(--foreground)]">
        Walkthroughs
      </h1>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--background-panel)] p-10 text-center">
        <p className="mb-2 text-lg font-medium text-[var(--foreground)]">
          No walkthroughs yet
        </p>
        <p className="text-sm text-[var(--foreground-muted)]">
          Open a pull request on a repository where PrVod is installed to generate your first walkthrough.
        </p>
      </div>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 font-[family-name:var(--font-display)] text-2xl font-bold text-[var(--foreground)]">
        Walkthroughs
      </h1>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--background-panel)] p-10 text-center">
        <p className="text-sm text-[var(--foreground-muted)]">
          Unable to load your walkthroughs right now. Please try again.
        </p>
      </div>
    </div>
  );
}
