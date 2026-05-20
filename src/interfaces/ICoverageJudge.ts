import type {
  CoverageJudgeResult,
  CoveragePlan,
} from "@/domain/entities/PromptPipelineV2";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";
import type { PRContext } from "@/domain/entities/PRContext";

export interface CoverageJudgeInput {
  context: PRContext;
  analysis: DiffAnalysis;
  coveragePlan: CoveragePlan;
}

export interface CoverageJudgeOutput {
  coveragePlan: CoveragePlan;
  result: CoverageJudgeResult;
}

export interface ICoverageJudge {
  judge(input: CoverageJudgeInput): Promise<CoverageJudgeOutput>;
}
