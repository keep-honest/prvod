import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/local-storage/[...key]/route";
import { parseRange } from "@/lib/storage/parseRange";
import { signLocalUrl, STORAGE_URL_SECRET_ENV } from "@/lib/storage/signLocalUrl";

const TEST_SECRET = "x".repeat(64);

async function bodyToBuffer(res: Response): Promise<Buffer> {
  const blob = await res.blob();
  return Buffer.from(await blob.arrayBuffer());
}

/** Construct a NextRequest from a signed key with optional Range header. */
function buildRequest(opts: {
  key: string;
  sig?: string | null;
  exp?: string | null;
  range?: string;
  /** When true, build a default-signed URL via signLocalUrl. */
  signed?: boolean;
  expirySeconds?: number;
  now?: () => number;
}): NextRequest {
  let pathname = `/api/local-storage/${opts.key}`;
  const params = new URLSearchParams();
  if (opts.signed) {
    const url = signLocalUrl(
      opts.key,
      opts.expirySeconds ?? 3600,
      TEST_SECRET,
      opts.now,
    );
    // Extract sig + exp from the signed URL to honour any overrides below.
    const u = new URL(url, "http://localhost");
    pathname = u.pathname;
    if (u.searchParams.get("exp")) params.set("exp", u.searchParams.get("exp")!);
    if (u.searchParams.get("sig")) params.set("sig", u.searchParams.get("sig")!);
  }
  if (opts.exp !== undefined && opts.exp !== null) params.set("exp", opts.exp);
  else if (opts.exp === null) params.delete("exp");
  if (opts.sig !== undefined && opts.sig !== null) params.set("sig", opts.sig);
  else if (opts.sig === null) params.delete("sig");

  const url = `http://localhost${pathname}?${params.toString()}`;
  const headers: HeadersInit = opts.range ? { range: opts.range } : {};
  return new NextRequest(url, { headers });
}

/** Build the routeContext object the handler expects. */
function buildContext(key: string): { params: Promise<{ key: string[] }> } {
  return { params: Promise.resolve({ key: key.split("/") }) };
}

describe("GET /api/local-storage/[...key]", () => {
  let tmpDir: string;
  let originalStorageDir: string | undefined;
  let originalSecret: string | undefined;
  let originalUseLocal: string | undefined;
  let originalProvider: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ls-route-test-"));
    originalStorageDir = process.env.LOCAL_STORAGE_DIR;
    originalSecret = process.env[STORAGE_URL_SECRET_ENV];
    originalUseLocal = process.env.USE_LOCAL_STORAGE;
    originalProvider = process.env.STORAGE_PROVIDER;
    process.env.LOCAL_STORAGE_DIR = tmpDir;
    process.env[STORAGE_URL_SECRET_ENV] = TEST_SECRET;
    process.env.USE_LOCAL_STORAGE = "true";
    delete process.env.STORAGE_PROVIDER;
    // Pre-populate a video file used by most tests.
    await fs.mkdir(path.join(tmpDir, "videos"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "videos", "demo.mp4"), Buffer.alloc(1000, "v"));
  });

  afterEach(async () => {
    if (originalStorageDir !== undefined) process.env.LOCAL_STORAGE_DIR = originalStorageDir;
    else delete process.env.LOCAL_STORAGE_DIR;
    if (originalSecret !== undefined) process.env[STORAGE_URL_SECRET_ENV] = originalSecret;
    else Reflect.deleteProperty(process.env, STORAGE_URL_SECRET_ENV);
    if (originalUseLocal !== undefined) process.env.USE_LOCAL_STORAGE = originalUseLocal;
    else delete process.env.USE_LOCAL_STORAGE;
    if (originalProvider !== undefined) process.env.STORAGE_PROVIDER = originalProvider;
    else delete process.env.STORAGE_PROVIDER;
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── Gating ──────────────────────────────────────────────────────────

  it("returns 404 when USE_LOCAL_STORAGE is unset and STORAGE_PROVIDER is not local", async () => {
    delete process.env.USE_LOCAL_STORAGE;
    process.env.STORAGE_PROVIDER = "r2";
    const req = buildRequest({ key: "videos/demo.mp4", signed: true });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when STORAGE_PROVIDER=local even without USE_LOCAL_STORAGE", async () => {
    delete process.env.USE_LOCAL_STORAGE;
    process.env.STORAGE_PROVIDER = "local";
    const req = buildRequest({ key: "videos/demo.mp4", signed: true });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(200); // gate passes; file exists
  });

  // ── Signature verification ──────────────────────────────────────────

  it("returns 401 when sig is missing", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", exp: "9999999999", sig: null });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when exp is missing", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", exp: null, sig: "0".repeat(64) });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when sig is wrong length", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, sig: "deadbeef" });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when sig is tampered (one byte flipped)", async () => {
    const signed = signLocalUrl("videos/demo.mp4", 3600, TEST_SECRET);
    const realSig = new URL(signed, "http://x").searchParams.get("sig")!;
    const flipped = (realSig[0] === "0" ? "1" : "0") + realSig.slice(1);
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, sig: flipped });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when exp is in the past", async () => {
    const past = () => 1_700_000_000_000; // mint at this time
    const future = () => 9_999_999_999_999;
    vi.spyOn(Date, "now").mockImplementation(future);
    // Mint URL with the "past" clock, exp = past + 1 second.
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, expirySeconds: 1, now: past });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when key is tampered but sig is unchanged", async () => {
    // Sign for videos/demo.mp4 but request videos/other.mp4
    const signed = signLocalUrl("videos/demo.mp4", 3600, TEST_SECRET);
    const u = new URL(signed, "http://x");
    const url = `http://localhost/api/local-storage/videos/other.mp4?${u.searchParams.toString()}`;
    const req = new NextRequest(url);
    const res = await GET(req, buildContext("videos/other.mp4"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when exp is tampered but sig is unchanged", async () => {
    const signed = signLocalUrl("videos/demo.mp4", 3600, TEST_SECRET);
    const u = new URL(signed, "http://x");
    const sig = u.searchParams.get("sig")!;
    const tamperedExp = String(Number(u.searchParams.get("exp")) + 1);
    const req = buildRequest({ key: "videos/demo.mp4", exp: tamperedExp, sig });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(401);
  });

  it("all 401 responses share the same body and headers", async () => {
    const cases = [
      buildRequest({ key: "videos/demo.mp4", exp: "9999999999", sig: null }),
      buildRequest({ key: "videos/demo.mp4", exp: null, sig: "0".repeat(64) }),
      buildRequest({ key: "videos/demo.mp4", signed: true, sig: "deadbeef" }),
    ];
    const responses = await Promise.all(
      cases.map((req) => GET(req, buildContext("videos/demo.mp4"))),
    );
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(bodies.every((b) => b === bodies[0])).toBe(true);
    expect(responses.every((r) => r.headers.get("Cache-Control") === responses[0].headers.get("Cache-Control"))).toBe(true);
  });

  // ── Path safety (signature must be valid first to reach these) ──────

  it("returns 404 for keys outside videos/ prefix", async () => {
    // Pre-populate a non-video file
    await fs.mkdir(path.join(tmpDir, "audio"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "audio", "x.ogg"), Buffer.from("x"));
    const req = buildRequest({ key: "audio/x.ogg", signed: true });
    const res = await GET(req, buildContext("audio/x.ogg"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for path traversal segments", async () => {
    // Sign the literal hostile key so the signature passes; the traversal
    // guard rejects after.
    const req = buildRequest({ key: "videos/../../etc/passwd", signed: true });
    const res = await GET(req, buildContext("videos/../../etc/passwd"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for null-byte injection in segments", async () => {
    const req = buildRequest({ key: "videos/demo\0.mp4", signed: true });
    const res = await GET(req, buildContext("videos/demo\0.mp4"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for missing file", async () => {
    const req = buildRequest({ key: "videos/missing.mp4", signed: true });
    const res = await GET(req, buildContext("videos/missing.mp4"));
    expect(res.status).toBe(404);
  });

  // ── Streaming ───────────────────────────────────────────────────────

  it("returns 200 with full body when no Range header", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("1000");
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    const body = await bodyToBuffer(res);
    expect(body.length).toBe(1000);
  });

  it("returns 206 with correct Content-Range for bytes=0-99", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, range: "bytes=0-99" });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("Content-Length")).toBe("100");
    const body = await bodyToBuffer(res);
    expect(body.length).toBe(100);
  });

  it("returns 206 suffix for bytes=-500", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, range: "bytes=-500" });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 500-999/1000");
    expect(res.headers.get("Content-Length")).toBe("500");
  });

  it("returns 206 open-ended for bytes=100-", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, range: "bytes=100-" });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-999/1000");
    expect(res.headers.get("Content-Length")).toBe("900");
  });

  it("returns 416 for multi-range", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, range: "bytes=0-100,200-300" });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("returns 416 for out-of-bounds range", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true, range: "bytes=2000-3000" });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("sets Cache-Control: private, no-store and X-Content-Type-Options: nosniff", async () => {
    const req = buildRequest({ key: "videos/demo.mp4", signed: true });
    const res = await GET(req, buildContext("videos/demo.mp4"));
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns video/mp4 for .mp4 and application/octet-stream for unknown extension", async () => {
    // Create an unknown-extension file
    await fs.writeFile(path.join(tmpDir, "videos", "weird.xyz"), Buffer.from("z"));
    const req = buildRequest({ key: "videos/weird.xyz", signed: true });
    const res = await GET(req, buildContext("videos/weird.xyz"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});

describe("parseRange", () => {
  it("returns null for missing header", () => {
    expect(parseRange(null, 100)).toBeNull();
  });
  it("returns malformed for header without bytes= prefix", () => {
    expect(parseRange("rows=0-10", 100)).toEqual({ kind: "malformed" });
  });
  it("parses bytes=0-99", () => {
    expect(parseRange("bytes=0-99", 100)).toEqual({ kind: "ok", start: 0, end: 99 });
  });
  it("parses suffix bytes=-50 against size=100", () => {
    expect(parseRange("bytes=-50", 100)).toEqual({ kind: "ok", start: 50, end: 99 });
  });
  it("parses open-ended bytes=20-", () => {
    expect(parseRange("bytes=20-", 100)).toEqual({ kind: "ok", start: 20, end: 99 });
  });
  it("rejects multi-range as unsatisfiable", () => {
    expect(parseRange("bytes=0-10,20-30", 100)).toEqual({ kind: "unsatisfiable" });
  });
  it("returns unsatisfiable for start >= size", () => {
    expect(parseRange("bytes=100-200", 100)).toEqual({ kind: "unsatisfiable" });
  });
  it("returns unsatisfiable when size=0", () => {
    expect(parseRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });
  it("returns malformed for negative-only ranges", () => {
    expect(parseRange("bytes=--5", 100)).toEqual({ kind: "malformed" });
  });
});
