import type {
  CoveragePlan,
  NarrationJudgeResult,
  SceneOutline,
} from "@/domain/entities/PromptPipelineV2";
import type { PRContext } from "@/domain/entities/PRContext";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";

export interface NarrationQualityJudgeInput {
  context: PRContext;
  analysis: DiffAnalysis;
  coveragePlan: CoveragePlan;
  sceneOutline: SceneOutline;
  script: VideoScript;
}

export interface NarrationQualityJudgeOutput {
  script: VideoScript;
  result: NarrationJudgeResult;
}

export interface INarrationQualityJudge {
  judge(input: NarrationQualityJudgeInput): Promise<NarrationQualityJudgeOutput>;
}
