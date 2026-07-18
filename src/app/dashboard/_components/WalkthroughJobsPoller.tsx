"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InProgressJobCard } from "./InProgressJobCard";
import { JobCard } from "./JobCard";

export const WALKTHROUGH_JOBS_POLL_INTERVAL_MS = 5_000;
const POLL_FAILURE_LOG_THRESHOLD = 3;

export interface DashboardJob {
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
  errorCode?: string | null;
}

interface WalkthroughJobsPollerProps {
  initialJobs: DashboardJob[];
  orgInstallationId: number;
}

export function buildWalkthroughJobsUrl(orgInstallationId: number) {
  return `/api/dashboard/jobs?status=all&org=${orgInstallationId}&limit=50`;
}

export function groupDashboardJobs(jobs: DashboardJob[]) {
  return {
    inProgress: jobs.filter((job) => job.status === "queued" || job.status === "processing"),
    completed: jobs.filter((job) => job.status === "completed"),
    failed: jobs.filter((job) => job.status === "failed" || job.status === "cancelled"),
  };
}

export function WalkthroughJobsPoller({
  initialJobs,
  orgInstallationId,
}: WalkthroughJobsPollerProps) {
  const [jobs, setJobs] = useState<DashboardJob[]>(initialJobs);
  const failureCountRef = useRef(0);

  // Re-seed only when the selected org changes; within the same org the client
  // poll is the source of truth so that a slower RSC refresh cannot regress
  // a fresher in-flight client update.
  useEffect(() => {
    setJobs(initialJobs);
    failureCountRef.current = 0;
  }, [orgInstallationId]);

  const recordFailure = useCallback((kind: string, detail: Record<string, unknown>) => {
    failureCountRef.current += 1;
    const count = failureCountRef.current;
    // Log at the threshold and on every Nth failure thereafter so a sustained
    // outage is visible in DevTools, not a single warn at the moment polling broke.
    if (count >= POLL_FAILURE_LOG_THRESHOLD && count % POLL_FAILURE_LOG_THRESHOLD === 0) {
      console.warn(`WalkthroughJobsPoller: ${kind}`, {
        ...detail,
        consecutiveFailures: count,
      });
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch(buildWalkthroughJobsUrl(orgInstallationId), {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      recordFailure("poll network error", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Keep the current snapshot and retry on the next poll/focus event.
      return;
    }

    if (!res.ok) {
      recordFailure("poll returned non-ok response", { status: res.status });
      return;
    }

    try {
      const data = (await res.json()) as { jobs?: DashboardJob[] };
      failureCountRef.current = 0;
      setJobs(data.jobs ?? []);
    } catch (err) {
      recordFailure("poll response parse error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [orgInstallationId, recordFailure]);

  useEffect(() => {
    const pollIfVisible = () => {
      if (document.visibilityState === "visible") {
        void fetchJobs();
      }
    };

    pollIfVisible();
    document.addEventListener("visibilitychange", pollIfVisible);
    const interval = window.setInterval(pollIfVisible, WALKTHROUGH_JOBS_POLL_INTERVAL_MS);

    return () => {
      document.removeEventListener("visibilitychange", pollIfVisible);
      window.clearInterval(interval);
    };
  }, [fetchJobs]);

  const sections = useMemo(() => groupDashboardJobs(jobs), [jobs]);

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--background-panel)] p-10 text-center">
        <p className="mb-2 text-lg font-medium text-[var(--foreground)]">
          No walkthroughs yet
        </p>
        <p className="text-sm text-[var(--foreground-muted)]">
          Open a pull request on a repository where PrVod is installed to generate your first walkthrough.
        </p>
      </div>
    );
  }

  return (
    <>
      {sections.inProgress.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--foreground-soft)]">
            In Progress ({sections.inProgress.length})
          </h2>
          <div className="space-y-3">
            {sections.inProgress.map((job) => (
              <InProgressJobCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}

      {sections.completed.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--foreground-soft)]">
            Completed ({sections.completed.length})
          </h2>
          <div className="space-y-3">
            {sections.completed.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}

      {sections.failed.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--foreground-soft)]">
            Failed ({sections.failed.length})
          </h2>
          <div className="space-y-3">
            {sections.failed.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
