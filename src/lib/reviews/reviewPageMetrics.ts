export interface ReviewPageMetricEvent {
  metricName: string;
  durationMs: number;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

declare global {
  interface Window {
    __PRVOD_REVIEW_METRICS__?: ReviewPageMetricEvent[];
  }
}

export function createReviewPageMetricEvent(
  metricName: string,
  durationMs: number,
  metadata: Record<string, unknown> = {},
): ReviewPageMetricEvent {
  return {
    metricName,
    durationMs: Math.max(0, Math.round(durationMs)),
    capturedAt: new Date().toISOString(),
    metadata,
  };
}

export function emitReviewPageMetric(event: ReviewPageMetricEvent): void {
  if (typeof window === "undefined") {
    return;
  }

  const queue = window.__PRVOD_REVIEW_METRICS__ ?? [];
  queue.push(event);
  window.__PRVOD_REVIEW_METRICS__ = queue;
  try {
    window.dispatchEvent(new CustomEvent("prvod:review-metric", { detail: event }));
  } catch (err) {
    console.warn("Review metric event listener threw:", err);
  }
}
