import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile } from "node:child_process";
import { GeminiCliScriptWriter } from "@/infrastructure/llm/GeminiCliScriptWriter";
import {
  VALID_SCRIPT,
  fakePRContext,
  fakeDiffAnalysis,
  mockExecFile,
  buildValidOutline,
} from "./fixtures/scriptWriterFixtures";

describe("GeminiCliScriptWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_CLI_MODEL;
    delete process.env.GEMINI_CLI_TIMEOUT_MS;
    delete process.env.CLI_LLM_TIMEOUT_MS;
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
  });

  afterEach(() => {
    delete process.env.GEMINI_CLI_TIMEOUT_MS;
    delete process.env.CLI_LLM_TIMEOUT_MS;
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
  });

  it("parses valid JSON output from gemini CLI", async () => {
    mockExecFile(JSON.stringify(VALID_SCRIPT));
    const writer = new GeminiCliScriptWriter();

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
    mockExecFile(fenced);
    const writer = new GeminiCliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.script.changeType).toBe("feature");
    expect(result.script.scenes).toHaveLength(8);
  });

  it("throws on invalid JSON output", async () => {
    mockExecFile("this is not json at all");
    const writer = new GeminiCliScriptWriter();

    await expect(
      writer.generateScript(fakePRContext, fakeDiffAnalysis),
    ).rejects.toThrow(); // jsonrepair parses it as a string, Zod rejects (expected object)
  });

  it("throws on CLI execution failure", async () => {
    const error = Object.assign(new Error("command not found"), { code: 127 });
    mockExecFile("", error);
    const writer = new GeminiCliScriptWriter();

    await expect(
      writer.generateScript(fakePRContext, fakeDiffAnalysis),
    ).rejects.toThrow("gemini CLI failed");
  });

  it("passes -m flag (not --model) and omits -p for model selection", async () => {
    mockExecFile(JSON.stringify(VALID_SCRIPT));
    const writer = new GeminiCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const cmd = call[0] as string;
    const args = call[1] as string[];
    expect(cmd).toBe("gemini");
    expect(args).toContain("-m");
    expect(args).not.toContain("--model");
    // Gemini CLI reads from stdin directly — no -p flag
    expect(args).not.toContain("-p");
  });

  it("reads GEMINI_MODEL env var for model override", async () => {
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    mockExecFile(JSON.stringify(VALID_SCRIPT));
    const writer = new GeminiCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[1] as string[];
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("gemini-2.5-pro");
  });

  it("passes the configured Gemini CLI timeout to each attempt", async () => {
    process.env.GEMINI_CLI_TIMEOUT_MS = "1234";
    mockExecFile(JSON.stringify(VALID_SCRIPT));
    const writer = new GeminiCliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toMatchObject({
      timeout: 1234,
      killSignal: "SIGTERM",
    });
  });

  it("uses Prompt Pipeline V2 across five staged CLI calls when enabled", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    const stagedOutputs = [
      JSON.stringify({
        summary: "plan",
        selectedEvidencePolicy: "cluster-only",
        clusters: [{
          clusterId: "c1",
          title: "auth",
          files: ["src/middleware/auth.ts", "src/routes/auth.ts"],
          evidenceSnippets: [{ filePath: "src/middleware/auth.ts", summary: "auth", diffExcerpt: "diff" }],
          technicalMechanism: "validate",
          impact: "protect",
          riskIfAbsent: "unsafe",
          validationEvidence: ["tests"],
          importanceRank: 1,
        }],
        ledger: [{ clusterId: "c1", disposition: "deep_dive", reason: "main change" }],
        majorClusterIds: ["c1"],
      }),
      JSON.stringify({
        passed: true,
        issues: [],
        missingMajorClusterIds: [],
        weakEvidenceClusterIds: [],
        allocationIssues: [],
        scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
      }),
      JSON.stringify(buildValidOutline()),
      JSON.stringify(VALID_SCRIPT),
      JSON.stringify({
        passed: true,
        issues: [],
        scores: {
          hookStrength: 8,
          explanatoryClarity: 9,
          evidenceGrounding: 9,
          sceneDistinctness: 8,
          themeFidelity: 8,
          topClusterCoverage: 9,
          jargonDensity: 4,
          boredomRisk: 3,
        },
      }),
    ];
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        const child = {
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        cb(null, stagedOutputs.shift() ?? "", "");
        return child;
      },
    );
    const writer = new GeminiCliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.promptPipelineV2?.enabled).toBe(true);
    expect((execFile as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(5);
    const firstCall = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = firstCall[1] as string[];
    expect(args).toContain("-m");
    expect(args).not.toContain("-p");
  });

  it("cleans wrapped JSON and trailing commas in V2 completeText responses", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    // Use durationSeconds: 0 to fail transport schema (positive int required), triggering repair
    const brokenScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((scene, index) =>
        index === 0 ? { ...scene, durationSeconds: 0 } : scene,
      ),
    };
    const repairedWithTrailingComma = `Here is the corrected JSON:\n${JSON.stringify(VALID_SCRIPT).replace("}]", "},]")}\nThanks!`;
    const stagedOutputs = [
      JSON.stringify({
        summary: "plan",
        selectedEvidencePolicy: "cluster-only",
        clusters: [{
          clusterId: "c1",
          title: "auth",
          files: ["src/middleware/auth.ts", "src/routes/auth.ts"],
          evidenceSnippets: [{ filePath: "src/middleware/auth.ts", summary: "auth", diffExcerpt: "diff" }],
          technicalMechanism: "validate",
          impact: "protect",
          riskIfAbsent: "unsafe",
          validationEvidence: ["tests"],
          importanceRank: 1,
        }],
        ledger: [{ clusterId: "c1", disposition: "deep_dive", reason: "main change" }],
        majorClusterIds: ["c1"],
      }),
      JSON.stringify({
        passed: true,
        issues: [],
        missingMajorClusterIds: [],
        weakEvidenceClusterIds: [],
        allocationIssues: [],
        scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
      }),
      JSON.stringify(buildValidOutline()),
      `Here is the JSON output:\n${JSON.stringify(brokenScript)}\nLet me know if you need changes!`,
      repairedWithTrailingComma,
      JSON.stringify({
        passed: true,
        issues: [],
        scores: {
          hookStrength: 8,
          explanatoryClarity: 9,
          evidenceGrounding: 9,
          sceneDistinctness: 8,
          themeFidelity: 8,
          topClusterCoverage: 9,
          jargonDensity: 4,
          boredomRisk: 3,
        },
      }),
    ];
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        const child = {
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        cb(null, stagedOutputs.shift() ?? "", "");
        return child;
      },
    );
    const writer = new GeminiCliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.promptPipelineV2?.enabled).toBe(true);
    expect(result.script.scenes[0].durationSeconds).toBeGreaterThan(0);
    expect((execFile as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(6);
  });
});
