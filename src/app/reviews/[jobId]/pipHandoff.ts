/** Snapshot captured when the Map modal opens — seeds the PiP and
 *  drives the resume-on-close decision. */
export interface PipHandoffSnapshot {
  wasPlayingBeforeOpen: boolean;
  mainTimeAtOpenMs: number;
}

/** Minimal video shape the close helper needs — easy to stub in tests. */
export interface MainVideoLike {
  currentTime: number;
  readyState?: number;
}

export type ApplyHandoffOutcome =
  | "ok"
  | "no_video"
  | "invalid_input"
  | "seek_failed";

/**
 * Build the handoff snapshot. Invalid `currentVideoTimeMs` values
 * (NaN, Infinity, negative) are clamped to 0 and logged.
 */
export function _snapshotMainPlayback(args: {
  currentVideoTimeMs: number;
  isPlaying: boolean;
  logger?: Pick<Console, "warn">;
}): PipHandoffSnapshot {
  let timeMs = args.currentVideoTimeMs;
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    (args.logger ?? console).warn(
      "[ReviewPageClient] Invalid currentVideoTimeMs at Map open — falling back to 0",
      { rawTime: timeMs },
    );
    timeMs = 0;
  }
  return { wasPlayingBeforeOpen: args.isPlaying, mainTimeAtOpenMs: timeMs };
}

/**
 * Seek the main video to the PiP's final time and conditionally
 * resume playback. Returns an outcome tag for testability.
 */
export function _applyHandoffOnClose(args: {
  video: MainVideoLike | null;
  finalPipTimeMs: number;
  snapshot: PipHandoffSnapshot | null;
  playVideo: () => Promise<void> | void;
  logger?: Pick<Console, "error">;
}): ApplyHandoffOutcome {
  const logger = args.logger ?? console;
  if (!args.video) return "no_video";
  if (!Number.isFinite(args.finalPipTimeMs) || args.finalPipTimeMs < 0) {
    logger.error(
      "[ReviewPageClient] PiP handoff received invalid finalPipTimeMs — skipping main seek",
      { finalPipTimeMs: args.finalPipTimeMs },
    );
    return "invalid_input";
  }
  try {
    args.video.currentTime = args.finalPipTimeMs / 1000;
  } catch (err) {
    logger.error(
      "[ReviewPageClient] Failed to seek main video on Map close",
      {
        finalPipTimeMs: args.finalPipTimeMs,
        readyState: args.video.readyState,
        err,
      },
    );
    return "seek_failed";
  }
  if (args.snapshot?.wasPlayingBeforeOpen) {
    void args.playVideo();
  }
  return "ok";
}
