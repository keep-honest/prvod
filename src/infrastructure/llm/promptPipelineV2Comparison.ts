import {
  promptPipelineRolloutComparisonSchema,
  type PromptPipelineRolloutComparison,
} from "@/domain/entities/PromptPipelineV2";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { ScriptWriterResult, ScriptWriterUsage } from "@/interfaces/IScriptWriter";

function snapshotScriptMetrics(script: VideoScript) {
  return {
    sceneCount: script.scenes.length,
    totalDurationSeconds: script.totalDurationSeconds,
    totalWordCount: script.totalWordCount,
    keyFilesCount: script.keyFiles.length,
    tagCount: script.tags.length,
  };
}

export function buildPromptPipelineRolloutComparison(
  v2Script: VideoScript,
  legacyScript: VideoScript,
): PromptPipelineRolloutComparison {
  const v2Metrics = snapshotScriptMetrics(v2Script);
  const legacyMetrics = snapshotScriptMetrics(legacyScript);

  return promptPipelineRolloutComparisonSchema.parse({
    enabled: true,
    legacyMetrics,
    v2Metrics,
    deltas: {
      sceneCount: v2Metrics.sceneCount - legacyMetrics.sceneCount,
      totalDurationSeconds: v2Metrics.totalDurationSeconds - legacyMetrics.totalDurationSeconds,
      totalWordCount: v2Metrics.totalWordCount - legacyMetrics.totalWordCount,
      keyFilesCount: v2Metrics.keyFilesCount - legacyMetrics.keyFilesCount,
      tagCount: v2Metrics.tagCount - legacyMetrics.tagCount,
    },
    legacySummary: legacyScript.summary,
    v2Summary: v2Script.summary,
  });
}

export function mergeScriptWriterUsage(
  primary?: ScriptWriterUsage,
  secondary?: ScriptWriterUsage,
): ScriptWriterUsage | undefined {
  if (!primary && !secondary) return undefined;

  return {
    inputTokens: (primary?.inputTokens ?? 0) + (secondary?.inputTokens ?? 0),
    outputTokens: (primary?.outputTokens ?? 0) + (secondary?.outputTokens ?? 0),
  };
}

export function attachPromptPipelineRolloutComparison(
  v2Result: ScriptWriterResult,
  legacyResult: ScriptWriterResult,
): ScriptWriterResult {
  if (!v2Result.promptPipelineV2) {
    return {
      ...v2Result,
      usage: mergeScriptWriterUsage(v2Result.usage, legacyResult.usage),
    };
  }

  return {
    ...v2Result,
    usage: mergeScriptWriterUsage(v2Result.usage, legacyResult.usage),
    promptPipelineV2: {
      ...v2Result.promptPipelineV2,
      rolloutComparison: buildPromptPipelineRolloutComparison(
        v2Result.script,
        legacyResult.script,
      ),
    },
  };
}
