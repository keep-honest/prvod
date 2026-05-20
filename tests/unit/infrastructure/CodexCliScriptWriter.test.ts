import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { CodexCliScriptWriter } from "@/infrastructure/llm/CodexCliScriptWriter";
import {
  VALID_SCRIPT,
  fakePRContext,
  fakeDiffAnalysis,
  mockSpawn,
  createMockSpawnChild,
  buildValidOutline,
  makeCoveragePlan,
  passingCoverageJudge,
  passingNarrationJudge,
} from "./fixtures/scriptWriterFixtures";

describe("CodexCliScriptWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_CLI_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
  });

  afterEach(() => {
    delete process.env.CODEX_REASONING_EFFORT;
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
  });

  it("parses valid JSON output from codex CLI", async () => {
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.script.changeType).toBe("feature");
    expect(result.script.scenes).toHaveLength(8);
    expect(result.script.totalDurationSeconds).toBe(54);
    expect(result.script.scenes[1].codeBroll).toBeTruthy();
    expect(result.usage).toBeDefined();
    const usage = result.usage;
    if (!usage) throw new Error("Expected usage to be defined");
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it("strips markdown code fences from output", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_SCRIPT) + "\n```";
    mockSpawn(fenced);
    const writer = new CodexCliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.script.changeType).toBe("feature");
    expect(result.script.scenes).toHaveLength(8);
  });

  it("throws on invalid JSON output", async () => {
    mockSpawn("this is not json at all");
    const writer = new CodexCliScriptWriter();

    await expect(
      writer.generateScript(fakePRContext, fakeDiffAnalysis),
    ).rejects.toThrow(); // jsonrepair parses it as a string, Zod rejects (expected object)
  });

  it("throws on CLI execution failure", async () => {
    const error = Object.assign(new Error("command not found"), { code: 127 });
    mockSpawn("", error);
    const writer = new CodexCliScriptWriter();

    await expect(
      writer.generateScript(fakePRContext, fakeDiffAnalysis),
    ).rejects.toThrow("codex CLI failed");
  });

  it("passes exec subcommand, --model, --full-auto, and prompt as last arg", async () => {
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const cmd = call[0] as string;
    const args = call[1] as string[];
    expect(cmd).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args).toContain("--model");
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("o4-mini");
    expect(args).toContain("--full-auto");
    // There are TWO `-c` overrides: the model (belt-and-suspenders against
    // Codex CLI falling back to a hardcoded default) and reasoning effort.
    const configOverrides = args
      .flatMap((arg, idx) => (arg === "-c" ? [args[idx + 1]] : []));
    expect(configOverrides).toContain('model="o4-mini"');
    expect(configOverrides).toContain('model_reasoning_effort="medium"');
    // Codex CLI has no --output-format or -p flags
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("-p");
    // Prompt is the last positional arg (not piped to stdin)
    const lastArg = args[args.length - 1];
    expect(lastArg).toContain("video script");
  });

  it("does not write stdin when prompt is passed as arg", async () => {
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    // Codex treats any piped stdin as additional prompt input, so prompt-as-arg
    // calls must not write or close stdin.
    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
  });

  it("reads CODEX_MODEL env var for model override", async () => {
    process.env.CODEX_MODEL = "o3";
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("o3");
  });

  it("falls back to CODEX_CLI_MODEL when CODEX_MODEL is not set", async () => {
    process.env.CODEX_CLI_MODEL = "gpt-5-codex";
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("gpt-5-codex");
  });

  it("prefers CODEX_MODEL over CODEX_CLI_MODEL when both are set", async () => {
    process.env.CODEX_MODEL = "o3";
    process.env.CODEX_CLI_MODEL = "gpt-5-codex";
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("o3");
  });

  it("reads CODEX_REASONING_EFFORT env var to override default", async () => {
    process.env.CODEX_REASONING_EFFORT = "low";
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[1] as string[];
    const configOverrides = args
      .flatMap((arg, idx) => (arg === "-c" ? [args[idx + 1]] : []));
    expect(configOverrides).toContain('model_reasoning_effort="low"');
  });

  it("passes the resolved model via -c model=\"...\" to override config.toml defaults", async () => {
    process.env.CODEX_MODEL = "gpt-5";
    mockSpawn(JSON.stringify(VALID_SCRIPT));
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[1] as string[];
    const configOverrides = args
      .flatMap((arg, idx) => (arg === "-c" ? [args[idx + 1]] : []));
    // The model must be forced via `-c model="..."` so it cannot be silently
    // overridden by ~/.codex/config.toml or a profile default.
    expect(configOverrides).toContain('model="gpt-5"');
    // And the --model flag is still present as a safety net.
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("gpt-5");
  });

  /** Wire up the spawn mock to return V2 pipeline staged outputs in order. */
  function mockV2StagedOutputs() {
    const stagedOutputs = [
      JSON.stringify(makeCoveragePlan()),
      JSON.stringify(passingCoverageJudge()),
      JSON.stringify(buildValidOutline()),
      JSON.stringify(VALID_SCRIPT),
      JSON.stringify(passingNarrationJudge()),
    ];
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => createMockSpawnChild(stagedOutputs.shift() ?? ""),
    );
  }

  it("uses Prompt Pipeline V2 across five staged CLI calls when enabled", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    mockV2StagedOutputs();
    const writer = new CodexCliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.promptPipelineV2?.enabled).toBe(true);
    expect(result.promptPipelineV2?.llmFamily).toBe("codex");
    expect((spawn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(5);
    const firstCall = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const firstArgs = firstCall[1] as string[];
    expect(firstArgs[0]).toBe("exec");
    expect(firstArgs).toContain("--model");
    expect(firstArgs).toContain("--full-auto");
    expect(firstArgs).not.toContain("-p");
  });

  it("uses --output-schema flag for V2 completeJson calls", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    mockV2StagedOutputs();
    const writer = new CodexCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    // completeJson calls should use --output-schema with a temp file path (not inline JSON)
    const allCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const jsonCalls = allCalls.filter((call: unknown[]) =>
      (call[1] as string[]).includes("--output-schema"),
    );
    expect(jsonCalls.length).toBeGreaterThan(0);
    // Verify the schema arg after --output-schema is a file path, not inline JSON
    for (const call of jsonCalls) {
      const args = call[1] as string[];
      const schemaIdx = args.indexOf("--output-schema");
      const schemaArg = args[schemaIdx + 1];
      expect(schemaArg).toMatch(/prvod-schema-.*\.json$/);
      expect(schemaArg).not.toMatch(/^\{/); // not inline JSON
    }
    // Verify writeFileSync was called with valid JSON schema content
    const writeCalls = (writeFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    for (const [filePath, content] of writeCalls) {
      expect(filePath).toMatch(/prvod-schema-.*\.json$/);
      const parsed = JSON.parse(content as string);
      expect(parsed).toHaveProperty("type", "object");
    }
    // Verify temp files are cleaned up
    expect(unlinkSync).toHaveBeenCalled();
    // No call should use --json-schema or --output-format
    for (const call of allCalls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--json-schema");
      expect(args).not.toContain("--output-format");
    }
  });
});
