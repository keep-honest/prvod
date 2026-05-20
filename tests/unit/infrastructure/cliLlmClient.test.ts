import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile, spawn } from "node:child_process";
import { createClaudeCliLlmClient, createGeminiCliLlmClient, createCodexCliLlmClient } from "@/infrastructure/llm/cliLlmClient";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

interface MockChild {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
}

function makeMockStdin() {
  return { write: vi.fn(), end: vi.fn(), on: vi.fn() };
}

function mockExecFileSuccess(stdout: string): MockChild {
  const child: MockChild = { stdin: makeMockStdin() };
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, stdout, "");
      return child;
    },
  );
  return child;
}

function mockExecFileFailure(stderr: string, exitCode = 1): MockChild {
  const child: MockChild = { stdin: makeMockStdin() };
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      const error = Object.assign(new Error(stderr), { code: exitCode });
      cb(error, "", stderr);
      return child;
    },
  );
  return child;
}

function mockSpawnSuccess(stdout: string): void {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => createMockSpawnChild(stdout, "", 0),
  );
}

function mockSpawnFailure(stderr: string, exitCode = 1): void {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => createMockSpawnChild("", stderr, exitCode),
  );
}

function createMockSpawnChild(stdout: string, stderr: string, exitCode: number) {
  return {
    kill: vi.fn(),
    stdin: undefined,
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data" && stdout) {
          queueMicrotask(() => cb(Buffer.from(stdout)));
        }
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data" && stderr) {
          queueMicrotask(() => cb(Buffer.from(stderr)));
        }
      }),
    },
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      if (event === "close") {
        queueMicrotask(() => cb(exitCode));
      }
    }),
  };
}

describe("cliLlmClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLAUDE_MODEL;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_CLI_TIMEOUT_MS;
    delete process.env.CLI_LLM_TIMEOUT_MS;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_CLI_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
  });

  afterEach(() => {
    delete process.env.CLAUDE_MODEL;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_CLI_TIMEOUT_MS;
    delete process.env.CLI_LLM_TIMEOUT_MS;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_CLI_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
  });

  describe("createClaudeCliLlmClient", () => {
    it("writes combined system + user prompt to stdin", async () => {
      const child = mockExecFileSuccess("response text");
      const client = createClaudeCliLlmClient();

      await client.complete("You are a helper.", "What is 2+2?");

      expect(child.stdin.write).toHaveBeenCalledWith(
        "You are a helper.\n\nWhat is 2+2?",
      );
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("invokes claude CLI with -p, --model, and --output-format text", async () => {
      mockExecFileSuccess("ok");
      const client = createClaudeCliLlmClient();

      await client.complete("sys", "user");

      const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("claude");
      const args: string[] = call[1];
      expect(args).toContain("-p");
      expect(args).toContain("--output-format");
      expect(args[args.indexOf("--output-format") + 1]).toBe("text");
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-20250514");
    });

    it("uses CLAUDE_MODEL env var when set", async () => {
      process.env.CLAUDE_MODEL = "claude-opus-4-20250514";
      mockExecFileSuccess("ok");
      const client = createClaudeCliLlmClient();

      await client.complete("sys", "user");

      const args: string[] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-20250514");
    });

    it("strips CLAUDECODE from env", async () => {
      process.env.CLAUDECODE = "true";
      mockExecFileSuccess("ok");
      const client = createClaudeCliLlmClient();

      await client.complete("sys", "user");

      const opts = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(opts.env).not.toHaveProperty("CLAUDECODE");

      delete process.env.CLAUDECODE;
    });

    it("trims whitespace from stdout", async () => {
      mockExecFileSuccess("  response with whitespace  \n");
      const client = createClaudeCliLlmClient();

      const result = await client.complete("sys", "user");

      expect(result).toBe("response with whitespace");
    });

    it("rejects on CLI error", async () => {
      mockExecFileFailure("authentication failed", 1);
      const client = createClaudeCliLlmClient();

      await expect(client.complete("sys", "user")).rejects.toThrow(
        /claude CLI failed.*authentication failed/,
      );
    });
  });

  describe("createGeminiCliLlmClient", () => {
    it("writes combined system + user prompt to stdin", async () => {
      const child = mockExecFileSuccess("response text");
      const client = createGeminiCliLlmClient();

      await client.complete("You are a helper.", "What is 2+2?");

      expect(child.stdin.write).toHaveBeenCalledWith(
        "You are a helper.\n\nWhat is 2+2?",
      );
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("invokes gemini CLI with -m and --output-format text", async () => {
      mockExecFileSuccess("ok");
      const client = createGeminiCliLlmClient();

      await client.complete("sys", "user");

      const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("gemini");
      const args: string[] = call[1];
      expect(args).toContain("-m");
      expect(args[args.indexOf("-m") + 1]).toBe("gemini-2.5-flash");
      expect(args).toContain("--output-format");
      expect(args[args.indexOf("--output-format") + 1]).toBe("text");
    });

    it("uses GEMINI_MODEL env var when set", async () => {
      process.env.GEMINI_MODEL = "gemini-2.5-pro";
      mockExecFileSuccess("ok");
      const client = createGeminiCliLlmClient();

      await client.complete("sys", "user");

      const args: string[] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args[args.indexOf("-m") + 1]).toBe("gemini-2.5-pro");
    });

    it("passes the configured Gemini CLI timeout to execFile", async () => {
      process.env.GEMINI_CLI_TIMEOUT_MS = "1234";
      mockExecFileSuccess("ok");
      const client = createGeminiCliLlmClient();

      await client.complete("sys", "user");

      const opts = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(opts).toMatchObject({
        timeout: 1234,
        killSignal: "SIGTERM",
      });
    });

    it("does not pass prompt as CLI argument (uses stdin only)", async () => {
      mockExecFileSuccess("ok");
      const client = createGeminiCliLlmClient();

      await client.complete("system prompt", "user prompt");

      const args: string[] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const argsStr = args.join(" ");
      expect(argsStr).not.toContain("system prompt");
      expect(argsStr).not.toContain("user prompt");
    });

    it("rejects on CLI error", async () => {
      mockExecFileFailure("model not found", 1);
      const client = createGeminiCliLlmClient();

      await expect(client.complete("sys", "user")).rejects.toThrow(
        /gemini CLI failed.*model not found/,
      );
    });
  });

  describe("createCodexCliLlmClient", () => {
    it("passes prompt as last positional arg without writing stdin", async () => {
      mockSpawnSuccess("response text");
      const client = createCodexCliLlmClient();

      await client.complete("You are a helper.", "What is 2+2?");

      // Prompt is in args, not stdin
      const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const args: string[] = call[1];
      expect(args[args.length - 1]).toBe("You are a helper.\n\nWhat is 2+2?");
      expect(call[2]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
    });

    it("invokes codex exec with --sandbox read-only, --model, and -c config", async () => {
      mockSpawnSuccess("ok");
      const client = createCodexCliLlmClient();

      await client.complete("sys", "user");

      const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("codex");
      const args: string[] = call[1];
      expect(args[0]).toBe("exec");
      expect(args).toContain("--sandbox");
      expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
      expect(args).not.toContain("--full-auto");
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("o4-mini");
      expect(args).toContain("-c");
      expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="medium"');
    });

    it("does not pass --output-format (Codex CLI does not support it)", async () => {
      mockSpawnSuccess("ok");
      const client = createCodexCliLlmClient();

      await client.complete("sys", "user");

      const args: string[] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args).not.toContain("--output-format");
    });

    it("uses CODEX_MODEL env var when set", async () => {
      process.env.CODEX_MODEL = "o3";
      mockSpawnSuccess("ok");
      const client = createCodexCliLlmClient();

      await client.complete("sys", "user");

      const args: string[] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args[args.indexOf("--model") + 1]).toBe("o3");
    });

    it("prefers CODEX_MODEL over CODEX_CLI_MODEL when both are set", async () => {
      process.env.CODEX_MODEL = "o3";
      process.env.CODEX_CLI_MODEL = "gpt-4.1";
      mockSpawnSuccess("ok");
      const client = createCodexCliLlmClient();

      await client.complete("sys", "user");

      const args: string[] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args[args.indexOf("--model") + 1]).toBe("o3");
    });

    it("falls back to CODEX_CLI_MODEL when CODEX_MODEL is not set", async () => {
      process.env.CODEX_CLI_MODEL = "gpt-4.1";
      mockSpawnSuccess("ok");
      const client = createCodexCliLlmClient();

      await client.complete("sys", "user");

      const args: string[] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args[args.indexOf("--model") + 1]).toBe("gpt-4.1");
    });

    it("uses CODEX_REASONING_EFFORT env var when set", async () => {
      process.env.CODEX_REASONING_EFFORT = "high";
      mockSpawnSuccess("ok");
      const client = createCodexCliLlmClient();

      await client.complete("sys", "user");

      const args: string[] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="high"');
    });

    it("trims whitespace from stdout", async () => {
      mockSpawnSuccess("  response with whitespace  \n");
      const client = createCodexCliLlmClient();

      const result = await client.complete("sys", "user");

      expect(result).toBe("response with whitespace");
    });

    it("rejects on CLI error", async () => {
      mockSpawnFailure("permission denied", 1);
      const client = createCodexCliLlmClient();

      await expect(client.complete("sys", "user")).rejects.toThrow(
        /codex CLI failed.*permission denied/,
      );
    });
  });
});
