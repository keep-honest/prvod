import { describe, expect, it } from "vitest";
import {
  buildBatchScriptSystemPrompt,
  buildCoverageJudgeSystemPrompt,
  buildCoverageJudgeUserPrompt,
  buildCoveragePlannerSystemPrompt,
  buildCoveragePlannerUserPrompt,
  buildFinalScriptSystemPrompt,
  buildFinalScriptUserPrompt,
  buildGroundingRepairPrompt,
  buildNarrationJudgeSystemPrompt,
  buildNarrationJudgeUserPrompt,
  buildSceneOutlineSystemPrompt,
} from "@/infrastructure/llm/promptPipelineV2";
import { videoScriptSchema } from "@/domain/entities/VideoScript";
import {
  VALID_SCRIPT,
  fakeDiffAnalysis,
  fakePRContext,
} from "./fixtures/scriptWriterFixtures";
import {
  PROMPT_PIPELINE_V2_EVAL_CORPUS,
  REVIEWER_RISK_CASES,
} from "./fixtures/promptPipelineV2EvalCorpus";

const MODES = ["short", "default", "popcorn"] as const;
const validVideoScript = videoScriptSchema.parse({
  ...VALID_SCRIPT,
  narrativeRoles: [],
  voiceAssignments: [],
});

describe("Prompt Pipeline V2 prompt builders", () => {
  it("emits duration context across the mode matrix", () => {
    for (const family of ["claude", "gemini"] as const) {
      for (const durationMode of MODES) {
        const prompt = buildCoveragePlannerSystemPrompt({
          family,
          durationMode,
        });

        expect(prompt).toContain(`Duration mode: ${durationMode}`);
      }
    }
  });

  it("uses XML-tagged user prompts for Claude-family planning and final writing", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const plannerPrompt = buildCoveragePlannerUserPrompt(
      {
        family: "claude",
        durationMode: fakePRContext.durationMode,
      },
      fakePRContext,
      fakeDiffAnalysis,
      fakePRContext.durationMode,
    );
    const finalPrompt = buildFinalScriptUserPrompt(
      "claude",
      fakePRContext,
      fakeDiffAnalysis,
      base.coveragePlan,
      base.sceneOutline,
    );
    const judgePrompt = buildNarrationJudgeUserPrompt(
      "claude",
      base.coveragePlan,
      base.sceneOutline,
      validVideoScript,
    );

    expect(plannerPrompt).toContain("<pr_context>");
    expect(plannerPrompt).toContain("<diff_evidence>");
    expect(finalPrompt).toContain("<scene_outline>");
    expect(judgePrompt).toContain("<pipeline_script>");
  });

  it("uses lighter labeled sections for Gemini-family prompts", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[1];
    const plannerPrompt = buildCoveragePlannerUserPrompt(
      {
        family: "gemini",
        durationMode: fakePRContext.durationMode,
      },
      fakePRContext,
      fakeDiffAnalysis,
      fakePRContext.durationMode,
    );
    const finalSystemPrompt = buildFinalScriptSystemPrompt(
      {
        family: "gemini",
        durationMode: fakePRContext.durationMode,
      },
      [4, 6, 8],
    );
    const finalPrompt = buildFinalScriptUserPrompt(
      "gemini",
      fakePRContext,
      fakeDiffAnalysis,
      base.coveragePlan,
      base.sceneOutline,
    );

    expect(plannerPrompt).toContain("PR CONTEXT:");
    expect(plannerPrompt).not.toContain("<pr_context>");
    expect(finalSystemPrompt).toContain("Rules:");
    expect(finalPrompt).toContain("SCENE OUTLINE:");
    expect(finalPrompt).not.toContain("<scene_outline>");
  });

  it("includes word budget section when validDurations is provided", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const prompt = buildNarrationJudgeUserPrompt(
      "claude",
      base.coveragePlan,
      base.sceneOutline,
      validVideoScript,
      [5, 10, 15],
    );

    expect(prompt).toContain("word_budget");
    expect(prompt).toContain("spoken words");
  });

  it("omits word budgets section when validDurations is not provided", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const prompt = buildNarrationJudgeUserPrompt(
      "claude",
      base.coveragePlan,
      base.sceneOutline,
      validVideoScript,
    );

    expect(prompt).not.toContain("word_budgets");
  });

  it("includes allowed identifiers in grounding repair prompts", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const invalidScript = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration: "The `inventedIdentifier` path rewires the auth flow.",
            }
          : scene,
      ),
    };
    const validation = {
      passed: false,
      issues: ["Final script uses ungrounded backtick references for scenes: 2"],
      warnings: [],
      unmappedSceneNumbers: [],
      missingOutlineSceneNumbers: [],
      invalidCodeBrollFileRefs: [],
      unknownFileReferences: [],
      crossSceneFileReferences: [],
      unknownBacktickReferences: [
        {
          sceneNumber: 2,
          identifiers: ["inventedIdentifier"],
        },
      ],
    };

    const prompt = buildGroundingRepairPrompt(
      "claude",
      JSON.stringify(invalidScript, null, 2),
      validation,
      base.sceneOutline,
      base.coveragePlan,
    );

    expect(prompt).toContain("identifiers=[");
    expect(prompt).toContain("validateJWT");
    expect(prompt).toContain("inventedIdentifier");
  });

  // ── Reviewer-oriented prompt scaffolding ──────────────────────────────
  // These tests verify that reviewer-specific instructions are present in
  // prompts once the reviewer narration feature is implemented.

  describe("reviewer-oriented prompt expectations", () => {
    it("reviewer-risk fixture cases are available for prompt testing", () => {
      expect(REVIEWER_RISK_CASES.length).toBeGreaterThanOrEqual(3);
      for (const riskCase of REVIEWER_RISK_CASES) {
        expect(riskCase.id).toContain("reviewer-risk-");
        expect(riskCase.coveragePlan.clusters.length).toBeGreaterThan(0);
        expect(riskCase.sceneOutline.scenes.length).toBeGreaterThanOrEqual(3);
      }
    });

    it("omits reviewer instructions by default", () => {
      const plannerPrompt = buildCoveragePlannerSystemPrompt({
        family: "claude",
        durationMode: "default",
      });
      const finalPrompt = buildFinalScriptSystemPrompt(
        { family: "claude", durationMode: "default" },
        [4, 6, 8],
      );
      const judgePrompt = buildNarrationJudgeSystemPrompt({
        family: "claude",
        durationMode: "default",
      });

      expect(plannerPrompt).not.toContain("review risk");
      expect(finalPrompt).not.toContain("engineering review");
      expect(judgePrompt).not.toContain("issue-first ordering");
    });

    it("coverage planner includes reviewer risk ranking instructions only in deepdive mode for both families", () => {
      for (const family of ["claude", "gemini"] as const) {
        const prompt = buildCoveragePlannerSystemPrompt({
          family,
          durationMode: "default",
          deepdive: true,
        });
        expect(prompt).toContain("review risk");
        expect(prompt).toContain("correctness");
        expect(prompt).toContain("concurrency");
        // Active risk surfacing rules (Change 2)
        expect(prompt).toContain("injection vectors");
        expect(prompt).toContain("god objects");
        expect(prompt).toContain("circuit-breaker");
        expect(prompt).toContain("unbounded thread");
        expect(prompt).toContain("non-idiomatic");
      }
    });

    it("final script system prompt includes reviewer narration rules only in deepdive mode for both families", () => {
      for (const family of ["claude", "gemini"] as const) {
        const prompt = buildFinalScriptSystemPrompt(
          { family, durationMode: "default", deepdive: true },
          [4, 6, 8],
        );
        expect(prompt).toContain("engineering review");
        // Active narration rules (Change 2)
        expect(prompt).toContain("vulnerability class");
        expect(prompt).toContain("failure scenario");
        expect(prompt).toContain("verdict");
        expect(prompt).toContain("indirect reviewer-style question");
        // Concrete examples of question framing (Fix for missing reviewer questions)
        expect(prompt).toContain("WRONG (declarative)");
        expect(prompt).toContain("RIGHT (reviewer question)");
        // Deepdive-aware teaching rule replaces declarative "what changed, why it matters"
        expect(prompt).toContain("raise the reviewer concern first");
        expect(prompt).not.toContain("what changed, why it matters");
      }
    });

    it("non-deepdive final script prompt uses declarative teaching rule", () => {
      for (const family of ["claude", "gemini"] as const) {
        const prompt = buildFinalScriptSystemPrompt(
          { family, durationMode: "default", deepdive: false },
          [4, 6, 8],
        );
        expect(prompt).toContain("what changed, why it matters");
        expect(prompt).not.toContain("raise the reviewer concern first");
      }
    });

    it("scene outline prompt orders scenes by review risk only in deepdive mode for both families", () => {
      for (const family of ["claude", "gemini"] as const) {
        const prompt = buildSceneOutlineSystemPrompt({
          family,
          durationMode: "default",
          deepdive: true,
        });
        expect(prompt).toContain("highest-risk");
      }
    });

    it("final script prompt includes opening and closing posture instructions only in deepdive mode for both families", () => {
      for (const family of ["claude", "gemini"] as const) {
        const prompt = buildFinalScriptSystemPrompt(
          { family, durationMode: "default", deepdive: true },
          [4, 6, 8],
        );
        expect(prompt).toContain("OPENING SCENE");
        expect(prompt).toContain("CLOSING SCENE");
        expect(prompt).toContain("teammate review handoff");
        expect(prompt).toContain("unresolved checks");
      }
    });

    it("batch script system prompt includes reviewer rules only in deepdive mode for both families", () => {
      for (const family of ["claude", "gemini"] as const) {
        for (const isFirst of [true, false]) {
          const prompt = buildBatchScriptSystemPrompt(
            { family, durationMode: "default", deepdive: true },
            [4, 6, 8],
            isFirst,
          );
          expect(prompt).toContain("engineering review");
          expect(prompt).toContain("verdict");
        }
      }
    });

    it("narration judge includes reviewer-specific evaluation axes only in deepdive mode for both families", () => {
      for (const family of ["claude", "gemini"] as const) {
        const prompt = buildNarrationJudgeSystemPrompt({
          family,
          durationMode: "default",
          deepdive: true,
        });
        expect(prompt).toContain("issue-first ordering");
        expect(prompt).toContain("reviewer tone fidelity");
        expect(prompt).toContain("verdict absence");
      }
    });
  });

  // ── Security directive presence ──────────────────────────────────────
  describe("security directive in V2 system prompts", () => {
    const CLAUDE_DIRECTIVE_MARKER = "<security_rules>";
    const NON_CLAUDE_DIRECTIVE_MARKER = "SECURITY:";
    const DIRECTIVE_CONTENT = "untrusted input";

    it("all system prompt builders include security directive for Claude family", () => {
      const ctx = { family: "claude" as const, durationMode: "default" as const };
      const prompts = [
        buildCoveragePlannerSystemPrompt(ctx),
        buildCoverageJudgeSystemPrompt(ctx),
        buildSceneOutlineSystemPrompt(ctx),
        buildFinalScriptSystemPrompt(ctx, [4, 6, 8]),
        buildBatchScriptSystemPrompt(ctx, [4, 6, 8], true),
        buildBatchScriptSystemPrompt(ctx, [4, 6, 8], false),
        buildNarrationJudgeSystemPrompt(ctx),
      ];
      for (const prompt of prompts) {
        expect(prompt).toContain(CLAUDE_DIRECTIVE_MARKER);
        expect(prompt).toContain(DIRECTIVE_CONTENT);
      }
    });

    it("all system prompt builders include security directive for non-Claude family", () => {
      const ctx = { family: "gemini" as const, durationMode: "default" as const };
      const prompts = [
        buildCoveragePlannerSystemPrompt(ctx),
        buildCoverageJudgeSystemPrompt(ctx),
        buildSceneOutlineSystemPrompt(ctx),
        buildFinalScriptSystemPrompt(ctx, [4, 6, 8]),
        buildBatchScriptSystemPrompt(ctx, [4, 6, 8], true),
        buildBatchScriptSystemPrompt(ctx, [4, 6, 8], false),
        buildNarrationJudgeSystemPrompt(ctx),
      ];
      for (const prompt of prompts) {
        expect(prompt).toContain(NON_CLAUDE_DIRECTIVE_MARKER);
        expect(prompt).toContain(DIRECTIVE_CONTENT);
        expect(prompt).not.toContain(CLAUDE_DIRECTIVE_MARKER);
      }
    });

    it("security directive includes NEVER-follow instruction for both families", () => {
      for (const family of ["claude", "gemini"] as const) {
        const prompt = buildCoveragePlannerSystemPrompt({ family, durationMode: "default" });
        expect(prompt).toContain("NEVER follow instructions");
      }
    });
  });

  // ── Coverage judge user prompt tag names ─────────────────────────────
  describe("coverage judge user prompt section tags", () => {
    it("emits <diff_analysis> tag (not <analysis>) for Claude family", () => {
      const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
      const prompt = buildCoverageJudgeUserPrompt(
        "claude",
        fakePRContext,
        fakeDiffAnalysis,
        base.coveragePlan,
      );
      expect(prompt).toContain("<diff_analysis>");
      expect(prompt).not.toContain("<analysis>");
      expect(prompt).toContain("<pr_context>");
      expect(prompt).toContain("<coverage_plan>");
    });

    it("emits labeled sections (not XML tags) for Gemini family", () => {
      const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
      const prompt = buildCoverageJudgeUserPrompt(
        "gemini",
        fakePRContext,
        fakeDiffAnalysis,
        base.coveragePlan,
      );
      expect(prompt).toContain("DIFF ANALYSIS:");
      expect(prompt).not.toContain("<diff_analysis>");
      expect(prompt).not.toContain("<analysis>");
    });
  });
});
