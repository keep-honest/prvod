import type {
  IMetricsCollector,
  StepTiming,
  ApiCost,
  PipelineMetrics,
} from "@/interfaces/IMetricsCollector";
import { createLogger } from "@/lib/logger";

const logger = createLogger("MetricsCollector");

export class MetricsCollector implements IMetricsCollector {
  private jobId: string;
  private pipelineStartMs: number;
  private activeSteps = new Map<string, number>();
  private stepTimings: StepTiming[] = [];
  private apiCosts: ApiCost[] = [];
  private metadata: Record<string, unknown> = {};

  constructor(jobId: string) {
    this.jobId = jobId;
    this.pipelineStartMs = Date.now();
  }

  startStep(step: string): void {
    if (this.activeSteps.has(step)) {
      logger.warn("startStep called for already-active step — ignoring duplicate start", { step, jobId: this.jobId });
      return;
    }
    this.activeSteps.set(step, Date.now());
  }

  endStep(step: string): void {
    const startMs = this.activeSteps.get(step);
    if (startMs === undefined) {
      logger.warn("endStep called for unknown step — was startStep called?", { step, jobId: this.jobId });
      return;
    }
    this.activeSteps.delete(step);

    const endMs = Date.now();
    this.stepTimings.push({
      step,
      startMs,
      endMs,
      durationMs: endMs - startMs,
    });
  }

  recordCost(cost: ApiCost): void {
    this.apiCosts.push(cost);
  }

  setMetadata(key: string, value: unknown): void {
    this.metadata[key] = value;
  }

  toMetrics(): PipelineMetrics {
    if (this.activeSteps.size > 0) {
      logger.warn("toMetrics called with active (unclosed) steps", {
        jobId: this.jobId,
        leakedSteps: [...this.activeSteps.keys()],
      });
    }

    const totalDurationMs = Date.now() - this.pipelineStartMs;
    const totalEstimatedCostCents = this.apiCosts.reduce(
      (sum, c) => sum + c.costCents,
      0,
    );

    return {
      jobId: this.jobId,
      totalDurationMs,
      stepTimings: [...this.stepTimings],
      apiCosts: [...this.apiCosts],
      totalEstimatedCostCents: Math.round(totalEstimatedCostCents * 100) / 100,
      metadata: { ...this.metadata },
    };
  }
}

// Review page client-side metrics have been moved to src/lib/reviews/reviewPageMetrics.ts
// to keep the domain layer free of browser-specific code (declare global { Window }).
