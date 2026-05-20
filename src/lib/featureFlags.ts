function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function isPromptPipelineV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.PROMPT_PIPELINE_V2);
}

export function isModelPromptAdaptersV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.MODEL_PROMPT_ADAPTERS_V1);
}

export function isPromptPipelineV2CompareV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.PROMPT_PIPELINE_V2_COMPARE_V1);
}

export function isBatchSceneGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.BATCH_SCENE_GENERATION);
}

export function isGroundingFailureWarnOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.GROUNDING_FAILURE_WARN);
}

export function isPostGroundingJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.POST_GROUNDING);
}

export function isReviewerViolationWarnOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.REVIEWER_VIOLATION_WARN);
}

/**
 * When `SKIP_JUDGE=true`, every AI judge in the pipeline is bypassed:
 *  - Visual prompt judge (step 2b in VideoOrchestrator)
 *  - Coverage judge (Prompt Pipeline V2, stage 2/7)
 *  - Narration quality judge (Prompt Pipeline V2, stage 5/7)
 *
 * Deterministic validators (coverage consistency, word budgets, evidence
 * grounding) still run — only the LLM-powered judges are skipped. Useful
 * for local iteration, test runs, or cost-sensitive environments.
 */
export function isJudgeSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.SKIP_JUDGE);
}
