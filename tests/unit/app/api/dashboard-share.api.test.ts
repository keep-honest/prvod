import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { verifyToken } from "@/lib/shareToken";

// The real mock-container path resolves its mocks via aliased require() calls
// that Node cannot resolve under vitest, so stub the container module with a
// MockJobRepository the test controls directly.
vi.mock("@/config/container", async () => {
  const { MockJobRepository } = await import("@/mocks/MockJobRepository");
  const jobRepository = new MockJobRepository({ sharedStore: false });
  return {
    getContainer: async () => ({ jobRepository }),
    resetContainer: () => {},
  };
});

import { GET as getShareLink } from "@/app/api/dashboard/jobs/[jobId]/share/route";
import { getContainer } from "@/config/container";

const SECRET = "route-test-secret";

function makeRequest(jobId: string, query = "") {
  return new NextRequest(
    `http://localhost:3000/api/dashboard/jobs/${jobId}/share${query}`,
  );
}

function routeParams(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

describe("GET /api/dashboard/jobs/[jobId]/share", () => {
  beforeEach(() => {
    vi.stubEnv("SHARE_SIGNING_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an invalid type parameter", async () => {
    const response = await getShareLink(
      makeRequest("some-job", "?type=bogus"),
      routeParams("some-job"),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("INVALID_TYPE");
  });

  it("returns 500 when SHARE_SIGNING_SECRET is not configured", async () => {
    vi.stubEnv("SHARE_SIGNING_SECRET", "");
    const response = await getShareLink(
      makeRequest("some-job", "?type=video"),
      routeParams("some-job"),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("INTERNAL_ERROR");
  });

  it("returns 404 for an unknown job", async () => {
    const response = await getShareLink(
      makeRequest("does-not-exist", "?type=video"),
      routeParams("does-not-exist"),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns 404 for a job that has not completed", async () => {
    const container = await getContainer();
    const job = await container.jobRepository.create({
      repoFullName: "acme/repo",
      prNumber: 11,
    });

    const response = await getShareLink(
      makeRequest(job.id, "?type=video"),
      routeParams(job.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns a signed link for a completed job", async () => {
    const container = await getContainer();
    const job = await container.jobRepository.create({
      repoFullName: "acme/repo",
      prNumber: 12,
    });
    await container.jobRepository.updateStatus(job.id, "processing");
    await container.jobRepository.updateStatus(job.id, "completed", {
      videoUrl: "https://cdn.example.com/video.mp4",
    });

    const response = await getShareLink(
      makeRequest(job.id, "?type=video"),
      routeParams(job.id),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.type).toBe("video");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const url = new URL(body.url);
    expect(url.pathname).toBe(`/watch/${job.id}`);
    const payload = verifyToken(url.searchParams.get("token") ?? "", SECRET);
    expect(payload).toMatchObject({ jobId: job.id, type: "video" });
  });

  it("defaults to a full walkthrough link when type is omitted", async () => {
    const container = await getContainer();
    const job = await container.jobRepository.create({
      repoFullName: "acme/repo",
      prNumber: 13,
    });
    await container.jobRepository.updateStatus(job.id, "processing");
    await container.jobRepository.updateStatus(job.id, "completed", {
      videoUrl: "https://cdn.example.com/video.mp4",
    });

    const response = await getShareLink(makeRequest(job.id), routeParams(job.id));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.type).toBe("full");
    const url = new URL(body.url);
    expect(url.pathname).toBe(`/reviews/${job.id}`);
    expect(url.searchParams.get("shareToken")).toBeTruthy();
  });
});
