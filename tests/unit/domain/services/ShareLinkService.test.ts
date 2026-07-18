import { describe, it, expect } from "vitest";
import { ShareLinkService } from "@/domain/services/ShareLinkService";
import { MockJobRepository } from "@/mocks/MockJobRepository";
import { verifyToken } from "@/lib/shareToken";

const SECRET = "test-share-secret";
const BASE_URL = "https://prvod.test";

async function makeCompletedJob(repo: MockJobRepository) {
  const job = await repo.create({ repoFullName: "acme/repo", prNumber: 42 });
  await repo.updateStatus(job.id, "processing");
  return repo.updateStatus(job.id, "completed", {
    videoUrl: "https://cdn.example.com/video.mp4",
  });
}

describe("ShareLinkService", () => {
  it("returns null for an unknown job", async () => {
    const repo = new MockJobRepository({ sharedStore: false });
    const service = new ShareLinkService(repo, SECRET);

    const result = await service.generateLink("nonexistent", "video", BASE_URL);
    expect(result).toBeNull();
  });

  it("returns null for a job that is not completed", async () => {
    const repo = new MockJobRepository({ sharedStore: false });
    const job = await repo.create({ repoFullName: "acme/repo", prNumber: 1 });
    const service = new ShareLinkService(repo, SECRET);

    const result = await service.generateLink(job.id, "video", BASE_URL);
    expect(result).toBeNull();
  });

  it("returns null for a completed job without a video", async () => {
    const repo = new MockJobRepository({ sharedStore: false });
    const job = await repo.create({ repoFullName: "acme/repo", prNumber: 2 });
    await repo.updateStatus(job.id, "processing");
    await repo.updateStatus(job.id, "completed");
    const service = new ShareLinkService(repo, SECRET);

    const result = await service.generateLink(job.id, "video", BASE_URL);
    expect(result).toBeNull();
  });

  it("generates a signed video link for a completed job", async () => {
    const repo = new MockJobRepository({ sharedStore: false });
    const job = await makeCompletedJob(repo);
    const service = new ShareLinkService(repo, SECRET);

    const result = await service.generateLink(job.id, "video", BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.url.startsWith(`${BASE_URL}/watch/${job.id}?token=`)).toBe(true);
    expect(result!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const token = new URL(result!.url).searchParams.get("token");
    const payload = verifyToken(token ?? "", SECRET);
    expect(payload).toMatchObject({ jobId: job.id, type: "video" });
  });

  it("generates a signed full-walkthrough link for a completed job", async () => {
    const repo = new MockJobRepository({ sharedStore: false });
    const job = await makeCompletedJob(repo);
    const service = new ShareLinkService(repo, SECRET);

    const result = await service.generateLink(job.id, "full", BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.url.startsWith(`${BASE_URL}/reviews/${job.id}?shareToken=`)).toBe(true);

    const token = new URL(result!.url).searchParams.get("shareToken");
    const payload = verifyToken(token ?? "", SECRET);
    expect(payload).toMatchObject({ jobId: job.id, type: "full" });
  });
});
