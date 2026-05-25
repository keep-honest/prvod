import { describe, expect, it } from "vitest";
import { normalizeStoredVideoUrl } from "@/lib/storage/normalizeStoredVideoUrl";

describe("normalizeStoredVideoUrl", () => {
  it("returns null for legacy file:// URL (forces caller to re-sign)", () => {
    expect(
      normalizeStoredVideoUrl("file:///Users/me/.local-storage/videos/x.mp4"),
    ).toBeNull();
  });

  it("passes through https:// URLs unchanged", () => {
    const url = "https://example.s3.amazonaws.com/videos/x.mp4?sig=abc";
    expect(normalizeStoredVideoUrl(url)).toBe(url);
  });

  it("passes through /api/local-storage/... URLs unchanged", () => {
    const url = "/api/local-storage/videos/x.mp4?exp=1&sig=ab";
    expect(normalizeStoredVideoUrl(url)).toBe(url);
  });

  it("returns null for null input", () => {
    expect(normalizeStoredVideoUrl(null)).toBeNull();
  });
});
