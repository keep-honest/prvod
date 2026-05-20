import { describe, expect, it } from "vitest";
import {
  buildCaptionCues,
  findActiveCaptionCue,
  findHighlightedWordIndex,
} from "@/infrastructure/video/remotion/components/CaptionOverlay";
import type { WordTiming } from "@/interfaces/ITTSService";

const wordTimings: WordTiming[] = [
  { word: "Adds", startTimeMs: 0, endTimeMs: 200 },
  { word: "rate", startTimeMs: 200, endTimeMs: 400 },
  { word: "limit.", startTimeMs: 400, endTimeMs: 600 },
  { word: "before", startTimeMs: 1100, endTimeMs: 1300 },
  { word: "auth", startTimeMs: 1300, endTimeMs: 1500 },
];

describe("CaptionOverlay helpers", () => {
  it("splits caption cues on sentence endings and timing gaps", () => {
    const cues = buildCaptionCues(wordTimings);

    expect(cues).toHaveLength(2);
    expect(cues[0].tokens.map((token) => token.word)).toEqual([
      "Adds",
      "rate",
      "limit.",
    ]);
    expect(cues[1].tokens.map((token) => token.word)).toEqual(["before", "auth"]);
  });

  it("finds the active cue by absolute caption time", () => {
    const cues = buildCaptionCues(wordTimings);

    expect(findActiveCaptionCue(cues, 450)?.tokens[0].word).toBe("Adds");
    expect(findActiveCaptionCue(cues, 1200)?.tokens[0].word).toBe("before");
    expect(findActiveCaptionCue(cues, 2000)).toBeNull();
  });

  it("highlights the exact active word and falls back to the last started word", () => {
    const cue = buildCaptionCues(wordTimings)[1];

    expect(findHighlightedWordIndex(cue, 1200)).toBe(0);
    expect(findHighlightedWordIndex(cue, 1490)).toBe(1);
    expect(findHighlightedWordIndex(cue, 1600)).toBe(1);
  });

  describe("captionOffsetMs arithmetic", () => {
    // Simulates the CaptionOverlay component logic:
    // currentTimeMs = (frame / fps) * 1000 - captionOffsetMs
    const computeCurrentTimeMs = (frame: number, fps: number, offsetMs: number) =>
      (frame / fps) * 1000 - offsetMs;

    it("positive offset delays captions (shifts active cue later in timeline)", () => {
      const cues = buildCaptionCues(wordTimings);
      // At frame 30 / 30fps = 1000ms with no offset → first cue is active
      const noOffset = computeCurrentTimeMs(30, 30, 0);
      expect(noOffset).toBe(1000);
      expect(findActiveCaptionCue(cues, noOffset)).toBeNull(); // 1000ms is between cues

      // At frame 36 / 30fps = 1200ms with no offset → second cue is active
      const atFrame36 = computeCurrentTimeMs(36, 30, 0);
      expect(findActiveCaptionCue(cues, atFrame36)?.tokens[0].word).toBe("before");

      // At frame 36 with +300ms offset → effective time is 900ms → no cue active (gap)
      const withOffset = computeCurrentTimeMs(36, 30, 300);
      expect(withOffset).toBe(900);
      expect(findActiveCaptionCue(cues, withOffset)).toBeNull();
    });

    it("negative offset advances captions (shows cue earlier)", () => {
      const cues = buildCaptionCues(wordTimings);
      // At frame 30 / 30fps = 1000ms with -200ms offset → effective time 1200ms → second cue
      const advanced = computeCurrentTimeMs(30, 30, -200);
      expect(advanced).toBe(1200);
      expect(findActiveCaptionCue(cues, advanced)?.tokens[0].word).toBe("before");
    });

    it("large positive offset produces negative currentTimeMs — no cue found", () => {
      const cues = buildCaptionCues(wordTimings);
      const negative = computeCurrentTimeMs(3, 30, 500);
      expect(negative).toBe(-400);
      expect(findActiveCaptionCue(cues, negative)).toBeNull();
    });
  });
});
