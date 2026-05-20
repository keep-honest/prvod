import { describe, expect, it } from "vitest";
import { msToASS, generateCaptionASS } from "@/infrastructure/video/ffmpeg/caption-builder";
import type { SceneTimelineEntry } from "@/interfaces/IClipAsset";
import type { WordTiming } from "@/interfaces/ITTSService";

// ── msToASS ──────────────────────────────────────────────────────────

describe("msToASS", () => {
  it("converts 0ms to 0:00:00.00", () => {
    expect(msToASS(0)).toBe("0:00:00.00");
  });

  it("converts 1500ms to 0:00:01.50", () => {
    expect(msToASS(1500)).toBe("0:00:01.50");
  });

  it("converts 61000ms to 0:01:01.00", () => {
    expect(msToASS(61000)).toBe("0:01:01.00");
  });

  it("converts 3661000ms to 1:01:01.00", () => {
    expect(msToASS(3661000)).toBe("1:01:01.00");
  });

  it("clamps negative ms to 0:00:00.00", () => {
    expect(msToASS(-500)).toBe("0:00:00.00");
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function makeWord(word: string, startTimeMs: number, endTimeMs: number): WordTiming {
  return { word, startTimeMs, endTimeMs };
}

function makeScene(
  sceneNumber: number,
  durationFrames: number,
  wordTimings?: WordTiming[],
  durationSeconds?: number,
): SceneTimelineEntry {
  return {
    sceneNumber,
    durationFrames,
    wordTimings,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

const ASS_HEADER_MARKER = "[Script Info]";
const DIALOGUE_PREFIX = "Dialogue: 0,";

// ── generateCaptionASS ───────────────────────────────────────────────

describe("generateCaptionASS", () => {
  it("returns ASS header only when sceneTimeline has no wordTimings", () => {
    const timeline = [makeScene(1, 150)];
    const result = generateCaptionASS(timeline, 0);

    expect(result).toContain(ASS_HEADER_MARKER);
    expect(result).not.toContain(DIALOGUE_PREFIX);
  });

  it("returns ASS header only when wordTimings is an empty array", () => {
    const timeline = [makeScene(1, 150, [])];
    const result = generateCaptionASS(timeline, 0);

    expect(result).toContain(ASS_HEADER_MARKER);
    expect(result).not.toContain(DIALOGUE_PREFIX);
  });

  it("emits one dialogue per cue with per-word alpha reveal tags", () => {
    const words = [
      makeWord("Hello", 0, 400),
      makeWord("world", 400, 900),
    ];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    // One Dialogue per cue (not per word) so libass renders as a single phrase
    expect(dialogueLines).toHaveLength(1);
    // Both words in one line
    expect(dialogueLines[0]).toContain("Hello");
    expect(dialogueLines[0]).toContain("world");
    // No \kf tags — per-word reveal uses \alpha + \t instead
    expect(result).not.toContain("\\kf");
    // "world" starts hidden and reveals at 400ms offset from cue start
    expect(dialogueLines[0]).toContain("\\alpha&HFF&");
    expect(dialogueLines[0]).toContain("\\t(400,400,\\alpha&H00&)");
    // "Hello" (first word) has no alpha override — visible from cue start
    expect(dialogueLines[0]).toMatch(/,,Hello /);
  });

  it("offsets timestamps correctly for multi-scene timelines", () => {
    // Scene 1: 150 frames at 30fps = 5000ms offset for scene 2
    const scene1Words = [makeWord("first", 0, 400)];
    const scene2Words = [makeWord("second", 0, 400)];
    const timeline = [
      makeScene(1, 150, scene1Words), // 150 frames / 30fps = 5s
      makeScene(2, 90, scene2Words),
    ];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(2);

    // Scene 1 starts at 0ms → 0:00:00.00
    expect(dialogueLines[0]).toContain("0:00:00.00");
    // Scene 2 starts at 5000ms → 0:00:05.00
    expect(dialogueLines[1]).toContain("0:00:05.00");
  });

  it("applies positive captionOffsetMs (delay)", () => {
    const words = [makeWord("delayed", 0, 500)];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, 200);

    // Start at 0 + 200ms = 200ms → centiseconds = 20 → 0:00:00.20
    expect(result).toContain("0:00:00.20");
  });

  it("applies negative captionOffsetMs (advance) and skips cues that end before 0", () => {
    // Word runs 100ms–500ms. With -600ms offset, endMs = 500 - 600 = -100ms < 0 → skip
    const words = [makeWord("early", 100, 500)];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, -600);

    expect(result).not.toContain(DIALOGUE_PREFIX);
  });

  it("keeps cues whose endMs is positive after negative offset", () => {
    // Word runs 800ms–1200ms. With -500ms offset, endMs = 700ms > 0 → keep
    const words = [makeWord("kept", 800, 1200)];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, -500);

    expect(result).toContain(DIALOGUE_PREFIX);
    expect(result).toContain("kept");
  });

  it("rebases per-word reveal offsets when negative offset clamps cue start to 0", () => {
    // Two words: "hello" at 100-400ms, "world" at 400-800ms.
    // With -300ms offset: cue rawStart = 100-300 = -200ms → clamped to 0ms.
    // "hello" absolute = 100-300 = -200ms → offset from dialogue start (0) = -200 → visible immediately
    // "world" absolute = 400-300 = 100ms → offset from dialogue start (0) = 100ms → reveal at 100ms
    const words = [
      makeWord("hello", 100, 400),
      makeWord("world", 400, 800),
    ];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, -300);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    // Dialogue starts at 0:00:00.00 (clamped from -200ms)
    expect(dialogueLines[0]).toMatch(/^Dialogue: 0,0:00:00\.00,/);
    // "hello" visible immediately (no alpha override)
    expect(dialogueLines[0]).toContain(",,hello ");
    // "world" reveals at 100ms offset from dialogue start (not 300ms from unclamped cue start)
    expect(dialogueLines[0]).toContain("\\t(100,100,\\alpha&H00&)");
  });

  it("clamps caption endMs to scene boundary when offset pushes it past the cut", () => {
    // Scene is 90 frames = 3000ms. Word at 2500-2900ms + 200ms offset →
    // start at 2700ms, raw end at 3100ms. Must clamp end to 3000ms.
    const words = [makeWord("edge", 2500, 2900)];
    const timeline = [makeScene(1, 90, words)]; // 90 frames / 30fps = 3000ms
    const result = generateCaptionASS(timeline, 200);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    // End time should be clamped to 3000ms (scene boundary), not 3100ms
    expect(dialogueLines[0]).toContain(",0:00:03.00,");
    // Start should be at 2700ms
    expect(dialogueLines[0]).toContain("0:00:02.70,");
  });

  it("skips scenes with undefined wordTimings and still accumulates frame offset", () => {
    // Scene 1: no timings, 90 frames (3s). Scene 2: has timings.
    const scene2Words = [makeWord("after", 0, 400)];
    const timeline = [
      makeScene(1, 90),          // no wordTimings property
      makeScene(2, 60, scene2Words),
    ];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    // Scene 2 starts at 90/30 = 3s = 3000ms → 0:00:03.00
    expect(dialogueLines[0]).toContain("0:00:03.00");
  });

  it("uses durationSeconds for precise scene boundaries when present", () => {
    // durationFrames=184 → 184/30 = 6133.33ms (frame-quantized)
    // durationSeconds=6.12 → 6120ms (precise probed value)
    // The caption end must use 6120ms, not 6133ms.
    const words = [makeWord("precise", 5900, 6200)];
    const timeline = [makeScene(1, 184, words, 6.12)];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    // End should be clamped to 6120ms (durationSeconds), not 6133ms (durationFrames/FPS)
    // 6120ms → 612 centiseconds → 0:00:06.12
    expect(dialogueLines[0]).toContain(",0:00:06.12,");
  });

  it("eliminates cumulative drift across 7 scenes with fractional probed durations", () => {
    // Each scene has durationSeconds that differs from durationFrames/FPS.
    // Over 7 scenes the frame-based approach would accumulate ~37ms drift;
    // the precise approach should hit the exact sum of durationSeconds.
    const scenes: Array<{ frames: number; seconds: number }> = [
      { frames: 184, seconds: 6.12 },  // 184/30 = 6.1333...
      { frames: 153, seconds: 5.08 },  // 153/30 = 5.1
      { frames: 122, seconds: 4.05 },  // 122/30 = 4.0666...
      { frames: 214, seconds: 7.12 },  // 214/30 = 7.1333...
      { frames: 91, seconds: 3.02 },   // 91/30  = 3.0333...
      { frames: 183, seconds: 6.08 },  // 183/30 = 6.1
      { frames: 152, seconds: 5.06 },  // 152/30 = 5.0666...
    ];
    const timeline = scenes.map((s, i) =>
      makeScene(i + 1, s.frames, [makeWord("w", 0, 100)], s.seconds),
    );
    const result = generateCaptionASS(timeline, 0);
    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(7);

    // Scene 7 starts at sum(durationSeconds[1..6]) = 6.12+5.08+4.05+7.12+3.02+6.08 = 31.47s
    // Frame-based: sum(frames[1..6])/30 = (184+153+122+214+91+183)/30 = 947/30 = 31.5666...s
    // The ASS dialogue START must use the precise value (31470ms → 0:00:31.47),
    // NOT the frame-quantized value (31567ms → 0:00:31.57).
    const scene7Line = dialogueLines[6];
    // Extract the Start timestamp (field after "Dialogue: 0,")
    const startTimestamp = scene7Line.split(",")[1];
    expect(startTimestamp).toBe("0:00:31.47");
    // Frame-based would give 0:00:31.57 — verify the start is NOT that
    expect(startTimestamp).not.toBe("0:00:31.57");
  });

  it("falls back to durationFrames/FPS when durationSeconds is absent", () => {
    // No durationSeconds set — should behave identically to pre-fix code.
    const scene1Words = [makeWord("one", 0, 400)];
    const scene2Words = [makeWord("two", 0, 400)];
    const timeline = [
      makeScene(1, 150, scene1Words), // 150/30 = 5s, no durationSeconds
      makeScene(2, 90, scene2Words),  // 90/30  = 3s, no durationSeconds
    ];
    const result = generateCaptionASS(timeline, 0);
    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(2);

    // Scene 2 starts at 150/30*1000 = 5000ms → 0:00:05.00
    expect(dialogueLines[1]).toContain("0:00:05.00");
  });

  it("restores 'dot' tokens into dotted filenames in caption text", () => {
    const words = [
      makeWord("auth", 0, 300),
      makeWord("dot", 320, 520),
      makeWord("ts", 540, 700),
    ];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    // "dot" token merged: caption should show "auth.ts" not "auth dot ts"
    expect(dialogueLines[0]).toContain("auth.ts");
    expect(dialogueLines[0]).not.toContain(" dot ");
  });

  it("restores format names (Yaml → YAML) in caption text", () => {
    const words = [
      makeWord("The", 0, 200),
      makeWord("Yaml", 220, 500),
      makeWord("config", 520, 800),
    ];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    expect(dialogueLines[0]).toContain("YAML");
    expect(dialogueLines[0]).not.toContain("Yaml");
  });

  it("restores chained dots and lowercases format extension in compound token", () => {
    const words = [
      makeWord("config", 0, 400),
      makeWord("dot", 420, 580),
      makeWord("prod", 600, 900),
      makeWord("dot", 920, 1080),
      makeWord("Yaml", 1100, 1500),
    ];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    // Dots merge first → config.prod.Yaml, then extension restored to lowercase
    expect(dialogueLines[0]).toContain("config.prod.yaml");
  });

  it("restores parkay through the full dot-merge + format-name chain (data.parquet)", () => {
    // TTS receives "data dot parkay"; captions should display "data.parquet"
    const words = [
      makeWord("data", 0, 300),
      makeWord("dot", 320, 520),
      makeWord("parkay", 540, 900),
    ];
    const timeline = [makeScene(1, 150, words)];
    const result = generateCaptionASS(timeline, 0);

    const dialogueLines = result.split("\n").filter((l) => l.startsWith(DIALOGUE_PREFIX));
    expect(dialogueLines).toHaveLength(1);
    expect(dialogueLines[0]).toContain("data.parquet");
    expect(dialogueLines[0]).not.toContain("parkay");
  });
});
