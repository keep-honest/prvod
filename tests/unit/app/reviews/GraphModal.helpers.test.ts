import { describe, expect, it, vi } from "vitest";
import {
  _seedPipVideo,
  _seekPipForNodeClick,
  _computeFinalPipTimeMs,
  _nextModalView,
  _nextSelectedNodeId,
  _sceneNumberForTimeMs,
} from "@/app/reviews/[jobId]/_components/GraphModal";
import { makeTwoNodeReviewGraph } from "../../../fixtures/reviewGraph";

/**
 * Pure-helper tests for the three decision functions inside GraphModal
 * that coordinate the main-page ⇆ modal-PiP video handoff.
 *
 * These helpers exist because the full component integration (Radix
 * Dialog portal + HTML video element + React hooks) is hostile to
 * unit testing. Extracting the logic into pure functions lets us pin
 * every branch of the "did the PiP seed yet?" state machine without
 * a browser.
 *
 * The three helpers coordinate these invariants:
 *
 *   1. `_seedPipVideo`: runs on `loadedmetadata`; seeds the PiP to
 *      `initialTimeMs`, unless it's already seeded (e.g. a node
 *      click got there first), unless the input is invalid.
 *   2. `_seekPipForNodeClick`: runs on node click; seeks the PiP
 *      AND marks it seeded so a later `loadedmetadata` handoff
 *      doesn't overwrite the user's explicit selection.
 *   3. `_computeFinalPipTimeMs`: runs on modal close; reads the
 *      PiP's currentTime IFF the PiP was actually seeded, falling
 *      back to `initialTimeMs` otherwise so a close-before-seed
 *      doesn't rewind the main video to 0.
 */

interface FakeVideo {
  currentTime: number;
  readyState?: number;
  play: () => Promise<void>;
  pause?: () => void;
}

function fakeVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  return {
    currentTime: 0,
    readyState: 1,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// _seedPipVideo
// ────────────────────────────────────────────────────────────────

describe("_seedPipVideo", () => {
  it("seeds currentTime from initialTimeMs and calls onSeeded on the happy path", () => {
    const video = fakeVideo();
    const onSeeded = vi.fn();
    const outcome = _seedPipVideo({
      video,
      alreadySeeded: false,
      initialTimeMs: 12_345,
      initiallyPlaying: false,
      onSeeded,
    });
    expect(outcome).toBe("seeded");
    expect(video.currentTime).toBe(12.345);
    expect(onSeeded).toHaveBeenCalledTimes(1);
    // Should NOT call play when initiallyPlaying=false.
    expect(video.play).not.toHaveBeenCalled();
  });

  it("calls play() when initiallyPlaying=true", () => {
    const video = fakeVideo();
    _seedPipVideo({
      video,
      alreadySeeded: false,
      initialTimeMs: 5000,
      initiallyPlaying: true,
      onSeeded: vi.fn(),
    });
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the video ref is null", () => {
    const onSeeded = vi.fn();
    const outcome = _seedPipVideo({
      video: null,
      alreadySeeded: false,
      initialTimeMs: 1000,
      initiallyPlaying: true,
      onSeeded,
    });
    expect(outcome).toBe("skipped_null_video");
    expect(onSeeded).not.toHaveBeenCalled();
  });

  it("is a no-op when the PiP is already seeded (e.g., by a prior node click)", () => {
    const video = fakeVideo({ currentTime: 42 });
    const onSeeded = vi.fn();
    const outcome = _seedPipVideo({
      video,
      alreadySeeded: true,
      initialTimeMs: 9999,
      initiallyPlaying: false,
      onSeeded,
    });
    expect(outcome).toBe("skipped_already_seeded");
    // The existing currentTime from the earlier seek must be
    // preserved — THIS is the "node-click-during-PiP-load" race fix.
    expect(video.currentTime).toBe(42);
    expect(onSeeded).not.toHaveBeenCalled();
  });

  it("rejects NaN initialTimeMs and logs", () => {
    const video = fakeVideo();
    const error = vi.fn();
    const warn = vi.fn();
    const outcome = _seedPipVideo({
      video,
      alreadySeeded: false,
      initialTimeMs: Number.NaN,
      initiallyPlaying: false,
      onSeeded: vi.fn(),
      logger: { error, warn },
    });
    expect(outcome).toBe("skipped_invalid_time");
    expect(video.currentTime).toBe(0); // untouched
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("invalid initialTimeMs");
  });

  it("rejects negative initialTimeMs and logs", () => {
    const video = fakeVideo();
    const error = vi.fn();
    const outcome = _seedPipVideo({
      video,
      alreadySeeded: false,
      initialTimeMs: -500,
      initiallyPlaying: false,
      onSeeded: vi.fn(),
      logger: { error, warn: vi.fn() },
    });
    expect(outcome).toBe("skipped_invalid_time");
    expect(error).toHaveBeenCalled();
  });

  it("reports 'failed' and does NOT mark seeded when the currentTime setter throws", () => {
    const error = vi.fn();
    const onSeeded = vi.fn();
    // Use a fresh object with a throwing setter
    const video = {
      get currentTime(): number {
        return 0;
      },
      set currentTime(_v: number) {
        throw new TypeError("InvalidStateError");
      },
      play: vi.fn(async () => undefined),
      readyState: 0,
    } as unknown as FakeVideo;
    const outcome = _seedPipVideo({
      video,
      alreadySeeded: false,
      initialTimeMs: 1000,
      initiallyPlaying: true,
      onSeeded,
      logger: { error, warn: vi.fn() },
    });
    expect(outcome).toBe("failed");
    expect(onSeeded).not.toHaveBeenCalled();
    // play() must not have been called on the failure path.
    expect(video.play).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("Failed to seed PiP");
  });

  it("swallows NotAllowedError from play() without logging (autoplay blocked)", async () => {
    const error = vi.fn();
    const video = fakeVideo({
      play: vi.fn(async () => {
        throw new DOMException("User did not interact", "NotAllowedError");
      }),
    });
    _seedPipVideo({
      video,
      alreadySeeded: false,
      initialTimeMs: 1000,
      initiallyPlaying: true,
      onSeeded: vi.fn(),
      logger: { error, warn: vi.fn() },
    });
    // Wait a microtask for the .catch to run
    await Promise.resolve();
    // The seed path itself succeeded; the autoplay rejection is not
    // an error condition (the user can press play manually).
    expect(error).not.toHaveBeenCalled();
  });

  it("logs other play() rejections (e.g. NotSupportedError)", async () => {
    const error = vi.fn();
    const video = fakeVideo({
      play: vi.fn(async () => {
        throw new DOMException("Decoder failure", "NotSupportedError");
      }),
    });
    _seedPipVideo({
      video,
      alreadySeeded: false,
      initialTimeMs: 1000,
      initiallyPlaying: true,
      onSeeded: vi.fn(),
      logger: { error, warn: vi.fn() },
    });
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("play() failed");
  });
});

// ────────────────────────────────────────────────────────────────
// _seekPipForNodeClick
// ────────────────────────────────────────────────────────────────

describe("_seekPipForNodeClick", () => {
  const sceneStartTimesMs = new Map([
    [1, 0],
    [2, 8_000],
    [3, 16_000],
  ]);

  it("seeks the video to the scene's start and marks seeded", () => {
    const video = fakeVideo();
    const onSeeded = vi.fn();
    const outcome = _seekPipForNodeClick({
      video,
      sceneNumber: 2,
      sceneStartTimesMs,
      onSeeded,
    });
    expect(outcome).toBe("seeked");
    expect(video.currentTime).toBe(8);
    expect(onSeeded).toHaveBeenCalledTimes(1);
  });

  it("marking seeded prevents a later _seedPipVideo from overwriting the node-click seek", () => {
    // This test exercises the integration contract between the two
    // helpers that fixes the node-click-during-PiP-load race.
    const video = fakeVideo();
    let seeded = false;
    const markSeeded = () => {
      seeded = true;
    };
    // 1) Node click happens before metadata loads
    _seekPipForNodeClick({
      video,
      sceneNumber: 3,
      sceneStartTimesMs,
      onSeeded: markSeeded,
    });
    expect(seeded).toBe(true);
    expect(video.currentTime).toBe(16);

    // 2) loadedmetadata fires later with a different initialTimeMs
    _seedPipVideo({
      video,
      alreadySeeded: seeded,
      initialTimeMs: 2_000, // the "handoff" time
      initiallyPlaying: false,
      onSeeded: markSeeded,
    });
    // The user's node-click seek (16s) must NOT be overwritten by
    // the initial handoff (2s).
    expect(video.currentTime).toBe(16);
  });

  it("logs an error and returns skipped_unknown_scene when the scene number is missing from the map", () => {
    const video = fakeVideo();
    const error = vi.fn();
    const outcome = _seekPipForNodeClick({
      video,
      sceneNumber: 99,
      sceneStartTimesMs,
      onSeeded: vi.fn(),
      logger: { error, warn: vi.fn() },
    });
    expect(outcome).toBe("skipped_unknown_scene");
    expect(video.currentTime).toBe(0); // untouched
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("unknown scene");
  });

  it("returns skipped_null_video when the ref is null but the scene exists", () => {
    const onSeeded = vi.fn();
    const outcome = _seekPipForNodeClick({
      video: null,
      sceneNumber: 1,
      sceneStartTimesMs,
      onSeeded,
    });
    expect(outcome).toBe("skipped_null_video");
    expect(onSeeded).not.toHaveBeenCalled();
  });

  it("returns 'failed' and does NOT mark seeded when the currentTime setter throws", () => {
    const error = vi.fn();
    const onSeeded = vi.fn();
    const video = {
      get currentTime(): number {
        return 0;
      },
      set currentTime(_v: number) {
        throw new Error("boom");
      },
      play: vi.fn(async () => undefined),
    } as unknown as FakeVideo;
    const outcome = _seekPipForNodeClick({
      video,
      sceneNumber: 2,
      sceneStartTimesMs,
      onSeeded,
      logger: { error, warn: vi.fn() },
    });
    expect(outcome).toBe("failed");
    expect(onSeeded).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// _computeFinalPipTimeMs
// ────────────────────────────────────────────────────────────────

describe("_computeFinalPipTimeMs", () => {
  it("returns the PiP's currentTime when the video is present AND seeded", () => {
    const video = fakeVideo({ currentTime: 42.5 });
    const final = _computeFinalPipTimeMs({
      video,
      seeded: true,
      initialTimeMs: 10_000,
    });
    expect(final).toBe(42_500);
  });

  it("falls back to initialTimeMs when the PiP was never seeded (close-before-seed race)", () => {
    // THIS is the "close-before-seed" bug fix. Without this
    // fallback, a quick open/close would rewind the main video to 0
    // because an unseeded PiP reports currentTime=0.
    const video = fakeVideo({ currentTime: 0 });
    const warn = vi.fn();
    const final = _computeFinalPipTimeMs({
      video,
      seeded: false,
      initialTimeMs: 37_500,
      logger: { warn, error: vi.fn() },
    });
    expect(final).toBe(37_500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Closed before PiP seeded");
  });

  it("falls back to initialTimeMs when the video ref is null", () => {
    const final = _computeFinalPipTimeMs({
      video: null,
      seeded: false,
      initialTimeMs: 500,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    expect(final).toBe(500);
  });

  it("rounds to whole milliseconds on the seeded happy path", () => {
    const video = fakeVideo({ currentTime: 12.3456 });
    const final = _computeFinalPipTimeMs({
      video,
      seeded: true,
      initialTimeMs: 0,
    });
    // 12.3456 * 1000 = 12345.6 → rounded to 12346
    expect(final).toBe(12_346);
  });
});

// ────────────────────────────────────────────────────────────────
// _nextModalView (view state machine)
// ────────────────────────────────────────────────────────────────

describe("_nextModalView", () => {
  it("resets to graph_pip on 'open' regardless of the current state", () => {
    expect(_nextModalView("graph_pip", "open")).toBe("graph_pip");
    expect(_nextModalView("video_expanded", "open")).toBe("graph_pip");
  });

  it("transitions to video_expanded on 'expand' from graph_pip", () => {
    expect(_nextModalView("graph_pip", "expand")).toBe("video_expanded");
  });

  it("stays in video_expanded on repeated 'expand'", () => {
    expect(_nextModalView("video_expanded", "expand")).toBe("video_expanded");
  });

  it("transitions back to graph_pip on 'collapse'", () => {
    expect(_nextModalView("video_expanded", "collapse")).toBe("graph_pip");
  });

  it("stays in graph_pip on 'collapse' from graph_pip (idempotent)", () => {
    expect(_nextModalView("graph_pip", "collapse")).toBe("graph_pip");
  });
});

describe("_sceneNumberForTimeMs", () => {
  const scenes = new Map<number, number>([
    [1, 0],
    [2, 6000],
    [3, 16000],
    [4, 24000],
    [5, 32000],
  ]);

  it("returns the scene whose startTime is at or before currentTimeMs", () => {
    expect(_sceneNumberForTimeMs(scenes, 12000)).toBe(2);
    expect(_sceneNumberForTimeMs(scenes, 24000)).toBe(4);
    expect(_sceneNumberForTimeMs(scenes, 35000)).toBe(5);
  });

  it("returns scene 1 for currentTimeMs = 0", () => {
    expect(_sceneNumberForTimeMs(scenes, 0)).toBe(1);
  });

  it("returns null for NaN", () => {
    expect(_sceneNumberForTimeMs(scenes, NaN)).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(_sceneNumberForTimeMs(scenes, -1)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(_sceneNumberForTimeMs(scenes, Infinity)).toBeNull();
  });

  it("returns null for an empty map", () => {
    expect(_sceneNumberForTimeMs(new Map(), 5000)).toBeNull();
  });

  it("resolves exact boundary to the matching scene", () => {
    expect(_sceneNumberForTimeMs(scenes, 16000)).toBe(3);
  });

  it("breaks ties by picking the larger sceneNumber", () => {
    // Two scenes share startTimeMs = 0
    const tied = new Map<number, number>([
      [1, 0],
      [2, 0],
      [3, 8000],
    ]);
    expect(_sceneNumberForTimeMs(tied, 0)).toBe(2);
    expect(_sceneNumberForTimeMs(tied, 4000)).toBe(2);
    expect(_sceneNumberForTimeMs(tied, 8000)).toBe(3);
  });
});

describe("_nextSelectedNodeId", () => {
  it("keeps the selected node while playback remains inside its scene membership", () => {
    expect(_nextSelectedNodeId({
      selectedNodeId: "src/lib/Auth.ts",
      nextSceneNumber: 3,
      reviewGraph: makeTwoNodeReviewGraph(),
    })).toBe("src/lib/Auth.ts");
  });

  it("clears the selected node when playback moves outside its scene membership", () => {
    expect(_nextSelectedNodeId({
      selectedNodeId: "src/lib/Auth.ts",
      nextSceneNumber: 2,
      reviewGraph: makeTwoNodeReviewGraph(),
    })).toBeNull();
  });

  it("clears the selected node when playback is outside all scenes", () => {
    expect(_nextSelectedNodeId({
      selectedNodeId: "src/lib/Auth.ts",
      nextSceneNumber: null,
      reviewGraph: makeTwoNodeReviewGraph(),
    })).toBeNull();
  });

  it("leaves selection empty when nothing is selected", () => {
    expect(_nextSelectedNodeId({
      selectedNodeId: null,
      nextSceneNumber: 2,
      reviewGraph: makeTwoNodeReviewGraph(),
    })).toBeNull();
  });
});
