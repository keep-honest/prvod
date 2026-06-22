import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildReviewPageUrl,
  PRIVATE_REPO_REVIEW_TOKEN_TTL_SECONDS,
} from "@/app/api/webhook/github/reviewPageUrl";
import { verifyToken } from "@/lib/shareToken";

const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";
const APP_URL = "https://prvod.example";
const SECRET = "test-secret-that-is-at-least-32-chars-long-ok";

describe("buildReviewPageUrl", () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
  const ORIGINAL_SECRET = process.env.SHARE_SIGNING_SECRET;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    process.env.SHARE_SIGNING_SECRET = SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
    if (ORIGINAL_SECRET === undefined) delete process.env.SHARE_SIGNING_SECRET;
    else process.env.SHARE_SIGNING_SECRET = ORIGINAL_SECRET;
  });

  it("public repo: returns bare URL without share token", () => {
    const url = buildReviewPageUrl(JOB_ID, { repoIsPrivate: false });
    expect(url).toBe(`${APP_URL}/reviews/${JOB_ID}`);
    expect(url).not.toContain("shareToken");
  });

  it("private repo: returns URL with shareToken query param", () => {
    const url = buildReviewPageUrl(JOB_ID, { repoIsPrivate: true });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/reviews/${JOB_ID}`);
    expect(parsed.searchParams.get("shareToken")).toBeTruthy();
  });

  it("private-repo shareToken verifies, has full type, matches jobId, and respects 180d TTL", () => {
    const url = buildReviewPageUrl(JOB_ID, { repoIsPrivate: true });
    const token = new URL(url).searchParams.get("shareToken")!;

    const payload = verifyToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.jobId).toBe(JOB_ID);
    expect(payload!.type).toBe("full");

    const nowSec = Math.floor(Date.now() / 1000);
    const expectedExp = nowSec + PRIVATE_REPO_REVIEW_TOKEN_TTL_SECONDS;
    // Allow 5s skew for test execution latency.
    expect(payload!.exp).toBeGreaterThanOrEqual(expectedExp - 5);
    expect(payload!.exp).toBeLessThanOrEqual(expectedExp + 5);
  });

  it("private-repo shareToken is rejected by a different secret (defends against secret rotation/leak)", () => {
    const url = buildReviewPageUrl(JOB_ID, { repoIsPrivate: true });
    const token = new URL(url).searchParams.get("shareToken")!;
    expect(verifyToken(token, "different-secret-of-sufficient-length-ok-ok")).toBeNull();
  });

  it("private repo + missing SHARE_SIGNING_SECRET: throws (refuses bare link for private repo)", () => {
    delete process.env.SHARE_SIGNING_SECRET;
    expect(() => buildReviewPageUrl(JOB_ID, { repoIsPrivate: true })).toThrow(
      /SHARE_SIGNING_SECRET not configured/,
    );
  });

  it("strips trailing slash from NEXT_PUBLIC_APP_URL before joining", () => {
    process.env.NEXT_PUBLIC_APP_URL = `${APP_URL}/`;
    const url = buildReviewPageUrl(JOB_ID, { repoIsPrivate: false });
    expect(url).toBe(`${APP_URL}/reviews/${JOB_ID}`);
  });

  it("URL-encodes the jobId for public repos (defense-in-depth — jobIds should already be UUIDs)", () => {
    const url = buildReviewPageUrl("abc/../etc", { repoIsPrivate: false });
    expect(url).toBe(`${APP_URL}/reviews/${encodeURIComponent("abc/../etc")}`);
    expect(url).not.toContain("/../");
  });

  it("throws when NEXT_PUBLIC_APP_URL is malformed", () => {
    process.env.NEXT_PUBLIC_APP_URL = "not a valid url";
    expect(() => buildReviewPageUrl(JOB_ID, { repoIsPrivate: false })).toThrow(/Invalid review page URL/);
  });
});
