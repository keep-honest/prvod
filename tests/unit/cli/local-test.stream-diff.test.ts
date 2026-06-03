import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { APIError, createJobFromDiffStream, mapDiffExitCode, parseArgs } from "@/cli/local-test";

// Base argv so serverUrl and apiKey validation pass
const BASE_ARGV = ["node", "cli.ts", "--server-url", "http://localhost:3000", "--api-key", "test-key"];

let tempDir: string;
let exitSpy: { mockRestore(): void };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cli-stream-test-"));
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined): never => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  exitSpy.mockRestore();
  try {
    for (const f of readdirSync(tempDir)) {
      unlinkSync(join(tempDir, f));
    }
  } catch { /* best-effort */ }
});

function writeDiffFile(name: string, content: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const VALID_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 000..111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 context
+added line
 unchanged
`;

describe("parseArgs --stream-diff", () => {
  it("defaults streamDiff to true when no flag is passed", () => {
    const args = parseArgs(BASE_ARGV);
    expect(args.streamDiff).toBe(true);
  });

  it("keeps streamDiff true when --stream-diff is passed explicitly", () => {
    const args = parseArgs([...BASE_ARGV, "--stream-diff"]);
    expect(args.streamDiff).toBe(true);
  });

  it("sets streamDiff to false when --no-stream-diff is passed", () => {
    const args = parseArgs([...BASE_ARGV, "--no-stream-diff"]);
    expect(args.streamDiff).toBe(false);
  });

  it("exits 2 when --stream-diff and --no-stream-diff are both passed", () => {
    expect(() =>
      parseArgs([...BASE_ARGV, "--stream-diff", "--no-stream-diff"]),
    ).toThrow("process.exit(2)");
  });

  it("treats --stream-diff=false as opt-out (parity with Go)", () => {
    const args = parseArgs([...BASE_ARGV, "--stream-diff=false"]);
    expect(args.streamDiff).toBe(false);
  });

  it("treats --stream-diff=true as explicit-on", () => {
    const args = parseArgs([...BASE_ARGV, "--stream-diff=true"]);
    expect(args.streamDiff).toBe(true);
  });

  it("exits 2 when --stream-diff=garbage is passed", () => {
    expect(() =>
      parseArgs([...BASE_ARGV, "--stream-diff=maybe"]),
    ).toThrow("process.exit(2)");
  });

  it("exits 2 when --stream-diff=true and --no-stream-diff are both passed", () => {
    expect(() =>
      parseArgs([...BASE_ARGV, "--stream-diff=true", "--no-stream-diff"]),
    ).toThrow("process.exit(2)");
  });

  describe("explicit --stream-diff mutual exclusion (exit code 2)", () => {
    it("exits 2 when combined with --diff-file (explicit form)", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p, "--stream-diff"]),
      ).toThrow("process.exit(2)");
    });

    it("exits 2 when combined with --retry-job (explicit form)", () => {
      expect(() =>
        parseArgs([...BASE_ARGV, "--stream-diff", "--retry-job", "some-uuid"]),
      ).toThrow("process.exit(2)");
    });
  });

  describe("default-streaming + --pr-number (exit code 2)", () => {
    it("exits 2 when --pr-number is set with default streaming", () => {
      // No --stream-diff token: streaming is the default and --pr-number is
      // ignored by the server, so the parser should refuse without it.
      expect(() =>
        parseArgs([...BASE_ARGV, "--pr-number", "42"]),
      ).toThrow("process.exit(2)");
    });

    it("exits 2 for --pr-number=N (equals form) with default streaming", () => {
      expect(() =>
        parseArgs([...BASE_ARGV, "--pr-number=42"]),
      ).toThrow("process.exit(2)");
    });

    it("emits the migration hint pointing at --no-stream-diff", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(() =>
          parseArgs([...BASE_ARGV, "--pr-number", "42"]),
        ).toThrow("process.exit(2)");
        const combined = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(combined).toContain("--no-stream-diff");
        expect(combined).toContain("--pr-number");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("accepts --pr-number when --no-stream-diff is also passed", () => {
      const args = parseArgs([...BASE_ARGV, "--no-stream-diff", "--pr-number", "42"]);
      expect(args.streamDiff).toBe(false);
      expect(args.prNumber).toBe(42);
    });

    it("accepts --pr-number when --stream-diff=false is also passed", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff=false", "--pr-number", "42"]);
      expect(args.streamDiff).toBe(false);
      expect(args.prNumber).toBe(42);
    });
  });

  describe("--diff-file mode coexists with the streaming default", () => {
    it("does not error when --diff-file is set and --stream-diff is the implicit default", () => {
      // Plain `--diff-file foo` users should not be forced to also pass
      // --no-stream-diff just because streaming is the new default.
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      const args = parseArgs([...BASE_ARGV, "--diff-file", p]);
      expect(args.diffFile).toBe(p);
    });

    it("does not error when --retry-job is set and streaming is the implicit default", () => {
      const args = parseArgs([...BASE_ARGV, "--retry-job", "some-uuid"]);
      expect(args.retryJob).toBe("some-uuid");
    });

    it("accepts --stream-diff=false + --diff-file (parity with --no-stream-diff)", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      const args = parseArgs([...BASE_ARGV, "--stream-diff=false", "--diff-file", p]);
      expect(args.diffFile).toBe(p);
      expect(args.streamDiff).toBe(false);
    });

    it("accepts --stream-diff=false + --retry-job (parity with --no-stream-diff)", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff=false", "--retry-job", "uuid"]);
      expect(args.retryJob).toBe("uuid");
      expect(args.streamDiff).toBe(false);
    });

    it("accepts --no-stream-diff + --diff-file", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      const args = parseArgs([...BASE_ARGV, "--no-stream-diff", "--diff-file", p]);
      expect(args.diffFile).toBe(p);
      expect(args.streamDiff).toBe(false);
    });

    it("accepts --no-stream-diff + --retry-job", () => {
      const args = parseArgs([...BASE_ARGV, "--no-stream-diff", "--retry-job", "uuid"]);
      expect(args.retryJob).toBe("uuid");
      expect(args.streamDiff).toBe(false);
    });
  });

  describe("compatible flags (no exit)", () => {
    it("accepts --stream-diff with --title", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff", "--title", "Custom title"]);
      expect(args.streamDiff).toBe(true);
      expect(args.title).toBe("Custom title");
    });

    it("accepts --stream-diff with --uncommitted", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff", "--uncommitted"]);
      expect(args.streamDiff).toBe(true);
      expect(args.uncommitted).toBe(true);
    });

    it("accepts --stream-diff with --script-only", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff", "--script-only"]);
      expect(args.streamDiff).toBe(true);
      expect(args.scriptOnly).toBe(true);
    });

    it("accepts --stream-diff with --tts-only", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff", "--tts-only"]);
      expect(args.streamDiff).toBe(true);
      expect(args.ttsOnly).toBe(true);
    });

    it("accepts --stream-diff with --short-dur", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff", "--short-dur"]);
      expect(args.streamDiff).toBe(true);
      expect(args.shortDur).toBe(true);
    });

    it("accepts --stream-diff with --popcorn", () => {
      const args = parseArgs([...BASE_ARGV, "--stream-diff", "--popcorn"]);
      expect(args.streamDiff).toBe(true);
      expect(args.popcorn).toBe(true);
    });
  });
});

describe("mapDiffExitCode", () => {
  it("maps DIFF_TOO_LARGE to 5", () => {
    expect(mapDiffExitCode("DIFF_TOO_LARGE")).toBe(5);
  });

  it("maps DIFF_PARSE_ERROR to 6", () => {
    expect(mapDiffExitCode("DIFF_PARSE_ERROR")).toBe(6);
  });

  it("maps DIFF_FETCH_TIMEOUT to 7", () => {
    expect(mapDiffExitCode("DIFF_FETCH_TIMEOUT")).toBe(7);
  });

  it("maps unknown codes to 1", () => {
    expect(mapDiffExitCode("WHATEVER")).toBe(1);
  });

  it("maps null/undefined/empty to 1", () => {
    expect(mapDiffExitCode(null)).toBe(1);
    expect(mapDiffExitCode(undefined)).toBe(1);
    expect(mapDiffExitCode("")).toBe(1);
  });
});

describe("createJobFromDiffStream", () => {
  let server: Server;
  let baseUrl: string;
  let captured: {
    method?: string;
    url?: string;
    headers?: IncomingMessage["headers"];
    body?: Buffer;
  } = {};

  beforeEach(async () => {
    captured = {};
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.method = req.method;
        captured.url = req.url;
        captured.headers = req.headers;
        captured.body = Buffer.concat(chunks);
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "s1", status: "queued" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("posts the diff to /api/jobs with the streaming wire contract", async () => {
    const diff = Buffer.from("diff --git a/x b/x\n+line\n", "utf-8");
    const query = new URLSearchParams({
      scriptOnly: "false",
      ttsOnly: "false",
      deepdive: "false",
      durationMode: "popcorn",
      prTitle: "feat: streaming",
    });

    const resp = await createJobFromDiffStream(baseUrl, "test-key", diff, query);

    expect(resp.id).toBe("s1");
    expect(resp.status).toBe("queued");
    expect(captured.method).toBe("POST");
    expect(captured.url).toMatch(/^\/api\/jobs\?/);
    expect(captured.headers?.["content-type"]).toBe("application/x-git-diff");
    expect(captured.headers?.["x-diff-source"]).toBe("local-stream");
    expect(captured.headers?.["content-length"]).toBe(String(diff.byteLength));
    expect(captured.headers?.["authorization"]).toBe("Bearer test-key");
    // Query params must include all five preserved-by-streaming-branch fields.
    expect(captured.url).toContain("scriptOnly=false");
    expect(captured.url).toContain("durationMode=popcorn");
    expect(captured.url).toContain("prTitle=feat");
    expect(captured.body?.toString("utf-8")).toBe(diff.toString("utf-8"));
  });
});

describe("apiFetch error surfacing (via createJobFromDiffStream)", () => {
  // A 413 returned by POST /api/jobs (before the job exists) must surface as
  // an APIError carrying the server's `error` code so the top-level catch can
  // map it to the documented DIFF_TOO_LARGE exit code (5).
  let server: Server;
  let baseUrl: string;
  let respond: (req: IncomingMessage, res: import("node:http").ServerResponse) => void = () => undefined;

  beforeEach(async () => {
    server = createServer((req, res) => respond(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("throws APIError with errorCode populated from a 413 DIFF_TOO_LARGE body", async () => {
    respond = (_req, res) => {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "DIFF_TOO_LARGE", message: "Diff file exceeds 100 MB limit" }));
    };

    let err: unknown = null;
    try {
      await createJobFromDiffStream(
        baseUrl,
        "k",
        Buffer.from("x", "utf-8"),
        new URLSearchParams(),
      );
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(APIError);
    const ae = err as APIError;
    expect(ae.status).toBe(413);
    expect(ae.errorCode).toBe("DIFF_TOO_LARGE");
    expect(mapDiffExitCode(ae.errorCode)).toBe(5);
  });

  it("returns APIError with null errorCode for non-JSON error bodies", async () => {
    respond = (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("oops");
    };

    let err: unknown = null;
    try {
      await createJobFromDiffStream(
        baseUrl,
        "k",
        Buffer.from("x", "utf-8"),
        new URLSearchParams(),
      );
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(APIError);
    const ae = err as APIError;
    expect(ae.status).toBe(500);
    expect(ae.errorCode).toBeNull();
    expect(mapDiffExitCode(ae.errorCode)).toBe(1);
  });
});
