import { createLogger } from "@/lib/logger";
import { countSpokenWords } from "@/lib/narrationText";
import { isBatchSceneGenerationEnabled, isGroundingFailureWarnOnly, isJudgeSkipped, isPostGroundingJudgeEnabled, isReviewerViolationWarnOnly } from "@/lib/featureFlags";
import type { PRContext } from "@/domain/entities/PRContext";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";
import type { ScriptWriterResult } from "@/interfaces/IScriptWriter";
import type { ZodTypeAny, infer as ZodInfer } from "zod";
import {
  coveragePlanSchema,
  promptPipelineV2ArtifactsSchema,
  sceneOutlineSchema,
  type CoveragePlan,
  type NarrationJudgeResult,
  type SceneIntent,
  type ScriptEvidenceValidationResult,
} from "@/domain/entities/PromptPipelineV2";
import {
  DEFAULT_MODE_MAX_DURATION,
  MAX_VIDEO_DURATION_SECONDS,
  POPCORN_MODE_MIN_DURATION,
  batchEnvelopeTransportSchema,
  batchScenesTransportSchema,
  videoScriptTransportSchema,
  videoScriptSchema,
  ensureLastSceneOverview,
  type Scene,
  type VideoScript,
} from "@/domain/entities/VideoScript";
import type { PromptPipelineV2Artifacts } from "@/domain/entities/PromptPipelineV2";
import {
  buildBatchScriptSystemPrompt,
  buildBatchScriptUserPrompt,
  buildCoverageJudgeUserPrompt,
  buildCoveragePlannerSystemPrompt,
  buildCoveragePlannerUserPrompt,
  buildFinalScriptSystemPrompt,
  buildFinalScriptUserPrompt,
  buildGroundingRepairPrompt,
  buildWordBudgetRepairPrompt,
  buildReviewerNarrationRepairPrompt,
  buildNarrationJudgeUserPrompt,
  buildSceneOutlineRepairPrompt,
  buildSceneOutlineSystemPrompt,
  buildSceneOutlineUserPrompt,
  type PromptContext,
  type PromptPipelineLlmFamily,
} from "@/infrastructure/llm/promptPipelineV2";
import {
  createCoverageJudge,
  createNarrationQualityJudge,
} from "@/infrastructure/llm/promptPipelineV2Judges";
import {
  type WordBudgetValidationResult,
  validateCoveragePlanConsistency,
  validateSceneOutlineConsistency,
  stripInvalidEvidenceFileRefs,
  validateScriptEvidenceGrounding,
  validateReviewerNarration,
  enforceReviewerNarration,
  validateTotalWordBudget,
} from "@/infrastructure/llm/promptPipelineV2Validators";
import type { ReviewConcern, ReviewPosture } from "@/domain/entities/PromptPipelineV2";
import { tryParseJson, tryValidate, repairLoop, isLlmValidationError, getMaxRepairAttempts, completeJsonWithRepair } from "@/infrastructure/llm/promptPipelineV2Repair";
import {
  computeActualNarrationDurationSeconds,
  computeDurationSecondsFromWordCount,
  computeTotalWordBudgetForMode,
  parseTtsSpeedMultiplier,
} from "@/infrastructure/llm/wordBudget";
import {
  buildDurationGuard,
  formatDurationGuardExceededError,
} from "@/lib/durationGuard";

const logger = createLogger("PromptPipelineV2Runner");

// Shape reminder passed to `repairLoop` for non-VideoScript schemas. The
// default reminder describes the VideoScript shape, which would confuse the
// LLM when repairing a coverage_plan or scene_outline payload — pass these
// as `shapeHint` overrides so the LLM sees the right schema in the repair
// prompt.
const COVERAGE_PLAN_REPAIR_SHAPE_HINT = [
  "Return JSON with this exact shape:",
  "{",
  '  "summary": string,',
  '  "selectedEvidencePolicy": string,',
  '  "clusters": [{ "clusterId": string, "title": string, "files": [string]+, "evidenceSnippets": [{ "filePath": string, "summary": string, "diffExcerpt": string }]+, "technicalMechanism": string, "impact": string, "riskIfAbsent": string, "validationEvidence": [string]+, "importanceRank": number }]+,',
  '  "ledger": [{ "clusterId": string, "disposition": "deep_dive"|"summary"|"omitted_low_priority", "reason": string }]+,',
  '  "majorClusterIds": [string]',
  "}",
  "Arrays marked with + require at least 1 element. Every cluster must have at least one validationEvidence entry naming the test, guard, or invariant.",
].join("\n");

const SCENE_OUTLINE_REPAIR_SHAPE_HINT = [
  "Return JSON with this exact shape:",
  "{",
  '  "scenes": [{ "sceneNumber": number, "sceneType": "overview"|"hook"|"code_walkthrough"|"before_after"|"architecture"|"summary"|"closing", "title": string, "clusterIds": [string], "evidenceFilePaths": [string], "whatChanged": string, "whyItMatters": string, "failureWithoutIt": string, "validation": string, "visualFocus": string }]+',
  "}",
  "scenes must be non-empty.",
].join("\n");

export interface CompleteJsonOptions {
  maxTokens?: number;
  schemaName?: string;
}

export interface PromptPipelineV2Model {
  family: PromptPipelineLlmFamily;
  /** True when completeJson uses native constrained decoding instead of prompt-only schema hints. */
  supportsNativeStructuredOutput?: boolean;
  completeJson<S extends ZodTypeAny>(
    system: string,
    userPrompt: string,
    schema: S,
    options?: CompleteJsonOptions,
  ): Promise<ZodInfer<S>>;
  /** Raw text completion (no schema validation). Used by the repair loop. */
  completeText?(system: string, userPrompt: string, maxTokens?: number): Promise<string>;
}

export interface PromptPipelineV2GenerateInput {
  model: PromptPipelineV2Model;
  context: PRContext;
  analysis: DiffAnalysis;
  validDurations: readonly number[];
}

interface FinalScriptPassResult {
  script: VideoScript;
  narrationJudge?: NarrationJudgeResult;
  scriptValidation: ScriptEvidenceValidationResult;
  scriptEstimatedLength: number;
  narrationJudgePromptLength: number;
}

/** Shared context for narration judge and post-grounding refinement. */
interface RefinementContext {
  context: PRContext;
  analysis: DiffAnalysis;
  approvedCoverage: PromptPipelineV2Artifacts["coveragePlan"];
  sceneOutline: PromptPipelineV2Artifacts["sceneOutline"];
  narrationJudgeRunner: ReturnType<typeof createNarrationQualityJudge>;
}

/**
 * Run the narration quality judge on a candidate script. On failure,
 * logs the error and returns the original script unchanged.
 */
async function runNarrationJudgePass(
  candidateScript: VideoScript,
  ctx: RefinementContext,
): Promise<{ script: VideoScript; narrationJudge?: NarrationJudgeResult }> {
  if (isJudgeSkipped()) {
    return { script: candidateScript };
  }
  try {
    const judged = await ctx.narrationJudgeRunner.judge({
      context: ctx.context,
      analysis: ctx.analysis,
      coveragePlan: ctx.approvedCoverage,
      sceneOutline: ctx.sceneOutline,
      script: candidateScript,
    });
    return { script: judged.script, narrationJudge: judged.result };
  } catch (err) {
    const logLevel = isLlmValidationError(err) ? "warn" : "error";
    logger[logLevel]("Narration judge failed — keeping current script", {
      error: err instanceof Error ? err.message : String(err),
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return { script: candidateScript };
  }
}

/**
 * Stages 5 (narration judge) and 6 (word budget validation), shared
 * between the single-pass and batched generation paths.
 */
async function runStages5And6(input: {
  script: VideoScript;
  model: PromptPipelineV2Model;
  promptContext: PromptContext;
  validDurations: readonly number[];
  refinement: RefinementContext;
  wordBudgetLogPrefix: string;
}): Promise<{
  script: VideoScript;
  narrationJudge?: NarrationJudgeResult;
  wordBudgetValidation: WordBudgetValidationResult;
}> {
  const { model, promptContext, validDurations, refinement, wordBudgetLogPrefix } = input;
  let { script } = input;
  const canRepairWithText = Boolean(model.completeText);

  // Stage 5: Narration judge
  const stage5Start = Date.now();
  let narrationJudge: NarrationJudgeResult | undefined;
  if (isJudgeSkipped()) {
    logger.info("V2 pipeline [5/7]: Skipping narration judge (SKIP_JUDGE=true)");
  } else {
    logger.info("V2 pipeline [5/7]: Running narration judge...");
    ({ script, narrationJudge } = await runNarrationJudgePass(script, refinement));
    if (narrationJudge?.revisedScript) {
      script = recomputeCodeFirstDurations(script);
    }
    logger.info(`V2 pipeline [5/7]: Narration judge complete (${elapsed(stage5Start)}s)`, {
      passed: narrationJudge?.passed ?? "skipped",
      revisedScriptProduced: narrationJudge?.revisedScript !== undefined,
    });
    if (narrationJudge && !narrationJudge.passed) {
      logger.warn("Narration judge did not pass", {
        issues: narrationJudge.issues,
        scores: narrationJudge.scores,
        revisedScriptProduced: narrationJudge.revisedScript !== undefined,
      });
    }
  }

  // Stage 6: Word budget validation
  logger.info("V2 pipeline [6/7]: Validating word budgets...");
  const stage6Start = Date.now();
  const wordBudgetMaxAttempts = canRepairWithText ? getMaxRepairAttempts() : 0;
  const wordBudgetResult = await runWordBudgetRepairPass({
    script,
    model,
    promptContext,
    validDurations,
    maxAttempts: wordBudgetMaxAttempts,
    violationLogMessage: `${wordBudgetLogPrefix} word budgets exceeded — attempting LLM repair`,
    exhaustedLogMessage: `${wordBudgetLogPrefix} word budget violations remain — proceeding with overlong narrations`,
    llmMetricLabel: `${wordBudgetLogPrefix} word budget repair`,
  });
  script = wordBudgetResult.script;
  const wordBudgetValidation = wordBudgetResult.validation;
  logger.info(`V2 pipeline [6/7]: Word budget validation complete (${elapsed(stage6Start)}s)`, {
    passed: wordBudgetValidation.passed,
    violationCount: wordBudgetValidation.violations.length,
  });

  return { script, narrationJudge, wordBudgetValidation };
}

/**
 * Post-grounding refinement: optionally re-runs narration judge after grounding
 * repair, validates grounding failure policy, and runs a final word budget recheck.
 * Shared between single-pass and batched generation paths.
 */
async function runPostGroundingRefinement(input: {
  script: VideoScript;
  narrationJudge?: NarrationJudgeResult;
  scriptValidation: ScriptEvidenceValidationResult;
  groundingRepairApplied: boolean;
  model: PromptPipelineV2Model;
  promptContext: PromptContext;
  validDurations: readonly number[];
  refinement: RefinementContext;
  wordBudgetLogPrefix: string;
  stage7Start: number;
}): Promise<{
  script: VideoScript;
  narrationJudge?: NarrationJudgeResult;
  scriptValidation: ScriptEvidenceValidationResult;
}> {
  const {
    model, promptContext, validDurations, refinement,
    groundingRepairApplied, wordBudgetLogPrefix, stage7Start,
  } = input;
  let { script, narrationJudge, scriptValidation } = input;
  const { approvedCoverage, sceneOutline } = refinement;
  const canRepairWithText = Boolean(model.completeText);
  const wordBudgetMaxAttempts = canRepairWithText ? getMaxRepairAttempts() : 0;

  // Post-grounding narration judge rerun
  if (scriptValidation.passed && groundingRepairApplied && isPostGroundingJudgeEnabled()) {
    const postGroundingJudgeStart = Date.now();
    const rerunResult = await runNarrationJudgePass(script, refinement);
    logger.info(`generateAndRefineScript: post-grounding narration judge rerun complete (${elapsed(postGroundingJudgeStart)}s)`);
    const rerunValidation = validateScriptEvidenceGrounding(
      approvedCoverage, sceneOutline, rerunResult.script,
    );
    if (rerunValidation.passed) {
      script = rerunResult.script;
      script = recomputeCodeFirstDurations(script);
      narrationJudge = rerunResult.narrationJudge;
      scriptValidation = rerunValidation;
    } else {
      logger.warn("Narration judge after grounding repair reintroduced grounding issues — keeping repaired script", {
        issues: rerunValidation.issues,
      });
      narrationJudge = undefined;
      scriptValidation = validateScriptEvidenceGrounding(approvedCoverage, sceneOutline, script);
    }
  } else if (groundingRepairApplied) {
    narrationJudge = undefined;
  }

  logger.info(`V2 pipeline [7/7]: Evidence grounding complete (${elapsed(stage7Start)}s)`, {
    passed: scriptValidation.passed,
    repairApplied: groundingRepairApplied,
  });

  if (!scriptValidation.passed) {
    if (isGroundingFailureWarnOnly()) {
      logger.warn("Script evidence grounding failed — proceeding (GROUNDING_FAILURE_WARN=true)", {
        issues: scriptValidation.issues,
      });
    } else {
      throw new Error(`Prompt Pipeline V2 script validation failed: ${scriptValidation.issues.join(" | ")}`);
    }
  }
  if (scriptValidation.warnings.length > 0) {
    logger.warn("Script evidence grounding warnings (non-fatal)", {
      warnings: scriptValidation.warnings,
    });
  }

  // Final word budget check — grounding repair and post-repair narration judge
  // can rewrite narrations after stage 6 passed, re-exceeding the budget.
  // Non-fatal: TTS extends scene durations to compensate downstream.
  const finalWbStart = Date.now();
  const groundedScript = script;
  const groundedValidation = scriptValidation;
  ({ script } = await runWordBudgetRepairPass({
    script,
    model,
    promptContext,
    validDurations,
    maxAttempts: wordBudgetMaxAttempts,
    violationLogMessage: `Word budgets re-exceeded after grounding/narration rewrites — attempting final LLM repair`,
    exhaustedLogMessage: "Word budgets still exceed actual TTS timing after final repair pass — TTS will compensate",
    llmMetricLabel: `${wordBudgetLogPrefix} final word budget repair`,
  }));
  const finalGroundingValidation = validateScriptEvidenceGrounding(
    approvedCoverage, sceneOutline, script,
  );
  if (!finalGroundingValidation.passed) {
    logger.warn(`Final ${wordBudgetLogPrefix} word budget repair reintroduced grounding issues — keeping last grounded script`, {
      issues: finalGroundingValidation.issues,
    });
    script = groundedScript;
    scriptValidation = groundedValidation;
    const revertedWordBudgets = validateTotalWordBudget(script, promptContext.durationMode);
    if (!revertedWordBudgets.passed) {
      logger.warn(
        "Word budgets still exceed actual TTS timing after final repair pass — TTS will compensate",
        { violations: revertedWordBudgets.violations },
      );
    }
  } else {
    scriptValidation = finalGroundingValidation;
    if (finalGroundingValidation.warnings.length > 0) {
      logger.warn(`Script evidence grounding warnings after final ${wordBudgetLogPrefix} word budget repair (non-fatal)`, {
        warnings: finalGroundingValidation.warnings,
      });
    }
  }
  logger.info(`generateAndRefineScript: final word budget recheck complete (${elapsed(finalWbStart)}s)`);

  return { script, narrationJudge, scriptValidation };
}

function isDefaultMode(durationMode: PRContext["durationMode"] | undefined): boolean {
  return !durationMode || durationMode === "default";
}

function elapsed(startMs: number): string {
  return ((Date.now() - startMs) / 1000).toFixed(1);
}

/** Classify review issue class from free-form risk text using keyword matching. */
const ISSUE_CLASS_KEYWORDS: Array<[ReviewConcern["issueClass"], RegExp]> = [
  ["concurrency", /\b(concurrenc|concurrent|race\s+condition|parallel|simultaneous|atomic|lock|mutex|deadlock|thread[- ]safe)/i],
  ["data_integrity", /\b(data\s+integrity|cascade|orphan|corrupt|inconsisten|foreign\s+key|referential)/i],
  ["security", /\b(security|vulnerab|unauthori[sz]|injection|authenticat|authori[sz]|csrf|xss|credential|phishing|redirect)/i],
  ["regression", /\b(regression|breaks?\b|breaking\b|backward.?compat|existing\s+behaviou?r)/i],
  ["validation_gap", /\b(validation|untested|uncovered|no\s+test|missing\s+test|test\s+coverage|unvalidated)/i],
];

/** Exported for unit testing. */
export function classifyIssueFromText(text: string): ReviewConcern["issueClass"] {
  for (const [issueClass, pattern] of ISSUE_CLASS_KEYWORDS) {
    if (pattern.test(text)) return issueClass;
  }
  return "correctness";
}

/**
 * Recompute each scene's durationSeconds to reflect the actual narration time
 * at the chosen speaking rate (capped at 1.0 × speedMultiplier). The LLM's
 * scripted durations don't account for the speed cap, so narration that is
 * longer than the scene will extend it. This pre-computation ensures the
 * duration mode checks (short/default/popcorn) see the real total.
 *
 * The rate formula mirrors GoogleTTSService.computeSpeakingRate exactly:
 *   cappedRate = min(rawRate, 1.0)
 *   adjusted  = cappedRate × speedMultiplier
 *   clamped   = clamp(round2(adjusted), 0.25, 4.0)
 *
 * Precondition: scene.durationSeconds > 0 (enforced by Zod schema).
 */
export function computeActualSceneDurations(
  script: VideoScript,
  speedMultiplier: number,
  isCodeFirst = false,
): VideoScript {
  // Code-first durations are already derived from word count — no TTS rate adjustment needed.
  if (isCodeFirst) return script;

  const scenes = script.scenes.map((scene) => {
    const wordCount = countSpokenWords(scene.narration);
    if (wordCount === 0) return scene;
    const actualNarrationSeconds = computeActualNarrationDurationSeconds(
      wordCount,
      scene.durationSeconds,
      speedMultiplier,
    );
    // Subtract small epsilon before ceil to avoid float imprecision (e.g. 8.000000001 → 9)
    const adjustedDuration = Math.max(scene.durationSeconds, Math.ceil(actualNarrationSeconds - 1e-9));
    if (adjustedDuration === scene.durationSeconds) return scene;
    return { ...scene, durationSeconds: adjustedDuration };
  });
  const totalDurationSeconds = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  if (totalDurationSeconds === script.totalDurationSeconds) return script;
  logger.info("Scene durations adjusted for speaking rate cap", {
    originalTotal: script.totalDurationSeconds,
    adjustedTotal: totalDurationSeconds,
    adjustedSceneCount: scenes.filter((s, i) => s !== script.scenes[i]).length,
    speedMultiplier,
  });
  return { ...script, scenes, totalDurationSeconds };
}

async function runWordBudgetRepairPass(input: {
  script: VideoScript;
  model: PromptPipelineV2Model;
  promptContext: PromptContext;
  validDurations: readonly number[];
  maxAttempts: number;
  violationLogMessage: string;
  exhaustedLogMessage: string;
  llmMetricLabel: string;
}): Promise<{ script: VideoScript; validation: WordBudgetValidationResult }> {
  const {
    model,
    promptContext,
    validDurations,
    maxAttempts,
    violationLogMessage,
    exhaustedLogMessage,
    llmMetricLabel,
  } = input;

  let script = input.script;

  const validate = (s: VideoScript) => validateTotalWordBudget(s, promptContext.durationMode);

  let validation = validate(script);
  for (
    let attempt = 1;
    attempt <= maxAttempts && !validation.passed && model.completeText;
    attempt++
  ) {
    logger.warn(violationLogMessage, {
      attempt,
      maxAttempts,
      violations: validation.violations,
    });
    const repairStart = Date.now();
    const repairRaw = await model.completeText(
      buildFinalScriptSystemPrompt(promptContext, validDurations),
      buildWordBudgetRepairPrompt(
        model.family,
        JSON.stringify(script, null, 2),
        validation.repairMessage,
      ),
      12288,
    );
    logger.info(`generateAndRefineScript: ${llmMetricLabel} LLM call complete (${elapsed(repairStart)}s)`, {
      attempt,
    });
    const repairSchema = videoScriptTransportSchema;
    let parseResult;
    try {
      parseResult = tryParseJson(repairRaw, repairSchema);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      logger.warn("Word budget repair returned unparseable JSON — skipping", {
        attempt,
        error: err.message,
      });
      continue;
    }
    if (!parseResult.success) {
      logger.warn("Word budget repair returned invalid script — skipping", {
        attempt,
        errors: parseResult.zodError?.issues.map((i) => i.message).slice(0, 5),
      });
      continue;
    }
    script = deriveScriptFromTransport(parseResult.data);
    // Re-derive durations after repair (narration may have changed)
    script = recomputeCodeFirstDurations(script);
    validation = validate(script);
  }

  if (!validation.passed) {
    logger.warn(exhaustedLogMessage, {
      violations: validation.violations,
    });
  }

  return { script, validation };
}

async function generateAndRefineScript(input: {
  model: PromptPipelineV2Model;
  promptContext: PromptContext;
  context: PRContext;
  analysis: DiffAnalysis;
  approvedCoverage: PromptPipelineV2Artifacts["coveragePlan"];
  sceneOutline: PromptPipelineV2Artifacts["sceneOutline"];
  validDurations: readonly number[];
  narrationJudgeRunner: ReturnType<typeof createNarrationQualityJudge>;
}): Promise<FinalScriptPassResult> {
  const {
    model,
    promptContext,
    context,
    analysis,
    approvedCoverage,
    sceneOutline,
    validDurations,
    narrationJudgeRunner,
  } = input;
  let script: VideoScript;
  const canRepairWithText = Boolean(model.completeText);
  const scriptGenStart = Date.now();
  if (model.supportsNativeStructuredOutput) {
    // Native structured output path: completeJson throws
    // `StructuredOutputValidationError` on Zod failure. `completeJsonWithRepair`
    // catches it and runs `repairLoop` against the original ZodError. (The
    // older `tryValidate` + `repairLoop` pattern that used to live here was
    // dead: completeJson either rejected with a plain Error that bypassed
    // tryValidate entirely, or resolved with an already-Zod-validated value,
    // in which case the re-validate always succeeded and repair never fired.)
    const transportScript = await completeJsonWithRepair({
      model,
      system: buildFinalScriptSystemPrompt(promptContext, validDurations),
      userPrompt: buildFinalScriptUserPrompt(
        model.family,
        context,
        analysis,
        approvedCoverage,
        sceneOutline,
      ),
      schema: videoScriptTransportSchema,
      options: { maxTokens: 12288, schemaName: "video_script" },
      repair: {
        ...(model.completeText !== undefined ? { completeText: model.completeText } : {}),
        promptContext,
        validDurations,
        label: "final_script",
      },
    });
    script = deriveScriptFromTransport(transportScript);
  } else if (canRepairWithText && model.completeText) {
    // Use raw text generation only when native structured output is unavailable.
    const scriptRaw = await model.completeText(
      buildFinalScriptSystemPrompt(promptContext, validDurations),
      buildFinalScriptUserPrompt(
        model.family,
        context,
        analysis,
        approvedCoverage,
        sceneOutline,
      ),
      12288,
    );
    const parseSchema = videoScriptTransportSchema;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- transport/full schema union handled via deriveScriptFromTransport below
    let parseResult: import("@/infrastructure/llm/promptPipelineV2Repair").ParseResult<any>;
    try {
      parseResult = tryParseJson(scriptRaw, parseSchema);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      logger.error("final_script: LLM returned unparseable text (not JSON)", {
        rawPreview: scriptRaw.slice(0, 500),
        error: err.message,
      });
      throw new Error(`Final script generation returned unparseable text: ${err.message}`);
    }
    if (!parseResult.success) {
      parseResult = await repairLoop(parseResult, parseSchema, {
        completeText: model.completeText,
        promptContext,
        validDurations,
        label: "final_script",
      });
    }
    if (!parseResult.success) throw parseResult.zodError;
    script = deriveScriptFromTransport(parseResult.data);
  } else {
    // Fallback: structured output with no repair capability
    const fallbackSchema = videoScriptTransportSchema;
    const fallbackOutput = await model.completeJson(
      buildFinalScriptSystemPrompt(promptContext, validDurations),
      buildFinalScriptUserPrompt(
        model.family,
        context,
        analysis,
        approvedCoverage,
        sceneOutline,
      ),
      fallbackSchema,
      { maxTokens: 12288, schemaName: "video_script" },
    );
    script = deriveScriptFromTransport(fallbackOutput);
  }
  logger.info(`generateAndRefineScript: LLM script generation complete (${elapsed(scriptGenStart)}s)`);

  const refinement: RefinementContext = {
    context, analysis, approvedCoverage, sceneOutline, narrationJudgeRunner,
  };

  // Recompute durationSeconds from narration word count before validation
  script = recomputeCodeFirstDurations(script);

  // Stages 5 + 6: narration judge + word budget validation
  let narrationJudge: NarrationJudgeResult | undefined;
  ({ script, narrationJudge } = await runStages5And6({
    script, model, promptContext, validDurations, refinement,
    wordBudgetLogPrefix: "Scene",
  }));

  // Stage 7: evidence grounding with single-pass repair
  logger.info("V2 pipeline [7/7]: Validating evidence grounding...");
  const stage7Start = Date.now();
  let scriptValidation = validateScriptEvidenceGrounding(
    approvedCoverage, sceneOutline, script,
  );

  const groundingMaxAttempts = canRepairWithText ? getMaxRepairAttempts() : 0;
  let groundingRepairApplied = false;
  for (
    let groundingAttempt = 1;
    groundingAttempt <= groundingMaxAttempts && !scriptValidation.passed && model.completeText;
    groundingAttempt++
  ) {
    logger.warn("Script evidence grounding failed — attempting LLM repair", {
      attempt: groundingAttempt,
      maxAttempts: groundingMaxAttempts,
      issues: scriptValidation.issues,
    });
    const grRepairStart = Date.now();
    const repairRaw = await model.completeText(
      buildFinalScriptSystemPrompt(promptContext, validDurations),
      buildGroundingRepairPrompt(
        model.family,
        JSON.stringify(script, null, 2),
        scriptValidation,
        sceneOutline,
        approvedCoverage,
      ),
      12288,
    );
    logger.info(`generateAndRefineScript: grounding repair LLM call complete (${elapsed(grRepairStart)}s)`, {
      attempt: groundingAttempt,
    });
    const groundingRepairSchema = videoScriptTransportSchema;
    let parseResult;
    try {
      parseResult = tryParseJson(repairRaw, groundingRepairSchema);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      logger.warn("Grounding repair attempt returned unparseable JSON — skipping", {
        attempt: groundingAttempt,
        error: err.message,
      });
      continue;
    }
    if (!parseResult.success) {
      logger.warn("Grounding repair attempt returned schema-invalid script — skipping", {
        attempt: groundingAttempt,
      });
      continue;
    }
    groundingRepairApplied = true;
    script = deriveScriptFromTransport(parseResult.data);
    script = recomputeCodeFirstDurations(script);
    scriptValidation = validateScriptEvidenceGrounding(approvedCoverage, sceneOutline, script);
  }

  // Post-grounding refinement: narration judge rerun + final word budget recheck
  ({ script, narrationJudge, scriptValidation } = await runPostGroundingRefinement({
    script, narrationJudge, scriptValidation, groundingRepairApplied,
    model, promptContext, validDurations, refinement,
    wordBudgetLogPrefix: "", stage7Start,
  }));

  return {
    script,
    narrationJudge,
    scriptValidation,
    scriptEstimatedLength: JSON.stringify(script).length,
    narrationJudgePromptLength: buildNarrationJudgeUserPrompt(
      model.family, approvedCoverage, sceneOutline, script, validDurations,
      { durationMode: promptContext.durationMode },
    ).length,
  };
}

// ── Batched scene generation ──────────────────────────────────────────

/** Partition outline scenes: overview scene alone, remaining in groups of `batchSize`. */
function partitionIntoBatches(
  sceneOutline: PromptPipelineV2Artifacts["sceneOutline"],
  batchSize = 3,
): SceneIntent[][] {
  const scenes = sceneOutline.scenes;
  const overviewScene = scenes.find((s) => s.sceneType === "overview");
  const remaining = scenes.filter((s) => s !== overviewScene);

  const batches: SceneIntent[][] = [];
  if (overviewScene) batches.push([overviewScene]);
  for (let i = 0; i < remaining.length; i += batchSize) {
    batches.push(remaining.slice(i, i + batchSize));
  }
  return batches;
}

/** Extract only the clusters referenced by a batch's clusterIds. */
function getClustersForBatch(
  batch: SceneIntent[],
  coveragePlan: CoveragePlan,
): CoveragePlan["clusters"] {
  const neededIds = new Set(batch.flatMap((s) => s.clusterIds));
  return coveragePlan.clusters.filter((c) => neededIds.has(c.clusterId));
}

/** Identify batch indices that contain scenes flagged by evidence grounding. */
function identifyFailingBatchIndices(
  validation: ScriptEvidenceValidationResult,
  batches: SceneIntent[][],
): number[] {
  const failingSceneNumbers = new Set([
    ...validation.unknownFileReferences.map((r) => r.sceneNumber),
    ...validation.unknownBacktickReferences.map((r) => r.sceneNumber),
    ...validation.invalidCodeBrollFileRefs.map((r) => r.sceneNumber),
    ...validation.unmappedSceneNumbers,
    ...validation.missingOutlineSceneNumbers,
  ]);
  return batches
    .map((batch, index) => ({ batch, index }))
    .filter(({ batch }) => batch.some((s) => failingSceneNumbers.has(s.sceneNumber)))
    .map(({ index }) => index);
}

/**
 * Rebuild envelope metadata (keyFiles, tags, summary) from ALL scenes + the
 * coverage plan, since batch 0's envelope only saw overview-scene context.
 *
 * - keyFiles: union of codeBroll file paths and coverage plan files
 * - tags: deduplicated cluster titles from the coverage plan
 * - summary: the coverage plan summary (describes the full PR, not just the overview)
 * - totalWordCount: recomputed from all scenes
 */
function rebuildEnvelopeFromAllBatches(
  scriptEnvelope: VideoScript,
  allScenes: Scene[],
  approvedCoverage: CoveragePlan,
): Record<string, unknown> {
  const codeBrollFiles = allScenes
    .flatMap((s) => s.codeBroll.map((cb) => cb.filePath))
    .filter((fp): fp is string => Boolean(fp));
  const includedClusterIds = new Set(
    approvedCoverage.ledger
      .filter((l) => l.disposition !== "omitted_low_priority")
      .map((l) => l.clusterId),
  );
  const coverageFiles = approvedCoverage.clusters
    .filter((c) => includedClusterIds.has(c.clusterId))
    .flatMap((c) => c.files);
  const allKeyFiles = [...new Set([...codeBrollFiles, ...coverageFiles])];

  const allTags = [...new Set(
    approvedCoverage.clusters
      .filter((c) => includedClusterIds.has(c.clusterId))
      .map((c) => c.title),
  )];

  return {
    ...(scriptEnvelope as unknown as Record<string, unknown>),
    scenes: allScenes,
    keyFiles: allKeyFiles,
    tags: allTags,
    summary: approvedCoverage.summary,
    totalWordCount: allScenes.reduce(
      (sum, s) => sum + countSpokenWords(s.narration), 0,
    ),
  };
}

export function deriveScriptFromTransport(transport: ZodInfer<typeof videoScriptTransportSchema>): VideoScript {
  const scenes = transport.scenes;
  return {
    ...transport,
    scenes,
    totalDurationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
    totalWordCount: scenes.reduce((sum, scene) => sum + countSpokenWords(scene.narration), 0),
  };
}

// Re-export from the domain entity for backward compatibility with existing imports.
export { ensureLastSceneOverview } from "@/domain/entities/VideoScript";

export function normalizeBatchedScenesFromOutline(
  scenes: Scene[],
  sceneOutline: PromptPipelineV2Artifacts["sceneOutline"],
): Scene[] {
  const outlineSceneTypes = new Map(
    sceneOutline.scenes.map((scene) => [scene.sceneNumber, scene.sceneType]),
  );
  let normalizedTypeCount = 0;
  const normalized = [...scenes]
    .sort((a, b) => a.sceneNumber - b.sceneNumber)
    .map((scene) => {
      const outlineType = outlineSceneTypes.get(scene.sceneNumber);
      if (outlineType && outlineType !== scene.sceneType) {
        normalizedTypeCount++;
        return { ...scene, sceneType: outlineType };
      }
      return scene;
    });

  if (normalizedTypeCount > 0) {
    logger.warn("Normalized batched scene types from validated outline", {
      normalizedTypeCount,
    });
  }

  return normalized;
}

/**
 * Generate the final script in small sequential batches (2-3 scenes each) instead
 * of a single monolithic LLM call. This dramatically reduces context pressure on
 * the LLM, preventing dropped scenes and misattributed file paths.
 *
 * The first batch uses `batchEnvelopeTransportSchema` to produce the full envelope
 * (keyFiles, tags, etc.) plus the overview scene. Subsequent
 * batches use `batchScenesSchema` to produce only scenes. All batches are assembled
 * into a single VideoScript that is then validated by the same pipeline (narration
 * judge, evidence grounding) as the single-pass approach.
 */
async function runBatchedFinalScriptPass(input: {
  model: PromptPipelineV2Model;
  promptContext: PromptContext;
  context: PRContext;
  analysis: DiffAnalysis;
  approvedCoverage: PromptPipelineV2Artifacts["coveragePlan"];
  sceneOutline: PromptPipelineV2Artifacts["sceneOutline"];
  validDurations: readonly number[];
  narrationJudgeRunner: ReturnType<typeof createNarrationQualityJudge>;
}): Promise<FinalScriptPassResult> {
  const {
    model, promptContext, context, analysis,
    approvedCoverage, sceneOutline, validDurations, narrationJudgeRunner,
  } = input;

  const batches = partitionIntoBatches(sceneOutline);
  logger.info("Batched scene generation: partitioned outline", {
    totalScenes: sceneOutline.scenes.length,
    batchCount: batches.length,
    batchSizes: batches.map((b) => b.length),
  });

  // Shape hints for batch repair prompts (avoid the default full-VideoScript shape)
  const durField = "number";
  const batchScenesShapeHint = `Return ONLY raw JSON (no markdown fences) matching: { "scenes": [{ "sceneNumber": number, "sceneType": "overview"|"hook"|"code_walkthrough"|"before_after"|"architecture"|"summary"|"closing", "durationSeconds": ${durField}, "narration": string, "productionAudio"?: string, "codeBroll"?: [{ "filePath": string, "code": string, "language": string, "lineRange"?: [number,number]|null, "highlights"?: number[] }] }] }`;
  const batchEnvelopeShapeHint = `Return ONLY raw JSON (no markdown fences) matching: { "changeType": string, "summary": string, "scenes": [{ "sceneNumber": number, "sceneType": string, "durationSeconds": ${durField}, "narration": string, "codeBroll"?: [] }], "totalWordCount": number, "keyFiles": string[], "tags": string[] }`;

  // ── Phase 1: Generate each batch sequentially ────────────────────────
  let scriptEnvelope: VideoScript | null = null;
  const allScenes: Scene[] = [];
  let lastNarration: string | null = null;
  const canRepairWithText = Boolean(model.completeText);
  const totalWordBudget = computeTotalWordBudgetForMode(promptContext.durationMode).maxWords;
  let wordsUsed = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const isFirst = batchIdx === 0;
    const batchClusters = getClustersForBatch(batch, approvedCoverage);
    const sceneNumbers = batch.map((s) => s.sceneNumber).join(", ");
    const remainingScenes = sceneOutline.scenes.length - allScenes.length;
    const wordBudgetContext = totalWordBudget !== undefined
      ? (() => {
        const remainingWords = Math.max(0, totalWordBudget - wordsUsed);
        const batchWordBudget = remainingScenes <= batch.length
          ? remainingWords
          : Math.min(
            remainingWords,
            Math.max(
              batch.length,
              Math.floor((remainingWords * batch.length) / Math.max(remainingScenes, 1)),
            ),
          );
        return {
          remainingWords,
          remainingScenes,
          batchWordBudget,
          reserveWords: Math.max(0, remainingWords - batchWordBudget),
        };
      })()
      : undefined;

    logger.info(`Generating batch ${batchIdx + 1}/${batches.length}: scenes ${sceneNumbers}`, {
      batchIndex: batchIdx,
      sceneCount: batch.length,
      clusterCount: batchClusters.length,
      isFirstBatch: isFirst,
      ...(wordBudgetContext
        ? {
          wordsRemaining: wordBudgetContext.remainingWords,
          scenesRemaining: wordBudgetContext.remainingScenes,
          batchWordBudget: wordBudgetContext.batchWordBudget,
        }
        : {}),
    });

    const systemPrompt = buildBatchScriptSystemPrompt(promptContext, validDurations, isFirst);
    const userPrompt = buildBatchScriptUserPrompt(
      model.family, context, analysis, batchClusters, batch, lastNarration, isFirst,
      wordBudgetContext,
    );

    const scenesBeforeBatch = allScenes.length;

    if (isFirst) {
      // First batch: envelope schema (allows 1 scene) → gets envelope fields + overview scene
      // Native structured-output Zod failures route through completeJsonWithRepair
      // → repairLoop instead of crashing the whole batched pipeline.
      const transportScript = await completeJsonWithRepair({
        model,
        system: systemPrompt,
        userPrompt,
        schema: batchEnvelopeTransportSchema,
        options: { maxTokens: 8192, schemaName: "batch_envelope" },
        repair: {
          ...(model.completeText !== undefined ? { completeText: model.completeText } : {}),
          promptContext,
          validDurations,
          label: "batch_0_script",
          shapeHint: batchEnvelopeShapeHint,
          systemPrompt,
        },
      });
      scriptEnvelope = transportScript as unknown as VideoScript;
      // Only accept scenes the batch was asked to produce (prevents model from
      // emitting later scenes that would duplicate with subsequent batches).
      const requestedSceneNumbers = new Set(batch.map((s) => s.sceneNumber));
      const envelopeScenes = (scriptEnvelope as unknown as { scenes: Scene[] }).scenes;
      const acceptedScenes = envelopeScenes.filter((s) => requestedSceneNumbers.has(s.sceneNumber));
      if (acceptedScenes.length < envelopeScenes.length) {
        logger.warn("Batch 0 returned extra scenes beyond requested set — trimming", {
          requested: [...requestedSceneNumbers],
          returned: envelopeScenes.map((s) => s.sceneNumber),
          accepted: acceptedScenes.map((s) => s.sceneNumber),
        });
      }
      allScenes.push(...acceptedScenes);
    } else {
      // Subsequent batches: lightweight batch schema → only scenes
      const batchOutput = await completeJsonWithRepair({
        model,
        system: systemPrompt,
        userPrompt,
        schema: batchScenesTransportSchema,
        options: { maxTokens: 6144, schemaName: "batch_scenes" },
        repair: {
          ...(model.completeText !== undefined ? { completeText: model.completeText } : {}),
          promptContext,
          validDurations,
          label: `batch_${batchIdx}_scenes`,
          shapeHint: batchScenesShapeHint,
          systemPrompt,
        },
      });
      // Only accept scenes this batch was asked to produce
      const requestedSceneNumbers = new Set(batch.map((s) => s.sceneNumber));
      const batchScenes = batchOutput.scenes.filter(
        (s: Scene) => requestedSceneNumbers.has(s.sceneNumber),
      );
      if (batchScenes.length < batchOutput.scenes.length) {
        logger.warn(`Batch ${batchIdx} returned extra scenes beyond requested set — trimming`, {
          requested: [...requestedSceneNumbers],
          returned: batchOutput.scenes.map((s: Scene) => s.sceneNumber),
        });
      }
      allScenes.push(...batchScenes);
    }

    // Overwrite LLM duration estimates with deterministic values derived from
    // narration word count, and track cumulative word usage for budget enforcement.
    // Use scenesBeforeBatch (captured before push) to iterate only newly added scenes.
    for (let i = scenesBeforeBatch; i < allScenes.length; i++) {
      const wordCount = countSpokenWords(allScenes[i].narration);
      wordsUsed += wordCount;
      if (wordCount > 0) {
        allScenes[i] = { ...allScenes[i], durationSeconds: computeDurationSecondsFromWordCount(wordCount) };
      }
    }

    // Track last narration for continuity seed
    const lastScene = allScenes[allScenes.length - 1];
    if (lastScene) {
      lastNarration = lastScene.narration.slice(-200);
    }

    logger.debug(`Batch ${batchIdx + 1} complete`, {
      scenesGenerated: batch.length,
      totalScenesAccumulated: allScenes.length,
    });
  }

  if (!scriptEnvelope) throw new Error("Batched generation produced no script envelope");

  // ── Phase 2: Assemble full VideoScript ───────────────────────────────
  // Rebuild envelope metadata from ALL batches + coverage plan (batch 0
  // only saw overview context, so its summary/keyFiles/tags are incomplete).
  const normalizedScenes = normalizeBatchedScenesFromOutline(allScenes, sceneOutline);
  const assembledTransport = rebuildEnvelopeFromAllBatches(
    scriptEnvelope, normalizedScenes, approvedCoverage,
  );
  // Durations already overwritten per-batch above. Recompute totalDurationSeconds
  // on the transport object BEFORE schema validation so the 320s max check sees
  // the correct total.
  (assembledTransport as Record<string, unknown>).totalDurationSeconds =
    normalizedScenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const assembledTransportResult = tryValidate(assembledTransport, videoScriptTransportSchema);
  if (!assembledTransportResult.success) {
    logger.warn("Assembled batched script failed full schema validation", {
      errors: assembledTransportResult.zodError?.issues.map((i) => i.message),
    });
    throw assembledTransportResult.zodError;
  }
  let assembledCandidate = deriveScriptFromTransport(assembledTransportResult.data);

  const preSchemaWordBudgetAttempts = canRepairWithText ? getMaxRepairAttempts() : 0;
  ({ script: assembledCandidate } = await runWordBudgetRepairPass({
    script: assembledCandidate,
    model,
    promptContext,
    validDurations,
    maxAttempts: preSchemaWordBudgetAttempts,
    violationLogMessage: "Batched assembled script exceeds word budget — attempting repair before full validation",
    exhaustedLogMessage: "Batched assembled script still exceeds word budget before full validation",
    llmMetricLabel: "batched pre-schema word budget repair",
  }));

  let assembledParseResult = tryValidate(assembledCandidate, videoScriptSchema);
  if (!assembledParseResult.success && canRepairWithText && model.completeText) {
    assembledParseResult = await repairLoop(assembledParseResult, videoScriptSchema, {
      completeText: model.completeText,
      promptContext,
      validDurations,
      label: "batched_assembled_script",
    });
  }
  if (!assembledParseResult.success) {
    logger.warn("Assembled batched script failed full schema validation", {
      errors: assembledParseResult.zodError?.issues.map((i) => i.message),
    });
    throw assembledParseResult.zodError;
  }
  let script: VideoScript = assembledParseResult.data;

  logger.info("Batched script assembled", {
    totalScenes: script.scenes.length,
    totalDurationSeconds: script.totalDurationSeconds,
    totalWordCount: script.totalWordCount,
  });

  const refinement: RefinementContext = {
    context, analysis, approvedCoverage, sceneOutline, narrationJudgeRunner,
  };

  // ── Phase 3: Stages 5 + 6 (narration judge + word budget validation) ──
  let narrationJudge: NarrationJudgeResult | undefined;
  ({ script, narrationJudge } = await runStages5And6({
    script, model, promptContext, validDurations, refinement,
    wordBudgetLogPrefix: "Batched script",
  }));

  // ── Phase 4: Evidence grounding (with per-batch targeted repair) ─────
  // Sync both allScenes and scriptEnvelope from the current script (which has
  // been through narration judge + word budget repair) so grounding repair
  // splices into the latest state rather than reverting non-failing scenes to
  // stale phase-1 text or overwriting judged envelope fields (narrativeRoles,
  // voiceAssignments).
  allScenes.length = 0;
  allScenes.push(...script.scenes);
  scriptEnvelope = script;

  logger.info("V2 pipeline [7/7]: Validating evidence grounding...");
  const stage7Start = Date.now();
  let scriptValidation = validateScriptEvidenceGrounding(approvedCoverage, sceneOutline, script);

  const groundingMaxAttempts = canRepairWithText ? getMaxRepairAttempts() : 0;
  let groundingRepairApplied = false;
  for (
    let groundingAttempt = 1;
    groundingAttempt <= groundingMaxAttempts && !scriptValidation.passed && model.completeText;
    groundingAttempt++
  ) {
    const failingIndices = identifyFailingBatchIndices(scriptValidation, batches);
    logger.warn("Batched script evidence grounding failed — re-generating failing batches", {
      attempt: groundingAttempt,
      maxAttempts: groundingMaxAttempts,
      failingBatches: failingIndices,
      issues: scriptValidation.issues,
    });

    // Re-generate only the failing batches
    for (const batchIdx of failingIndices) {
      const batch = batches[batchIdx];
      const isFirst = batchIdx === 0;
      const batchClusters = getClustersForBatch(batch, approvedCoverage);
      const prevBatchLastScene = batchIdx > 0 ? allScenes.find(
        (s) => s.sceneNumber === batches[batchIdx - 1][batches[batchIdx - 1].length - 1].sceneNumber,
      ) : null;

      const systemPrompt = buildBatchScriptSystemPrompt(promptContext, validDurations, isFirst);
      const userPrompt = buildBatchScriptUserPrompt(
        model.family, context, analysis, batchClusters, batch,
        prevBatchLastScene?.narration.slice(-200) ?? null, isFirst,
      );

      try {
        if (isFirst) {
          const transportScript = await model.completeJson(
            systemPrompt, userPrompt, batchEnvelopeTransportSchema,
            { maxTokens: 8192, schemaName: "batch_envelope" },
          );
          const parseResult = tryValidate(transportScript, batchEnvelopeTransportSchema);
          if (!parseResult.success) {
            logger.warn(`Batch ${batchIdx} re-generation produced schema-invalid output — skipping`, {
              attempt: groundingAttempt,
              batchIndex: batchIdx,
              errors: parseResult.zodError?.issues.map((i) => i.message),
            });
            continue;
          }
          const repairedEnvelope = parseResult.data as unknown as VideoScript;
          // Persist the repaired envelope (keyFiles, tags, etc.)
          // so reassembly uses corrected top-level fields, not the stale batch-0 original.
          scriptEnvelope = repairedEnvelope;
          const repairedScenes = (repairedEnvelope as unknown as { scenes: Scene[] }).scenes;
          const batchSceneNumbers = new Set(batch.map((s) => s.sceneNumber));
          const filtered = allScenes.filter((s) => !batchSceneNumbers.has(s.sceneNumber));
          filtered.push(...repairedScenes.filter((s) => batchSceneNumbers.has(s.sceneNumber)));
          filtered.sort((a, b) => a.sceneNumber - b.sceneNumber);
          allScenes.length = 0;
          allScenes.push(...filtered);
          // Recompute durations for re-generated scenes
          for (let i = 0; i < allScenes.length; i++) {
            if (!batchSceneNumbers.has(allScenes[i].sceneNumber)) continue;
            const wc = countSpokenWords(allScenes[i].narration);
            if (wc > 0) allScenes[i] = { ...allScenes[i], durationSeconds: computeDurationSecondsFromWordCount(wc) };
          }
          groundingRepairApplied = true;
        } else {
          const batchOutput = await model.completeJson(
            systemPrompt, userPrompt, batchScenesTransportSchema,
            { maxTokens: 6144, schemaName: "batch_scenes" },
          );
          const parseResult = tryValidate(batchOutput, batchScenesTransportSchema);
          if (!parseResult.success) {
            logger.warn(`Batch ${batchIdx} re-generation produced schema-invalid output — skipping`, {
              attempt: groundingAttempt,
              batchIndex: batchIdx,
              errors: parseResult.zodError?.issues.map((i) => i.message),
            });
            continue;
          }
          const batchSceneNumbers = new Set(batch.map((s) => s.sceneNumber));
          const filtered = allScenes.filter((s) => !batchSceneNumbers.has(s.sceneNumber));
          // Only accept scenes this batch was asked to produce
          const repairedBatchScenes = parseResult.data.scenes.filter(
            (s: Scene) => batchSceneNumbers.has(s.sceneNumber),
          );
          filtered.push(...repairedBatchScenes);
          filtered.sort((a, b) => a.sceneNumber - b.sceneNumber);
          allScenes.length = 0;
          allScenes.push(...filtered);
          // Recompute durations for re-generated scenes
          for (let i = 0; i < allScenes.length; i++) {
            if (!batchSceneNumbers.has(allScenes[i].sceneNumber)) continue;
            const wc = countSpokenWords(allScenes[i].narration);
            if (wc > 0) allScenes[i] = { ...allScenes[i], durationSeconds: computeDurationSecondsFromWordCount(wc) };
          }
          groundingRepairApplied = true;
        }
      } catch (err) {
        if (!isLlmValidationError(err)) {
          // Infrastructure error (network, auth, rate limit) — further attempts
          // will likely fail too. Re-throw to fail fast with the real cause.
          logger.error(`Batch ${batchIdx} re-generation failed with infrastructure error — aborting repair`, {
            error: err instanceof Error ? err.message : String(err),
            errorType: err instanceof Error ? err.name : typeof err,
          });
          throw err;
        }
        logger.warn(`Batch ${batchIdx} re-generation failed with validation error — skipping`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    // Re-assemble and re-validate (uses latest scriptEnvelope, which may
    // have been updated by a batch-0 grounding repair above)
    const reAssembled = rebuildEnvelopeFromAllBatches(
      scriptEnvelope, allScenes, approvedCoverage,
    );
    (reAssembled as Record<string, unknown>).totalDurationSeconds =
      allScenes.reduce((sum, s) => sum + s.durationSeconds, 0);
    (reAssembled as Record<string, unknown>).totalWordCount =
      allScenes.reduce((sum, s) => sum + countSpokenWords(s.narration), 0);
    const reParseSchema = videoScriptTransportSchema;
    const reParse = tryValidate(reAssembled, reParseSchema);
    if (reParse.success) {
      script = deriveScriptFromTransport(reParse.data);
      scriptValidation = validateScriptEvidenceGrounding(approvedCoverage, sceneOutline, script);
    } else {
      // Re-assembly is schema-invalid (e.g., duration out of bounds) — further
      // repair attempts will produce the same structural issue. Break early.
      logger.warn("Re-assembled batched script failed full schema validation after grounding repair — stopping repair", {
        attempt: groundingAttempt,
        errors: reParse.zodError?.issues.map((i) => i.message),
      });
      break;
    }
  }

  // Post-grounding refinement: narration judge rerun + final word budget recheck
  ({ script, narrationJudge, scriptValidation } = await runPostGroundingRefinement({
    script, narrationJudge, scriptValidation, groundingRepairApplied,
    model, promptContext, validDurations, refinement,
    wordBudgetLogPrefix: "batched", stage7Start,
  }));

  return {
    script,
    narrationJudge,
    scriptValidation,
    scriptEstimatedLength: JSON.stringify(script).length,
    narrationJudgePromptLength: buildNarrationJudgeUserPrompt(
      model.family, approvedCoverage, sceneOutline, script, validDurations,
      { durationMode: promptContext.durationMode },
    ).length,
  };
}

/**
 * Recompute `durationSeconds` on every scene from its narration word count.
 * Code-first scenes have no fixed clip durations — duration = narration length.
 */
export function recomputeCodeFirstDurations(script: VideoScript, speedMultiplier = parseTtsSpeedMultiplier()): VideoScript {
  const scenes = script.scenes.map((scene) => {
    const wordCount = countSpokenWords(scene.narration);
    if (wordCount === 0) {
      logger.warn("Code-first scene has empty narration — preserving original duration", {
        sceneNumber: scene.sceneNumber,
        originalDurationSeconds: scene.durationSeconds,
      });
      return scene;
    }
    return { ...scene, durationSeconds: computeDurationSecondsFromWordCount(wordCount, speedMultiplier) };
  });
  const totalDurationSeconds = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  return { ...script, scenes, totalDurationSeconds };
}

export async function generateScriptWithPromptPipelineV2(
  input: PromptPipelineV2GenerateInput,
): Promise<ScriptWriterResult> {
  const { model, context, analysis, validDurations } = input;
  const promptContext: PromptContext = {
    family: model.family,
    durationMode: context.durationMode,
    deepdive: context.deepdive,
  };

  logger.info("Running Prompt Pipeline V2", {
    family: model.family,
    repo: context.repoFullName,
    pr: context.prNumber,
    durationMode: context.durationMode,
    deepdive: context.deepdive,
  });

  logger.info("V2 pipeline [1/7]: Running coverage planner...");
  const stage1Start = Date.now();
  const coveragePlannerSystemPrompt = buildCoveragePlannerSystemPrompt(promptContext);
  const plannedCoverage = await completeJsonWithRepair({
    model,
    system: coveragePlannerSystemPrompt,
    userPrompt: buildCoveragePlannerUserPrompt(
      promptContext,
      context,
      analysis,
      context.durationMode,
    ),
    schema: coveragePlanSchema,
    options: { maxTokens: 8192, schemaName: "coverage_plan" },
    // Retry-with-feedback: a single malformed cluster (e.g. empty
    // validationEvidence array, missing required field) used to kill the
    // entire 7-stage job. With repair, the LLM gets a chance to fix the
    // specific Zod errors and return corrected JSON before we give up.
    repair: {
      ...(model.completeText !== undefined ? { completeText: model.completeText } : {}),
      promptContext,
      validDurations,
      label: "coverage_plan",
      systemPrompt: coveragePlannerSystemPrompt,
      shapeHint: COVERAGE_PLAN_REPAIR_SHAPE_HINT,
    },
  });
  logger.info(`V2 pipeline [1/7]: Coverage planner complete (${elapsed(stage1Start)}s)`, {
    clusterCount: plannedCoverage.clusters.length,
    majorClusterCount: plannedCoverage.majorClusterIds.length,
  });
  const coverageJudgeRunner = createCoverageJudge(model);
  const narrationJudgeRunner = createNarrationQualityJudge(model, validDurations);
  const skipJudges = isJudgeSkipped();

  const stage2Start = Date.now();
  let coverageJudge = undefined;
  let approvedCoverage = plannedCoverage;
  if (skipJudges) {
    logger.info("V2 pipeline [2/7]: Skipping coverage judge (SKIP_JUDGE=true)");
  } else {
    logger.info("V2 pipeline [2/7]: Running coverage judge...");
    try {
      const judgedCoverage = await coverageJudgeRunner.judge({
        context,
        analysis,
        coveragePlan: plannedCoverage,
      });
      coverageJudge = judgedCoverage.result;
      approvedCoverage = judgedCoverage.coveragePlan;
    } catch (err) {
      const logLevel = isLlmValidationError(err) ? "warn" : "error";
      logger[logLevel]("Coverage judge failed — keeping planner output", {
        error: err instanceof Error ? err.message : String(err),
        errorType: err instanceof Error ? err.name : typeof err,
      });
    }
    logger.info(`V2 pipeline [2/7]: Coverage judge complete (${elapsed(stage2Start)}s)`, {
      passed: coverageJudge?.passed ?? "skipped",
    });
  }
  // Auto-fix: strip ledger entries referencing clusters the LLM didn't define.
  // These are harmless no-ops downstream but fail consistency validation.
  const knownClusterIds = new Set(approvedCoverage.clusters.map((c) => c.clusterId));
  const unknownLedgerEntries = approvedCoverage.ledger.filter((e) => !knownClusterIds.has(e.clusterId));
  if (unknownLedgerEntries.length > 0) {
    logger.warn("Auto-stripped unknown cluster references from coverage ledger", {
      unknownClusterIds: unknownLedgerEntries.map((e) => e.clusterId),
    });
    approvedCoverage = {
      ...approvedCoverage,
      ledger: approvedCoverage.ledger.filter((e) => knownClusterIds.has(e.clusterId)),
    };
  }

  const coverageValidation = validateCoveragePlanConsistency(approvedCoverage);
  if (!coverageValidation.passed) {
    throw new Error(`Prompt Pipeline V2 coverage validation failed: ${coverageValidation.issues.join(" | ")}`);
  }

  logger.info("V2 pipeline [3/7]: Running scene outline...");
  const stage3Start = Date.now();
  const sceneOutlineSystemPrompt = buildSceneOutlineSystemPrompt(promptContext);
  let sceneOutline = await completeJsonWithRepair({
    model,
    system: sceneOutlineSystemPrompt,
    userPrompt: buildSceneOutlineUserPrompt(model.family, context, approvedCoverage),
    schema: sceneOutlineSchema,
    options: { maxTokens: 8192, schemaName: "scene_outline" },
    // Schema-level repair runs BEFORE the existing business-validation
    // repair below (validateSceneOutlineConsistency). A scene_outline that
    // fails Zod (e.g. empty scenes array, missing required field) now
    // gets a text-mode retry instead of throwing.
    repair: {
      ...(model.completeText !== undefined ? { completeText: model.completeText } : {}),
      promptContext,
      validDurations,
      label: "scene_outline_schema",
      systemPrompt: sceneOutlineSystemPrompt,
      shapeHint: SCENE_OUTLINE_REPAIR_SHAPE_HINT,
    },
  });

  // Auto-fix: strip evidence files not belonging to the scene's clusters
  const { sceneOutline: fixedOutline, stripped } = stripInvalidEvidenceFileRefs(approvedCoverage, sceneOutline);
  if (stripped.length > 0) {
    const emptiedScenes = stripped.filter((s) => {
      const scene = fixedOutline.scenes.find((sc) => sc.sceneNumber === s.sceneNumber);
      return scene && scene.evidenceFilePaths.length === 0;
    });
    logger.warn("Auto-stripped out-of-cluster evidence files from scene outline", {
      stripped,
      ...(emptiedScenes.length > 0 && { emptiedScenes: emptiedScenes.map((s) => s.sceneNumber) }),
    });
    sceneOutline = fixedOutline;
  }

  let sceneOutlineValidation = validateSceneOutlineConsistency(approvedCoverage, sceneOutline, context.durationMode);

  // Scene outline repair: feed validation errors back to the LLM
  const canRepairOutline = Boolean(model.completeText);
  const outlineRepairMaxAttempts = canRepairOutline ? getMaxRepairAttempts() : 0;
  for (
    let outlineRepairAttempt = 1;
    outlineRepairAttempt <= outlineRepairMaxAttempts && !sceneOutlineValidation.passed && model.completeText;
    outlineRepairAttempt++
  ) {
    logger.warn("Scene outline validation failed — attempting LLM repair", {
      attempt: outlineRepairAttempt,
      maxAttempts: outlineRepairMaxAttempts,
      issues: sceneOutlineValidation.issues,
    });
    const repairRaw = await model.completeText(
      buildSceneOutlineSystemPrompt(promptContext),
      buildSceneOutlineRepairPrompt(
        model.family,
        JSON.stringify(sceneOutline, null, 2),
        sceneOutlineValidation,
        approvedCoverage,
      ),
      8192,
    );
    let parseResult;
    try {
      parseResult = tryParseJson(repairRaw, sceneOutlineSchema);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      logger.warn("Scene outline repair returned unparseable JSON — skipping", {
        attempt: outlineRepairAttempt,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!parseResult.success) {
      logger.warn("Scene outline repair returned schema-invalid outline — skipping", {
        attempt: outlineRepairAttempt,
      });
      continue;
    }
    sceneOutline = parseResult.data;
    const { sceneOutline: repairedFixed, stripped: repairedStripped } = stripInvalidEvidenceFileRefs(approvedCoverage, sceneOutline);
    if (repairedStripped.length > 0) {
      const emptiedScenes = repairedStripped.filter((s) => {
        const scene = repairedFixed.scenes.find((sc) => sc.sceneNumber === s.sceneNumber);
        return scene && scene.evidenceFilePaths.length === 0;
      });
      logger.warn("Auto-stripped out-of-cluster evidence files from repaired outline", {
        stripped: repairedStripped,
        ...(emptiedScenes.length > 0 && { emptiedScenes: emptiedScenes.map((s) => s.sceneNumber) }),
      });
      sceneOutline = repairedFixed;
    }
    sceneOutlineValidation = validateSceneOutlineConsistency(approvedCoverage, sceneOutline, context.durationMode);
  }

  logger.info(`V2 pipeline [3/7]: Scene outline complete (${elapsed(stage3Start)}s)`, {
    sceneCount: sceneOutline.scenes.length,
  });
  if (!sceneOutlineValidation.passed) {
    throw new Error(`Prompt Pipeline V2 scene outline validation failed: ${sceneOutlineValidation.issues.join(" | ")}`);
  }

  const finalPassInput = {
    model,
    promptContext,
    context,
    analysis,
    approvedCoverage,
    sceneOutline,
    validDurations,
    narrationJudgeRunner,
  };
  logger.info("V2 pipeline [4/7]: Running final script generation...", {
    batched: isBatchSceneGenerationEnabled(),
  });
  const stage4Start = Date.now();
  let finalScriptPass = isBatchSceneGenerationEnabled()
    ? await runBatchedFinalScriptPass(finalPassInput)
    : await generateAndRefineScript(finalPassInput);
  logger.info(`V2 pipeline [4/7]: Final script generation complete (${elapsed(stage4Start)}s)`, {
    totalDurationSeconds: finalScriptPass.script.totalDurationSeconds,
    sceneCount: finalScriptPass.script.scenes.length,
  });

  // Duration retries must use the same generator (batched vs monolithic)
  // as the initial pass to avoid silent fallback to the monolithic prompt.
  const retryFinalScript = () => isBatchSceneGenerationEnabled()
    ? runBatchedFinalScriptPass(finalPassInput)
    : generateAndRefineScript(finalPassInput);

  const retryPasses: FinalScriptPassResult[] = [];
  const retryUpperDurationGuard = async (
    mode: string,
    requestedSeconds: number,
  ): Promise<void> => {
    const guard = buildDurationGuard(requestedSeconds);
    if (finalScriptPass.script.totalDurationSeconds <= guard.guardCapSeconds) {
      return;
    }

    logger.warn("Prompt Pipeline V2 script exceeds duration guard, retrying once", {
      mode,
      totalDurationSeconds: finalScriptPass.script.totalDurationSeconds,
      requestedSeconds: guard.requestedSeconds,
      guardCapSeconds: guard.guardCapSeconds,
      coefficient: guard.coefficient,
    });

    try {
      const retryPass = await retryFinalScript();
      retryPasses.push(retryPass);
      if (retryPass.script.totalDurationSeconds <= guard.guardCapSeconds) {
        logger.info("Prompt Pipeline V2 retry produced script within duration guard", {
          mode,
          totalDurationSeconds: retryPass.script.totalDurationSeconds,
          requestedSeconds: guard.requestedSeconds,
          guardCapSeconds: guard.guardCapSeconds,
          coefficient: guard.coefficient,
        });
        finalScriptPass = retryPass;
      } else if (
        retryPass.script.totalDurationSeconds < finalScriptPass.script.totalDurationSeconds
      ) {
        logger.warn("Prompt Pipeline V2 retry still exceeds duration guard, keeping shorter retry", {
          mode,
          retryDurationSeconds: retryPass.script.totalDurationSeconds,
          originalDurationSeconds: finalScriptPass.script.totalDurationSeconds,
          requestedSeconds: guard.requestedSeconds,
          guardCapSeconds: guard.guardCapSeconds,
          coefficient: guard.coefficient,
        });
        finalScriptPass = retryPass;
      } else {
        logger.warn("Prompt Pipeline V2 retry still exceeds duration guard, keeping original", {
          mode,
          retryDurationSeconds: retryPass.script.totalDurationSeconds,
          originalDurationSeconds: finalScriptPass.script.totalDurationSeconds,
          requestedSeconds: guard.requestedSeconds,
          guardCapSeconds: guard.guardCapSeconds,
          coefficient: guard.coefficient,
        });
      }
    } catch (retryErr) {
      logger.warn("Prompt Pipeline V2 duration guard retry failed", {
        mode,
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    if (finalScriptPass.script.totalDurationSeconds > guard.guardCapSeconds) {
      throw new Error(formatDurationGuardExceededError(mode, guard, finalScriptPass.script.totalDurationSeconds));
    }
  };

  if (isDefaultMode(context.durationMode)) {
    await retryUpperDurationGuard("default", DEFAULT_MODE_MAX_DURATION);
  }

  if (context.durationMode === "short") {
    await retryUpperDurationGuard("short", 60);
  }

  const POPCORN_MAX_RETRIES = 2;
  let popcornRetryCount = 0;
  while (
    context.durationMode === "popcorn" &&
    finalScriptPass.script.totalDurationSeconds < POPCORN_MODE_MIN_DURATION &&
    popcornRetryCount < POPCORN_MAX_RETRIES
  ) {
    popcornRetryCount++;
    logger.warn(`Prompt Pipeline V2 popcorn-mode script is too short, retry ${popcornRetryCount}/${POPCORN_MAX_RETRIES}`, {
      totalDurationSeconds: finalScriptPass.script.totalDurationSeconds,
      target: POPCORN_MODE_MIN_DURATION,
    });

    try {
      const retryPass = await retryFinalScript();
      retryPasses.push(retryPass);
      if (retryPass.script.totalDurationSeconds >= POPCORN_MODE_MIN_DURATION) {
        logger.info("Prompt Pipeline V2 popcorn-mode retry produced script meeting duration target", {
          totalDurationSeconds: retryPass.script.totalDurationSeconds,
          target: POPCORN_MODE_MIN_DURATION,
          attempt: popcornRetryCount,
        });
        finalScriptPass = retryPass;
      } else if (
        retryPass.script.totalDurationSeconds > finalScriptPass.script.totalDurationSeconds
      ) {
        logger.warn("Prompt Pipeline V2 popcorn-mode retry still too short, keeping longer retry", {
          retryDurationSeconds: retryPass.script.totalDurationSeconds,
          originalDurationSeconds: finalScriptPass.script.totalDurationSeconds,
          target: POPCORN_MODE_MIN_DURATION,
          attempt: popcornRetryCount,
        });
        finalScriptPass = retryPass;
      }
    } catch (retryErr) {
      logger.warn("Prompt Pipeline V2 popcorn-mode retry failed, keeping current script", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        attempt: popcornRetryCount,
      });
      break;
    }
  }

  if (context.durationMode === "popcorn") {
    await retryUpperDurationGuard("popcorn", MAX_VIDEO_DURATION_SECONDS);
  }

  let script = finalScriptPass.script;
  let narrationJudge = finalScriptPass.narrationJudge;
  let scriptValidation = finalScriptPass.scriptValidation;

  let reviewConcerns: ReviewConcern[] | undefined;
  let reviewPosture: ReviewPosture | undefined;
  if (context.deepdive) {
    // ── Reviewer narration validation + repair ─────────────────────────
    const canRepairReviewer = Boolean(model.completeText);
    const reviewerMaxAttempts = canRepairReviewer ? getMaxRepairAttempts() : 0;
    let reviewerNarrationRepaired = false;
    let reviewerValidation = validateReviewerNarration(script);
    for (
      let reviewerAttempt = 1;
      reviewerAttempt <= reviewerMaxAttempts && !reviewerValidation.passed && model.completeText;
      reviewerAttempt++
    ) {
      const repairMessage = reviewerValidation.violations
        .map((v) => `${v.field === "summary" ? "Summary" : `Scene ${v.sceneNumber}`}: contains ${v.rule.replace(/_/g, " ")} ("${v.matchedText}") — rewrite to remove it`)
        .join("\n");
      logger.warn("Reviewer narration violations detected — attempting LLM repair", {
        attempt: reviewerAttempt,
        maxAttempts: reviewerMaxAttempts,
        violations: reviewerValidation.violations,
      });
      let repairRaw: string;
      try {
        repairRaw = await model.completeText(
          buildFinalScriptSystemPrompt(promptContext, validDurations),
          buildReviewerNarrationRepairPrompt(
            model.family,
            JSON.stringify(script, null, 2),
            repairMessage,
          ),
          12288,
        );
      } catch (err) {
        logger.error("Reviewer narration repair LLM call failed — stopping repair", {
          attempt: reviewerAttempt,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      let parseResult;
      try {
        parseResult = tryParseJson(repairRaw, videoScriptTransportSchema);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        logger.warn("Reviewer narration repair returned unparseable JSON — skipping", {
          attempt: reviewerAttempt,
          error: err.message,
        });
        continue;
      }
      if (!parseResult.success) {
        logger.warn("Reviewer narration repair returned invalid script — skipping", {
          attempt: reviewerAttempt,
          errors: parseResult.zodError?.issues.map((i) => i.message).slice(0, 5),
        });
        continue;
      }
      script = deriveScriptFromTransport(parseResult.data);
      script = recomputeCodeFirstDurations(script);
      reviewerNarrationRepaired = true;
      reviewerValidation = validateReviewerNarration(script);
    }
    if (!reviewerValidation.passed) {
      enforceReviewerNarration(script, logger, isReviewerViolationWarnOnly);
    }

    if (reviewerNarrationRepaired) {
      logger.info("Re-validating word budgets and evidence grounding after reviewer narration repair");

      let reverted = false;
      const postRepairWordBudget = validateTotalWordBudget(script, promptContext.durationMode);
      if (!postRepairWordBudget.passed) {
        logger.warn("Reviewer narration repair introduced word budget violations — reverting to pre-repair script", {
          violations: postRepairWordBudget.violations,
        });
        reverted = true;
      } else {
        const postRepairGrounding = validateScriptEvidenceGrounding(
          approvedCoverage, sceneOutline, script,
        );
        if (!postRepairGrounding.passed) {
          logger.warn("Reviewer narration repair introduced grounding violations — reverting to pre-repair script", {
            issues: postRepairGrounding.issues,
          });
          reverted = true;
        } else {
          scriptValidation = postRepairGrounding;
          narrationJudge = undefined;
        }
      }

      if (reverted) {
        script = finalScriptPass.script;
        narrationJudge = finalScriptPass.narrationJudge;
        scriptValidation = finalScriptPass.scriptValidation;
        enforceReviewerNarration(script, logger, isReviewerViolationWarnOnly);
      }
    }

    const omittedClusterIds = new Set(
      approvedCoverage.ledger
        .filter((entry) => entry.disposition === "omitted_low_priority")
        .map((entry) => entry.clusterId),
    );
    const narratedClusterIds = new Set(
      sceneOutline.scenes.flatMap((s) => s.clusterIds),
    );
    reviewConcerns = approvedCoverage.clusters
      .filter((cluster) =>
        !omittedClusterIds.has(cluster.clusterId) &&
        narratedClusterIds.has(cluster.clusterId),
      )
      .sort((a, b) => a.importanceRank - b.importanceRank)
      .map((cluster, index) => ({
        concernId: `rc-${cluster.clusterId}`,
        sourceClusterIds: [cluster.clusterId],
        evidenceFilePaths: cluster.files,
        priorityRank: index + 1,
        issueClass: classifyIssueFromText(cluster.riskIfAbsent),
        riskStatement: cluster.riskIfAbsent,
        validationNeed: cluster.validationEvidence.join("; "),
        proseSupport: null,
      }));

    reviewPosture = {
      audience: "teammate_reviewer",
      evidencePolicy: "code_and_tests_primary",
      concernBudget: "highest_value_only",
      verdictPolicy: "no_verdict",
      hintPolicy: "non_prescriptive",
    };
  }

  // Force last scene to overview for constellation graph overlay.
  script = ensureLastSceneOverview(script);

  const artifacts: PromptPipelineV2Artifacts = promptPipelineV2ArtifactsSchema.parse({
    enabled: true,
    llmFamily: model.family,
    coveragePlan: approvedCoverage,
    sceneOutline,
    ...(coverageJudge ? { coverageJudge } : {}),
    ...(narrationJudge ? { narrationJudge } : {}),
    coverageValidation,
    sceneOutlineValidation,
    scriptValidation,
    ...(reviewConcerns ? { reviewConcerns } : {}),
    ...(reviewPosture ? { reviewPosture } : {}),
  });

  return {
    script,
    usage: {
      // Best-effort estimates; V2 may run across multiple providers/CLIs.
      inputTokens: Math.ceil(
        (
          buildCoveragePlannerUserPrompt(
            promptContext,
            context,
            analysis,
            context.durationMode,
          ).length +
          buildCoverageJudgeUserPrompt(model.family, context, analysis, plannedCoverage).length +
          buildSceneOutlineUserPrompt(model.family, context, approvedCoverage).length +
          buildFinalScriptUserPrompt(
            model.family,
            context,
            analysis,
            approvedCoverage,
            sceneOutline,
          ).length * (retryPasses.length + 1) +
          finalScriptPass.narrationJudgePromptLength +
          retryPasses.reduce((sum, pass) => sum + pass.narrationJudgePromptLength, 0)
        ) / 4,
      ),
      outputTokens: Math.ceil(
        (
          JSON.stringify(plannedCoverage).length +
          JSON.stringify(sceneOutline).length +
          finalScriptPass.scriptEstimatedLength +
          retryPasses.reduce((sum, pass) => sum + pass.scriptEstimatedLength, 0)
        ) / 4,
      ),
    },
    promptPipelineV2: artifacts,
  };
}
