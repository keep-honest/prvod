import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "@/domain/services/MetricsCollector";

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector("test-job");
  });

  it("tracks step timings", () => {
    collector.startStep("step-1");
    collector.endStep("step-1");

    const metrics = collector.toMetrics();
    expect(metrics.stepTimings).toHaveLength(1);
    expect(metrics.stepTimings[0].step).toBe("step-1");
    expect(metrics.stepTimings[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records API costs and sums total", () => {
    collector.recordCost({
      service: "claude",
      operation: "generate-script",
      costCents: 1.5,
      unit: "tokens",
      quantity: 3000,
    });
    collector.recordCost({
      service: "google-tts",
      operation: "synthesize",
      costCents: 0.24,
      unit: "characters",
      quantity: 150,
    });

    const metrics = collector.toMetrics();
    expect(metrics.apiCosts).toHaveLength(2);
    expect(metrics.totalEstimatedCostCents).toBe(1.74);
  });

  it("ignores endStep for unstarted steps", () => {
    collector.endStep("never-started");
    const metrics = collector.toMetrics();
    expect(metrics.stepTimings).toHaveLength(0);
  });

  it("includes jobId and totalDurationMs", () => {
    const metrics = collector.toMetrics();
    expect(metrics.jobId).toBe("test-job");
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("supports metadata via setMetadata", () => {
    collector.setMetadata("model", "claude-sonnet");
    const metrics = collector.toMetrics();
    expect(metrics.metadata.model).toBe("claude-sonnet");
  });
});
