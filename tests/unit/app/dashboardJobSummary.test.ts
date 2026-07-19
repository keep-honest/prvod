import { describe, it, expect } from "vitest";
import {
  STATUS_FILTER_MAP,
  clampLimit,
  clampPage,
  hasMorePages,
  resolveStatusFilter,
  toJobSummary,
  type JobSummaryRow,
} from "@/app/dashboard/jobSummary";

const NOW = new Date("2026-05-13T10:05:00.000Z").getTime();

function makeRow(overrides: Partial<JobSummaryRow> = {}): JobSummaryRow {
  return {
    id: "job-1",
    status: "completed",
    currentStage: null,
    repoFullName: "acme/repo",
    prNumber: 42,
    createdAt: new Date("2026-05-13T10:00:00.000Z"),
    completedAt: new Date("2026-05-13T10:02:00.000Z"),
    scriptJson: null,
    metricsJson: null,
    errorCode: null,
    ...overrides,
  };
}

describe("toJobSummary", () => {
  it("maps a completed row with metrics prTitle", () => {
    const summary = toJobSummary(
      makeRow({ metricsJson: { prTitle: "Add feature X" }, scriptJson: { scenes: [] } }),
      NOW,
    );
    expect(summary).toEqual({
      id: "job-1",
      status: "completed",
      currentStage: null,
      repoFullName: "acme/repo",
      prNumber: 42,
      prTitle: "Add feature X",
      createdAt: "2026-05-13T10:00:00.000Z",
      completedAt: "2026-05-13T10:02:00.000Z",
      hasReview: true,
      elapsedMs: null,
      errorCode: null,
    });
  });

  it("falls back to metrics title, then #prNumber", () => {
    expect(toJobSummary(makeRow({ metricsJson: { title: "Legacy title" } }), NOW).prTitle)
      .toBe("Legacy title");
    expect(toJobSummary(makeRow({ metricsJson: {} }), NOW).prTitle).toBe("#42");
    expect(toJobSummary(makeRow({ metricsJson: null }), NOW).prTitle).toBe("#42");
  });

  it("ignores non-string prTitle/title values in metrics", () => {
    expect(
      toJobSummary(makeRow({ metricsJson: { prTitle: 123, title: { nested: true } } }), NOW)
        .prTitle,
    ).toBe("#42");
    expect(
      toJobSummary(makeRow({ metricsJson: { prTitle: 123, title: "Real title" } }), NOW).prTitle,
    ).toBe("Real title");
  });

  it("ignores non-object metricsJson", () => {
    expect(toJobSummary(makeRow({ metricsJson: "corrupt" }), NOW).prTitle).toBe("#42");
  });

  it("computes elapsedMs only for queued/processing jobs", () => {
    const fiveMinutes = 5 * 60 * 1000;
    expect(
      toJobSummary(makeRow({ status: "queued", completedAt: null }), NOW).elapsedMs,
    ).toBe(fiveMinutes);
    expect(
      toJobSummary(makeRow({ status: "processing", completedAt: null }), NOW).elapsedMs,
    ).toBe(fiveMinutes);
    expect(toJobSummary(makeRow({ status: "completed" }), NOW).elapsedMs).toBeNull();
    expect(
      toJobSummary(makeRow({ status: "failed", completedAt: null }), NOW).elapsedMs,
    ).toBeNull();
  });

  it("derives hasReview from scriptJson presence", () => {
    expect(toJobSummary(makeRow({ scriptJson: null }), NOW).hasReview).toBe(false);
    expect(toJobSummary(makeRow({ scriptJson: { scenes: [] } }), NOW).hasReview).toBe(true);
  });

  it("passes through errorCode and currentStage", () => {
    const summary = toJobSummary(
      makeRow({ status: "failed", currentStage: "scripting", errorCode: "LLM_RATE_LIMITED_EXHAUSTED", completedAt: null }),
      NOW,
    );
    expect(summary.errorCode).toBe("LLM_RATE_LIMITED_EXHAUSTED");
    expect(summary.currentStage).toBe("scripting");
  });
});

describe("resolveStatusFilter", () => {
  it("resolves each known filter to its DB statuses", () => {
    expect(resolveStatusFilter("in_progress")).toEqual(["queued", "processing"]);
    expect(resolveStatusFilter("completed")).toEqual(["completed"]);
    expect(resolveStatusFilter("failed")).toEqual(["failed", "cancelled"]);
    expect(resolveStatusFilter("all")).toEqual(
      ["queued", "processing", "completed", "failed", "cancelled"],
    );
  });

  it("returns null for unknown filters", () => {
    expect(resolveStatusFilter("bogus")).toBeNull();
    expect(resolveStatusFilter("")).toBeNull();
    // Prototype pollution guard: inherited keys must not resolve
    expect(resolveStatusFilter("toString")).toBeNull();
  });

  it("exposes the same keys as STATUS_FILTER_MAP", () => {
    expect(Object.keys(STATUS_FILTER_MAP).sort()).toEqual(
      ["all", "completed", "failed", "in_progress"],
    );
  });
});

describe("pagination clamps", () => {
  it("clampPage defaults, floors at 1, and handles NaN", () => {
    expect(clampPage(null)).toBe(1);
    expect(clampPage("3")).toBe(3);
    expect(clampPage("0")).toBe(1);
    expect(clampPage("-5")).toBe(1);
    expect(clampPage("garbage")).toBe(1);
  });

  it("clampLimit defaults, clamps to 1..100, and handles NaN", () => {
    expect(clampLimit(null)).toBe(20);
    expect(clampLimit("50")).toBe(50);
    // "0" parses falsy, so it falls back to the default before clamping
    expect(clampLimit("0")).toBe(20);
    expect(clampLimit("-1")).toBe(1);
    expect(clampLimit("101")).toBe(100);
    expect(clampLimit("garbage")).toBe(20);
  });

  it("hasMorePages handles the off-by-one boundary", () => {
    // page 1 of exactly one full page: no more
    expect(hasMorePages(0, 20, 20)).toBe(false);
    // one extra row beyond the page: more
    expect(hasMorePages(0, 20, 21)).toBe(true);
    // last partial page consumed: no more
    expect(hasMorePages(20, 20, 21)).toBe(false);
    expect(hasMorePages(0, 20, 0)).toBe(false);
  });
});
