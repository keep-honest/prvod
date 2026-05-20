/**
 * Maps a job's persisted error state to a user-facing message.
 *
 * Raw server error text (stack traces, internal identifiers, upstream provider
 * messages) is never surfaced to dashboard users. We rely on the structured
 * {@link JobFailureMetadata.errorCode} produced by `PipelineRunner` and fall
 * back to a generic message for unrecognized failures.
 */

const DEFAULT_FAILURE_MESSAGE =
  "Walkthrough generation failed. Please retry the pull request or contact support if the problem persists.";

const CANCELLED_MESSAGE = "Walkthrough was cancelled.";

const ERROR_CODE_MESSAGES: Record<string, string> = {
  DIFF_TOO_LARGE:
    "This pull request is too large for an automated walkthrough. Try splitting it into smaller PRs.",
  DIFF_FETCH_TIMEOUT:
    "Couldn't fetch this pull request's diff in time. Retry to try again.",
  DIFF_PARSE_ERROR:
    "We couldn't read this pull request's diff. Retry, or reach out if it keeps happening.",
  LLM_RATE_LIMITED_EXHAUSTED:
    "Our AI provider is at capacity right now. Please retry in a few minutes.",
  LLM_VALIDATION_EXHAUSTED:
    "We couldn't produce a valid walkthrough for this pull request. Retry or simplify the change set.",
};

export function mapJobErrorToUserMessage(
  status: string,
  errorCode: string | null | undefined,
): string | null {
  if (status === "cancelled") return CANCELLED_MESSAGE;
  if (status !== "failed") return null;
  if (errorCode && ERROR_CODE_MESSAGES[errorCode]) {
    return ERROR_CODE_MESSAGES[errorCode];
  }
  return DEFAULT_FAILURE_MESSAGE;
}

export const __testing = {
  DEFAULT_FAILURE_MESSAGE,
  CANCELLED_MESSAGE,
  ERROR_CODE_MESSAGES,
};
