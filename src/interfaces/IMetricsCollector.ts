export interface StepTiming {
  step: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface ApiCost {
  service: string;
  operation: string;
  costCents: number;
  unit: string;
  quantity: number;
  details?: Record<string, unknown>;
}

export interface PipelineMetrics {
  jobId: string;
  totalDurationMs: number;
  stepTimings: StepTiming[];
  apiCosts: ApiCost[];
  totalEstimatedCostCents: number;
  metadata: Record<string, unknown>;
}

export interface IMetricsCollector {
  startStep(step: string): void;
  endStep(step: string): void;
  recordCost(cost: ApiCost): void;
  setMetadata(key: string, value: unknown): void;
  toMetrics(): PipelineMetrics;
}
