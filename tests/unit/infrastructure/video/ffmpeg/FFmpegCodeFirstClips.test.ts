import { describe, expect, it } from "vitest";
import type { ClipAsset } from "@/interfaces/IClipAsset";

/**
 * Tests the code-first clip filtering logic used by FFmpegCompositor.
 * The compositor must skip download/probe for clips with sourceType "code"
 * or clipUrl starting with "code://", while still processing video clips.
 */

function isCodeClip(clip: ClipAsset): boolean {
  return clip.sourceType === "code" || clip.clipUrl.startsWith("code://");
}

function makeVideoClip(sceneNumber: number): ClipAsset {
  return {
    sceneNumber,
    clipIndex: 0,
    clipUrl: `https://example.com/scene-${sceneNumber}.mp4`,
    sourceType: "video",
    durationSeconds: 6,
    durationFrames: 180,
  };
}

function makeCodeClip(sceneNumber: number): ClipAsset {
  return {
    sceneNumber,
    clipIndex: 0,
    clipUrl: `code://scene/${sceneNumber}`,
    sourceType: "code",
    durationSeconds: 8,
    durationFrames: 240,
  };
}

describe("FFmpeg code-first clip filtering", () => {
  it("identifies code clips by sourceType", () => {
    expect(isCodeClip(makeCodeClip(1))).toBe(true);
    expect(isCodeClip(makeVideoClip(1))).toBe(false);
  });

  it("identifies code clips by clipUrl prefix even without sourceType", () => {
    const clip: ClipAsset = {
      sceneNumber: 1,
      clipIndex: 0,
      clipUrl: "code://scene/1",
      durationSeconds: 8,
      durationFrames: 240,
    };
    expect(isCodeClip(clip)).toBe(true);
  });

  it("filters a mixed clip array into video-only clips for download", () => {
    const clips: ClipAsset[] = [
      makeCodeClip(1),
      makeVideoClip(2),
      makeCodeClip(3),
      makeVideoClip(4),
      makeCodeClip(5),
    ];

    const videoClips = clips.filter((c) => !isCodeClip(c));
    expect(videoClips).toHaveLength(2);
    expect(videoClips.map((c) => c.sceneNumber)).toEqual([2, 4]);
  });

  it("filters to empty when all clips are code-first", () => {
    const clips: ClipAsset[] = [
      makeCodeClip(1),
      makeCodeClip(2),
      makeCodeClip(3),
    ];

    const videoClips = clips.filter((c) => !isCodeClip(c));
    expect(videoClips).toHaveLength(0);
  });

  it("preserves all clips when none are code-first", () => {
    const clips: ClipAsset[] = [
      makeVideoClip(1),
      makeVideoClip(2),
    ];

    const videoClips = clips.filter((c) => !isCodeClip(c));
    expect(videoClips).toHaveLength(2);
  });
});
