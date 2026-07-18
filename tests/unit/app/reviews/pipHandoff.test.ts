import { describe, expect, it, vi } from "vitest";
import {
  _applyHandoffOnClose,
  _snapshotMainPlayback,
  type MainVideoLike,
} from "@/app/reviews/[jobId]/pipHandoff";

/**
 * Pure-helper tests for the main-video ⇆ modal-PiP handoff. These
 * pin the highest-risk code path in the Phase 4 constellation graph
 * rework: the coordination between two `<video>` elements that
 * share a single logical playhead.
 *
 * A regression in any of these branches causes a "why did my video
 * rewind?" bug that is very hard to diagnose after the fact. The
 * Round 4 test analyzer specifically called out this code path as
 * the biggest uncovered regression surface.
 */

function fakeMainVideo(overrides: Partial<MainVideoLike> = {}): MainVideoLike {
  return {
    currentTime: 0,
    readyState: 4,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// _snapshotMainPlayback
// ────────────────────────────────────────────────────────────────

describe("_snapshotMainPlayback — happy path", () => {
  it("captures the current video time and playing state verbatim", () => {
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: 27_345,
      isPlaying: true,
    });
    expect(snap).toEqual({
      wasPlayingBeforeOpen: true,
      mainTimeAtOpenMs: 27_345,
    });
  });

  it("captures a paused state verbatim", () => {
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: 0,
      isPlaying: false,
    });
    expect(snap).toEqual({
      wasPlayingBeforeOpen: false,
      mainTimeAtOpenMs: 0,
    });
  });
});

describe("_snapshotMainPlayback — invalid inputs", () => {
  it("clamps NaN currentVideoTimeMs to 0 and logs a warning", () => {
    const warn = vi.fn();
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: Number.NaN,
      isPlaying: true,
      logger: { warn },
    });
    expect(snap.mainTimeAtOpenMs).toBe(0);
    expect(snap.wasPlayingBeforeOpen).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Invalid currentVideoTimeMs");
  });

  it("clamps Infinity to 0 and logs", () => {
    const warn = vi.fn();
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: Number.POSITIVE_INFINITY,
      isPlaying: false,
      logger: { warn },
    });
    expect(snap.mainTimeAtOpenMs).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("clamps negative values to 0 and logs", () => {
    const warn = vi.fn();
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: -1000,
      isPlaying: false,
      logger: { warn },
    });
    expect(snap.mainTimeAtOpenMs).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("does NOT log for a valid 0 (paused at start)", () => {
    const warn = vi.fn();
    _snapshotMainPlayback({
      currentVideoTimeMs: 0,
      isPlaying: false,
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// _applyHandoffOnClose
// ────────────────────────────────────────────────────────────────

describe("_applyHandoffOnClose — happy path", () => {
  it("seeks the main video and resumes playback when the user was playing before", () => {
    const video = fakeMainVideo({ currentTime: 10 });
    const playVideo = vi.fn();
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: 42_500,
      snapshot: { wasPlayingBeforeOpen: true, mainTimeAtOpenMs: 10_000 },
      playVideo,
    });
    expect(outcome).toBe("ok");
    expect(video.currentTime).toBe(42.5);
    expect(playVideo).toHaveBeenCalledTimes(1);
  });

  it("seeks the main video but does NOT resume when the user was paused before", () => {
    const video = fakeMainVideo({ currentTime: 10 });
    const playVideo = vi.fn();
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: 42_500,
      snapshot: { wasPlayingBeforeOpen: false, mainTimeAtOpenMs: 10_000 },
      playVideo,
    });
    expect(outcome).toBe("ok");
    expect(video.currentTime).toBe(42.5);
    expect(playVideo).not.toHaveBeenCalled();
  });

  it("seeks the main video without resuming when the snapshot is null (recovery path)", () => {
    const video = fakeMainVideo({ currentTime: 0 });
    const playVideo = vi.fn();
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: 5_000,
      snapshot: null,
      playVideo,
    });
    expect(outcome).toBe("ok");
    expect(video.currentTime).toBe(5);
    expect(playVideo).not.toHaveBeenCalled();
  });
});

describe("_applyHandoffOnClose — error paths", () => {
  it("returns 'no_video' and does nothing when the ref is null", () => {
    const playVideo = vi.fn();
    const outcome = _applyHandoffOnClose({
      video: null,
      finalPipTimeMs: 1_000,
      snapshot: { wasPlayingBeforeOpen: true, mainTimeAtOpenMs: 0 },
      playVideo,
    });
    expect(outcome).toBe("no_video");
    expect(playVideo).not.toHaveBeenCalled();
  });

  it("returns 'invalid_input' and logs for NaN finalPipTimeMs", () => {
    const error = vi.fn();
    const video = fakeMainVideo({ currentTime: 10 });
    const playVideo = vi.fn();
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: Number.NaN,
      snapshot: { wasPlayingBeforeOpen: true, mainTimeAtOpenMs: 0 },
      playVideo,
      logger: { error },
    });
    expect(outcome).toBe("invalid_input");
    expect(video.currentTime).toBe(10); // untouched
    expect(playVideo).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("invalid finalPipTimeMs");
  });

  it("returns 'invalid_input' for negative finalPipTimeMs", () => {
    const error = vi.fn();
    const video = fakeMainVideo({ currentTime: 10 });
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: -500,
      snapshot: { wasPlayingBeforeOpen: true, mainTimeAtOpenMs: 0 },
      playVideo: vi.fn(),
      logger: { error },
    });
    expect(outcome).toBe("invalid_input");
    expect(error).toHaveBeenCalled();
  });

  it("returns 'seek_failed' and does NOT resume when the currentTime setter throws", () => {
    const error = vi.fn();
    const playVideo = vi.fn();
    // Object with a throwing setter — simulates a video whose
    // metadata hasn't loaded yet, or an InvalidStateError.
    const video: MainVideoLike = {
      get currentTime(): number {
        return 0;
      },
      set currentTime(_v: number) {
        throw new TypeError("InvalidStateError");
      },
      readyState: 0,
    };
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: 5_000,
      snapshot: { wasPlayingBeforeOpen: true, mainTimeAtOpenMs: 0 },
      playVideo,
      logger: { error },
    });
    expect(outcome).toBe("seek_failed");
    // CRITICAL: must NOT resume playback — we're at the wrong
    // position and playing would make the issue worse.
    expect(playVideo).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("Failed to seek main video");
  });

  it("rounds sub-millisecond finalPipTimeMs when seeking", () => {
    const video = fakeMainVideo({ currentTime: 0 });
    _applyHandoffOnClose({
      video,
      finalPipTimeMs: 12_345, // already ms
      snapshot: null,
      playVideo: vi.fn(),
    });
    expect(video.currentTime).toBe(12.345);
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end snapshot + apply handoff (integration of the two helpers)
// ────────────────────────────────────────────────────────────────

describe("pipHandoff — snapshot + apply integration", () => {
  it("round-trips a paused handoff without losing playhead position", () => {
    // User opens Map while paused at 20s, PiP plays for a few
    // seconds, user closes at 30s — main video must be at 30s and
    // still paused.
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: 20_000,
      isPlaying: false,
    });
    const video = fakeMainVideo({ currentTime: 20 });
    const playVideo = vi.fn();
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: 30_000,
      snapshot: snap,
      playVideo,
    });
    expect(outcome).toBe("ok");
    expect(video.currentTime).toBe(30);
    expect(playVideo).not.toHaveBeenCalled();
  });

  it("round-trips a playing handoff and resumes playback", () => {
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: 20_000,
      isPlaying: true,
    });
    const video = fakeMainVideo({ currentTime: 20 });
    const playVideo = vi.fn();
    _applyHandoffOnClose({
      video,
      finalPipTimeMs: 30_000,
      snapshot: snap,
      playVideo,
    });
    expect(video.currentTime).toBe(30);
    expect(playVideo).toHaveBeenCalledTimes(1);
  });

  it("does not rewind the main video when the close fires on an unseeded PiP (invalid NaN input)", () => {
    // This is the scenario: user opens Map → closes before PiP
    // metadata loads → PiP never seeded → _computeFinalPipTimeMs
    // falls back to initialTimeMs → main video seeks there.
    // We test that NaN/Infinity DO NOT silently rewind to 0.
    const snap = _snapshotMainPlayback({
      currentVideoTimeMs: 20_000,
      isPlaying: true,
    });
    const video = fakeMainVideo({ currentTime: 20 });
    const playVideo = vi.fn();
    const error = vi.fn();
    const outcome = _applyHandoffOnClose({
      video,
      finalPipTimeMs: Number.NaN,
      snapshot: snap,
      playVideo,
      logger: { error },
    });
    expect(outcome).toBe("invalid_input");
    // Main video must stay at its original position — do NOT rewind.
    expect(video.currentTime).toBe(20);
    expect(playVideo).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});
