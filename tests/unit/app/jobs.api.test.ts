import { describe, it, expect, afterEach } from "vitest";
import { POST as createJob } from "@/app/api/jobs/route";
import { GET as getJob } from "@/app/api/jobs/[id]/route";
import { POST as retryJob } from "@/app/api/jobs/[id]/retry/route";
import { resetContainer } from "@/config/container";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  } else {
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_NODE_ENV;
  }
  resetContainer();
});

describe("/api/jobs availability", () => {
  it("disables POST /api/jobs in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    const request = new Request("https://example.com/api/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const response = await createJob(request as never);
    expect(response.status).toBe(404);
  });

  it("disables GET /api/jobs/:id in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    const request = new Request("https://example.com/api/jobs/123", {
      method: "GET",
    });

    const response = await getJob(request as never, {
      params: Promise.resolve({ id: "123" }),
    });
    expect(response.status).toBe(404);
  });

  it("disables POST /api/jobs/:id/retry in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    const request = new Request("https://example.com/api/jobs/123/retry", {
      method: "POST",
    });

    const response = await retryJob(request as never, {
      params: Promise.resolve({ id: "123" }),
    });
    expect(response.status).toBe(404);
  });
});
