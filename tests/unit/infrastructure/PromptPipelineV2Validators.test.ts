import { describe, expect, it, vi } from "vitest";
import {
  validateCoveragePlanConsistency,
  validateSceneOutlineConsistency,
  stripInvalidEvidenceFileRefs,
  validateScriptEvidenceGrounding,
  validateReviewerNarration,
  enforceReviewerNarration,
  validateCodeBindings,
  POPCORN_MIN_SCENE_COUNT,
} from "@/infrastructure/llm/promptPipelineV2Validators";
import {
  PROMPT_PIPELINE_V2_EVAL_CORPUS,
  REVIEWER_RISK_CASES,
} from "./fixtures/promptPipelineV2EvalCorpus";

// Helper: build a properly-shaped ChangeCluster for fixture extension.
// Matches changeClusterSchema (src/domain/entities/PromptPipelineV2.ts).
function buildDriftCluster(clusterId: string, filePath: string) {
  return {
    clusterId,
    title: `Drift fixture ${clusterId}`,
    files: [filePath],
    evidenceSnippets: [
      { filePath, summary: "test drift fixture", diffExcerpt: "+x = 1" },
    ],
    technicalMechanism: "test fixture",
    impact: "test fixture — no production impact",
    riskIfAbsent: "n/a (test only)",
    validationEvidence: ["unit test fixture"],
    importanceRank: 99,
  };
}

describe("PromptPipelineV2 deterministic validators", () => {
  it("passes the representative eval corpus", () => {
    for (const testCase of PROMPT_PIPELINE_V2_EVAL_CORPUS) {
      const coverageValidation = validateCoveragePlanConsistency(testCase.coveragePlan);
      const outlineValidation = validateSceneOutlineConsistency(
        testCase.coveragePlan,
        testCase.sceneOutline,
      );
      const scriptValidation = validateScriptEvidenceGrounding(
        testCase.coveragePlan,
        testCase.sceneOutline,
        testCase.script,
      );

      expect(coverageValidation.passed, testCase.id).toBe(true);
      expect(outlineValidation.passed, testCase.id).toBe(true);
      expect(scriptValidation.passed, testCase.id).toBe(true);
    }
  });

  it("fails ledger completeness when a cluster is missing from the coverage ledger", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const invalidPlan = {
      ...base.coveragePlan,
      ledger: [],
    };

    const validation = validateCoveragePlanConsistency(invalidPlan);

    expect(validation.passed).toBe(false);
    expect(validation.missingLedgerClusterIds).toContain("feature-auth-cluster");
  });

  it("fails scene outlines that reference evidence outside their assigned clusters", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[1];
    const invalidOutline = {
      ...base.sceneOutline,
      scenes: base.sceneOutline.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? { ...scene, evidenceFilePaths: [...scene.evidenceFilePaths, "src/not-in-cluster.ts"] }
          : scene,
      ),
    };

    const validation = validateSceneOutlineConsistency(base.coveragePlan, invalidOutline);

    expect(validation.passed).toBe(false);
    expect(validation.invalidEvidenceFileRefs[0]?.sceneNumber).toBe(2);
  });

  it("fails scene outlines that drop required clusters from the approved ledger", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const invalidOutline = {
      ...base.sceneOutline,
      scenes: base.sceneOutline.scenes.map((scene) =>
        scene.clusterIds.includes("feature-auth-cluster")
          ? { ...scene, clusterIds: [], evidenceFilePaths: [] }
          : scene,
      ),
    };

    const validation = validateSceneOutlineConsistency(base.coveragePlan, invalidOutline);

    expect(validation.passed).toBe(false);
    expect(validation.uncoveredRequiredClusterIds).toContain("feature-auth-cluster");
  });

  it("fails final scripts that cite backtick identifiers not in assigned evidence", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[2];
    const scriptWithUnknownRef = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration: "The `inventedIdentifier` path rewires the migration.",
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      scriptWithUnknownRef,
    );

    expect(validation.passed).toBe(false);
    expect(validation.issues.length).toBeGreaterThan(0);
    expect(validation.issues[0]).toContain("ungrounded backtick references");
    expect(validation.warnings).toHaveLength(0);
    expect(validation.unknownBacktickReferences[0]?.sceneNumber).toBe(2);
    expect(validation.unknownBacktickReferences[0]?.identifiers).toContain("inventedIdentifier");
  });

  it("warns when technical scenes are missing codeBroll anchors", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithoutCodeBroll = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneType === "code_walkthrough"
          ? { ...scene, codeBroll: [] }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      scriptWithoutCodeBroll,
    );

    expect(validation.warnings.length).toBeGreaterThan(0);
    expect(validation.warnings[0]).toContain("Technical scenes missing codeBroll anchors");
  });

  it("fails final scripts that mention file paths not in assigned evidence", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithUnknownFile = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration: "The change in `src/unplanned/extra-file.ts` adds a new route.",
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      scriptWithUnknownFile,
    );

    expect(validation.passed).toBe(false);
    expect(validation.issues.length).toBeGreaterThan(0);
    expect(validation.issues[0]).toContain("unassigned file paths");
    expect(validation.warnings).toHaveLength(0);
    expect(validation.unknownFileReferences[0]?.sceneNumber).toBe(2);
    expect(validation.crossSceneFileReferences).toHaveLength(0);
  });

  it("warns (does not fail) when narration mentions a corpus file assigned to a different scene", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    // Add a new cluster with a file that no scene references — so the file
    // is in the corpus but outside scene 2's allow-list.
    const driftFile = "src/cross/scene/drift-file.ts";
    const extendedCoverage = {
      ...base.coveragePlan,
      clusters: [
        ...base.coveragePlan.clusters,
        buildDriftCluster("drift_cluster", driftFile),
      ],
    };

    const scriptWithDrift = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? { ...scene, narration: `The handler in ${driftFile} is wired into this flow.` }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      extendedCoverage,
      base.sceneOutline,
      scriptWithDrift,
    );

    expect(validation.passed).toBe(true);
    expect(validation.unknownFileReferences).toHaveLength(0);
    expect(validation.crossSceneFileReferences).toHaveLength(1);
    expect(validation.crossSceneFileReferences[0]?.sceneNumber).toBe(2);
    expect(validation.crossSceneFileReferences[0]?.filePaths).toContain(driftFile);
    expect(validation.warnings.some((w) => w.includes("prose drift"))).toBe(true);
  });

  it("warns when a backtick-wrapped corpus file is mentioned in a different scene", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const driftFile = "src/cross/scene/backtick-drift.ts";
    const extendedCoverage = {
      ...base.coveragePlan,
      clusters: [
        ...base.coveragePlan.clusters,
        buildDriftCluster("backtick_drift_cluster", driftFile),
      ],
    };

    const scriptWithBacktickDrift = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? { ...scene, narration: `The handler in \`${driftFile}\` is wired into this flow.` }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      extendedCoverage,
      base.sceneOutline,
      scriptWithBacktickDrift,
    );

    expect(validation.passed).toBe(true);
    expect(validation.unknownFileReferences).toHaveLength(0);
    expect(validation.crossSceneFileReferences[0]?.filePaths).toContain(driftFile);
  });

  it("classifies drift and hallucination separately when both appear in one scene", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const driftFile = "src/cross/scene/mixed-drift.ts";
    const hallucinatedFile = "src/totally/fake.ts";
    const extendedCoverage = {
      ...base.coveragePlan,
      clusters: [
        ...base.coveragePlan.clusters,
        buildDriftCluster("mixed_drift_cluster", driftFile),
      ],
    };

    const scriptWithMixed = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration: `The drift in ${driftFile} relates to ${hallucinatedFile} elsewhere.`,
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      extendedCoverage,
      base.sceneOutline,
      scriptWithMixed,
    );

    expect(validation.passed).toBe(false); // hallucination still fatal
    expect(validation.unknownFileReferences[0]?.filePaths).toContain(hallucinatedFile);
    expect(validation.unknownFileReferences[0]?.filePaths).not.toContain(driftFile);
    expect(validation.crossSceneFileReferences[0]?.filePaths).toContain(driftFile);
    expect(validation.crossSceneFileReferences[0]?.filePaths).not.toContain(hallucinatedFile);
  });

  it("keeps codeBroll mismatch fatal even when filePath exists elsewhere in the corpus", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const driftFile = "src/cross/scene/cb-drift-file.ts";
    const extendedCoverage = {
      ...base.coveragePlan,
      clusters: [
        ...base.coveragePlan.clusters,
        buildDriftCluster("cb_drift_cluster", driftFile),
      ],
    };

    const scriptWithBadCodeBroll = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              codeBroll: [
                {
                  filePath: driftFile,
                  code: "x = 1",
                  language: "typescript",
                  lineRange: [1, 1] as [number, number],
                  highlights: [],
                },
              ],
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      extendedCoverage,
      base.sceneOutline,
      scriptWithBadCodeBroll,
    );

    expect(validation.passed).toBe(false);
    expect(validation.issues.some((i) => i.includes("codeBroll references files outside"))).toBe(true);
    expect(validation.invalidCodeBrollFileRefs[0]?.filePath).toBe(driftFile);
  });

  it("fails final scripts that omit outline scenes", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[3];
    const lastScriptScene = base.script.scenes.at(-1);
    const lastOutlineScene = base.sceneOutline.scenes.at(-1);
    if (!lastScriptScene || !lastOutlineScene) {
      throw new Error("Expected eval corpus fixture to include at least one scene");
    }
    const invalidScript = {
      ...base.script,
      scenes: base.script.scenes.slice(0, -1),
      totalDurationSeconds: base.script.totalDurationSeconds - lastScriptScene.durationSeconds,
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      invalidScript,
    );

    expect(validation.passed).toBe(false);
    expect(validation.missingOutlineSceneNumbers).toContain(lastOutlineScene.sceneNumber);
  });

  it("allows file references from assigned cluster files (not just evidenceFilePaths)", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    // Add an extra file to the cluster that is NOT in the scene outline's evidenceFilePaths
    const extendedCoverage = {
      ...base.coveragePlan,
      clusters: base.coveragePlan.clusters.map((c) => ({
        ...c,
        files: [...c.files, "src/config/jwt.ts"],
      })),
    };
    // Scene 2 references the extra cluster file in narration
    const scriptWithClusterFile = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? { ...scene, narration: "The config in src/config/jwt.ts sets the token expiry." }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(extendedCoverage, base.sceneOutline, scriptWithClusterFile);
    expect(validation.passed).toBe(true);
    expect(validation.unknownFileReferences).toHaveLength(0);
  });

  it("skips evidence grounding for overview and closing scenes", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    // Overview scene (scene 1) mentions a file path — should be exempt
    const scriptWithOverviewFilePath = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 1
          ? { ...scene, narration: "This PR modifies src/totally/unrelated.ts to add new features." }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      scriptWithOverviewFilePath,
    );
    expect(validation.passed).toBe(true);
    expect(validation.unknownFileReferences).toHaveLength(0);
  });

  it("ignores prose-like path references (client/server, before/after)", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithProse = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? { ...scene, narration: "The client/server architecture improves the input/output handling." }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(base.coveragePlan, base.sceneOutline, scriptWithProse);
    expect(validation.passed).toBe(true);
    expect(validation.unknownFileReferences).toHaveLength(0);
  });

  it("classifies JSON.parse as identifier, not file path", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithDottedRef = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? { ...scene, narration: "The `JSON.parse` call validates the incoming payload." }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(base.coveragePlan, base.sceneOutline, scriptWithDottedRef);
    // JSON.parse should not appear in unknownFileReferences (it's not a file path)
    expect(validation.unknownFileReferences).toHaveLength(0);
  });

  it("treats common bare filenames in backticks as file paths", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithBareFileRefs = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration: "The rollout touches `README.md`, `.env.example`, and `Dockerfile.local`.",
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      scriptWithBareFileRefs,
    );

    expect(validation.passed).toBe(false);
    expect(validation.unknownFileReferences[0]?.sceneNumber).toBe(2);
    expect(validation.unknownFileReferences[0]?.filePaths).toEqual([
      "README.md",
      ".env.example",
      "Dockerfile.local",
    ]);
  });

  it("normalizes /src/... and trailing-period paths to match assigned evidence", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithSlashPrefix = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration: "Changes in /src/middleware/auth.ts improve security.",
              codeBroll: scene.codeBroll.length > 0
                ? scene.codeBroll.map((cb) => ({ ...cb, filePath: "/src/middleware/auth.ts" }))
                : scene.codeBroll,
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(base.coveragePlan, base.sceneOutline, scriptWithSlashPrefix);
    expect(validation.passed).toBe(true);
    expect(validation.unknownFileReferences).toHaveLength(0);
    expect(validation.invalidCodeBrollFileRefs).toHaveLength(0);
  });

  it("still validates codeBroll file paths for overview scenes", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithInvalidOverviewCodeBroll = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 1 && scene.codeBroll.length > 0
          ? {
              ...scene,
              narration: "This PR modifies src/totally/unrelated.ts at a high level.",
              codeBroll: scene.codeBroll.map((cb) => ({
                ...cb,
                filePath: "src/totally/unrelated.ts",
              })),
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      scriptWithInvalidOverviewCodeBroll,
    );

    expect(validation.passed).toBe(false);
    expect(validation.unknownFileReferences).toHaveLength(0);
    expect(validation.invalidCodeBrollFileRefs).toEqual([
      {
        sceneNumber: 1,
        filePath: "src/totally/unrelated.ts",
      },
    ]);
  });

  describe("stripInvalidEvidenceFileRefs", () => {
    it("removes evidence files not in assigned clusters", () => {
      const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[1];
      const outlineWithBadFile = {
        ...base.sceneOutline,
        scenes: base.sceneOutline.scenes.map((scene) =>
          scene.sceneNumber === 2
            ? { ...scene, evidenceFilePaths: [...scene.evidenceFilePaths, "src/not-in-cluster.ts"] }
            : scene,
        ),
      };

      const { sceneOutline: fixed, stripped } = stripInvalidEvidenceFileRefs(base.coveragePlan, outlineWithBadFile);

      expect(stripped).toHaveLength(1);
      expect(stripped[0]?.sceneNumber).toBe(2);
      expect(stripped[0]?.filePaths).toEqual(["src/not-in-cluster.ts"]);
      // The invalid file should be gone from the fixed outline
      const scene2 = fixed.scenes.find((s) => s.sceneNumber === 2);
      expect(scene2?.evidenceFilePaths).not.toContain("src/not-in-cluster.ts");
    });

    it("returns empty stripped array when all files are valid", () => {
      const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
      const { sceneOutline: fixed, stripped } = stripInvalidEvidenceFileRefs(base.coveragePlan, base.sceneOutline);

      expect(stripped).toHaveLength(0);
      expect(fixed).toEqual(base.sceneOutline);
    });

    it("preserves valid evidence files while removing invalid ones", () => {
      const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[1];
      const originalScene2 = base.sceneOutline.scenes.find((s) => s.sceneNumber === 2);
      const originalFilePaths = originalScene2?.evidenceFilePaths ?? [];

      const outlineWithBadFile = {
        ...base.sceneOutline,
        scenes: base.sceneOutline.scenes.map((scene) =>
          scene.sceneNumber === 2
            ? { ...scene, evidenceFilePaths: [...scene.evidenceFilePaths, "src/bogus.ts"] }
            : scene,
        ),
      };

      const { sceneOutline: fixed } = stripInvalidEvidenceFileRefs(base.coveragePlan, outlineWithBadFile);
      const fixedScene2 = fixed.scenes.find((s) => s.sceneNumber === 2);
      // Original valid files preserved, only bogus file removed
      expect(fixedScene2?.evidenceFilePaths).toEqual(originalFilePaths);
    });
  });

  it("accepts ./-prefixed file paths when they match assigned evidence", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const validScript = {
      ...base.script,
      scenes: base.script.scenes.map((scene) =>
        scene.sceneNumber === 2
          ? {
              ...scene,
              narration:
                "The `validateJWT` mechanism in `./src/middleware/auth.ts` enforces the new behavior.",
              codeBroll: scene.codeBroll.length > 0
                ? scene.codeBroll.map((cb) => ({ ...cb, filePath: "./src/middleware/auth.ts" }))
                : scene.codeBroll,
            }
          : scene,
      ),
    };

    const validation = validateScriptEvidenceGrounding(
      base.coveragePlan,
      base.sceneOutline,
      validScript,
    );

    expect(validation.passed).toBe(true);
    expect(validation.unknownFileReferences).toHaveLength(0);
    expect(validation.invalidCodeBrollFileRefs).toHaveLength(0);
  });

  // ── Reviewer-risk fixture validation ────────────────────────────────
  // Reviewer-risk cases must pass the same deterministic validators as
  // regular cases — reviewer narration changes prompts, not evidence structure.

  // ── Reviewer narration validation ────────────────────────────────────

  it("validateReviewerNarration passes when narration has no verdict or client language", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const result = validateReviewerNarration(base.script);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("validateReviewerNarration catches verdict language in narration", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithVerdict = {
      ...base.script,
      scenes: base.script.scenes.map((scene, i) =>
        i === 1
          ? { ...scene, narration: "I would approve this change — it looks ready to merge." }
          : scene,
      ),
    };
    const result = validateReviewerNarration(scriptWithVerdict);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "verdict_language")).toBe(true);
  });

  it("validateReviewerNarration catches all forms of approve/approval/approved/approving", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    for (const word of ["approve", "approved", "approves", "approval", "approving"]) {
      const script = {
        ...base.script,
        scenes: base.script.scenes.map((scene, i) =>
          i === 1
            ? { ...scene, narration: `I would ${word} this PR.` }
            : scene,
        ),
      };
      const result = validateReviewerNarration(script);
      expect(result.passed, `Should catch "${word}"`).toBe(false);
    }
  });

  it("validateReviewerNarration does not false-positive on domain entity customer references", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    for (const narration of [
      "The `getCustomer` query now filters by active status.",
      "Changes to the customer table add an index on email.",
      "The CustomerRepository validates input before insert.",
    ]) {
      const script = {
        ...base.script,
        scenes: base.script.scenes.map((scene, i) =>
          i === 1 ? { ...scene, narration } : scene,
        ),
      };
      const result = validateReviewerNarration(script);
      expect(result.passed, `Should not flag: "${narration}"`).toBe(true);
    }
  });

  it("validateReviewerNarration catches marketing-tone customer phrasing", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    for (const narration of [
      "Our customers will benefit from this improvement.",
      "This enhances customer satisfaction across the platform.",
      "The customer experience is significantly improved.",
    ]) {
      const script = {
        ...base.script,
        scenes: base.script.scenes.map((scene, i) =>
          i === 1 ? { ...scene, narration } : scene,
        ),
      };
      const result = validateReviewerNarration(script);
      expect(result.passed, `Should flag: "${narration}"`).toBe(false);
    }
  });

  it("validateReviewerNarration does not false-positive on engineering terms like code block", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithBlock = {
      ...base.script,
      scenes: base.script.scenes.map((scene, i) =>
        i === 1
          ? { ...scene, narration: "The try-catch block handles failures gracefully." }
          : scene,
      ),
    };
    const result = validateReviewerNarration(scriptWithBlock);
    expect(result.passed).toBe(true);
  });

  it("validateReviewerNarration catches client-facing language in summary", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const scriptWithClientLanguage = {
      ...base.script,
      summary: "This executive summary highlights the value proposition for our stakeholders.",
    };
    const result = validateReviewerNarration(scriptWithClientLanguage);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "client_facing_language")).toBe(true);
  });

  it("passes all reviewer-risk fixture cases through deterministic validators", () => {
    for (const riskCase of REVIEWER_RISK_CASES) {
      const coverageValidation = validateCoveragePlanConsistency(riskCase.coveragePlan);
      const outlineValidation = validateSceneOutlineConsistency(
        riskCase.coveragePlan,
        riskCase.sceneOutline,
      );
      const scriptValidation = validateScriptEvidenceGrounding(
        riskCase.coveragePlan,
        riskCase.sceneOutline,
        riskCase.script,
      );

      expect(coverageValidation.passed, riskCase.id).toBe(true);
      expect(outlineValidation.passed, riskCase.id).toBe(true);
      expect(scriptValidation.passed, riskCase.id).toBe(true);
    }
  });

  // ── Per-pattern verdict coverage ────────────────────────────────────
  // Each VERDICT_PATTERN regex is verified individually to catch typos.

  it.each([
    ["reject this PR", "reject"],
    ["rejected the change", "rejected"],
    ["I would reject it", "reject"],
    ["LGTM", "LGTM"],
    ["lgtm", "lgtm"],
    ["block this", "block this"],
    ["block the PR", "block the PR"],
    ["block merge", "block merge"],
    ["changes requested", "changes requested"],
    ["merge this", "merge this"],
    ["merge the PR", "merge the PR"],
    ["ready to merge", "ready to merge"],
    ["high confidence", "high confidence"],
    ["low confidence", "low confidence"],
    ["confidence: 9", "confidence: 9"],
    ["review severity: critical", "review severity: critical"],
    ["finding severity: high", "finding severity: high"],
  ])("catches verdict pattern: %s", (narration, _expected) => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const script = {
      ...base.script,
      scenes: base.script.scenes.map((scene, i) =>
        i === 1 ? { ...scene, narration } : scene,
      ),
    };
    const result = validateReviewerNarration(script);
    expect(result.passed, `Should flag: "${narration}"`).toBe(false);
  });

  // Approve/reject without PR/merge context should NOT trigger (engineering usage)
  it.each([
    "The server rejects malformed requests",
    "The approval workflow validates all signers",
    "Input is rejected if schema validation fails",
    "The approving manager signs the document",
    "The new Logger class assigns severity: high to auth failures",
    "Error responses include severity: critical for 5xx status codes",
  ])("does not false-positive on engineering usage: %s", (narration) => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const script = {
      ...base.script,
      scenes: base.script.scenes.map((scene, i) =>
        i === 1 ? { ...scene, narration } : scene,
      ),
    };
    const result = validateReviewerNarration(script);
    expect(result.passed, `Should not flag: "${narration}"`).toBe(true);
  });

  // ── Per-pattern client-facing coverage ──────────────────────────────
  it.each([
    ["stakeholders", "stakeholders"],
    ["customer satisfaction", "customer satisfaction"],
    ["customer experience", "customer experience"],
    ["customer facing", "customer facing"],
    ["our customers", "our customers"],
    ["executive summary", "executive summary"],
    ["value proposition", "value proposition"],
    ["ROI", "ROI"],
  ])("catches client-facing pattern: %s", (narration, _expected) => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const script = {
      ...base.script,
      scenes: base.script.scenes.map((scene, i) =>
        i === 1 ? { ...scene, narration } : scene,
      ),
    };
    const result = validateReviewerNarration(script);
    expect(result.passed, `Should flag: "${narration}"`).toBe(false);
  });

  // ── enforceReviewerNarration unit tests ──────────────────────────────

  it("enforceReviewerNarration throws on violations when warn-only is false", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const script = {
      ...base.script,
      scenes: base.script.scenes.map((scene, i) =>
        i === 1 ? { ...scene, narration: "I would approve this PR." } : scene,
      ),
    };
    const mockLogger = { warn: vi.fn() };
    expect(() => enforceReviewerNarration(script, mockLogger, () => false))
      .toThrow("Reviewer narration validation failed");
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("enforceReviewerNarration warns on violations when warn-only is true", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const script = {
      ...base.script,
      scenes: base.script.scenes.map((scene, i) =>
        i === 1 ? { ...scene, narration: "I would approve this PR." } : scene,
      ),
    };
    const mockLogger = { warn: vi.fn() };
    enforceReviewerNarration(script, mockLogger, () => true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("REVIEWER_VIOLATION_WARN=true"),
      expect.objectContaining({ violations: expect.any(Array) }),
    );
  });

  it("enforceReviewerNarration is a no-op when script passes validation", () => {
    const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0];
    const mockLogger = { warn: vi.fn() };
    enforceReviewerNarration(base.script, mockLogger, () => false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  describe("popcorn minimum scene count", () => {
    const baseCoverage = PROMPT_PIPELINE_V2_EVAL_CORPUS[0]!.coveragePlan;
    const baseOutline = PROMPT_PIPELINE_V2_EVAL_CORPUS[0]!.sceneOutline;

    it("fails when popcorn outline has fewer than POPCORN_MIN_SCENE_COUNT scenes", () => {
      const shortOutline = { ...baseOutline, scenes: baseOutline.scenes.slice(0, 5) };
      const result = validateSceneOutlineConsistency(baseCoverage, shortOutline, "popcorn");
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.includes("Popcorn mode requires at least"))).toBe(true);
    });

    it("passes when durationMode is not popcorn even with few scenes", () => {
      const shortOutline = { ...baseOutline, scenes: baseOutline.scenes.slice(0, 5) };
      const result = validateSceneOutlineConsistency(baseCoverage, shortOutline, "default");
      // May fail for other reasons (uncovered clusters), but NOT for scene count
      expect(result.issues.every((i) => !i.includes("Popcorn mode requires"))).toBe(true);
    });

    it("passes when durationMode is omitted even with few scenes", () => {
      const shortOutline = { ...baseOutline, scenes: baseOutline.scenes.slice(0, 5) };
      const result = validateSceneOutlineConsistency(baseCoverage, shortOutline);
      expect(result.issues.every((i) => !i.includes("Popcorn mode requires"))).toBe(true);
    });

    it(`uses ${POPCORN_MIN_SCENE_COUNT} as the threshold`, () => {
      expect(POPCORN_MIN_SCENE_COUNT).toBe(10);
    });
  });

  describe("outline overview requirements", () => {
    const baseCoverage = PROMPT_PIPELINE_V2_EVAL_CORPUS[0]!.coveragePlan;
    const baseOutline = PROMPT_PIPELINE_V2_EVAL_CORPUS[0]!.sceneOutline;

    it("fails when scene 1 is not the overview", () => {
      const brokenOutline = {
        ...baseOutline,
        scenes: baseOutline.scenes.map((scene) => (
          scene.sceneNumber === 1
            ? { ...scene, sceneType: "hook" as const }
            : scene
        )),
      };
      const result = validateSceneOutlineConsistency(baseCoverage, brokenOutline, "popcorn");
      expect(result.passed).toBe(false);
      expect(result.issues).toContain('Scene outline scene 1 must be an "overview" scene.');
    });

    it("fails when the outline contains multiple overview scenes", () => {
      const brokenOutline = {
        ...baseOutline,
        scenes: baseOutline.scenes.map((scene) => (
          scene.sceneNumber === 2
            ? { ...scene, sceneType: "overview" as const }
            : scene
        )),
      };
      const result = validateSceneOutlineConsistency(baseCoverage, brokenOutline, "popcorn");
      expect(result.passed).toBe(false);
      expect(result.issues.some((issue) => issue.includes("exactly one overview scene"))).toBe(true);
    });
  });

  describe("validateCodeBindings", () => {
    function makeScript(scenes: Array<Partial<typeof PROMPT_PIPELINE_V2_EVAL_CORPUS[0]["script"]["scenes"][number]>>) {
      const base = PROMPT_PIPELINE_V2_EVAL_CORPUS[0].script;
      return {
        ...base,
        scenes: scenes.map((s, i) => ({
          sceneNumber: i + 1,
          sceneType: "code_walkthrough" as const,
          durationSeconds: 6,
          narration: "the function alpha computes the result",
          codeBroll: [{
            filePath: "src/a.ts",
            code: "function alpha() { return 1 }\nfunction beta() {}",
            language: "typescript",
            lineRange: [10, 11] as [number, number],
            highlights: [],
          }],
          ...s,
        })),
      };
    }

    it("passes when codeBindings are absent or empty (heuristic path)", () => {
      const script = makeScript([{}, {}]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(true);
      expect(result.strippedScenes).toEqual([]);
    });

    it("flags codeBrollIndex out of range", () => {
      const script = makeScript([{
        codeBindings: [{ wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 5, highlightLines: [], relatesToCodeBrollIndices: [] }],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
      expect(result.strippedScenes).toEqual([1]);
      expect(result.violations[0].reason).toContain("codeBrollIndex 5 out of range");
    });

    it("flags wordStartIndex/wordEndIndex past the scene's word count", () => {
      const script = makeScript([{
        narration: "short narration only", // 3 spoken words
        codeBindings: [{ wordStartIndex: 0, wordEndIndex: 99, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] }],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
      expect(result.violations[0].reason).toContain("exceeds scene word count");
    });

    it("flags inverted word range (wordEndIndex < wordStartIndex)", () => {
      const script = makeScript([{
        codeBindings: [{ wordStartIndex: 5, wordEndIndex: 2, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] }],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
      expect(result.violations[0].reason).toContain("invalid word range");
    });

    it("flags highlightLines outside the snippet's lineRange", () => {
      const script = makeScript([{
        codeBindings: [{ wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [99, 100], relatesToCodeBrollIndices: [] }],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
      expect(result.violations[0].reason).toContain("outside snippet line range");
    });

    it("flags self-relation in relatesToCodeBrollIndices", () => {
      const script = makeScript([{
        codeBindings: [{ wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [0] }],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
      expect(result.violations[0].reason).toContain("relatesToCodeBrollIndices");
    });

    it("flags OOB relatesToCodeBrollIndices", () => {
      const script = makeScript([{
        codeBindings: [{ wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [5] }],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
    });

    it("groups violations by sceneNumber in strippedScenes", () => {
      const script = makeScript([
        {
          codeBindings: [{ wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 99, highlightLines: [], relatesToCodeBrollIndices: [] }],
        },
        {}, // valid scene
        {
          codeBindings: [{ wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 99, highlightLines: [], relatesToCodeBrollIndices: [] }],
        },
      ]);
      const result = validateCodeBindings(script as never);
      expect(result.strippedScenes).toEqual([1, 3]);
    });

    it("accepts valid bindings without flagging", () => {
      const script = makeScript([{
        codeBindings: [{ wordStartIndex: 1, wordEndIndex: 2, codeBrollIndex: 0, highlightLines: [10], relatesToCodeBrollIndices: [] }],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(true);
    });

    it("flags a nested word span (inner span would shadow the outer in the sticky-forward resolver)", () => {
      const script = makeScript([{
        codeBindings: [
          { wordStartIndex: 0, wordEndIndex: 4, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
          { wordStartIndex: 1, wordEndIndex: 2, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
        ],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
      expect(result.strippedScenes).toEqual([1]);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].bindingIndex).toBe(1);
      expect(result.violations[0].reason).toContain("overlaps binding 0");
    });

    it("flags partially overlapping word spans", () => {
      const script = makeScript([{
        codeBindings: [
          { wordStartIndex: 0, wordEndIndex: 2, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
          { wordStartIndex: 2, wordEndIndex: 4, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
        ],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(false);
      expect(result.violations[0].reason).toContain("overlaps binding");
    });

    it("accepts disjoint word spans within a scene", () => {
      const script = makeScript([{
        codeBindings: [
          { wordStartIndex: 0, wordEndIndex: 1, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
          { wordStartIndex: 2, wordEndIndex: 3, codeBrollIndex: 0, highlightLines: [], relatesToCodeBrollIndices: [] },
        ],
      }]);
      const result = validateCodeBindings(script as never);
      expect(result.passed).toBe(true);
      expect(result.strippedScenes).toEqual([]);
    });
  });
});
