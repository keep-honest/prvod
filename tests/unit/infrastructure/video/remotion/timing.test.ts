import { describe, expect, it } from "vitest";
import {
  getRequiredTotalFrames,
  getSceneNarrationDurationsMs,
  resolveClipRequestDurationSeconds,
  resolveSceneTimeline,
} from "@/infrastructure/video/remotion/timing";
import type { Scene } from "@/domain/entities/VideoScript";

describe("remotion timing", () => {
  it("extends total frames when audio runs longer than script duration", () => {
    const totalFrames = getRequiredTotalFrames(
      60,
      [{ word: "done", startTimeMs: 0, endTimeMs: 60_500 }],
      30,
    );

    expect(totalFrames).toBeGreaterThan(1800);
  });

  it("keeps script duration when there are no word timings", () => {
    const totalFrames = getRequiredTotalFrames(60, [], 30);

    expect(totalFrames).toBe(1800);
  });

  it("expands scene timing when narration exceeds the scripted duration", () => {
    const resolved = resolveSceneTimeline(
      {
        changeType: "feature",
        summary: "Timing",
        headline: "",
        scenes: [
          {
            sceneNumber: 1,
            sceneType: "hook",
            durationSeconds: 4,
            narration: "This scene runs longer than four seconds.",
            codeBroll: [],
          },
        ],
        totalDurationSeconds: 4,
        totalWordCount: 8,
        keyFiles: [],
        tags: [],
        narrativeRoles: [],
        voiceAssignments: [],
      },
      [
        { word: "This", startTimeMs: 0, endTimeMs: 900 },
        { word: "scene", startTimeMs: 900, endTimeMs: 1800 },
        { word: "runs", startTimeMs: 1800, endTimeMs: 2700 },
        { word: "longer", startTimeMs: 2700, endTimeMs: 3600 },
        { word: "than", startTimeMs: 3600, endTimeMs: 4500 },
        { word: "four", startTimeMs: 4500, endTimeMs: 5400 },
        { word: "seconds.", startTimeMs: 5400, endTimeMs: 6300 },
      ],
      30,
    );

    expect(resolved.scenes[0].durationSeconds).toBe(7);
    expect(resolved.totalDurationSeconds).toBe(7);
  });

  it("rounds clip requests up to the next supported duration", () => {
    expect(resolveClipRequestDurationSeconds(8, [5, 10, 15])).toBe(10);
    expect(resolveClipRequestDurationSeconds(6, [4, 6, 8])).toBe(6);
  });

  it("returns the original script reference when no timing changes are needed", () => {
    // Script has 6s scene; narration is 5s → does not exceed durationSeconds → no change.
    const script = {
      changeType: "feature" as const,
      summary: "",
      headline: "",
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "hook" as const,
          durationSeconds: 6,
          narration: "five words here today",
          codeBroll: [],
        },
      ],
      totalDurationSeconds: 6,
      totalWordCount: 5,
      keyFiles: [],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
    };
    // 4 word timings spanning 0–2000ms (2s) — well within 6s — so no expansion needed.
    const wordTimings = [
      { word: "five", startTimeMs: 0, endTimeMs: 400 },
      { word: "words", startTimeMs: 400, endTimeMs: 800 },
      { word: "here", startTimeMs: 800, endTimeMs: 1200 },
      { word: "today", startTimeMs: 1200, endTimeMs: 2000 },
    ];
    const resolved = resolveSceneTimeline(script, wordTimings, 30);
    // Identity return: same reference when nothing changed.
    expect(resolved).toBe(script);
  });
});

function makeScene(sceneNumber: number, narration: string): Scene {
  return {
    sceneNumber,
    sceneType: "code_walkthrough",
    durationSeconds: 6,
    narration,
    codeBroll: [],
  };
}

describe("getSceneNarrationDurationsMs — proportional fallback path", () => {
  it("returns zero durations when wordTimings is empty", () => {
    const scenes = [makeScene(1, "one two"), makeScene(2, "three four")];
    expect(getSceneNarrationDurationsMs(scenes, [])).toEqual([0, 0]);
  });

  it("proportionally distributes audioSpanMs when wordCount mismatches totalSceneWords", () => {
    // Scene 1 has 4 words, scene 2 has 2 words → 6 total.
    // wordTimings only has 4 entries (mismatch) so proportional path is taken.
    // audioSpanMs = 3900 - 0 = 3900ms.
    // Scene 1 gets 4/6 × 3900 = 2600ms; scene 2 gets 2/6 × 3900 = 1300ms.
    const scenes = [
      makeScene(1, "alpha beta gamma delta"),
      makeScene(2, "epsilon zeta"),
    ];
    const wordTimings = [
      { word: "alpha", startTimeMs: 0, endTimeMs: 1000 },
      { word: "beta", startTimeMs: 1000, endTimeMs: 2000 },
      { word: "gamma", startTimeMs: 2000, endTimeMs: 3000 },
      { word: "delta", startTimeMs: 3000, endTimeMs: 3900 },
    ];
    const [dur1, dur2] = getSceneNarrationDurationsMs(scenes, wordTimings);
    expect(dur1).toBe(Math.round((4 / 6) * 3900));
    expect(dur2).toBe(Math.round((2 / 6) * 3900));
  });

  it("assigns zero duration to scenes with no words in proportional path", () => {
    const scenes = [
      makeScene(1, "one two three"),
      makeScene(2, ""),
    ];
    // 4 timings for a 3-word total → mismatch → proportional path.
    // Scene 2 has 0 words → returns 0 regardless of audioSpanMs.
    const wordTimings = [
      { word: "one", startTimeMs: 0, endTimeMs: 400 },
      { word: "two", startTimeMs: 400, endTimeMs: 800 },
      { word: "three", startTimeMs: 800, endTimeMs: 1200 },
      { word: "extra", startTimeMs: 1200, endTimeMs: 1600 },
    ];
    const [dur1, dur2] = getSceneNarrationDurationsMs(scenes, wordTimings);
    expect(dur2).toBe(0);
    expect(dur1).toBeGreaterThan(0);
  });
});

describe("getSceneNarrationDurationsMs — exact-match path (multi-scene)", () => {
  it("slices word timings per scene using advancing wordIndex", () => {
    // Scene 1: 3 words (0–1200ms). Scene 2: 4 words (1500–4500ms).
    // wordTimings.length (7) === totalSceneWords (7) → exact-match path.
    // Scene 1 duration: lastWord.endTimeMs - firstWord.startTimeMs = 1200 - 0 = 1200ms.
    // Scene 2 duration: 4500 - 1500 = 3000ms.
    const scenes = [
      makeScene(1, "alpha beta gamma"),
      makeScene(2, "delta epsilon zeta eta"),
    ];
    const wordTimings = [
      { word: "alpha", startTimeMs: 0, endTimeMs: 400 },
      { word: "beta", startTimeMs: 400, endTimeMs: 800 },
      { word: "gamma", startTimeMs: 800, endTimeMs: 1200 },
      { word: "delta", startTimeMs: 1500, endTimeMs: 2000 },
      { word: "epsilon", startTimeMs: 2000, endTimeMs: 2750 },
      { word: "zeta", startTimeMs: 2750, endTimeMs: 3500 },
      { word: "eta", startTimeMs: 3500, endTimeMs: 4500 },
    ];
    const [dur1, dur2] = getSceneNarrationDurationsMs(scenes, wordTimings);
    expect(dur1).toBe(1200); // 1200 - 0
    expect(dur2).toBe(3000); // 4500 - 1500
  });

  it("returns zero for a zero-word scene without consuming timings for subsequent scenes", () => {
    // Scene 1: 0 words. Scene 2: 3 words. Scene 3: 2 words.
    // wordIndex must NOT advance for scene 1; scenes 2+3 get their own slices.
    const scenes = [
      makeScene(1, ""),
      makeScene(2, "one two three"),
      makeScene(3, "four five"),
    ];
    const wordTimings = [
      { word: "one", startTimeMs: 0, endTimeMs: 500 },
      { word: "two", startTimeMs: 500, endTimeMs: 1000 },
      { word: "three", startTimeMs: 1000, endTimeMs: 1500 },
      { word: "four", startTimeMs: 2000, endTimeMs: 2500 },
      { word: "five", startTimeMs: 2500, endTimeMs: 3000 },
    ];
    const [dur1, dur2, dur3] = getSceneNarrationDurationsMs(scenes, wordTimings);
    expect(dur1).toBe(0);        // zero-word scene
    expect(dur2).toBe(1500);     // 1500 - 0
    expect(dur3).toBe(1000);     // 3000 - 2000
  });
});
