import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createCoverageJudge,
  createNarrationQualityJudge,
} from "@/infrastructure/llm/promptPipelineV2Judges";
import { narrationJudgeTransportResultSchema } from "@/domain/entities/PromptPipelineV2";
import { videoScriptSchema } from "@/domain/entities/VideoScript";
import {
  VALID_SCRIPT,
  fakeDiffAnalysis,
  fakePRContext,
} from "./fixtures/scriptWriterFixtures";

describe("PromptPipelineV2 judges", () => {
  it("requires a full transport-shaped revisedScript while allowing repairable semantics", () => {
    const partialResult = narrationJudgeTransportResultSchema.safeParse({
      passed: false,
      issues: ["Needs revision"],
      scores: {
        hookStrength: 5,
        explanatoryClarity: 8,
        evidenceGrounding: 8,
        sceneDistinctness: 7,
        themeFidelity: 7,
        topClusterCoverage: 8,
        jargonDensity: 4,
        boredomRisk: 5,
      },
      revisedScript: {},
    });
    expect(partialResult.success).toBe(false);

    const repairableResult = narrationJudgeTransportResultSchema.safeParse({
      passed: false,
      issues: ["Needs stronger overview"],
      scores: {
        hookStrength: 5,
        explanatoryClarity: 8,
        evidenceGrounding: 8,
        sceneDistinctness: 7,
        themeFidelity: 7,
        topClusterCoverage: 8,
        jargonDensity: 4,
        boredomRisk: 5,
      },
      revisedScript: {
        ...VALID_SCRIPT,
        scenes: VALID_SCRIPT.scenes.map((scene, index) =>
          index === 0 ? { ...scene, sceneType: "hook" } : scene,
        ),
      },
    });
    expect(repairableResult.success).toBe(true);
  });

  it("coverage judge returns a revised plan when the plan fails", async () => {
    const plannedCoverage = {
      summary: "Initial plan",
      selectedEvidencePolicy: "Use top files only.",
      clusters: [
        {
          clusterId: "cluster-auth",
          title: "Authentication middleware",
          files: ["src/middleware/auth.ts"],
          evidenceSnippets: [
            {
              filePath: "src/middleware/auth.ts",
              summary: "Adds auth validation",
              diffExcerpt: "function validateJWT() {}",
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
          disposition: "deep_dive" as const,
          reason: "Primary user-facing change",
        },
      ],
      majorClusterIds: ["cluster-auth"],
    };
    const revisedPlan = {
      ...plannedCoverage,
      summary: "Revised plan",
      selectedEvidencePolicy: "Use only cluster-selected evidence in the final writer.",
    };
    const model = {
      family: "claude" as const,
      completeJson: vi.fn().mockResolvedValue({
        passed: false,
        issues: ["Need stronger evidence selection policy"],
        missingMajorClusterIds: [],
        weakEvidenceClusterIds: [],
        allocationIssues: [],
        scores: {
          completeness: 8,
          evidenceGrounding: 7,
          allocationQuality: 8,
        },
        revisedPlan,
      }),
    };

    const result = await createCoverageJudge(model).judge({
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      coveragePlan: plannedCoverage,
    });

    expect(result.result.passed).toBe(false);
    expect(result.coveragePlan.summary).toBe("Revised plan");
  });

  it("narration quality judge returns a revised script when the story fails", async () => {
    const coveragePlan = {
      summary: "Plan",
      selectedEvidencePolicy: "Cluster-selected evidence only.",
      clusters: [
        {
          clusterId: "cluster-auth",
          title: "Authentication middleware",
          files: ["src/middleware/auth.ts"],
          evidenceSnippets: [
            {
              filePath: "src/middleware/auth.ts",
              summary: "Adds auth validation",
              diffExcerpt: "function validateJWT() {}",
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
          disposition: "deep_dive" as const,
          reason: "Primary user-facing change",
        },
      ],
      majorClusterIds: ["cluster-auth"],
    };
    const sceneOutline = {
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "overview" as const,
          title: "Overview",
          clusterIds: ["cluster-auth"],
          evidenceFilePaths: ["src/middleware/auth.ts"],
          whatChanged: "Adds authentication",
          whyItMatters: "Protects requests",
          failureWithoutIt: "Unauthorized calls slip through",
          validation: "Middleware tests verify access control",
          visualFocus: "A locked gate being installed",
        },
      ],
    };
    const revisedScript = {
      ...VALID_SCRIPT,
      summary: "Revised final script summary",
    };
    const model = {
      family: "gemini" as const,
      completeJson: vi.fn().mockResolvedValue({
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
      }),
    };

    const result = await createNarrationQualityJudge(model, [4, 6, 8]).judge({
      context: fakePRContext,
      analysis: fakeDiffAnalysis,
      coveragePlan,
      sceneOutline,
      script: videoScriptSchema.parse(VALID_SCRIPT),
    });

    expect(result.result.passed).toBe(false);
    expect(result.script.summary).toBe("Revised final script summary");
  });

  describe("narration judge revisedScript repair", () => {
    const coveragePlan = {
      summary: "Plan",
      selectedEvidencePolicy: "Cluster-selected evidence only.",
      clusters: [
        {
          clusterId: "cluster-auth",
          title: "Authentication middleware",
          files: ["src/middleware/auth.ts"],
          evidenceSnippets: [
            { filePath: "src/middleware/auth.ts", summary: "Adds auth", diffExcerpt: "function validateJWT() {}" },
          ],
          technicalMechanism: "Validate JWT",
          impact: "Protects requests",
          riskIfAbsent: "Unauthorized access",
          validationEvidence: ["auth tests"],
          importanceRank: 1,
        },
      ],
      ledger: [{ clusterId: "cluster-auth", disposition: "deep_dive" as const, reason: "Primary change" }],
      majorClusterIds: ["cluster-auth"],
    };
    const sceneOutline = {
      scenes: [
        { sceneNumber: 1, sceneType: "overview" as const, title: "Overview", clusterIds: ["cluster-auth"], evidenceFilePaths: ["src/middleware/auth.ts"], whatChanged: "Adds auth", whyItMatters: "Security", failureWithoutIt: "Open access", validation: "Tests", visualFocus: "Gate" },
      ],
    };

    // Script with invalid durationSeconds (0) — fails videoScriptTransportSchema (positive int required)
    const brokenRevisedScript = {
      ...VALID_SCRIPT,
      scenes: VALID_SCRIPT.scenes.map((s, i) => i === 0 ? { ...s, durationSeconds: 0 } : s),
    };

    const failingJudgeResult = {
      passed: false,
      issues: ["Hook too flat"],
      scores: {
        hookStrength: 5, explanatoryClarity: 8, evidenceGrounding: 8,
        sceneDistinctness: 7, themeFidelity: 7, topClusterCoverage: 8,
        jargonDensity: 4, boredomRisk: 5,
      },
    };

    beforeEach(() => {
      vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("repairs revisedScript that fails validation when completeText is available", async () => {
      const completeText = vi.fn().mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));
      const model = {
        family: "claude" as const,
        completeJson: vi.fn().mockResolvedValue({
          ...failingJudgeResult,
          revisedScript: brokenRevisedScript,
        }),
        completeText,
      };

      const result = await createNarrationQualityJudge(model, [4, 6, 8]).judge({
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        coveragePlan,
        sceneOutline,
        script: videoScriptSchema.parse(VALID_SCRIPT),
      });

      expect(completeText).toHaveBeenCalledTimes(1);
      expect(result.script.scenes[0].durationSeconds).toBeGreaterThan(0);
      expect(result.result.revisedScript?.scenes[0]?.durationSeconds).toBeGreaterThan(0);
    });

    it("falls back to original script when revisedScript repair is exhausted", async () => {
      const completeText = vi.fn().mockResolvedValue(JSON.stringify(brokenRevisedScript));
      const model = {
        family: "claude" as const,
        completeJson: vi.fn().mockResolvedValue({
          ...failingJudgeResult,
          revisedScript: brokenRevisedScript,
        }),
        completeText,
      };

      const originalScript = videoScriptSchema.parse(VALID_SCRIPT);
      const result = await createNarrationQualityJudge(model, [4, 6, 8]).judge({
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        coveragePlan,
        sceneOutline,
        script: originalScript,
      });

      // Falls back to original script
      expect(result.script.summary).toBe(originalScript.summary);
      // 2 repair attempts were made
      expect(completeText).toHaveBeenCalledTimes(2);
      expect(result.result.revisedScript).toBeUndefined();
    });

    it("skips repair and falls back when completeText is not available", async () => {
      const model = {
        family: "claude" as const,
        completeJson: vi.fn().mockResolvedValue({
          ...failingJudgeResult,
          revisedScript: brokenRevisedScript,
        }),
        // No completeText
      };

      const originalScript = videoScriptSchema.parse(VALID_SCRIPT);
      const result = await createNarrationQualityJudge(model, [4, 6, 8]).judge({
        context: fakePRContext,
        analysis: fakeDiffAnalysis,
        coveragePlan,
        sceneOutline,
        script: originalScript,
      });

      // Falls back to original script (no repair possible)
      expect(result.script.summary).toBe(originalScript.summary);
      expect(result.result.revisedScript).toBeUndefined();
    });
  });

  // ── Reviewer-tone judge coverage ──────────────────────────────────
  describe("reviewer-tone evaluation", () => {
    it("narration judge transport schema accepts optional reviewer scores", () => {
      const withReviewerScores = narrationJudgeTransportResultSchema.safeParse({
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
          issueFirstOrdering: 9,
          reviewerToneFidelity: 8,
          verdictAbsence: 10,
        },
      });
      expect(withReviewerScores.success).toBe(true);
    });

    it("narration judge transport schema still passes without reviewer scores", () => {
      const withoutReviewerScores = narrationJudgeTransportResultSchema.safeParse({
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
      });
      expect(withoutReviewerScores.success).toBe(true);
    });
  });
});
