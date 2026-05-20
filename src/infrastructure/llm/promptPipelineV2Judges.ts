import type { PRContext } from "@/domain/entities/PRContext";
import type {
  CoverageJudgeInput,
  CoverageJudgeOutput,
  ICoverageJudge,
} from "@/interfaces/ICoverageJudge";
import type {
  INarrationQualityJudge,
  NarrationQualityJudgeInput,
  NarrationQualityJudgeOutput,
} from "@/interfaces/INarrationQualityJudge";
import {
  coverageJudgeResultSchema,
  narrationJudgeTransportResultSchema,
  narrationJudgeResultSchema,
  type NarrationJudgeResult,
} from "@/domain/entities/PromptPipelineV2";
import { videoScriptTransportSchema, type VideoScript } from "@/domain/entities/VideoScript";
import { createLogger } from "@/lib/logger";
import {
  buildCoverageJudgeSystemPrompt,
  buildCoverageJudgeUserPrompt,
  buildNarrationJudgeSystemPrompt,
  buildNarrationJudgeUserPrompt,
  type PromptContext,
  type PromptPipelineLlmFamily,
} from "@/infrastructure/llm/promptPipelineV2";
import { type PromptPipelineV2Model, deriveScriptFromTransport } from "@/infrastructure/llm/promptPipelineV2Runner";
import { tryValidate, repairLoop, formatZodErrors } from "@/infrastructure/llm/promptPipelineV2Repair";

const logger = createLogger("PromptPipelineV2Judges");

function buildJudgePromptContext(
  family: PromptPipelineLlmFamily,
  context: PRContext,
): PromptContext {
  return {
    family,
    durationMode: context.durationMode,
    deepdive: context.deepdive,
  };
}

class PromptPipelineCoverageJudge implements ICoverageJudge {
  constructor(private readonly model: PromptPipelineV2Model) {}

  async judge(input: CoverageJudgeInput): Promise<CoverageJudgeOutput> {
    const promptContext = buildJudgePromptContext(
      this.model.family,
      input.context,
    );
    const result = await this.model.completeJson(
      buildCoverageJudgeSystemPrompt(promptContext),
      buildCoverageJudgeUserPrompt(
        this.model.family,
        input.context,
        input.analysis,
        input.coveragePlan,
      ),
      coverageJudgeResultSchema,
      { maxTokens: 4096, schemaName: "coverage_judge" },
    );
    return {
      coveragePlan: result.passed || !result.revisedPlan ? input.coveragePlan : result.revisedPlan,
      result,
    };
  }
}

class PromptPipelineNarrationQualityJudge implements INarrationQualityJudge {
  constructor(
    private readonly model: PromptPipelineV2Model,
    private readonly validDurations: readonly number[],
  ) {}

  async judge(input: NarrationQualityJudgeInput): Promise<NarrationQualityJudgeOutput> {
    const promptContext = buildJudgePromptContext(
      this.model.family,
      input.context,
    );
    const rawResult = await this.model.completeJson(
      buildNarrationJudgeSystemPrompt(promptContext),
      buildNarrationJudgeUserPrompt(
        this.model.family,
        input.coveragePlan,
        input.sceneOutline,
        input.script,
        this.validDurations,
        {
          durationMode: input.context.durationMode,
        },
      ),
      narrationJudgeTransportResultSchema,
      { maxTokens: 12288, schemaName: "narration_judge" },
    );
    const buildResult = (revisedScript?: VideoScript): NarrationJudgeResult =>
      narrationJudgeResultSchema.parse(
        revisedScript
          ? { ...rawResult, revisedScript }
          : {
            passed: rawResult.passed,
            issues: rawResult.issues,
            scores: rawResult.scores,
          },
      );

    // If the judge passed or didn't provide a revision, keep the original script
    if (rawResult.passed || !rawResult.revisedScript) {
      return { script: input.script, result: buildResult() };
    }

    // Code-first: use transport schema (no totalDuration bounds) since the judge's
    // revised script has LLM-estimated durations. Caller recomputes via recomputeCodeFirstDurations.
    const validateSchema = videoScriptTransportSchema;

    // Validate the revisedScript through schema + repair if needed
    let parseResult = tryValidate(rawResult.revisedScript, validateSchema);

    if (!parseResult.success && this.model.completeText) {
      logger.warn("Narration judge revisedScript failed validation — attempting repair", {
        errors: formatZodErrors(parseResult.zodError),
      });
      parseResult = await repairLoop(parseResult, validateSchema, {
        completeText: this.model.completeText,
        promptContext,
        validDurations: this.validDurations,
        label: "narration_revised_script",
      });
    }

    if (parseResult.success) {
      // Derive full VideoScript (recompute totalDurationSeconds/totalWordCount from scenes).
      const revisedScript = deriveScriptFromTransport(parseResult.data);
      return { script: revisedScript, result: buildResult(revisedScript) };
    }

    logger.warn("Narration judge revisedScript could not be repaired — keeping original script", {
      errors: formatZodErrors(parseResult.zodError),
    });
    return { script: input.script, result: buildResult() };
  }
}

export function createCoverageJudge(model: PromptPipelineV2Model): ICoverageJudge {
  return new PromptPipelineCoverageJudge(model);
}

export function createNarrationQualityJudge(
  model: PromptPipelineV2Model,
  validDurations: readonly number[],
): INarrationQualityJudge {
  return new PromptPipelineNarrationQualityJudge(model, validDurations);
}
