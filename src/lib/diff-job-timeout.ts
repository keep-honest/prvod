/** 20-minute AbortController wrapper enforcing SC-007 wall-clock SLA. */

import { DiffFetchTimeoutError } from "@/lib/diff-errors";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export interface DiffJobTimeout {
  signal: AbortSignal;
  clear: () => void;
}

/**
 * Creates an AbortController that fires after `ms` milliseconds.
 * Call `clear()` to cancel the timer when the job completes successfully.
 *
 * The abort reason is a typed `DiffFetchTimeoutError` (not a plain Error) so
 * `PipelineRunner.extractFailureMetadata` can map it to errorCode
 * "DIFF_FETCH_TIMEOUT" and the API/CLI can distinguish wall-clock SLA breaches
 * from generic pipeline failures.
 */
export function createDiffJobTimeout(ms: number = DEFAULT_TIMEOUT_MS): DiffJobTimeout {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DiffFetchTimeoutError("overall", {
        cause: new Error(`Diff ingest exceeded wall-clock limit of ${ms}ms (SC-007)`),
      }),
    );
  }, ms);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}
