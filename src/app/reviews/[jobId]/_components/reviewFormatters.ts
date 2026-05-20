/** Shared formatting helpers for review-page components. */

/**
 * Format a millisecond timestamp as MM:SS.
 * Used by ScenePicker, TranscriptTimeline, and ReviewPageClient.
 */
export function formatTimestamp(timeMs: number): string {
  const totalSeconds = Math.floor(timeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
