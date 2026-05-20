import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/health/route";

const ORIGINAL_APP_VERSION = process.env.APP_VERSION;

beforeEach(() => {
  (process.env as Record<string, string | undefined>).APP_VERSION = "1.2.3";
});

afterEach(() => {
  if (ORIGINAL_APP_VERSION === undefined) {
    delete (process.env as Record<string, string | undefined>).APP_VERSION;
  } else {
    (process.env as Record<string, string | undefined>).APP_VERSION = ORIGINAL_APP_VERSION;
  }
});

describe("GET /api/health", () => {
  it("returns 200 with version, status, uptime, and timestamp", async () => {
    const response = GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({
      version: "1.2.3",
      status: "ok",
    });
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  it("returns 'unknown' when APP_VERSION is not set", async () => {
    delete (process.env as Record<string, string | undefined>).APP_VERSION;

    const response = GET();
    const body = await response.json();
    expect(body.version).toBe("unknown");
  });
});
