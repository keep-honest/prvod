import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeScriptWriter } from "@/infrastructure/llm/ClaudeScriptWriter";
import type { IOutputValidator } from "@/interfaces/IPromptInjectionGuard";
import {
  VALID_SCRIPT,
  fakeDiffAnalysis,
  fakePRContext,
  buildValidOutline,
} from "./fixtures/scriptWriterFixtures";

function makeAnthropicClient() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "write_script",
            input: VALID_SCRIPT,
          },
        ],
        usage: {
          input_tokens: 123,
          output_tokens: 456,
        },
      }),
    },
  } as unknown as Anthropic;
}

function makeScriptWithDurations(durations: readonly number[]) {
  const scenes = VALID_SCRIPT.scenes.map((scene, index) => ({
    ...scene,
    durationSeconds: durations[index] ?? scene.durationSeconds,
  }));
  return {
    ...VALID_SCRIPT,
    scenes,
    totalDurationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
  };
}

function makeToolUseResponse(input: unknown) {
  return {
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        name: "write_script",
        input,
      },
    ],
    usage: {
      input_tokens: 123,
      output_tokens: 456,
    },
  };
}

describe("ClaudeScriptWriter", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_MAX_TOKENS;
    delete process.env.CLAUDE_SCRIPT_MAX_TOKENS;
    delete process.env.CLAUDE_RETIME_MAX_TOKENS;
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
    delete process.env.SCRIPT_DURATION_GUARD_COEFFICIENT;
  });

  afterEach(() => {
    delete process.env.PROMPT_PIPELINE_V2;
    delete process.env.PROMPT_PIPELINE_V2_COMPARE_V1;
    delete process.env.SCRIPT_DURATION_GUARD_COEFFICIENT;
    vi.restoreAllMocks();
  });

  it("uses a larger default output budget for script generation", async () => {
    const client = makeAnthropicClient();
    const writer = new ClaudeScriptWriter(client);

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const create = client.messages.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].max_tokens).toBe(8192);
  });

  it("allows overriding the script output budget via env", async () => {
    process.env.CLAUDE_SCRIPT_MAX_TOKENS = "12288";
    const client = makeAnthropicClient();
    const writer = new ClaudeScriptWriter(client);

    await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const create = client.messages.create as ReturnType<typeof vi.fn>;
    expect(create.mock.calls[0][0].max_tokens).toBe(12288);
  });

  it("accepts default-mode output above 120 seconds when within the duration guard", async () => {
    const acceptedScript = makeScriptWithDurations([20, 20, 20, 20, 20, 20, 10, 9]);
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue(makeToolUseResponse(acceptedScript)),
      },
    } as unknown as Anthropic;
    const writer = new ClaudeScriptWriter(client);

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.script.totalDurationSeconds).toBe(139);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("retries and fails when default-mode output still exceeds the duration guard", async () => {
    const overGuardScript = makeScriptWithDurations([22, 22, 22, 22, 22, 22, 22, 22]);
    const client = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce(makeToolUseResponse(overGuardScript))
          .mockResolvedValueOnce(makeToolUseResponse(overGuardScript)),
      },
    } as unknown as Anthropic;
    const writer = new ClaudeScriptWriter(client);

    await expect(writer.generateScript(fakePRContext, fakeDiffAnalysis)).rejects.toThrow(
      "requested=120s, coefficient=1.4, guardCap=168s, actual=176s",
    );
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("uses Prompt Pipeline V2 when enabled", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    const client = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
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
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
              passed: true,
              issues: [],
              missingMajorClusterIds: [],
              weakEvidenceClusterIds: [],
              allocationIssues: [],
              scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(buildValidOutline()) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(VALID_SCRIPT) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
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
            }) }],
          }),
      },
    } as unknown as Anthropic;
    const writer = new ClaudeScriptWriter(client);

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.promptPipelineV2?.enabled).toBe(true);
    const create = client.messages.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(5);
    expect(create.mock.calls[0][0].tools).toBeUndefined();
    const outputFormat = create.mock.calls[0][0].output_config?.format as { schema?: Record<string, unknown> };
    expect(JSON.stringify(outputFormat?.schema ?? {})).not.toContain("\"nullable\"");
    expect(create.mock.calls[3][0].output_config).toBeDefined();
  });

  it("accepts a judge revisedScript that passes transport schema without repair", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    // In code-first mode, the transport schema (no overview constraint) is used for validation.
    // A script with scene 1 = "hook" passes transport schema, so no repair is needed.
    const revisedScript = {
      ...VALID_SCRIPT,
      summary: "Judge-revised summary",
    };
    const client = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
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
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
              passed: true,
              issues: [],
              missingMajorClusterIds: [],
              weakEvidenceClusterIds: [],
              allocationIssues: [],
              scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(buildValidOutline()) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(VALID_SCRIPT) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
              passed: false,
              issues: ["Hook is too flat"],
              scores: {
                hookStrength: 6,
                explanatoryClarity: 9,
                evidenceGrounding: 9,
                sceneDistinctness: 8,
                themeFidelity: 8,
                topClusterCoverage: 9,
                jargonDensity: 5,
                boredomRisk: 4,
              },
              revisedScript,
            }) }],
          }),
      },
    } as unknown as Anthropic;
    const writer = new ClaudeScriptWriter(client);

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const create = client.messages.create as ReturnType<typeof vi.fn>;
    // 5 calls: planner, coverage judge, outline, final script, narration judge (no repair needed)
    expect(create).toHaveBeenCalledTimes(5);
    expect(result.script.scenes[0].sceneType).toBe("overview");
  });

  it("accepts a transport-valid script without repair in code-first mode", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    // In code-first mode, transport schema is used. A script with scene 1 = "hook"
    // passes transport schema (no overview constraint), so no repair is needed.
    const nonOverviewScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((scene, index) =>
        index === 0 ? { ...scene, sceneType: "hook" } : scene,
      ),
    };
    const client = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
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
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
              passed: true,
              issues: [],
              missingMajorClusterIds: [],
              weakEvidenceClusterIds: [],
              allocationIssues: [],
              scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(buildValidOutline()) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(nonOverviewScript) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
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
            }) }],
          }),
      },
    } as unknown as Anthropic;
    const writer = new ClaudeScriptWriter(client);

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    const create = client.messages.create as ReturnType<typeof vi.fn>;
    // 5 calls — no repair step needed (transport schema accepts non-overview scene 1)
    expect(create).toHaveBeenCalledTimes(5);
    expect(result.script.scenes.length).toBe(VALID_SCRIPT.scenes.length);
  });

  it("attaches rollout comparison metrics when V2 shadow comparison is enabled", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    process.env.PROMPT_PIPELINE_V2_COMPARE_V1 = "true";
    const legacyScript = {
      ...VALID_SCRIPT,
      summary: "Legacy summary",
      totalDurationSeconds: 50,
      totalWordCount: 45,
      keyFiles: ["src/middleware/auth.ts", "src/routes/auth.ts"],
      tags: ["security"],
      scenes: VALID_SCRIPT.scenes.slice(0, 7),
    };
    const client = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
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
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
              passed: true,
              issues: [],
              missingMajorClusterIds: [],
              weakEvidenceClusterIds: [],
              allocationIssues: [],
              scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
            }) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(buildValidOutline()) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(VALID_SCRIPT) }],
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
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
            }) }],
          })
          .mockResolvedValueOnce({
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                name: "write_script",
                input: legacyScript,
              },
            ],
            usage: {
              input_tokens: 111,
              output_tokens: 222,
            },
          }),
      },
    } as unknown as Anthropic;
    const writer = new ClaudeScriptWriter(client);

    const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

    expect(result.promptPipelineV2?.rolloutComparison).toMatchObject({
      enabled: true,
      legacySummary: "Legacy summary",
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
    expect(result.usage?.inputTokens).toBeGreaterThan(111);
    expect((client.messages.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(6);
  });

  describe("V2 output validation", () => {
    function makeV2ClientWithScript(script: typeof VALID_SCRIPT) {
      return {
        messages: {
          create: vi.fn()
            .mockResolvedValueOnce({
              content: [{ type: "text", text: JSON.stringify({
                summary: "plan",
                selectedEvidencePolicy: "cluster-only",
                clusters: [{
                  clusterId: "c1", title: "auth",
                  files: ["src/middleware/auth.ts", "src/routes/auth.ts"],
                  evidenceSnippets: [{ filePath: "src/middleware/auth.ts", summary: "auth", diffExcerpt: "diff" }],
                  technicalMechanism: "validate", impact: "protect",
                  riskIfAbsent: "unsafe", validationEvidence: ["tests"], importanceRank: 1,
                }],
                ledger: [{ clusterId: "c1", disposition: "deep_dive", reason: "main change" }],
                majorClusterIds: ["c1"],
              }) }],
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: JSON.stringify({
                passed: true, issues: [],
                missingMajorClusterIds: [], weakEvidenceClusterIds: [], allocationIssues: [],
                scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
              }) }],
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: JSON.stringify(buildValidOutline()) }],
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: JSON.stringify(script) }],
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: JSON.stringify({
                passed: true, issues: [],
                scores: { hookStrength: 8, explanatoryClarity: 9, evidenceGrounding: 9, sceneDistinctness: 8, themeFidelity: 8, topClusterCoverage: 9, jargonDensity: 4, boredomRisk: 3 },
              }) }],
            }),
        },
      } as unknown as Anthropic;
    }

    function makeV2Client() {
      return makeV2ClientWithScript(VALID_SCRIPT);
    }

    function cleanResult(input: string): import("@/interfaces/IPromptInjectionGuard").SanitizationResult {
      return { content: input, injectionDetected: false, detections: [], contentHash: "hash" };
    }

    function redactedResult(): import("@/interfaces/IPromptInjectionGuard").SanitizationResult {
      return { content: "[REDACTED]", injectionDetected: true, detections: [{ field: "prDescription", patternId: "instruction_override", category: "injection", action: "redacted", position: { start: 0, end: 5 } }], contentHash: "hash" };
    }

    it("replaces narration in scene 1 when outputValidator detects injection", async () => {
      process.env.PROMPT_PIPELINE_V2 = "true";
      const client = makeV2Client();
      const mockValidator: IOutputValidator = {
        validate: vi.fn((text: string) =>
          text === VALID_SCRIPT.scenes[0].narration ? redactedResult() : cleanResult(text),
        ),
        checkCanary: vi.fn().mockReturnValue(false),
      };
      const writer = new ClaudeScriptWriter(client, [4, 6, 8], mockValidator);

      const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

      expect(result.script.scenes[0].narration).toBe("[REDACTED]");
      // Other scenes untouched
      for (let i = 1; i < result.script.scenes.length; i++) {
        expect(result.script.scenes[i].narration).toBe(VALID_SCRIPT.scenes[i].narration);
      }
    });

    it("passes through all fields unchanged when outputValidator detects nothing", async () => {
      process.env.PROMPT_PIPELINE_V2 = "true";
      const client = makeV2Client();
      const mockValidator: IOutputValidator = {
        validate: vi.fn((text: string) => cleanResult(text)),
        checkCanary: vi.fn().mockReturnValue(false),
      };
      const writer = new ClaudeScriptWriter(client, [4, 6, 8], mockValidator);

      const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

      for (let i = 0; i < result.script.scenes.length; i++) {
        expect(result.script.scenes[i].narration).toBe(VALID_SCRIPT.scenes[i].narration);
      }
    });

    it("skips output validation when no outputValidator is injected", async () => {
      process.env.PROMPT_PIPELINE_V2 = "true";
      const client = makeV2Client();
      const writer = new ClaudeScriptWriter(client);

      const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

      expect(result.script.scenes[0].narration).toBe(VALID_SCRIPT.scenes[0].narration);
    });

    it("does NOT validate codeBroll filePath with outputValidator — path is preserved unchanged", async () => {
      process.env.PROMPT_PIPELINE_V2 = "true";
      const client = makeV2Client();
      const targetPath = VALID_SCRIPT.scenes[1].codeBroll[0].filePath;
      const mockValidator: IOutputValidator = {
        validate: vi.fn((text: string) =>
          text === targetPath ? redactedResult() : cleanResult(text),
        ),
        checkCanary: vi.fn().mockReturnValue(false),
      };
      const writer = new ClaudeScriptWriter(client, [4, 6, 8], mockValidator);

      const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

      // codeBroll.filePath is a structured key, not narration content.
      // InputSanitizer + grounding already guard it; OutputValidator would
      // cause false positives on real filenames (e.g. fixtures/alice@example.com.json)
      // and turn technical scenes into NarrativeBridge fallbacks.
      expect(result.script.scenes[1].codeBroll[0].filePath).toBe(targetPath);
    });

    it("replaces productionAudio in scene 1 when outputValidator detects injection", async () => {
      process.env.PROMPT_PIPELINE_V2 = "true";
      const scriptWithAudio = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((s, i) =>
          i === 0 ? { ...s, productionAudio: "low bass drone" } : s,
        ),
      };
      const client = makeV2ClientWithScript(scriptWithAudio as typeof VALID_SCRIPT);
      const mockValidator: IOutputValidator = {
        validate: vi.fn((text: string) =>
          text === "low bass drone" ? redactedResult() : cleanResult(text),
        ),
        checkCanary: vi.fn().mockReturnValue(false),
      };
      const writer = new ClaudeScriptWriter(client, [4, 6, 8], mockValidator);

      const result = await writer.generateScript(fakePRContext, fakeDiffAnalysis);

      expect(result.script.scenes[0].productionAudio).toBe("[REDACTED]");
      // Other scenes' narration untouched
      expect(result.script.scenes[1].narration).toBe(VALID_SCRIPT.scenes[1].narration);
    });
  });

  it("throws on max_tokens truncation during structured output generation", async () => {
    process.env.PROMPT_PIPELINE_V2 = "true";
    const client = {
      messages: {
        create: vi.fn()
          // Call 1: coverage plan
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
              summary: "plan",
              selectedEvidencePolicy: "cluster-only",
              clusters: [{
                clusterId: "c1", title: "auth",
                files: ["src/middleware/auth.ts", "src/routes/auth.ts"],
                evidenceSnippets: [{ filePath: "src/middleware/auth.ts", summary: "auth", diffExcerpt: "diff" }],
                technicalMechanism: "validate", impact: "protect",
                riskIfAbsent: "unsafe", validationEvidence: ["tests"], importanceRank: 1,
              }],
              ledger: [{ clusterId: "c1", disposition: "deep_dive", reason: "main change" }],
              majorClusterIds: ["c1"],
            }) }],
          })
          // Call 2: coverage judge
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify({
              passed: true, issues: [],
              missingMajorClusterIds: [], weakEvidenceClusterIds: [], allocationIssues: [],
              scores: { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 },
            }) }],
          })
          // Call 3: scene outline
          .mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(buildValidOutline()) }],
          })
          // Call 4: final script — TRUNCATED
          .mockResolvedValueOnce({
            stop_reason: "max_tokens",
            content: [{ type: "text", text: '{"partial":' }],
          }),
      },
    } as unknown as Anthropic;
    const writer = new ClaudeScriptWriter(client);

    await expect(writer.generateScript(fakePRContext, fakeDiffAnalysis))
      .rejects.toThrow(/truncated/i);
  });
});

describe("ClaudeScriptWriter.completeJson typed-error contract", () => {
  // Schema validation failures must throw StructuredOutputValidationError carrying
  // rawJson + ZodError so completeJsonWithRepair can route the failure into
  // repairLoop. Claude SDK writer's throw site is distinct from CLI / Gemini:
  // rawJson = the raw `textBlock.text` (not parsed, not jsonrepaired).

  beforeEach(() => {
    process.env.PROMPT_PIPELINE_V2 = "true";
  });
  afterEach(() => {
    delete process.env.PROMPT_PIPELINE_V2;
    vi.restoreAllMocks();
  });

  async function captureModelCompleteJson(client: Anthropic): Promise<
    NonNullable<Parameters<typeof import("@/infrastructure/llm/promptPipelineV2Runner").generateScriptWithPromptPipelineV2>[0]["model"]["completeJson"]>
  > {
    const v2Runner = await import("@/infrastructure/llm/promptPipelineV2Runner");
    let captured: Parameters<typeof v2Runner.generateScriptWithPromptPipelineV2>[0]["model"]["completeJson"] | undefined;
    const spy = vi.spyOn(v2Runner, "generateScriptWithPromptPipelineV2");
    spy.mockImplementation(async (input) => {
      captured = input.model.completeJson;
      return {
        script: VALID_SCRIPT as unknown as Awaited<ReturnType<typeof v2Runner.generateScriptWithPromptPipelineV2>>["script"],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });
    const writer = new ClaudeScriptWriter(client);
    await writer.generateScript(fakePRContext, fakeDiffAnalysis);
    spy.mockRestore();
    if (!captured) throw new Error("completeJson not captured");
    return captured;
  }

  it("throws StructuredOutputValidationError on Zod failure with rawJson = raw textBlock.text", async () => {
    const invalidPayload = JSON.stringify({ wrong: "shape" });
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "end_turn",
          content: [{ type: "text", text: invalidPayload }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    } as unknown as Anthropic;

    const completeJson = await captureModelCompleteJson(client);
    const { z } = await import("zod");
    const { StructuredOutputValidationError } = await import("@/infrastructure/llm/promptPipelineV2Repair");
    const schema = z.object({ required: z.string() });

    let thrown: unknown;
    try {
      await completeJson("sys", "user", schema, { schemaName: "test_claude_zod" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredOutputValidationError);
    const typed = thrown as InstanceType<typeof StructuredOutputValidationError>;
    expect(typed.schemaName).toBe("test_claude_zod");
    expect(typed.rawJson).toBe(invalidPayload); // raw textBlock.text, no JSON.stringify, no jsonrepair
    expect(typed.zodError.issues.length).toBeGreaterThan(0);
    expect(typed.message).toContain("structured output");
    expect(typed.cause).toBe(typed.zodError);
  });

  it("throws plain Error (NOT typed) on JSON syntax failure", async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "{ not valid json" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    } as unknown as Anthropic;

    const completeJson = await captureModelCompleteJson(client);
    const { z } = await import("zod");
    const { StructuredOutputValidationError } = await import("@/infrastructure/llm/promptPipelineV2Repair");
    const schema = z.object({ ok: z.boolean() });

    let thrown: unknown;
    try {
      await completeJson("sys", "user", schema, { schemaName: "test_claude_syntax" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(StructuredOutputValidationError);
    expect((thrown as Error).message).toContain("structured output");
  });
});
