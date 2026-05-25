import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStorageUrlSecret,
  signLocalUrl,
  STORAGE_URL_PATH_PREFIX,
  STORAGE_URL_SECRET_ENV,
  verifyLocalUrl,
} from "@/lib/storage/signLocalUrl";

const SECRET = "test-secret-do-not-use-in-prod-".repeat(2); // 64 chars

describe("signLocalUrl", () => {
  it("returns a URL under /api/local-storage/ with exp + sig query params", () => {
    const url = signLocalUrl("videos/a/b/c.mp4", 3600, SECRET, () => 1_700_000_000_000);
    expect(url.startsWith(STORAGE_URL_PATH_PREFIX)).toBe(true);
    const u = new URL(url, "http://x");
    expect(u.pathname).toBe("/api/local-storage/videos/a/b/c.mp4");
    expect(u.searchParams.get("exp")).toBe(String(1_700_000_000 + 3600));
    expect(u.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("URL-encodes path segments containing reserved characters", () => {
    const url = signLocalUrl("videos/owner repo/a+b.mp4", 60, SECRET, () => 0);
    expect(url).toContain("/api/local-storage/videos/owner%20repo/a%2Bb.mp4");
  });

  it("preserves `/` as a path separator", () => {
    const url = signLocalUrl("videos/x/y/z.mp4", 60, SECRET, () => 0);
    const u = new URL(url, "http://x");
    expect(u.pathname).toBe("/api/local-storage/videos/x/y/z.mp4");
  });

  it("produces the same signature for the same inputs (determinism)", () => {
    const a = signLocalUrl("videos/x.mp4", 60, SECRET, () => 100_000_000);
    const b = signLocalUrl("videos/x.mp4", 60, SECRET, () => 100_000_000);
    expect(a).toBe(b);
  });

  it("produces different signatures when the secret changes", () => {
    const a = signLocalUrl("videos/x.mp4", 60, "secret-a", () => 100_000_000);
    const b = signLocalUrl("videos/x.mp4", 60, "secret-b", () => 100_000_000);
    expect(a).not.toBe(b);
  });
});

describe("verifyLocalUrl", () => {
  const now = () => 1_700_000_000_000;
  const KEY = "videos/owner/repo/12/abc.mp4";
  const EXP_SECONDS = 1_700_000_000 + 3600;

  function freshSig(): string {
    const url = signLocalUrl(KEY, 3600, SECRET, now);
    return new URL(url, "http://x").searchParams.get("sig")!;
  }

  it("accepts a valid signature within expiry", () => {
    const sig = freshSig();
    expect(verifyLocalUrl(KEY, String(EXP_SECONDS), sig, SECRET, now)).toEqual({
      valid: true,
    });
  });

  it("rejects when sig is missing", () => {
    expect(verifyLocalUrl(KEY, String(EXP_SECONDS), null, SECRET, now)).toEqual({
      valid: false,
      reason: "missing",
    });
  });

  it("rejects when exp is missing", () => {
    expect(verifyLocalUrl(KEY, null, freshSig(), SECRET, now)).toEqual({
      valid: false,
      reason: "missing",
    });
  });

  it("rejects sig with wrong length", () => {
    expect(verifyLocalUrl(KEY, String(EXP_SECONDS), "deadbeef", SECRET, now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects sig with non-hex characters", () => {
    const badSig = "z".repeat(64);
    expect(verifyLocalUrl(KEY, String(EXP_SECONDS), badSig, SECRET, now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects tampered sig (one bit flipped)", () => {
    const sig = freshSig();
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(verifyLocalUrl(KEY, String(EXP_SECONDS), flipped, SECRET, now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects when key is tampered but sig is left unchanged", () => {
    const sig = freshSig();
    expect(verifyLocalUrl("videos/other.mp4", String(EXP_SECONDS), sig, SECRET, now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects when exp is tampered but sig is left unchanged", () => {
    const sig = freshSig();
    // Bumping exp by 1 second invalidates the signature.
    expect(verifyLocalUrl(KEY, String(EXP_SECONDS + 1), sig, SECRET, now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects when exp is in the past (signature was valid)", () => {
    // Mint a URL that expires far in the past relative to the verify clock.
    const past = () => 0;
    const url = signLocalUrl(KEY, 1, SECRET, past); // exp = 1
    const sig = new URL(url, "http://x").searchParams.get("sig")!;
    const future = () => 1_700_000_000_000;
    expect(verifyLocalUrl(KEY, "1", sig, SECRET, future)).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rejects malformed exp (non-numeric)", () => {
    expect(verifyLocalUrl(KEY, "abc", freshSig(), SECRET, now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects sig of different length without throwing (length-mismatch guard)", () => {
    // Pass a 64-hex sig that isn't ours — should never throw.
    expect(() =>
      verifyLocalUrl(KEY, String(EXP_SECONDS), "0".repeat(64), SECRET, now),
    ).not.toThrow();
  });

  it("rejects when secret is different (effective rotation)", () => {
    const sig = freshSig();
    expect(verifyLocalUrl(KEY, String(EXP_SECONDS), sig, "different-secret", now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });
});

describe("readStorageUrlSecret", () => {
  const ORIGINAL = process.env[STORAGE_URL_SECRET_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined) Reflect.deleteProperty(process.env, STORAGE_URL_SECRET_ENV);
    else process.env[STORAGE_URL_SECRET_ENV] = ORIGINAL;
    vi.unstubAllEnvs();
  });

  it("returns the env value when set", () => {
    vi.stubEnv(STORAGE_URL_SECRET_ENV, "abc123");
    expect(readStorageUrlSecret()).toBe("abc123");
  });

  it("throws with remediation hint when unset", () => {
    vi.stubEnv(STORAGE_URL_SECRET_ENV, "");
    expect(() => readStorageUrlSecret()).toThrow(/openssl rand -hex 32/);
  });
});
