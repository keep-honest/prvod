import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ZodError } from "zod";
import { generateScriptWithPromptPipelineV2, recomputeCodeFirstDurations, deriveScriptFromTransport, normalizeBatchedScenesFromOutline, ensureLastSceneOverview } from "@/infrastructure/llm/promptPipelineV2Runner";
import { promptPipelineV2ArtifactsSchema, coveragePlanSchema, sceneOutlineSchema } from "@/domain/entities/PromptPipelineV2";
import { StructuredOutputValidationError } from "@/infrastructure/llm/promptPipelineV2Repair";
import {
  VALID_SCRIPT,
  fakeDiffAnalysis,
  fakePRContext,
  buildValidOutline,
  makeVideoScript,
  makeCoveragePlan,
  passingJudgeScores,
  passingCoverageJudge,
  passingNarrationJudge,
} from "./fixtures/scriptWriterFixtures";
import { PROMPT_PIPELINE_V2_EVAL_CORPUS } from "./fixtures/promptPipelineV2EvalCorpus";

describe("generateScriptWithPromptPipelineV2", () => {
  const deepdiveContext = {
    ...fakePRContext,
    deepdive: true,
  } as const;

  it("runs planner, judges, outline, and final writer and applies judge revisions", async () => {
    const plannedCoverage = {
      summary: "Initial plan",
      selectedEvidencePolicy: "Use the top diff hunks per cluster.",
      clusters: [
        {
          clusterId: "cluster-auth",
          title: "Authentication middleware",
          files: ["src/middleware/auth.ts", "src/routes/auth.ts"],
          evidenceSnippets: [
            {
              filePath: "src/middleware/auth.ts",
              summary: "Adds auth validation",
              diffExcerpt: "function validateJWT() {}",
            },
            {
              filePath: "src/routes/auth.ts",
              summary: "Installs middleware on the auth router",
              diffExcerpt: "router.use(authMiddleware())",
            },
          ],
          technicalMechanism: "Validate JWT before route execution",
          impact: "Protects incoming requests",
          riskIfAbsent: "Unauthorized requests reach handlers",
          validationEvidence: ["auth middleware test coverage"],
          importanceRank: 1,
        },
      ],
      ledger: [
        {
          clusterId: "cluster-auth",
          disposition: "deep_dive",
          reason: "Primary user-facing change",
        },
      ],
      majorClusterIds: ["cluster-auth"],
    };

    const revisedCoverage = {
      ...plannedCoverage,
      summary: "Revised plan",
      selectedEvidencePolicy: "Use only cluster-selected evidence in the final writer.",
    };

    const outline = buildValidOutline();
    // Override with richer outline for this test
    outline.scenes = [
      { sceneNumber: 1, sceneType: "overview", title: "Overview", clusterIds: [], evidenceFilePaths: [], whatChanged: "Adds authentication", whyItMatters: "Protects requests", failureWithoutIt: "Unauthorized calls slip through", validation: "Middleware tests verify access control", visualFocus: "A locked gate being installed" },
      { sceneNumber: 2, sceneType: "code_walkthrough", title: "JWT validation", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/middleware/auth.ts"], whatChanged: "JWT validation runs before handlers", whyItMatters: "Separates auth from business logic", failureWithoutIt: "Routes trust unauthenticated traffic", validation: "Middleware tests reject invalid tokens", visualFocus: "Inspection and rejection at a checkpoint" },
      { sceneNumber: 3, sceneType: "before_after", title: "Before and after", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/routes/auth.ts"], whatChanged: "Requests now pass through middleware first", whyItMatters: "Auth is centralized before route handlers", failureWithoutIt: "Routes stay exposed", validation: "Integration tests reject invalid tokens", visualFocus: "A gate swings from open access to controlled admission" },
      { sceneNumber: 4, sceneType: "code_walkthrough", title: "Route integration", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/middleware/auth.ts"], whatChanged: "Middleware attaches before route logic", whyItMatters: "Handlers can assume authenticated callers", failureWithoutIt: "Every handler must re-check auth", validation: "Route tests observe protected access", visualFocus: "A checkpoint feeds a cleaner path downstream" },
      { sceneNumber: 5, sceneType: "architecture", title: "Separation of concerns", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/middleware/auth.ts"], whatChanged: "Auth concerns moved into a dedicated layer", whyItMatters: "The design stays maintainable", failureWithoutIt: "Auth logic leaks into route handlers", validation: "Middleware-level tests keep the contract stable", visualFocus: "A distinct security lane wraps around the main mechanism" },
      { sceneNumber: 6, sceneType: "code_walkthrough", title: "Failure handling", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/middleware/auth.ts"], whatChanged: "Invalid tokens fail before business logic runs", whyItMatters: "Unauthorized requests are rejected early", failureWithoutIt: "Invalid traffic reaches handlers", validation: "Tests reject malformed credentials", visualFocus: "Rejected parts drop into a discard chute before the machine starts" },
      { sceneNumber: 7, sceneType: "summary", title: "Outcome", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/middleware/auth.ts"], whatChanged: "Routes are now protected by middleware", whyItMatters: "Auth is applied consistently", failureWithoutIt: "Coverage remains uneven", validation: "Protected-route tests confirm enforcement", visualFocus: "The protected corridor settles into a steady guarded rhythm" },
      { sceneNumber: 8, sceneType: "closing", title: "Resolution", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/middleware/auth.ts"], whatChanged: "Authentication is enforced before route execution", whyItMatters: "The request path is secure", failureWithoutIt: "The system stays exposed", validation: "Middleware tests close the loop", visualFocus: "A final lock engages across the workshop gate" },
    ] as typeof outline.scenes;

    const revisedScript = {
      ...VALID_SCRIPT,
      summary: "Revised final script summary",
    };

    const model = {
      family: "claude" as const,
      completeJson: vi.fn()
        // 1. Coverage planner
        .mockResolvedValueOnce(plannedCoverage)
        // 2. Coverage judge
        .mockResolvedValueOnce({
          passed: false,
          issues: ["Need stronger evidence selection policy"],
          missingMajorClusterIds: [],
          weakEvidenceClusterIds: [],
          allocationIssues: [],
          scores: { completeness: 8, evidenceGrounding: 7, allocationQuality: 8 },
          revisedPlan: revisedCoverage,
        })
        // 3. Scene outline
        .mockResolvedValueOnce(outline)
        // 4. Final script
        .mockResolvedValueOnce(VALID_SCRIPT)
        // 5. Narration judge
        .mockResolvedValueOnce({
          passed: false,
          issues: ["Hook is too flat"],
          scores: {
            hookStrength: 6, explanatoryClarity: 9, evidenceGrounding: 9,
            sceneDistinctness: 8, themeFidelity: 8, topClusterCoverage: 9,
            jargonDensity: 5, boredomRisk: 4,
          },
          revisedScript,
        }),
    };

    const result = await generateScriptWithPromptPipelineV2({
      model,
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      validDurations: [4, 6, 8],
    });

    expect(model.completeJson).toHaveBeenCalledTimes(5);
    expect(result.script.summary).toBe("Revised final script summary");
    expect(result.promptPipelineV2?.coveragePlan.summary).toBe("Revised plan");
    expect(result.promptPipelineV2?.narrationJudge?.passed).toBe(false);
    expect(result.promptPipelineV2?.sceneOutline.scenes).toHaveLength(8);
    expect(result.promptPipelineV2?.coverageValidation?.passed).toBe(true);
    expect(result.promptPipelineV2?.sceneOutlineValidation?.passed).toBe(true);
    expect(result.promptPipelineV2?.scriptValidation?.passed).toBe(true);
  });

  it("fails when the approved coverage plan is structurally incomplete", async () => {
    const invalidCoverage = {
      summary: "Invalid plan",
      selectedEvidencePolicy: "Use top diff hunks.",
      clusters: [
        {
          clusterId: "cluster-auth",
          title: "Authentication middleware",
          files: ["src/middleware/auth.ts"],
          evidenceSnippets: [
            { filePath: "src/middleware/auth.ts", summary: "Adds auth validation", diffExcerpt: "function validateJWT() {}" },
          ],
          technicalMechanism: "Validate JWT before route execution",
          impact: "Protects incoming requests",
          riskIfAbsent: "Unauthorized requests reach handlers",
          validationEvidence: ["auth middleware test coverage"],
          importanceRank: 1,
        },
      ],
      ledger: [{ clusterId: "ghost-cluster", disposition: "summary", reason: "unknown cluster" }],
      majorClusterIds: ["cluster-auth"],
    };
    const model = {
      family: "claude" as const,
      completeJson: vi.fn()
        .mockResolvedValueOnce(invalidCoverage)
        .mockResolvedValueOnce({
          passed: true,
          issues: [],
          missingMajorClusterIds: [],
          weakEvidenceClusterIds: [],
          allocationIssues: [],
          scores: passingJudgeScores(),
        }),
    };

    await expect(
      generateScriptWithPromptPipelineV2({
        model,
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      }),
    ).rejects.toThrow(/coverage validation failed/i);
  });

  it("fails when the final script cites files outside the assigned evidence", async () => {
    const invalidScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration: "The change in `src/unplanned/extra-file.ts` adds a new route.",
            }
          : scene,
      ),
    };
    const model = {
      family: "claude" as const,
      completeJson: vi.fn()
        .mockResolvedValueOnce(makeCoveragePlan())
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(buildValidOutline())
        .mockResolvedValueOnce(invalidScript)
        .mockResolvedValueOnce(passingNarrationJudge()),
    };

    await expect(
      generateScriptWithPromptPipelineV2({
        model,
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      }),
    ).rejects.toThrow(/script validation failed/i);
  });

  it("accepts default-mode output above 120 seconds when within the duration guard", async () => {
    // Code-first mode recomputes durations from word count (ceil(wordCount * 0.4)).
    // To exceed 120s, each of the 8 scenes needs ~40 words (ceil(40*0.4)=16s, 8*16=128s).
    const longNarration = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const tooLongScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((scene) => ({
        ...scene,
        narration: longNarration,
        durationSeconds: 16,
      })),
      totalDurationSeconds: 128,
      totalWordCount: 320,
    };
    const model = {
      family: "claude" as const,
      completeJson: vi.fn()
        .mockResolvedValueOnce(makeCoveragePlan())
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(buildValidOutline())
        .mockResolvedValueOnce(tooLongScript)
        .mockResolvedValueOnce({
          passed: true, issues: [],
          scores: { hookStrength: 7, explanatoryClarity: 8, evidenceGrounding: 8, sceneDistinctness: 8, themeFidelity: 8, topClusterCoverage: 8, jargonDensity: 4, boredomRisk: 4 },
        })
        .mockResolvedValueOnce(VALID_SCRIPT)
        .mockResolvedValueOnce(passingNarrationJudge()),
    };

    const result = await generateScriptWithPromptPipelineV2({
      model,
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      validDurations: [4, 6, 8],
    });

    expect(result.script.totalDurationSeconds).toBe(128);
    expect(model.completeJson).toHaveBeenCalledTimes(5);
  });

  it("retries and fails when default-mode output exceeds the duration guard after retry", async () => {
    const longNarration = Array.from({ length: 55 }, (_, i) => `word${i}`).join(" ");
    const tooLongScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((scene) => ({
        ...scene,
        narration: longNarration,
        durationSeconds: 22,
      })),
      totalDurationSeconds: 176,
      totalWordCount: 320,
    };
    const model = {
      family: "claude" as const,
      completeJson: vi.fn()
        .mockResolvedValueOnce(makeCoveragePlan())
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(buildValidOutline())
        .mockResolvedValueOnce(tooLongScript)
        .mockResolvedValueOnce(passingNarrationJudge())
        .mockResolvedValueOnce(tooLongScript)
        .mockResolvedValueOnce(passingNarrationJudge()),
    };

    await expect(
      generateScriptWithPromptPipelineV2({
        model,
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      }),
    ).rejects.toThrow(/requested=120s.*coefficient=1\.4.*guardCap=168s.*actual=176s/);
    expect(model.completeJson).toHaveBeenCalledTimes(7);
  });

  it("fails fast when the coverage planner returns invalid data", async () => {
    // In production, completeJson validates via Zod — simulate the rejection
    const model = {
      family: "claude" as const,
      completeJson: vi.fn().mockRejectedValueOnce(
        new Error("Required at \"majorClusterIds\""),
      ),
    };

    await expect(
      generateScriptWithPromptPipelineV2({
        model,
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      }),
    ).rejects.toThrow(/majorClusterIds/i);
  });

  it("repairs a Zod-invalid coverage_plan via completeText (regression for the original bug)", async () => {
    // The exact failure mode from the production trace: clusters[6] emitted
    // with an empty validationEvidence array, failing z.array().min(1). The
    // pipeline used to die at stage 1/7; now completeJsonWithRepair catches
    // the typed StructuredOutputValidationError, runs repairLoop against
    // the original ZodError, and the LLM returns a fixed coverage plan.
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    const validPlan = makeCoveragePlan();
    const brokenPlan = {
      ...validPlan,
      clusters: validPlan.clusters.map((c, i) =>
        i === 0 ? { ...c, validationEvidence: [] } : c,
      ),
    };
    const zodError = (coveragePlanSchema.safeParse(brokenPlan) as { success: false; error: ZodError }).error;
    const completeText = vi.fn().mockResolvedValueOnce(JSON.stringify(validPlan));
    const completeJson = vi.fn()
      .mockRejectedValueOnce(
        new StructuredOutputValidationError(
          'CLI structured output for "coverage_plan" failed: ...',
          JSON.stringify(brokenPlan, null, 2),
          zodError,
          "coverage_plan",
        ),
      )
      .mockResolvedValueOnce(passingCoverageJudge())
      .mockResolvedValueOnce(buildValidOutline())
      .mockResolvedValueOnce(VALID_SCRIPT)
      .mockResolvedValueOnce(passingNarrationJudge());

    const result = await generateScriptWithPromptPipelineV2({
      model: {
        family: "claude",
        supportsNativeStructuredOutput: true,
        completeJson,
        completeText,
      },
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      validDurations: [4, 6, 8],
    });

    expect(result.script.summary).toBe(VALID_SCRIPT.summary);
    expect(completeText).toHaveBeenCalledTimes(1);
    // The repair attempt must be invoked with the coverage-plan shape hint,
    // not the default video-script shape hint.
    const [, repairUserPrompt] = completeText.mock.calls[0];
    expect(repairUserPrompt).toContain("validationEvidence");
    vi.unstubAllEnvs();
  });

  it("propagates final ZodError as StructuredOutputValidationError when coverage_plan repair exhausts", async () => {
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    const validPlan = makeCoveragePlan();
    const brokenPlan = {
      ...validPlan,
      clusters: validPlan.clusters.map((c) => ({ ...c, validationEvidence: [] })),
    };
    const zodError = (coveragePlanSchema.safeParse(brokenPlan) as { success: false; error: ZodError }).error;
    const completeText = vi.fn().mockResolvedValue(JSON.stringify(brokenPlan)); // repair always returns invalid
    const completeJson = vi.fn().mockRejectedValueOnce(
      new StructuredOutputValidationError(
        'CLI structured output for "coverage_plan" failed: ...',
        JSON.stringify(brokenPlan, null, 2),
        zodError,
        "coverage_plan",
      ),
    );

    await expect(
      generateScriptWithPromptPipelineV2({
        model: {
          family: "claude",
          supportsNativeStructuredOutput: true,
          completeJson,
          completeText,
        },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      }),
    ).rejects.toMatchObject({
      name: "StructuredOutputValidationError",
      schemaName: "coverage_plan",
    });
    vi.unstubAllEnvs();
  });

  it("rethrows the original StructuredOutputValidationError on coverage_plan when completeText is absent", async () => {
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    const validPlan = makeCoveragePlan();
    const brokenPlan = {
      ...validPlan,
      clusters: validPlan.clusters.map((c) => ({ ...c, validationEvidence: [] })),
    };
    const zodError = (coveragePlanSchema.safeParse(brokenPlan) as { success: false; error: ZodError }).error;
    const originalError = new StructuredOutputValidationError(
      'CLI structured output for "coverage_plan" failed: ...',
      JSON.stringify(brokenPlan, null, 2),
      zodError,
      "coverage_plan",
    );
    const completeJson = vi.fn().mockRejectedValueOnce(originalError);

    await expect(
      generateScriptWithPromptPipelineV2({
        model: {
          family: "claude",
          supportsNativeStructuredOutput: true,
          completeJson,
          // completeText intentionally omitted
        },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      }),
    ).rejects.toBe(originalError);
    vi.unstubAllEnvs();
  });

  it("repairs a Zod-invalid scene_outline via completeText before business validation", async () => {
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    const validOutline = buildValidOutline();
    const brokenOutline = { scenes: [] }; // fails sceneOutlineSchema (.min(1))
    const zodError = (sceneOutlineSchema.safeParse(brokenOutline) as { success: false; error: ZodError }).error;
    const completeText = vi.fn().mockResolvedValueOnce(JSON.stringify(validOutline));
    const completeJson = vi.fn()
      .mockResolvedValueOnce(makeCoveragePlan())
      .mockResolvedValueOnce(passingCoverageJudge())
      .mockRejectedValueOnce(
        new StructuredOutputValidationError(
          'CLI structured output for "scene_outline" failed: ...',
          JSON.stringify(brokenOutline, null, 2),
          zodError,
          "scene_outline",
        ),
      )
      .mockResolvedValueOnce(VALID_SCRIPT)
      .mockResolvedValueOnce(passingNarrationJudge());

    const result = await generateScriptWithPromptPipelineV2({
      model: {
        family: "claude",
        supportsNativeStructuredOutput: true,
        completeJson,
        completeText,
      },
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      validDurations: [4, 6, 8],
    });

    expect(result.script.summary).toBe(VALID_SCRIPT.summary);
    expect(completeText).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it("keeps the first final-script pass on completeJson when native structured output exists", async () => {
    const completeText = vi.fn();
    const completeJson = vi.fn()
      .mockResolvedValueOnce(makeCoveragePlan())
      .mockResolvedValueOnce(passingCoverageJudge())
      .mockResolvedValueOnce(buildValidOutline())
      .mockResolvedValueOnce(VALID_SCRIPT)
      .mockResolvedValueOnce(passingNarrationJudge());

    const result = await generateScriptWithPromptPipelineV2({
      model: {
        family: "claude",
        supportsNativeStructuredOutput: true,
        completeJson,
        completeText,
      },
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      validDurations: [4, 6, 8],
    });

    expect(result.script.summary).toBe(VALID_SCRIPT.summary);
    expect(completeJson).toHaveBeenCalledTimes(5);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("repairs a schema-invalid final script after native structured output", async () => {
    // Use durationSeconds: 0 to fail transport schema (positive int required)
    const brokenScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((scene, index) =>
        index === 0 ? { ...scene, durationSeconds: 0 } : scene,
      ),
    };
    const completeText = vi.fn().mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));
    const completeJson = vi.fn()
      .mockResolvedValueOnce(makeCoveragePlan())
      .mockResolvedValueOnce(passingCoverageJudge())
      .mockResolvedValueOnce(buildValidOutline())
      .mockResolvedValueOnce(brokenScript)
      .mockResolvedValueOnce(passingNarrationJudge());

    const result = await generateScriptWithPromptPipelineV2({
      model: {
        family: "claude",
        supportsNativeStructuredOutput: true,
        completeJson,
        completeText,
      },
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      validDurations: [4, 6, 8],
    });

    expect(result.script.scenes[0].durationSeconds).toBeGreaterThan(0);
    expect(completeJson).toHaveBeenCalledTimes(5);
    expect(completeText).toHaveBeenCalledTimes(1);
  });

  describe("script repair loop (via completeText)", () => {
    const coveragePlan = makeCoveragePlan();
    const outline = buildValidOutline();

    // Script with durationSeconds: 0 — fails transport schema (positive int required)
    const brokenScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((s, i) =>
        i === 0 ? { ...s, durationSeconds: 0 } : s,
      ),
    };

    beforeEach(() => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("repairs a script that fails Zod validation on first attempt", async () => {
      const completeText = vi.fn()
        // Call 1: final script — broken (no overview)
        .mockResolvedValueOnce(JSON.stringify(brokenScript))
        // Call 2: repair attempt — valid
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        // Call 1: coverage plan
        .mockResolvedValueOnce(coveragePlan)
        // Call 2: coverage judge
        .mockResolvedValueOnce(passingCoverageJudge())
        // Call 3: scene outline
        .mockResolvedValueOnce(outline)
        // Call 4: narration judge (after repaired script)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // completeText called twice: initial script + 1 repair
      expect(completeText).toHaveBeenCalledTimes(2);
      // Repair prompt should contain the validation error (durationSeconds must be positive)
      expect(completeText.mock.calls[1][1]).toMatch(/durationSeconds|positive/i);
      expect(result.script.scenes[0].durationSeconds).toBeGreaterThan(0);
    });

    it("throws after exhausting repair attempts", async () => {
      const completeText = vi.fn()
        .mockResolvedValue(JSON.stringify(brokenScript)); // Always returns broken

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline);

      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow(/positive|durationSeconds/i);

      // Initial + 2 repair attempts = 3 calls
      expect(completeText).toHaveBeenCalledTimes(3);
    });

    it("skips repair when SCRIPT_REPAIR_MAX_ATTEMPTS=0", async () => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "0");

      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(brokenScript));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline);

      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow(/positive|durationSeconds/i);

      // Only initial call, no repair attempts
      expect(completeText).toHaveBeenCalledTimes(1);
    });

    it("throws immediately when completeText returns non-JSON text", async () => {
      const completeText = vi.fn()
        .mockResolvedValueOnce("Sorry, I cannot generate a script for that.");

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline);

      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow(/unparseable text/i);

      expect(completeText).toHaveBeenCalledTimes(1);
    });
  });

  describe("grounding repair loop", () => {
    const coveragePlan = makeCoveragePlan();
    const outline = buildValidOutline();

    // Script with ungrounded file reference in scene 4 narration
    const ungroundedScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((s) =>
        s.sceneNumber === 4
          ? { ...s, narration: "The file src/unrelated/foo.ts integrates seamlessly." }
          : s,
      ),
    };

    beforeEach(() => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("repairs a script with ungrounded file references via completeText", async () => {
      // completeText call 1: initial script (text-first path) returns ungrounded script
      // completeText call 2: grounding repair returns clean script
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(ungroundedScript))
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // Initial script + grounding repair = 2 completeText calls
      expect(completeText).toHaveBeenCalledTimes(2);
      // Narration judge runs once (no post-grounding rerun).
      expect(completeJson).toHaveBeenCalledTimes(4);
      // Repair prompt should mention the ungrounded file
      expect(completeText.mock.calls[1][1]).toContain("src/unrelated/foo.ts");
      expect(result.script.scenes[3].narration).not.toContain("src/unrelated/foo.ts");
      // Grounding repair rewrote the script — stale narration judge is cleared
      expect(result.promptPipelineV2?.narrationJudge).toBeUndefined();
    });

    it("re-runs narration judge after grounding repair when POST_GROUNDING=true", async () => {
      vi.stubEnv("POST_GROUNDING", "true");
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(ungroundedScript))
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge())
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(completeText).toHaveBeenCalledTimes(2);
      // Narration judge runs before AND after grounding repair.
      expect(completeJson).toHaveBeenCalledTimes(5);
      expect(result.promptPipelineV2?.narrationJudge?.passed).toBe(true);
    });

    it("re-runs word budget repair after grounding and post-grounding judge rewrites", async () => {
      vi.stubEnv("POST_GROUNDING", "true");
      // Code-first: total word budget at speed=1.0 is 300. Create over-budget grounded script (480 words).
      const longNarration = Array.from({ length: 60 }, (_, j) => `word${j}`).join(" ");
      const overBudgetGroundedScript = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((s) => ({
          ...s,
          narration: longNarration,
        })),
      };
      const completeText = vi.fn()
        // Pass 1: ungrounded script
        .mockResolvedValueOnce(JSON.stringify(ungroundedScript))
        // Pass 1: grounding repair → over-budget grounded script
        .mockResolvedValueOnce(JSON.stringify(overBudgetGroundedScript))
        // Pass 1: post-grounding word budget repair → short valid script
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge())
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(completeText).toHaveBeenCalledTimes(3);
      expect(completeJson).toHaveBeenCalledTimes(5);
      expect(completeText.mock.calls[2][1]).toContain("word");
      expect(result.script.scenes[0].sceneType).toBe("overview");
    });

    it("keeps the last grounded script when final word-budget repair breaks grounding", async () => {
      vi.stubEnv("POST_GROUNDING", "true");
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const longNarration = Array.from({ length: 60 }, (_, j) => `word${j}`).join(" ");
      const overBudgetGroundedScript = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((s) => ({
          ...s,
          narration: longNarration,
        })),
      };
      const completeText = vi.fn()
        // Pass 1: ungrounded script
        .mockResolvedValueOnce(JSON.stringify(ungroundedScript))
        // Pass 1: grounding repair → over-budget grounded
        .mockResolvedValueOnce(JSON.stringify(overBudgetGroundedScript))
        // Pass 1: word budget repair → ungrounded (triggers revert)
        .mockResolvedValueOnce(JSON.stringify(ungroundedScript))
        // Pass 2 (duration retry): returns short valid script
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge())
        .mockResolvedValueOnce(passingNarrationJudge())
        // Pass 2 (duration retry): narration judge
        .mockResolvedValueOnce(passingNarrationJudge());

      try {
        const result = await generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        });

        const revertWarnings = consoleWarnSpy.mock.calls.filter(
          ([msg]) => typeof msg === "string"
            && msg.includes("reintroduced grounding issues"),
        );
        expect(revertWarnings).toHaveLength(1);
        expect(result.script.scenes[0].sceneType).toBe("overview");
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it("warns once when post-grounding repair still exceeds total word budget", async () => {
      vi.stubEnv("POST_GROUNDING", "true");
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const longNarration = Array.from({ length: 60 }, (_, j) => `word${j}`).join(" ");
      const overBudgetGroundedScript = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((s) => ({
          ...s,
          narration: longNarration,
        })),
      };
      const completeText = vi.fn()
        // Pass 1: ungrounded
        .mockResolvedValueOnce(JSON.stringify(ungroundedScript))
        // Pass 1: grounding repair → over-budget
        .mockResolvedValueOnce(JSON.stringify(overBudgetGroundedScript))
        // Pass 1: word budget repair attempt 1 → still over-budget
        .mockResolvedValueOnce(JSON.stringify(overBudgetGroundedScript))
        // Pass 1: word budget repair attempt 2 → still over-budget
        .mockResolvedValueOnce(JSON.stringify(overBudgetGroundedScript))
        // Pass 2 (duration retry): returns short valid script
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge())
        .mockResolvedValueOnce(passingNarrationJudge())
        // Pass 2 (duration retry): narration judge
        .mockResolvedValueOnce(passingNarrationJudge());

      try {
        const result = await generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        });

        const finalWarnings = consoleWarnSpy.mock.calls.filter(
          ([msg]) => typeof msg === "string"
            && msg.includes("Word budgets still exceed"),
        );
        expect(finalWarnings).toHaveLength(1);
        // Duration retry succeeded with short script
        expect(result.script.scenes[0].sceneType).toBe("overview");
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it("throws after grounding repair attempts are exhausted", async () => {
      // All completeText calls return ungrounded script
      const completeText = vi.fn()
        .mockResolvedValue(JSON.stringify(ungroundedScript));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge());

      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow(/script validation failed/i);

      // Initial + 2 grounding repair attempts = 3 completeText calls
      expect(completeText).toHaveBeenCalledTimes(3);
    });

    it("proceeds with warning when GROUNDING_FAILURE_WARN=true", async () => {
      process.env.GROUNDING_FAILURE_WARN = "true";
      try {
        const completeText = vi.fn()
          .mockResolvedValue(JSON.stringify(ungroundedScript));

        const completeJson = vi.fn()
          .mockResolvedValueOnce(coveragePlan)
          .mockResolvedValueOnce(passingCoverageJudge())
          .mockResolvedValueOnce(outline)
          .mockResolvedValueOnce(passingNarrationJudge());

        const result = await generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        });

        // Should succeed instead of throwing
        expect(result.script).toBeDefined();
        expect(result.script.scenes.length).toBeGreaterThan(0);
      } finally {
        delete process.env.GROUNDING_FAILURE_WARN;
      }
    });

    it("batched pass: handles over-budget grounded script through duration retry", async () => {
      vi.stubEnv("BATCH_SCENE_GENERATION", "true");
      vi.stubEnv("SKIP_JUDGE", "true");
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "1");

      const longNarration = Array.from({ length: 60 }, (_, j) => `word${j}`).join(" ");
      const overBudgetGroundedScript = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((s) => ({
          ...s,
          narration: longNarration,
        })),
      };

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(outline)
        // Batched generation (4 batches)
        .mockResolvedValueOnce(overBudgetGroundedScript)
        .mockResolvedValueOnce({
          scenes: overBudgetGroundedScript.scenes.filter(
            (s) => s.sceneNumber >= 2 && s.sceneNumber <= 4,
          ),
        })
        .mockResolvedValueOnce({
          scenes: overBudgetGroundedScript.scenes.filter(
            (s) => s.sceneNumber >= 5 && s.sceneNumber <= 7,
          ),
        })
        .mockResolvedValueOnce({
          scenes: overBudgetGroundedScript.scenes.filter(
            (s) => s.sceneNumber === 8,
          ),
        });

      const completeText = vi.fn()
        // Word budget repair → over-budget (exhausts)
        .mockResolvedValueOnce(JSON.stringify(overBudgetGroundedScript))
        // Final word budget repair → ungrounded (triggers revert to over-budget)
        .mockResolvedValueOnce(JSON.stringify(ungroundedScript));

      // Code-first: over-budget script (480 words -> 192s) exceeds the duration guard.
      // Duration retry throws since no retry mock response is supplied.
      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow();
    });

    it("batched pass: repairs a Zod-invalid batch_envelope via completeText", async () => {
      // First batch (envelope) throws StructuredOutputValidationError → wrapper
      // catches it, repairLoop fires, returns a valid envelope. Subsequent
      // batches resolve normally. The batched pipeline must NOT crash on a
      // single bad batch envelope.
      vi.stubEnv("BATCH_SCENE_GENERATION", "true");
      vi.stubEnv("SKIP_JUDGE", "true");
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");

      const validEnvelope = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.filter((s) => s.sceneNumber === 1),
      };
      const brokenEnvelope = { ...validEnvelope, scenes: [] }; // fails .min(1) on scenes
      const envelopeZodError = new ZodError([
        { code: "too_small", minimum: 1, type: "array", inclusive: true, message: "Array must contain at least 1 element(s)", path: ["scenes"] },
      ] as never);

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(outline)
        // Batch 0 (envelope): throws typed error, repair via completeText.
        .mockRejectedValueOnce(
          new StructuredOutputValidationError(
            'CLI structured output for "batch_envelope" failed: ...',
            JSON.stringify(brokenEnvelope, null, 2),
            envelopeZodError,
            "batch_envelope",
          ),
        )
        // Remaining batches: scene groups.
        .mockResolvedValueOnce({ scenes: VALID_SCRIPT.scenes.filter((s) => s.sceneNumber >= 2 && s.sceneNumber <= 4) })
        .mockResolvedValueOnce({ scenes: VALID_SCRIPT.scenes.filter((s) => s.sceneNumber >= 5 && s.sceneNumber <= 7) })
        .mockResolvedValueOnce({ scenes: VALID_SCRIPT.scenes.filter((s) => s.sceneNumber === 8) });

      const completeText = vi.fn()
        // Repair for batch 0 envelope.
        .mockResolvedValueOnce(JSON.stringify(validEnvelope));

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(result.script.scenes.length).toBeGreaterThanOrEqual(8);
      expect(completeText).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });

    it("batched code-first pass repairs assembled duration overflow before failing the pipeline", async () => {
      vi.stubEnv("BATCH_SCENE_GENERATION", "true");
      vi.stubEnv("SKIP_JUDGE", "true");
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "1");

      const popcornCodeFirstContext = {
        ...fakePRContext,
        durationMode: "popcorn" as const,
      };
      const popcornOutline = {
        ...outline,
        scenes: [
          ...outline.scenes,
          {
            sceneNumber: 9,
            sceneType: "summary" as const,
            title: "Operational summary",
            clusterIds: ["c1"],
            evidenceFilePaths: ["src/middleware/auth.ts"],
            whatChanged: "Summarizes the operational impact.",
            whyItMatters: "Connects the deeper changes together.",
            failureWithoutIt: "The walkthrough feels fragmented.",
            validation: "The integrated flow still matches the evidence.",
            visualFocus: "The system stabilizes into a coherent pattern.",
          },
          {
            sceneNumber: 10,
            sceneType: "closing" as const,
            title: "Final takeaway",
            clusterIds: ["c1"],
            evidenceFilePaths: ["src/middleware/auth.ts"],
            whatChanged: "Closes the arc with the final outcome.",
            whyItMatters: "Leaves the viewer with the system-level result.",
            failureWithoutIt: "The ending lacks a clear takeaway.",
            validation: "The wrapped-up state matches the code changes.",
            visualFocus: "The mechanism resolves into its final locked state.",
          },
        ],
      };
      const veryLongNarration = Array.from({ length: 110 }, (_, i) => `long${i}`).join(" ");
      const trimmedNarration = Array.from({ length: 80 }, (_, i) => `trim${i}`).join(" ");
      const overBudgetScript = makeVideoScript(popcornOutline.scenes.map((scene) => ({
        sceneType: scene.sceneType as "overview" | "hook" | "code_walkthrough" | "before_after" | "architecture" | "summary" | "closing",
        narration: veryLongNarration,
        durationSeconds: 10,
        codeBroll: [],
      })));
      const repairedScript = makeVideoScript(popcornOutline.scenes.map((scene) => ({
        sceneType: scene.sceneType as "overview" | "hook" | "code_walkthrough" | "before_after" | "architecture" | "summary" | "closing",
        narration: trimmedNarration,
        durationSeconds: 10,
        codeBroll: [],
      })));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(popcornOutline)
        .mockResolvedValueOnce(overBudgetScript)
        .mockResolvedValueOnce({
          scenes: overBudgetScript.scenes.filter(
            (scene) => scene.sceneNumber >= 2 && scene.sceneNumber <= 4,
          ),
        })
        .mockResolvedValueOnce({
          scenes: overBudgetScript.scenes.filter(
            (scene) => scene.sceneNumber >= 5 && scene.sceneNumber <= 7,
          ),
        })
        .mockResolvedValueOnce({
          scenes: overBudgetScript.scenes.filter(
            (scene) => scene.sceneNumber >= 8 && scene.sceneNumber <= 10,
          ),
        });
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(repairedScript));

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: popcornCodeFirstContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(completeText).toHaveBeenCalledTimes(1);
      expect(result.script.totalDurationSeconds).toBeLessThanOrEqual(320);
      expect(result.script.scenes[0].sceneType).toBe("overview");
    });
  });

  describe("word budget repair loop", () => {
    const coveragePlan = makeCoveragePlan();
    const outline = buildValidOutline();

    // Code-first uses total word budget. Default mode at speed=1.0: max 300 words.
    // 60 words/scene * 8 = 480 words exceeds 300-word budget.
    // Word budget repair runs INSIDE generateAndRefineScript (stage 6) BEFORE the
    // duration cap check. The repaired script (VALID_SCRIPT, 49 words) is short enough.
    const longNarration = Array.from({ length: 60 }, (_, j) => `word${j}`).join(" ");
    const overBudgetScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((s) => ({
        ...s,
        narration: longNarration,
      })),
      totalWordCount: 400,
    };

    beforeEach(() => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("calls completeText with repair prompt when narration exceeds word budget", async () => {
      const completeText = vi.fn()
        // Call 1: initial script — over budget
        .mockResolvedValueOnce(JSON.stringify(overBudgetScript))
        // Call 2: word budget repair — valid, within budget
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // Initial + word budget repair = 2 completeText calls
      expect(completeText).toHaveBeenCalledTimes(2);
      // Repair prompt should include word budget instructions
      expect(completeText.mock.calls[1][1]).toContain("word");
      // Verify the repaired script was actually used
      expect(result.script.scenes[0].sceneType).toBe("overview");
    });

    it("proceeds when word budget repair returns unparseable JSON (non-fatal)", async () => {
      const completeText = vi.fn()
        // Pass 1: initial script — over budget
        .mockResolvedValueOnce(JSON.stringify(overBudgetScript))
        // Pass 1: repair attempt 1 — unparseable
        .mockResolvedValueOnce("Sorry, I cannot fix that.")
        // Pass 1: repair attempt 2 — still unparseable
        .mockResolvedValueOnce("Still cannot fix.")
        // Pass 1: final post-grounding repair also fails
        .mockResolvedValueOnce("Sorry, I cannot fix that.")
        .mockResolvedValueOnce("Still cannot fix.")
        // Pass 2 (duration retry): returns short script
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        // Pass 1: narration judge
        .mockResolvedValueOnce(passingNarrationJudge())
        // Pass 2 (duration retry): narration judge
        .mockResolvedValueOnce(passingNarrationJudge());

      // Word budget violations are non-fatal, but code-first duration recomputation (480 words -> 192s)
      // exceeds the default guard cap, triggering a retry that produces VALID_SCRIPT.
      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // Pass 1: initial + 2 repairs + 2 post-grounding = 5, Pass 2: retry = 1 → total 6
      expect(completeText).toHaveBeenCalledTimes(6);
      // After duration retry, the short script is used
      expect(result.script.scenes[0].sceneType).toBe("overview");
    });

    it("continues when word budget repair returns Zod-invalid JSON (non-fatal)", async () => {
      const zodInvalidRepair = JSON.stringify({ scenes: [{ sceneNumber: 1, narration: "short" }] });
      const completeText = vi.fn()
        // Pass 1: initial script — over budget
        .mockResolvedValueOnce(JSON.stringify(overBudgetScript))
        // Pass 1: repair attempt 1 — Zod-invalid
        .mockResolvedValueOnce(zodInvalidRepair)
        // Pass 1: repair attempt 2 — Zod-invalid
        .mockResolvedValueOnce(zodInvalidRepair)
        // Pass 1: final post-grounding repair also fails
        .mockResolvedValueOnce(zodInvalidRepair)
        .mockResolvedValueOnce(zodInvalidRepair)
        // Pass 2 (duration retry): returns short script
        .mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge())
        // Pass 2 (duration retry): narration judge
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(completeText).toHaveBeenCalledTimes(6);
      expect(result.script.scenes[0].sceneType).toBe("overview");
    });
  });

  describe("reviewer narration repair loop", () => {
    const coveragePlan = {
      summary: "Plan",
      selectedEvidencePolicy: "Use cluster evidence only.",
      clusters: [
        {
          clusterId: "cluster-auth",
          title: "Authentication middleware",
          files: ["src/middleware/auth.ts", "src/routes/auth.ts"],
          evidenceSnippets: [
            { filePath: "src/middleware/auth.ts", summary: "Adds auth validation", diffExcerpt: "function validateJWT() {}" },
          ],
          technicalMechanism: "Validate JWT",
          impact: "Protects requests",
          riskIfAbsent: "Unauthorized access",
          validationEvidence: ["auth middleware test coverage"],
          importanceRank: 1,
        },
      ],
      ledger: [{ clusterId: "cluster-auth", disposition: "deep_dive", reason: "Primary change" }],
      majorClusterIds: ["cluster-auth"],
    };
    const outline = buildValidOutline("cluster-auth");

    // Script with verdict language in scene 2
    const verdictScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((s, i) =>
        i === 1
          ? { ...s, narration: "I would approve this change and it looks ready to merge." }
          : s,
      ),
    };
    // Clean version without verdict language
    const cleanScript = { ...VALID_SCRIPT };

    beforeEach(() => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("repairs verdict language in narration via LLM repair loop", async () => {
      const completeText = vi.fn()
        // Call 1: reviewer narration repair — clean version
        .mockResolvedValueOnce(JSON.stringify(cleanScript));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(verdictScript) // script gen via structured output
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // Deepdive mode should perform an initial generation plus one repair attempt.
      expect(completeText).toHaveBeenCalledTimes(1);
      // The repaired script should not contain verdict language
      expect(result.script.scenes[1].narration).not.toContain("approve");
    });

    it("recomputes totalWordCount after successful reviewer narration repair", async () => {
      // The clean script has a known totalWordCount from its narrations.
      // Build a version with an artificially wrong totalWordCount to simulate
      // the LLM preserving the old field value after rewriting narration.
      const cleanWithStaleCount = {
        ...cleanScript,
        totalWordCount: 9999, // obviously wrong
      };
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(verdictScript))
        .mockResolvedValueOnce(JSON.stringify(cleanWithStaleCount));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(verdictScript)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // totalWordCount must reflect actual narration, not the stale value
      const actualWordCount = result.script.scenes.reduce(
        (sum, s) => sum + s.narration.split(/\s+/).filter(Boolean).length, 0,
      );
      expect(result.script.totalWordCount).toBe(actualWordCount);
      expect(result.script.totalWordCount).not.toBe(9999);
    });

    it("throws when reviewer narration repair fails and REVIEWER_VIOLATION_WARN is not set", async () => {
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(verdictScript))
        // Repair returns garbage
        .mockResolvedValueOnce("NOT JSON AT ALL")
        .mockResolvedValueOnce("STILL NOT JSON");

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(verdictScript)
        .mockResolvedValueOnce(passingNarrationJudge());

      await expect(generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      })).rejects.toThrow("Reviewer narration validation failed");
    });

    it("proceeds with warn when REVIEWER_VIOLATION_WARN is set", async () => {
      vi.stubEnv("REVIEWER_VIOLATION_WARN", "true");
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(verdictScript))
        .mockResolvedValueOnce("NOT JSON AT ALL")
        .mockResolvedValueOnce("STILL NOT JSON");

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(verdictScript)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // Pipeline completes with violations — original verdict script preserved
      expect(result.script.scenes[1].narration).toContain("approve");
      expect(result.promptPipelineV2?.reviewPosture?.verdictPolicy).toBe("no_verdict");
    });

    it("uses the repaired clean script when word budget is within total budget (code-first)", async () => {
      // In code-first mode, per-scene word budgets are not checked — only total budget (300 words).
      // The clean repaired script (25 words in scene 1, ~64 total) is under budget,
      // so the pipeline uses it instead of reverting to the verdict script.
      const cleanScript = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((s, i) =>
          i === 0
            ? { ...s, narration: Array.from({ length: 25 }, (_, j) => `word${j}`).join(" ") }
            : s,
        ),
      };

      const completeText = vi.fn()
        // Call 1: initial script — contains verdict language
        .mockResolvedValueOnce(JSON.stringify(verdictScript))
        // Call 2: reviewer repair — clean, within total budget
        .mockResolvedValueOnce(JSON.stringify(cleanScript));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge());

      // Pipeline should succeed (clean script is within total budget)
      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      // The repaired clean script was used (no verdict language in scene 1)
      expect(result.script.scenes[0].narration).not.toContain("approve");
    });

    it("throws when reviewer repair LLM call throws infrastructure error", async () => {
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(verdictScript))
        // LLM repair call throws (network error)
        .mockRejectedValueOnce(new Error("Connection timeout"));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(passingNarrationJudge());

      // Infrastructure error breaks the loop, then enforceReviewerNarration throws
      await expect(generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      })).rejects.toThrow("Reviewer narration validation failed");
    });

    it("throws when reviewer repair succeeds but revert due to grounding violation restores violating script", async () => {
      // Repaired script: clean reviewer narration but introduces a file reference
      // not in the coverage plan (grounding violation)
      const groundingViolationScript = {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((s, i) =>
          i === 2 && Array.isArray(s.codeBroll) && s.codeBroll.length > 0
            ? {
                ...s,
                codeBroll: [{ ...s.codeBroll[0], filePath: "src/totally/unknown/file.ts" }],
              }
            : s,
        ),
      };

      const completeText = vi.fn()
        // Reviewer repair attempt — returns a script with grounding violation
        .mockResolvedValueOnce(JSON.stringify(groundingViolationScript));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(verdictScript) // script gen via structured output
        .mockResolvedValueOnce(passingNarrationJudge());

      // Grounding violation triggers revert → original script still has verdict
      // language → enforceReviewerNarration throws
      await expect(generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: deepdiveContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      })).rejects.toThrow("Reviewer narration validation failed");
    });

    it("skips reviewer narration repair entirely when deepdive is disabled", async () => {
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(verdictScript));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(coveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(outline)
        .mockResolvedValueOnce(verdictScript)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(result.script.scenes[1].narration).toContain("approve this change");
      expect(result.promptPipelineV2?.reviewPosture).toBeUndefined();
      // With supportsNativeStructuredOutput, script gen uses completeJson.
      // No reviewer repair runs when deepdive is false → completeText never called.
      expect(completeText).not.toHaveBeenCalled();
    });
  });
});

// ── classifyIssueFromText unit tests ──────────────────────────────────
import { classifyIssueFromText } from "@/infrastructure/llm/promptPipelineV2Runner";

describe("classifyIssueFromText", () => {
  it("classifies concurrency keywords", () => {
    expect(classifyIssueFromText("Race condition if two writers collide")).toBe("concurrency");
    expect(classifyIssueFromText("Not thread-safe under concurrent access")).toBe("concurrency");
    expect(classifyIssueFromText("Missing lock on shared state")).toBe("concurrency");
  });

  it("classifies data_integrity keywords", () => {
    expect(classifyIssueFromText("CASCADE delete silently removes child rows")).toBe("data_integrity");
    expect(classifyIssueFromText("Orphan records if parent is deleted")).toBe("data_integrity");
    expect(classifyIssueFromText("Data integrity violated by partial write")).toBe("data_integrity");
  });

  it("classifies security keywords", () => {
    expect(classifyIssueFromText("Unauthorized access to admin endpoints")).toBe("security");
    expect(classifyIssueFromText("SQL injection vulnerability in user input")).toBe("security");
    expect(classifyIssueFromText("Open redirect allows phishing")).toBe("security");
  });

  it("classifies regression keywords", () => {
    expect(classifyIssueFromText("This breaks backward compatibility")).toBe("regression");
    expect(classifyIssueFromText("Regression in existing behavior")).toBe("regression");
  });

  it("classifies validation_gap keywords", () => {
    expect(classifyIssueFromText("No test coverage for the retry path")).toBe("validation_gap");
    expect(classifyIssueFromText("The new branch is untested")).toBe("validation_gap");
    expect(classifyIssueFromText("Missing test for edge case")).toBe("validation_gap");
  });

  it("defaults to correctness when no keywords match", () => {
    expect(classifyIssueFromText("Without this, the change would not hold")).toBe("correctness");
    expect(classifyIssueFromText("General problem statement")).toBe("correctness");
  });

  it("does not false-positive on words like breakthrough or unbreakable", () => {
    expect(classifyIssueFromText("This is a breakthrough improvement")).toBe("correctness");
  });

  it("prioritizes earlier classes when text matches multiple", () => {
    // concurrency appears before security in the keyword list
    expect(classifyIssueFromText("Race condition with security implications")).toBe("concurrency");
  });
});

// ── computeActualSceneDurations + code-first helper unit tests ─────────
import {
  computeActualSceneDurations,
} from "@/infrastructure/llm/promptPipelineV2Runner";

describe("computeActualSceneDurations", () => {

  it("returns script unchanged when narration fits within scripted duration", () => {
    // 5 words × 0.4s = 2s natural. Scene is 10s. Rate = 2/10 = 0.2, capped at 1.0 → 0.2.
    // Actual narration = 2/0.2 = 10s. Equals scene duration → no change.
    const script = makeVideoScript([{ narration: "one two three four five", durationSeconds: 10 }]);
    const result = computeActualSceneDurations(script, 1.0);
    expect(result).toBe(script); // Same reference — no change
  });

  it("extends scene when narration exceeds scripted duration at capped rate", () => {
    // 20 words × 0.4s = 8s natural. Scene is 5s. rawRate = 8/5 = 1.6, capped at 1.0.
    // adjusted = 1.0 × 1.0 = 1.0. Actual = 8/1.0 = 8s → ceil = 8. Max(5, 8) = 8.
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const script = makeVideoScript([{ narration: words, durationSeconds: 5 }]);
    const result = computeActualSceneDurations(script, 1.0);
    expect(result.scenes[0].durationSeconds).toBe(8);
    expect(result.totalDurationSeconds).toBe(8);
  });

  it("accounts for speedMultiplier < 1.0 (slower speech extends more)", () => {
    // 10 words × 0.4s = 4s natural. Scene is 3s. rawRate = 4/3 ≈ 1.33, capped at 1.0.
    // adjusted = 1.0 × 0.9 = 0.9. Actual = 4/0.9 ≈ 4.44 → ceil = 5. Max(3, 5) = 5.
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([{ narration: words, durationSeconds: 3 }]);
    const result = computeActualSceneDurations(script, 0.9);
    expect(result.scenes[0].durationSeconds).toBe(5);
    expect(result.totalDurationSeconds).toBe(5);
  });

  it("leaves scenes with empty narration unchanged", () => {
    const script = makeVideoScript([{ narration: "", durationSeconds: 5 }]);
    const result = computeActualSceneDurations(script, 0.9);
    expect(result).toBe(script);
  });

  it("handles mixed scenes where only some need adjustment", () => {
    const shortNarration = "hello";             // 1 word × 0.4 = 0.4s → fits in 5s
    const longNarration = Array.from({ length: 25 }, (_, i) => `w${i}`).join(" "); // 25 × 0.4 = 10s
    const script = makeVideoScript([
      { narration: shortNarration, durationSeconds: 5 },
      { narration: longNarration, durationSeconds: 5 },
    ]);
    const result = computeActualSceneDurations(script, 1.0);
    expect(result.scenes[0].durationSeconds).toBe(5);  // Unchanged
    expect(result.scenes[1].durationSeconds).toBe(10); // Extended
    expect(result.totalDurationSeconds).toBe(15);
  });

  it("rounds rate to 2 decimal places matching GoogleTTSService formula", () => {
    // 7 words × 0.4 = 2.8s. Scene is 3s. rawRate = 2.8/3 ≈ 0.933, capped at 0.933.
    // adjusted = 0.933 × 0.9 = 0.8397 → round2 = 0.84. Actual = 2.8/0.84 ≈ 3.33 → ceil = 4.
    const words = Array.from({ length: 7 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([{ narration: words, durationSeconds: 3 }]);
    const result = computeActualSceneDurations(script, 0.9);
    expect(result.scenes[0].durationSeconds).toBe(4);
  });
});

// ── Reviewer artifact flow coverage ────────────────────────────────────
// Verify that the artifacts schema can carry reviewer-oriented metadata
// without breaking the existing pipeline output contract.

describe("reviewer artifact flow", () => {
  it("promptPipelineV2ArtifactsSchema accepts artifacts with reviewer metadata", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];

    const artifacts = promptPipelineV2ArtifactsSchema.parse({
      enabled: true,
      llmFamily: "claude",
      coveragePlan: base.coveragePlan,
      sceneOutline: base.sceneOutline,
      reviewConcerns: [
        {
          concernId: "rc-1",
          sourceClusterIds: [base.coveragePlan.clusters[0].clusterId],
          evidenceFilePaths: [base.coveragePlan.clusters[0].files[0]],
          priorityRank: 1,
          issueClass: "concurrency",
          riskStatement: "Concurrent writes may collide",
          validationNeed: "Check for row lock",
          proseSupport: null,
        },
      ],
      reviewPosture: {
        audience: "teammate_reviewer",
        evidencePolicy: "code_and_tests_primary",
        concernBudget: "highest_value_only",
        verdictPolicy: "no_verdict",
        hintPolicy: "non_prescriptive",
      },
    });

    expect(artifacts.enabled).toBe(true);
    expect(artifacts.reviewConcerns).toHaveLength(1);
    expect(artifacts.reviewPosture?.verdictPolicy).toBe("no_verdict");
  });

  it("promptPipelineV2ArtifactsSchema remains valid without reviewer fields", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];

    const artifacts = promptPipelineV2ArtifactsSchema.parse({
      enabled: true,
      llmFamily: "claude",
      coveragePlan: base.coveragePlan,
      sceneOutline: base.sceneOutline,
    });

    expect(artifacts.enabled).toBe(true);
    expect(artifacts.reviewConcerns).toBeUndefined();
    expect(artifacts.reviewPosture).toBeUndefined();
  });

  it("excludes omitted_low_priority clusters from reviewConcerns", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const mainCluster = base.coveragePlan.clusters[0];

    // Add a second cluster that is omitted
    const omittedCluster = {
      ...mainCluster,
      clusterId: "omitted-nit",
      title: "Style nit",
      importanceRank: 2,
    };
    const coveragePlanWithOmitted = {
      ...base.coveragePlan,
      clusters: [mainCluster, omittedCluster],
      ledger: [
        ...base.coveragePlan.ledger,
        { clusterId: "omitted-nit", disposition: "omitted_low_priority" as const, reason: "Style only" },
      ],
    };

    // Scene outline only references the main cluster, not the omitted one
    const artifacts = promptPipelineV2ArtifactsSchema.parse({
      enabled: true,
      llmFamily: "claude",
      coveragePlan: coveragePlanWithOmitted,
      sceneOutline: base.sceneOutline, // only references mainCluster via clusterIds
      reviewConcerns: [
        {
          concernId: `rc-${mainCluster.clusterId}`,
          sourceClusterIds: [mainCluster.clusterId],
          evidenceFilePaths: mainCluster.files,
          priorityRank: 1,
          issueClass: "correctness" as const,
          riskStatement: mainCluster.riskIfAbsent,
          validationNeed: mainCluster.validationEvidence.join("; "),
          proseSupport: null,
        },
        // The omitted cluster should NOT appear here in the real pipeline
      ],
      reviewPosture: {
        audience: "teammate_reviewer" as const,
        evidencePolicy: "code_and_tests_primary" as const,
        concernBudget: "highest_value_only" as const,
        verdictPolicy: "no_verdict" as const,
        hintPolicy: "non_prescriptive" as const,
      },
    });

    // Only the narrated cluster should be a concern — not the omitted one
    expect(artifacts.reviewConcerns).toHaveLength(1);
    expect(artifacts.reviewConcerns![0].sourceClusterIds).toContain(mainCluster.clusterId);
    expect(artifacts.reviewConcerns!.some(
      (c) => c.sourceClusterIds.includes("omitted-nit"),
    )).toBe(false);
  });
});

// ── recomputeCodeFirstDurations unit tests ──────────────────────────────

describe("recomputeCodeFirstDurations", () => {
  it("recomputes durationSeconds from narration word count", () => {
    // 10 words × 0.4s = 4s at speed 1.0
    const script = makeVideoScript([
      { narration: "one two three four five six seven eight nine ten", durationSeconds: 99 },
    ]);
    const result = recomputeCodeFirstDurations(script, 1.0);
    expect(result.scenes[0].durationSeconds).toBe(4);
    expect(result.totalDurationSeconds).toBe(4);
  });

  it("preserves original duration for scenes with empty narration", () => {
    const script = makeVideoScript([
      { narration: "", durationSeconds: 5 },
    ]);
    const result = recomputeCodeFirstDurations(script, 1.0);
    expect(result.scenes[0].durationSeconds).toBe(5);
  });

  it("recalculates totalDurationSeconds as sum of all scenes", () => {
    const script = makeVideoScript([
      { narration: "one two three four five", durationSeconds: 99 },
      { narration: "six seven eight nine ten eleven twelve", durationSeconds: 99 },
    ]);
    const result = recomputeCodeFirstDurations(script, 1.0);
    // 5 words → 2s, 7 words → ceil(2.8) = 3s → total = 5s
    expect(result.totalDurationSeconds).toBe(result.scenes[0].durationSeconds + result.scenes[1].durationSeconds);
  });

  it("adjusts duration with speed multiplier", () => {
    const script = makeVideoScript([
      { narration: "one two three four five six seven eight nine ten", durationSeconds: 99 },
    ]);
    const normal = recomputeCodeFirstDurations(script, 1.0);
    const fast = recomputeCodeFirstDurations(script, 1.5);
    expect(fast.scenes[0].durationSeconds).toBeLessThan(normal.scenes[0].durationSeconds);
  });
});

// ── deriveScriptFromTransport unit tests ─────────────────────────────────

describe("deriveScriptFromTransport", () => {
  it("computes totalDurationSeconds and totalWordCount from scenes", () => {
    const transport = {
      ...VALID_SCRIPT,
      totalDurationSeconds: undefined,
      totalWordCount: undefined,
      scenes: [
        { ...VALID_SCRIPT.scenes[0], durationSeconds: 5, narration: "one two three" },
        { ...VALID_SCRIPT.scenes[0], sceneNumber: 2, durationSeconds: 8, narration: "four five" },
      ],
    };
    const result = deriveScriptFromTransport(transport as never);
    expect(result.totalDurationSeconds).toBe(13);
    expect(result.totalWordCount).toBe(5);
  });
});

// ── normalizeBatchedScenesFromOutline unit tests ─────────────────────────

describe("normalizeBatchedScenesFromOutline", () => {
  it("corrects sceneType from outline when LLM drifts", () => {
    const twoSceneScript = makeVideoScript([
      { sceneType: "hook", narration: "scene one", durationSeconds: 4 },
      { sceneType: "code_walkthrough", narration: "scene two", durationSeconds: 4 },
    ]);
    const outline = {
      scenes: [
        { sceneNumber: 1, sceneType: "overview" as const, title: "T1", clusterIds: ["c1"], evidenceFilePaths: [], whatChanged: "", whyItMatters: "", failureWithoutIt: "", validation: "", visualFocus: "" },
        { sceneNumber: 2, sceneType: "code_walkthrough" as const, title: "T2", clusterIds: ["c1"], evidenceFilePaths: [], whatChanged: "", whyItMatters: "", failureWithoutIt: "", validation: "", visualFocus: "" },
      ],
    };
    const result = normalizeBatchedScenesFromOutline(twoSceneScript.scenes, outline);
    expect(result[0].sceneType).toBe("overview");
    expect(result[1].sceneType).toBe("code_walkthrough");
  });

  it("sorts scenes by sceneNumber", () => {
    const threeSceneScript = makeVideoScript([
      { sceneType: "closing", narration: "scene a", durationSeconds: 4 },
      { sceneType: "overview", narration: "scene b", durationSeconds: 4 },
      { sceneType: "code_walkthrough", narration: "scene c", durationSeconds: 4 },
    ]);
    // Scramble scene numbers to test sorting
    const scenes = threeSceneScript.scenes.map((s, i) => ({ ...s, sceneNumber: [3, 1, 2][i]! }));
    const outline = {
      scenes: [
        { sceneNumber: 1, sceneType: "overview" as const, title: "", clusterIds: [], evidenceFilePaths: [], whatChanged: "", whyItMatters: "", failureWithoutIt: "", validation: "", visualFocus: "" },
        { sceneNumber: 2, sceneType: "code_walkthrough" as const, title: "", clusterIds: [], evidenceFilePaths: [], whatChanged: "", whyItMatters: "", failureWithoutIt: "", validation: "", visualFocus: "" },
        { sceneNumber: 3, sceneType: "closing" as const, title: "", clusterIds: [], evidenceFilePaths: [], whatChanged: "", whyItMatters: "", failureWithoutIt: "", validation: "", visualFocus: "" },
      ],
    };
    const result = normalizeBatchedScenesFromOutline(scenes, outline);
    expect(result.map((s) => s.sceneNumber)).toEqual([1, 2, 3]);
  });
});

// ── ensureLastSceneOverview unit tests ──────────────────────────────────

describe("ensureLastSceneOverview", () => {
  it("converts a closing last scene to overview", () => {
    const script = makeVideoScript([
      { narration: "intro", durationSeconds: 4 },
      { narration: "code", durationSeconds: 6 },
      { sceneType: "closing", narration: "wrap up", durationSeconds: 4 },
    ]);
    const result = ensureLastSceneOverview(script);
    expect(result.scenes[2].sceneType).toBe("overview");
    expect(result.scenes[0].sceneType).toBe("code_walkthrough"); // unchanged
  });

  it("converts a summary last scene to overview", () => {
    const script = makeVideoScript([
      { narration: "intro", durationSeconds: 4 },
      { sceneType: "summary", narration: "summary", durationSeconds: 6 },
    ]);
    const result = ensureLastSceneOverview(script);
    expect(result.scenes[1].sceneType).toBe("overview");
  });

  it("leaves an already-overview last scene unchanged", () => {
    const script = makeVideoScript([
      { narration: "intro", durationSeconds: 4 },
      { sceneType: "overview", narration: "overview end", durationSeconds: 4 },
    ]);
    const result = ensureLastSceneOverview(script);
    expect(result).toBe(script); // same reference — no mutation
  });

  it("returns unchanged for empty scenes", () => {
    const script = makeVideoScript([
      { narration: "only", durationSeconds: 4 },
    ]);
    script.scenes = [];
    const result = ensureLastSceneOverview(script);
    expect(result.scenes).toHaveLength(0);
  });
});

describe("scene outline repair loop", () => {
    // Two-cluster coverage plan — outline will initially omit the second cluster
    const authPlan = makeCoveragePlan("cluster-auth");
    const twoClusterCoveragePlan = {
      ...authPlan,
      clusters: [
        ...authPlan.clusters,
        {
          clusterId: "cluster-logging",
          title: "Structured logging",
          files: ["src/lib/logger.ts"],
          evidenceSnippets: [
            { filePath: "src/lib/logger.ts", summary: "Adds structured JSON logging", diffExcerpt: "export function createLogger() {}" },
          ],
          technicalMechanism: "JSON structured logging",
          impact: "Observability",
          riskIfAbsent: "No debug visibility",
          validationEvidence: ["logger tests"],
          importanceRank: 2,
        },
      ],
      ledger: [
        { clusterId: "cluster-auth", disposition: "deep_dive", reason: "Primary change" },
        { clusterId: "cluster-logging", disposition: "summary", reason: "Supporting change" },
      ],
    };

    // Outline missing cluster-logging from all scenes
    const brokenOutline = buildValidOutline("cluster-auth");
    // Fixed outline adds cluster-logging to scene 7
    const fixedOutline = {
      ...brokenOutline,
      scenes: brokenOutline.scenes.map((s) =>
        s.sceneNumber === 7
          ? { ...s, clusterIds: ["cluster-auth", "cluster-logging"], evidenceFilePaths: ["src/middleware/auth.ts", "src/lib/logger.ts"] }
          : s,
      ),
    };

    beforeEach(() => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("repairs an outline missing a required cluster on first attempt", async () => {
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(fixedOutline));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(twoClusterCoveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(brokenOutline) // initial outline missing cluster-logging
        .mockResolvedValueOnce(VALID_SCRIPT)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(completeText).toHaveBeenCalledTimes(1);
      expect(completeText.mock.calls[0][1]).toContain("cluster-logging");
      expect(result.script.changeType).toBe("feature");
    });

    it("repairs on second attempt when first repair also fails", async () => {
      const completeText = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(brokenOutline)) // still broken
        .mockResolvedValueOnce(JSON.stringify(fixedOutline)); // fixed

      const completeJson = vi.fn()
        .mockResolvedValueOnce(twoClusterCoveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(brokenOutline)
        .mockResolvedValueOnce(VALID_SCRIPT)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(completeText).toHaveBeenCalledTimes(2);
      expect(result.script.changeType).toBe("feature");
    });

    it("throws after repair attempts exhausted", async () => {
      const completeText = vi.fn()
        .mockResolvedValue(JSON.stringify(brokenOutline));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(twoClusterCoveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(brokenOutline);

      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow(/scene outline validation failed/i);

      expect(completeText).toHaveBeenCalledTimes(2);
    });

    it("skips repair when SCRIPT_REPAIR_MAX_ATTEMPTS=0", async () => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "0");

      const completeText = vi.fn();
      const completeJson = vi.fn()
        .mockResolvedValueOnce(twoClusterCoveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(brokenOutline);

      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson, completeText },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow(/scene outline validation failed/i);

      expect(completeText).not.toHaveBeenCalled();
    });

    it("skips repair when model has no completeText", async () => {
      const completeJson = vi.fn()
        .mockResolvedValueOnce(twoClusterCoveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(brokenOutline);

      await expect(
        generateScriptWithPromptPipelineV2({
          model: { family: "claude", completeJson },
          context: fakePRContext,
          analysis: fakeDiffAnalysis,
          validDurations: [4, 6, 8],
        }),
      ).rejects.toThrow(/scene outline validation failed/i);
    });

    it("continues loop when repair returns unparseable JSON", async () => {
      const completeText = vi.fn()
        .mockResolvedValueOnce("{broken json")
        .mockResolvedValueOnce(JSON.stringify(fixedOutline));

      const completeJson = vi.fn()
        .mockResolvedValueOnce(twoClusterCoveragePlan)
        .mockResolvedValueOnce(passingCoverageJudge())
        .mockResolvedValueOnce(brokenOutline)
        .mockResolvedValueOnce(VALID_SCRIPT)
        .mockResolvedValueOnce(passingNarrationJudge());

      const result = await generateScriptWithPromptPipelineV2({
        model: { family: "claude", supportsNativeStructuredOutput: true, completeJson, completeText },
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        validDurations: [4, 6, 8],
      });

      expect(completeText).toHaveBeenCalledTimes(2);
      expect(result.script.changeType).toBe("feature");
    });
  });
