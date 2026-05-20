import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { CliScriptWriter } from "@/infrastructure/llm/CliScriptWriter";
import { _extractClaudeCliStructuredOutput as extractClaudeCliStructuredOutput } from "@/infrastructure/llm/BaseCliScriptWriter";
import { createLogger } from "@/lib/logger";
import {
  VALID_SCRIPT,
  fakePRContext,
  fakeDiffAnalysis,
  mockExecFile,
  buildValidOutline,
} from "./fixtures/scriptWriterFixtures";

function makeScriptWithDurations(durations: number[]) {
  return {
    ...VALID_SCRIPT,
    scenes: VALID_SCRIPT.scenes.map((scene, index) => ({
      ...scene,
      durationSeconds: durations[index] ?? scene.durationSeconds,
    })),
  };
}

function mockExecFileSequence(outputs: string[]) {
  const queue = [...outputs];
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const child = {
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      };
      cb(null, queue.shift() ?? "", "");
      return child;
    },
  );
}

describe("CliScriptWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
  });

  afterEach(() => {
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
  });

  it("parses valid JSON output from claude CLI", async () => {
    mockExecFile(JSON.stringify(VALID_SCRIPT));
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.script.changeType).toBe("feature");
    expect(result.script.scenes).toHaveLength(8);
    // computeActualSceneDurations may adjust durations for TTS speed cap
    expect(result.script.totalDurationSeconds).toBeGreaterThanOrEqual(54);
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
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.script.changeType).toBe("feature");
    expect(result.script.scenes).toHaveLength(8);
  });

  it("throws on invalid JSON output", async () => {
    mockExecFile("this is not json at all");
    const writer = new CliScriptWriter();

    await expect(
      writer.generateScript(fakePRContext, fakeDiffAnalysis),
    ).rejects.toThrow(); // jsonrepair parses it as a string, Zod rejects (expected object)
  });

  it("repairs JSON with preamble and epilogue text", async () => {
    const preamble = "Here is the JSON output:\n";
    const epilogue = "\nLet me know if you need any changes!";
    mockExecFile(preamble + JSON.stringify(VALID_SCRIPT) + epilogue);
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);
    expect(result.script.changeType).toBe("feature");
    expect(result.script.scenes).toHaveLength(8);
  });

  it("repairs JSON with control characters inside string values", async () => {
    // Inject a raw tab (0x09) inside the summary string value
    const json = JSON.stringify(VALID_SCRIPT);
    const withControlChar = json.replace(
      "authentication middleware",
      "authentication\tmiddleware",
    );
    mockExecFile(withControlChar);
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);
    expect(result.script.summary).toContain("authentication");
  });

  it("accepts short mode above the requested target when within the guard coefficient", async () => {
    const tolerated = makeScriptWithDurations([10, 10, 10, 10, 10, 10, 10, 10]); // 80s <= 84s
    mockExecFile(JSON.stringify(tolerated));
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(
      { ...fakePRContext, durationMode: "short" },
      fakeDiffAnalysis,
    );

    expect(result.script.totalDurationSeconds).toBe(80);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("throws when popcorn mode exceeds the upper guard after retry", async () => {
    const oversized = makeScriptWithDurations([60, 60, 60, 60, 60, 60, 60, 60]); // 480s > 448s
    mockExecFileSequence([
      JSON.stringify(oversized),
      JSON.stringify(oversized),
    ]);
    const writer = new CliScriptWriter();

    await expect(
      writer.generateScript({ ...fakePRContext, durationMode: "popcorn" }, fakeDiffAnalysis),
    ).rejects.toThrow(/requested=320s.*coefficient=1\.4.*guardCap=448s.*actual=480s/);
  });

  it("repairs JSON with trailing commas", async () => {
    // Add trailing comma after the last scene in the array
    const json = JSON.stringify(VALID_SCRIPT);
    const withTrailing = json.replace("}]", "},]");
    mockExecFile(withTrailing);
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);
    expect(result.script.scenes).toHaveLength(8);
  });

  it("throws on CLI execution failure", async () => {
    const error = Object.assign(new Error("command not found"), { code: 127 });
    mockExecFile("", error);
    const writer = new CliScriptWriter();

    await expect(
      writer.generateScript(fakePRContext, fakeDiffAnalysis),
    ).rejects.toThrow("claude CLI failed");
  });

  it("invokes claude binary with -p and --model flags", async () => {
    mockExecFile(JSON.stringify(VALID_SCRIPT));
    const writer = new CliScriptWriter();

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("claude");
    expect(call[1]).toContain("-p");
    expect(call[1]).toContain("--model");
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
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.promptPipelineV2?.enabled).toBe(true);
    const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
    expect(execFileMock).toHaveBeenCalledTimes(5);
    const firstCallArgs = execFileMock.mock.calls[0]?.[1] as string[];
    const schemaFlagIndex = firstCallArgs.indexOf("--json-schema");
    expect(schemaFlagIndex).toBeGreaterThan(-1);
    const schemaArg = JSON.parse(firstCallArgs[schemaFlagIndex + 1] ?? "{}") as Record<string, unknown>;
    expect(JSON.stringify(schemaArg)).not.toContain("\"nullable\"");
  });

  it("attaches rollout comparison metrics when CLI V2 shadow comparison is enabled", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    process.env.PROMPT_PIPELINE_V2_COMPARE_V1 = "true";
    const legacyScript = {
      ...VALID_SCRIPT,
      summary: "Legacy CLI summary",
      totalDurationSeconds: 50,
      totalWordCount: 45,
      keyFiles: ["src/middleware/auth.ts", "src/routes/auth.ts"],
      tags: ["security"],
      scenes: VALID_SCRIPT.scenes.slice(0, 7),
    };
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
      JSON.stringify(legacyScript),
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
    const writer = new CliScriptWriter();

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.promptPipelineV2?.rolloutComparison).toMatchObject({
      enabled: true,
      legacySummary: "Legacy CLI summary",
      v2Summary: VALID_SCRIPT.summary,
      deltas: expect.objectContaining({
        sceneCount: 1,
        totalWordCount: 4,
        keyFilesCount: -1,
        tagCount: 1,
      }),
    });
    // Code-first: V2 durations are recomputed from word count (typically shorter than legacy)
    expect(result.promptPipelineV2?.rolloutComparison?.deltas?.totalDurationSeconds).toBeDefined();
    expect((execFile as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(6);
  });
});

describe("extractClaudeCliStructuredOutput", () => {
  const logger = createLogger("test");

  it("extracts structured_output from a success envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
      structured_output: { summary: "plan", clusters: [] },
    });
    const result = extractClaudeCliStructuredOutput(envelope, logger);
    expect(result).toEqual({ extracted: true, data: { summary: "plan", clusters: [] } });
  });

  it("returns null data for error_max_structured_output_retries", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "error_max_structured_output_retries",
      result: "",
    });
    const result = extractClaudeCliStructuredOutput(envelope, logger);
    expect(result).toEqual({ extracted: true, data: null });
  });

  it("returns extracted:false when envelope has result text but no structured_output", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Coverage plan complete. The PR adds...",
    });
    const result = extractClaudeCliStructuredOutput(envelope, logger);
    expect(result).toEqual({ extracted: false });
  });

  it("returns null data when envelope has no structured_output and empty result", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
    });
    const result = extractClaudeCliStructuredOutput(envelope, logger);
    expect(result).toEqual({ extracted: true, data: null });
  });

  it("returns extracted:false for valid JSON that is not a CLI envelope", () => {
    const notEnvelope = JSON.stringify({ summary: "plan", clusters: [] });
    const result = extractClaudeCliStructuredOutput(notEnvelope, logger);
    expect(result).toEqual({ extracted: false });
  });

  it("returns extracted:false for non-JSON text", () => {
    const result = extractClaudeCliStructuredOutput("not json at all", logger);
    expect(result).toEqual({ extracted: false });
  });

  it("returns extracted:false for text not starting with {", () => {
    const result = extractClaudeCliStructuredOutput("[1,2,3]", logger);
    expect(result).toEqual({ extracted: false });
  });

  it("returns extracted:false when JSON.parse throws SyntaxError", () => {
    const result = extractClaudeCliStructuredOutput("{invalid json", logger);
    expect(result).toEqual({ extracted: false });
  });

  it("re-throws non-SyntaxError exceptions", () => {
    const originalParse = JSON.parse;
    JSON.parse = () => { throw new TypeError("simulated OOM"); };
    try {
      expect(() => extractClaudeCliStructuredOutput("{}", logger)).toThrow(TypeError);
    } finally {
      JSON.parse = originalParse;
    }
  });
});
