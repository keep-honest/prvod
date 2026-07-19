// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/dashboard/walkthroughs";
let search = "";
const refreshMock = vi.fn();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/dashboard/_components/InProgressJobCard", () => ({
  InProgressJobCard: ({ job }: { job: { id: string; prTitle: string } }) => (
    <div data-testid={`in-progress-${job.id}`}>{job.prTitle}</div>
  ),
}));

vi.mock("@/app/dashboard/_components/ShareDialog", () => ({
  ShareDialog: () => null,
}));

vi.mock("@/app/dashboard/_components/JobCard", () => ({
  JobCard: ({ job }: { job: { id: string; prTitle: string } }) => (
    <div data-testid={`job-${job.id}`}>{job.prTitle}</div>
  ),
}));

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

const baseJob = {
  id: "job-1",
  status: "processing",
  currentStage: "scripting",
  repoFullName: "acme/repo",
  prNumber: 12,
  prTitle: "Initial",
  createdAt: "2026-05-13T10:00:00.000Z",
  completedAt: null,
  hasReview: false,
  elapsedMs: 1_000,
};

describe("dashboard freshness", () => {
  beforeEach(() => {
    pathname = "/dashboard/walkthroughs";
    search = "";
    refreshMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("disables sidebar link prefetch", async () => {
    const { DashboardSidebar } = await import("@/app/dashboard/_components/DashboardSidebar");
    const { container, root } = await render(
      <DashboardSidebar organizations={[]} />,
    );

    const links = Array.from(container.querySelectorAll("a[href^='/dashboard']"));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.getAttribute("data-prefetch") === "false")).toBe(true);
    await unmount(root);
  });

  it("shows an empty-accounts state when the org list is empty", async () => {
    const { DashboardSidebar } = await import("@/app/dashboard/_components/DashboardSidebar");
    const { container, root } = await render(
      <DashboardSidebar organizations={[]} />,
    );
    expect(container.textContent).toContain("No accounts");
    expect(container.textContent).not.toContain("load accounts");
    await unmount(root);
  });

  it("shows a load-failure state when organizations is null", async () => {
    const { DashboardSidebar } = await import("@/app/dashboard/_components/DashboardSidebar");
    const { container, root } = await render(
      <DashboardSidebar organizations={null} />,
    );
    expect(container.textContent).toContain("load accounts");
    expect(container.textContent).not.toContain("No accounts");
    await unmount(root);
  });

});

describe("JobCard error rendering", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders a translated user-facing message for known failure codes", async () => {
    vi.doUnmock("@/app/dashboard/_components/JobCard");
    const { JobCard } = await import("@/app/dashboard/_components/JobCard");
    const { __testing } = await import("@/lib/jobErrorMessages");
    const { container, root } = await render(
      <JobCard
        job={{
          id: "job-failed",
          status: "failed",
          repoFullName: "acme/repo",
          prNumber: 7,
          prTitle: "Failed PR",
          createdAt: "2026-05-13T10:00:00.000Z",
          completedAt: null,
          hasReview: false,
          errorCode: "LLM_RATE_LIMITED_EXHAUSTED",
        }}
      />,
    );
    const errNode = container.querySelector("[data-testid='job-error-message']");
    expect(errNode?.textContent).toBe(
      __testing.ERROR_CODE_MESSAGES.LLM_RATE_LIMITED_EXHAUSTED,
    );
    await unmount(root);
  });

  it("renders the default failure message for unknown error codes", async () => {
    vi.doUnmock("@/app/dashboard/_components/JobCard");
    const { JobCard } = await import("@/app/dashboard/_components/JobCard");
    const { __testing } = await import("@/lib/jobErrorMessages");
    const { container, root } = await render(
      <JobCard
        job={{
          id: "job-failed-unknown",
          status: "failed",
          repoFullName: "acme/repo",
          prNumber: 9,
          prTitle: "Mystery failure",
          createdAt: "2026-05-13T10:00:00.000Z",
          completedAt: null,
          hasReview: false,
          errorCode: null,
        }}
      />,
    );
    const errNode = container.querySelector("[data-testid='job-error-message']");
    expect(errNode?.textContent).toBe(__testing.DEFAULT_FAILURE_MESSAGE);
    await unmount(root);
  });

  it("does not render an error block for completed jobs", async () => {
    vi.doUnmock("@/app/dashboard/_components/JobCard");
    const { JobCard } = await import("@/app/dashboard/_components/JobCard");
    const { container, root } = await render(
      <JobCard
        job={{
          id: "job-done",
          status: "completed",
          repoFullName: "acme/repo",
          prNumber: 8,
          prTitle: "Done PR",
          createdAt: "2026-05-13T10:00:00.000Z",
          completedAt: "2026-05-13T10:02:00.000Z",
          hasReview: true,
          errorCode: "LLM_RATE_LIMITED_EXHAUSTED",
        }}
      />,
    );
    expect(container.querySelector("[data-testid='job-error-message']")).toBeNull();
    await unmount(root);
  });
});

describe("WalkthroughJobsPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("fetches all dashboard jobs for the selected org", async () => {
    const { buildWalkthroughJobsUrl } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    expect(buildWalkthroughJobsUrl(123)).toBe("/api/dashboard/jobs?status=all&org=123&limit=50");
  });

  it("polls from an initially empty list and renders returned sections", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: [
          { ...baseJob, id: "job-1", status: "processing", prTitle: "Running" },
          {
            ...baseJob,
            id: "job-2",
            status: "completed",
            prTitle: "Done",
            completedAt: "2026-05-13T10:02:00.000Z",
            hasReview: true,
            elapsedMs: null,
          },
          { ...baseJob, id: "job-3", status: "failed", prTitle: "Failed", elapsedMs: null },
        ],
      }),
    } as Response);

    const { WalkthroughJobsPoller } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { container, root } = await render(
      <WalkthroughJobsPoller initialJobs={[]} orgInstallationId={123} />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/jobs?status=all&org=123&limit=50",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(container.textContent).toContain("In Progress (1)");
    expect(container.textContent).toContain("Completed (1)");
    expect(container.textContent).toContain("Failed (1)");
    await unmount(root);
  });

  it("re-seeds local jobs when orgInstallationId changes", async () => {
    const fetchMock = vi.mocked(fetch);
    // Never-resolving fetch so the initial poll cannot overwrite seeded state.
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));

    const { WalkthroughJobsPoller } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { container, root } = await render(
      <WalkthroughJobsPoller initialJobs={[baseJob]} orgInstallationId={123} />,
    );
    expect(container.textContent).toContain("In Progress (1)");

    await act(async () => {
      root.render(
        <WalkthroughJobsPoller
          initialJobs={[{ ...baseJob, id: "job-org2", prTitle: "Org2 job" }]}
          orgInstallationId={456}
        />,
      );
    });
    expect(container.textContent).toContain("Org2 job");
    await unmount(root);
  });

  it("preserves the current snapshot when fetch returns non-ok", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const { WalkthroughJobsPoller, WALKTHROUGH_JOBS_POLL_INTERVAL_MS } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { container, root } = await render(
      <WalkthroughJobsPoller initialJobs={[baseJob]} orgInstallationId={123} />,
    );

    await act(async () => {
      vi.advanceTimersByTime(WALKTHROUGH_JOBS_POLL_INTERVAL_MS * 3);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("In Progress (1)");
    await unmount(root);
  });

  it("preserves the current snapshot when fetch rejects", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new Error("network"));

    const { WalkthroughJobsPoller, WALKTHROUGH_JOBS_POLL_INTERVAL_MS } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { container, root } = await render(
      <WalkthroughJobsPoller initialJobs={[baseJob]} orgInstallationId={123} />,
    );

    await act(async () => {
      vi.advanceTimersByTime(WALKTHROUGH_JOBS_POLL_INTERVAL_MS * 3);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("In Progress (1)");
    await unmount(root);
  });

  it("keeps the current snapshot when the response jobs field is not an array", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ jobs: "not-an-array" }),
    } as Response);

    const { WalkthroughJobsPoller, WALKTHROUGH_JOBS_POLL_INTERVAL_MS } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { container, root } = await render(
      <WalkthroughJobsPoller initialJobs={[baseJob]} orgInstallationId={123} />,
    );

    await act(async () => {
      vi.advanceTimersByTime(WALKTHROUGH_JOBS_POLL_INTERVAL_MS * 3);
      await Promise.resolve();
    });

    // Snapshot retained — the poller must not wipe jobs on contract drift.
    expect(container.textContent).toContain("In Progress (1)");
    warnSpy.mockRestore();
    await unmount(root);
  });

  it("shows a stale banner after repeated failures and clears it on success", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new Error("network down"));

    const { WalkthroughJobsPoller, WALKTHROUGH_JOBS_POLL_INTERVAL_MS } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { container, root } = await render(
      <WalkthroughJobsPoller initialJobs={[baseJob]} orgInstallationId={123} />,
    );

    // Below threshold: no banner yet (mount poll = 1 failure).
    expect(container.querySelector("[data-testid='poll-stale-banner']")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(WALKTHROUGH_JOBS_POLL_INTERVAL_MS * 3);
      await Promise.resolve();
    });

    const banner = container.querySelector("[data-testid='poll-stale-banner']");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Live updates paused");
    // Jobs stay visible alongside the banner.
    expect(container.textContent).toContain("In Progress (1)");

    // Recovery: next successful poll clears the banner.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ jobs: [baseJob] }),
    } as Response);

    await act(async () => {
      vi.advanceTimersByTime(WALKTHROUGH_JOBS_POLL_INTERVAL_MS);
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='poll-stale-banner']")).toBeNull();
    expect(container.textContent).toContain("In Progress (1)");
    warnSpy.mockRestore();
    await unmount(root);
  });

  it("stops polling after unmount", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ jobs: [] }),
    } as Response);

    const { WalkthroughJobsPoller, WALKTHROUGH_JOBS_POLL_INTERVAL_MS } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { root } = await render(
      <WalkthroughJobsPoller initialJobs={[]} orgInstallationId={123} />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    const callsBeforeUnmount = fetchMock.mock.calls.length;
    await unmount(root);

    await act(async () => {
      vi.advanceTimersByTime(WALKTHROUGH_JOBS_POLL_INTERVAL_MS * 5);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it("moves jobs between sections after a poll update", async () => {
    const fetchMock = vi.mocked(fetch);
    let resolveFetch: (response: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const { WalkthroughJobsPoller } = await import(
      "@/app/dashboard/_components/WalkthroughJobsPoller"
    );
    const { container, root } = await render(
      <WalkthroughJobsPoller initialJobs={[baseJob]} orgInstallationId={123} />,
    );
    expect(container.textContent).toContain("In Progress (1)");

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          jobs: [
            {
              ...baseJob,
              status: "completed",
              completedAt: "2026-05-13T10:02:00.000Z",
              hasReview: true,
              elapsedMs: null,
            },
          ],
        }),
      } as Response);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("In Progress (1)");
    expect(container.textContent).toContain("Completed (1)");
    await unmount(root);
  });
});
