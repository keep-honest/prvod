import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { MockInstallationRepository } from "@/mocks/MockInstallationRepository";

// Same pattern as dashboard-share.api.test.ts: stub the container module with
// mock repositories the test controls directly. The DB is never reached —
// the covered branches (400 invalid status, 404 unknown org) return earlier.
vi.mock("@/config/container", async () => {
  const { MockInstallationRepository } = await import("@/mocks/MockInstallationRepository");
  const installationRepository = new MockInstallationRepository();
  return {
    getContainer: async () => ({ installationRepository }),
    resetContainer: () => {},
  };
});

import { GET as getJobs } from "@/app/api/dashboard/jobs/route";
import { getContainer } from "@/config/container";

function makeRequest(query = "") {
  return new NextRequest(`http://localhost:3000/api/dashboard/jobs${query}`);
}

describe("GET /api/dashboard/jobs", () => {
  let installationRepository: MockInstallationRepository;

  beforeEach(async () => {
    const container = await getContainer();
    installationRepository =
      container.installationRepository as MockInstallationRepository;
    installationRepository.reset();
  });

  it("rejects an unknown status filter with 400", async () => {
    const response = await getJobs(makeRequest("?status=bogus"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("INVALID_STATUS");
    expect(body.message).toContain("in_progress");
  });

  it("rejects inherited-object-key status filters with 400", async () => {
    const response = await getJobs(makeRequest("?status=toString"));
    expect(response.status).toBe(400);
  });

  it("returns 404 when no installation matches the org param", async () => {
    await installationRepository.upsert({
      installationId: 100,
      accountLogin: "acme",
      accountType: "Organization",
    });
    const response = await getJobs(makeRequest("?org=999"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns 404 when there are no active installations at all", async () => {
    const response = await getJobs(makeRequest());
    expect(response.status).toBe(404);
  });
});
