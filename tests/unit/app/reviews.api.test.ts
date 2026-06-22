import { describe, it, expect, vi, beforeEach } from "vitest";

const loadReviewPageMock = vi.fn();

vi.mock("@/lib/reviews/loadReviewPage", () => ({
  loadReviewPage: (...args: unknown[]) => loadReviewPageMock(...args),
}));

import { GET as getReview } from "@/app/api/reviews/[jobId]/route";

const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("GET /api/reviews/[jobId] shareToken forwarding", () => {
  beforeEach(() => {
    loadReviewPageMock.mockReset();
  });

  it("forwards shareToken=undefined when query param is absent", async () => {
    loadReviewPageMock.mockResolvedValueOnce({ ok: true, payload: { jobId: JOB_ID } });
    const request = new Request(`https://example.com/api/reviews/${JOB_ID}`);
    const response = await getReview(request, { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(200);
    expect(loadReviewPageMock).toHaveBeenCalledWith({ jobId: JOB_ID, shareToken: undefined });
  });

  it("forwards the shareToken query param verbatim to loadReviewPage", async () => {
    loadReviewPageMock.mockResolvedValueOnce({ ok: true, payload: { jobId: JOB_ID } });
    const token = "abc123.deadbeef";
    const request = new Request(
      `https://example.com/api/reviews/${JOB_ID}?shareToken=${encodeURIComponent(token)}`,
    );
    const response = await getReview(request, { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(200);
    expect(loadReviewPageMock).toHaveBeenCalledWith({ jobId: JOB_ID, shareToken: token });
  });

  it("propagates 404 NOT_FOUND from loader (e.g. missing/invalid token on private repo)", async () => {
    loadReviewPageMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "NOT_FOUND",
      message: "Review page not found",
    });
    const request = new Request(`https://example.com/api/reviews/${JOB_ID}`);
    const response = await getReview(request, { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "NOT_FOUND", message: "Review page not found" });
  });

  it("propagates 503 SERVICE_UNAVAILABLE from loader (e.g. missing SHARE_SIGNING_SECRET)", async () => {
    loadReviewPageMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "SERVICE_UNAVAILABLE",
      message: "Review page services are unavailable",
    });
    const request = new Request(`https://example.com/api/reviews/${JOB_ID}`);
    const response = await getReview(request, { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(503);
  });

  it("ignores other query params (only shareToken matters here)", async () => {
    loadReviewPageMock.mockResolvedValueOnce({ ok: true, payload: { jobId: JOB_ID } });
    const request = new Request(
      `https://example.com/api/reviews/${JOB_ID}?shareToken=tok.sig&utm_source=x&debug=1`,
    );
    await getReview(request, { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(loadReviewPageMock).toHaveBeenCalledWith({ jobId: JOB_ID, shareToken: "tok.sig" });
  });
});
