import { describe, expect, it } from "vitest";
import { _formatCliFailure } from "@/infrastructure/llm/BaseCliScriptWriter";

/**
 * `_formatCliFailure` is the formatter used when a CLI child-process
 * exits non-zero. It's the operator's debugging lifeline for LLM CLI
 * failures — the original code surfaced only `stderr || error.message`
 * which, when the CLI printed its error to stdout (as the Claude CLI
 * does when rate-limited), left operators with a meaningless
 * "Command failed: claude -p ..." and nothing else.
 *
 * These tests pin the four behaviours that matter:
 *   1. Both streams present → `stderr:` before `stdout:` in the output.
 *   2. Only one stream present → only that prefix appears.
 *   3. Both streams empty → fall back to the Node error message.
 *   4. Each stream preview is capped at 2000 chars while preserving head and tail.
 * Plus: exit code renders as `unknown` when null/undefined, and signal
 * terminations include the signal name.
 */

describe("_formatCliFailure", () => {
  it("includes stderr first, then stdout, when both streams are present", () => {
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: 1,
      stdout: "structured output failed",
      stderr: "Error: rate limited",
      fallbackMessage: "Command failed: claude -p",
    });
    expect(msg).toBe(
      "claude CLI failed (exit 1): stderr: Error: rate limited | stdout: structured output failed",
    );
  });

  it("includes only stderr when stdout is empty", () => {
    const msg = _formatCliFailure({
      cmd: "gemini",
      exitCode: 2,
      stdout: "",
      stderr: "auth token expired",
      fallbackMessage: "fallback",
    });
    expect(msg).toContain("stderr: auth token expired");
    expect(msg).not.toContain("stdout:");
    expect(msg).not.toContain("fallback");
  });

  it("includes only stdout when stderr is empty", () => {
    const msg = _formatCliFailure({
      cmd: "codex",
      exitCode: 3,
      stdout: '{"error":"schema mismatch"}',
      stderr: "",
      fallbackMessage: "fallback",
    });
    expect(msg).toContain('stdout: {"error":"schema mismatch"}');
    expect(msg).not.toContain("stderr:");
    expect(msg).not.toContain("fallback");
  });

  it("falls back to the Node error message when both streams are empty", () => {
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: 1,
      stdout: "",
      stderr: "",
      fallbackMessage: "Command failed: claude -p --json-schema {...}",
    });
    expect(msg).toBe("claude CLI failed (exit 1): Command failed: claude -p --json-schema {...}");
  });

  it("falls back to the Node error message when both streams are null/undefined", () => {
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: 1,
      stdout: null,
      stderr: undefined,
      fallbackMessage: "Command failed",
    });
    expect(msg).toBe("claude CLI failed (exit 1): Command failed");
  });

  it("caps each stream preview at 2000 characters while preserving head and tail", () => {
    const longStderr = "stderr-head-" + "E".repeat(3000) + "-stderr-tail";
    const longStdout = "stdout-head-" + "O".repeat(3000) + "-stdout-tail";
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: 1,
      stdout: longStdout,
      stderr: longStderr,
      fallbackMessage: "ignored",
    });
    const stderrMatch = msg.match(/stderr: ([\s\S]+) \| stdout:/);
    expect(stderrMatch).not.toBeNull();
    if (!stderrMatch) throw new Error("Expected stderr preview to match");
    expect(stderrMatch[1]).toHaveLength(2000);
    expect(stderrMatch[1]).toContain("stderr-head-");
    expect(stderrMatch[1]).toContain("-stderr-tail");
    expect(stderrMatch[1]).toContain("...[truncated ");

    const stdoutMatch = msg.match(/stdout: ([\s\S]+)$/);
    expect(stdoutMatch).not.toBeNull();
    if (!stdoutMatch) throw new Error("Expected stdout preview to match");
    expect(stdoutMatch[1]).toHaveLength(2000);
    expect(stdoutMatch[1]).toContain("stdout-head-");
    expect(stdoutMatch[1]).toContain("-stdout-tail");
    expect(stdoutMatch[1]).toContain("...[truncated ");
  });

  it("renders exit code as 'unknown' when null", () => {
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: null,
      stdout: "",
      stderr: "some error",
      fallbackMessage: "ignored",
    });
    expect(msg).toContain("claude CLI failed (exit unknown)");
  });

  it("renders exit code as 'unknown' when undefined", () => {
    const msg = _formatCliFailure({
      cmd: "gemini",
      exitCode: undefined,
      stdout: "",
      stderr: "some error",
      fallbackMessage: "ignored",
    });
    expect(msg).toContain("gemini CLI failed (exit unknown)");
  });

  it("preserves numeric exit codes verbatim", () => {
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: 137,
      stdout: "",
      stderr: "killed by OOM",
      fallbackMessage: "ignored",
    });
    expect(msg).toContain("exit 137");
  });

  it("includes the signal name when the child was killed by a signal", () => {
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      fallbackMessage: "Command killed",
    });
    expect(msg).toContain("exit unknown, signal SIGKILL");
    expect(msg).toContain("Command killed");
  });

  it("omits the signal suffix when signal is null/undefined", () => {
    const msgNoSignal = _formatCliFailure({
      cmd: "claude",
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "auth failed",
      fallbackMessage: "ignored",
    });
    expect(msgNoSignal).not.toContain("signal");
    expect(msgNoSignal).toContain("exit 1");

    const msgUndefinedSignal = _formatCliFailure({
      cmd: "claude",
      exitCode: 1,
      stdout: "",
      stderr: "auth failed",
      fallbackMessage: "ignored",
    });
    expect(msgUndefinedSignal).not.toContain("signal");
  });

  it("is resilient to the real incident shape: Claude CLI exits 1 with empty stderr + structured JSON envelope on stdout", () => {
    // Reproduces the exact shape of the user's production incident. The
    // CLI produced a JSON envelope on stdout containing the model's
    // is_error=true result, and exited 1 with NO stderr output. Before
    // this refactor the error was "Command failed: claude -p ..." with
    // zero signal about the real reason.
    const stdoutJson = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Rate limit exceeded. Please try again in 60 seconds.",
      num_turns: 1,
    });
    const msg = _formatCliFailure({
      cmd: "claude",
      exitCode: 1,
      stdout: stdoutJson,
      stderr: "",
      fallbackMessage: "Command failed: claude -p --model claude-sonnet-4-20250514",
    });
    // The operator must be able to see the rate-limit message in the
    // rejection — that's the whole point of the fix.
    expect(msg).toContain("Rate limit exceeded");
    // The useless fallback must NOT be in the message when stdout has content.
    expect(msg).not.toContain("Command failed: claude -p");
  });
});
