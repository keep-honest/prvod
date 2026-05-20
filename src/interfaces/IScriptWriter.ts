import type { PRContext } from "@/domain/entities/PRContext";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { PromptPipelineV2Artifacts } from "@/domain/entities/PromptPipelineV2";
import type { DiffAnalysis } from "./IDiffAnalyzer";

export interface ScriptWriterUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ScriptWriterResult {
  script: VideoScript;
  usage?: ScriptWriterUsage;
  promptPipelineV2?: PromptPipelineV2Artifacts;
}

export interface NarrationRetimeBudget {
  sceneNumber: number;
  durationFrames: number;
  durationMs: number;
  maxWords: number;
}

export interface RetimedSceneNarration {
  sceneNumber: number;
  narration: string;
}

export interface NarrationRetimeResult {
  scenes: RetimedSceneNarration[];
  usage?: ScriptWriterUsage;
}

export interface IScriptWriter {
  generateScript(
    context: PRContext,
    analysis: DiffAnalysis,
  ): Promise<ScriptWriterResult>;

  retimeNarration(
    context: PRContext,
    analysis: DiffAnalysis,
    script: VideoScript,
    sceneBudgets: NarrationRetimeBudget[],
    targetSceneNumbers?: number[],
  ): Promise<NarrationRetimeResult>;
}
