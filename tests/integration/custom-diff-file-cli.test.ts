import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unlinkSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetContainer, setContainer } from "@/config/container";
import { POST } from "@/app/api/jobs/route";
import { makeTestContainer, seedTestApiKey } from "./helpers/testContainer";

const VALID_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 000..111 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " context",
  "+added line",
  " unchanged",
].join("\n") + "\n";

const API_KEY_SECRET = "test-secret-key-for-diff-upload";

vi.stubEnv("API_SECRET_KEY", API_KEY_SECRET);
vi.stubEnv("APP_ENCRYPTION_KEY", "test-pepper");
vi.stubEnv("JOBS_API_ENABLED", "true");

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "diff-api-test-"));
});

afterEach(() => {
  resetContainer();
  try {
    for (const f of readdirSync(tempDir)) {
      unlinkSync(join(tempDir, f));
    }
  } catch { /* best-effort */ }
});

async function makeAuthedRequest(body: string, extraHeaders: Record<string, string> = {}) {
  const container = makeTestContainer();
  await seedTestApiKey(container.apiKeyRepository, API_KEY_SECRET);
  setContainer(container);

  const request = new NextRequest("http://localhost/api/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/x-git-diff",
      authorization: `Bearer ${API_KEY_SECRET}`,
      ...extraHeaders,
    },
    body,
  });

  const response = await POST(request);
  return { response, container };
}

describe("POST /api/jobs with application/x-git-diff", () => {
  it("returns 201 and creates a job for a valid diff", async () => {
    const { response, container } = await makeAuthedRequest(VALID_DIFF);

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; status: string };
    // Status may already be updated by async pipeline runner
    expect(["queued", "processing", "completed"]).toContain(body.status);
    expect(typeof body.id).toBe("string");

    // Job must exist in the repository
    const job = await container.jobRepository.findById(body.id);
    expect(job).not.toBeNull();
  });

  it("uses a synthetic repoFullName for local diff jobs", async () => {
    const { response, container } = await makeAuthedRequest(VALID_DIFF);

    const body = await response.json() as { id: string };
    const job = await container.jobRepository.findById(body.id);

    expect(job?.repoFullName).toMatch(/^local\/diff-/);
  });

  it("accepts prTitle query param and uses it as the job title", async () => {
    const container = makeTestContainer();
    await seedTestApiKey(container.apiKeyRepository, API_KEY_SECRET);
    setContainer(container);

    const request = new NextRequest(
      "http://localhost/api/jobs?prTitle=2025-04-22-git-diff",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-git-diff",
          authorization: `Bearer ${API_KEY_SECRET}`,
        },
        body: VALID_DIFF,
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(201);
  });

  it("returns 401 when no authorization header is present", async () => {
    const container = makeTestContainer();
    setContainer(container);

    const request = new NextRequest("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/x-git-diff" },
      body: VALID_DIFF,
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });
});
