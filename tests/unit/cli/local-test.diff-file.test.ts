import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "@/cli/local-test";

// Base argv so serverUrl and apiKey validation pass
const BASE_ARGV = ["node", "cli.ts", "--server-url", "http://localhost:3000", "--api-key", "test-key"];

let tempDir: string;
// Typed as unknown to avoid @types/node version-specific keyof constraints
let exitSpy: { mockRestore(): void };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cli-diff-test-"));
  // Spy on process.exit so tests don't actually terminate
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

describe("parseArgs --diff-file", () => {
  describe("mutual exclusion (exit code 2)", () => {
    it("exits 2 when combined with --pr-number", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p, "--pr-number", "5"]),
      ).toThrow("process.exit(2)");
    });

    it("exits 2 when combined with --title", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p, "--title", "My PR"]),
      ).toThrow("process.exit(2)");
    });

    it("exits 2 when combined with --uncommitted", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p, "--uncommitted"]),
      ).toThrow("process.exit(2)");
    });

    it("exits 2 when combined with --retry-job", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p, "--retry-job", "some-uuid"]),
      ).toThrow("process.exit(2)");
    });
  });

  describe("file pre-flight (exit code 3)", () => {
    it("exits 3 when diff file does not exist", () => {
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", "/nonexistent/path/test.diff"]),
      ).toThrow("process.exit(3)");
    });

    it("exits 3 when diff file is empty", () => {
      const p = writeDiffFile("empty.diff", "");
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p]),
      ).toThrow("process.exit(3)");
    });
  });

  describe("content validation (exit code 4)", () => {
    it("exits 4 when file does not start with a diff header", () => {
      const p = writeDiffFile("notadiff.txt", "This is not a diff file\nsome content\n");
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p]),
      ).toThrow("process.exit(4)");
    });

    it("exits 4 for JSON content", () => {
      const p = writeDiffFile("data.json", '{"key": "value"}\n');
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p]),
      ).toThrow("process.exit(4)");
    });
  });

  describe("happy path", () => {
    it("accepts a valid diff file and returns diffFile path", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      const args = parseArgs([...BASE_ARGV, "--diff-file", p]);
      expect(args.diffFile).toBeTruthy();
      expect(args.diffFile).toContain("valid.diff");
    });

    it("rejects diff starting with '--- ' (exit code 4 — only diff --git format supported)", () => {
      const p = writeDiffFile("plain.diff", `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+line\n`);
      expect(() =>
        parseArgs([...BASE_ARGV, "--diff-file", p]),
      ).toThrow("process.exit(4)");
    });

    it("accepts --script-only alongside --diff-file", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      const args = parseArgs([...BASE_ARGV, "--diff-file", p, "--script-only"]);
      expect(args.diffFile).toBeTruthy();
      expect(args.scriptOnly).toBe(true);
    });

    it("resolves relative path to absolute", () => {
      const p = writeDiffFile("valid.diff", VALID_DIFF);
      const args = parseArgs([...BASE_ARGV, "--diff-file", p]);
      expect(args.diffFile?.startsWith("/")).toBe(true);
    });

    it("sets diffFile to null when --diff-file is not provided", () => {
      const args = parseArgs([...BASE_ARGV]);
      expect(args.diffFile).toBeNull();
    });
  });
});
