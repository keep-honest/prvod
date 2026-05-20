import { describe, it, expect } from "vitest";
import { videoScriptSchema, codeBrollSchema, sceneSchema, minimumSceneCountForDurations, MIN_SCRIPT_SCENES } from "@/domain/entities/VideoScript";

describe("VideoScript schema", () => {
  const validScene = {
    sceneNumber: 1,
    sceneType: "hook",
    durationSeconds: 8,
    narration: "Test narration",
    codeBroll: [],
  };

  const validScript = {
    changeType: "feature",
    summary: "Test summary",
    scenes: [
      { ...validScene, sceneType: "overview" },
      { ...validScene, sceneNumber: 2, sceneType: "code_walkthrough", durationSeconds: 6 },
      { ...validScene, sceneNumber: 3, sceneType: "code_walkthrough", durationSeconds: 8 },
      { ...validScene, sceneNumber: 4, sceneType: "code_walkthrough", durationSeconds: 6 },
      { ...validScene, sceneNumber: 5, sceneType: "architecture", durationSeconds: 8 },
      { ...validScene, sceneNumber: 6, sceneType: "summary", durationSeconds: 6 },
      { ...validScene, sceneNumber: 7, sceneType: "summary", durationSeconds: 6 },
      { ...validScene, sceneNumber: 8, sceneType: "closing", durationSeconds: 4 },
    ],
    totalDurationSeconds: 52,
    totalWordCount: 150,
    keyFiles: ["src/index.ts"],
    tags: ["feature"],
  };

  it("validates a valid script", () => {
    const result = videoScriptSchema.safeParse(validScript);
    expect(result.success).toBe(true);
  });

  it("rejects scripts whose scene durations sum below 20", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      scenes: [
        { ...validScene, sceneNumber: 1, sceneType: "overview", durationSeconds: 5 },
        { ...validScene, sceneNumber: 2, sceneType: "code_walkthrough", durationSeconds: 5 },
        { ...validScene, sceneNumber: 3, sceneType: "code_walkthrough", durationSeconds: 5 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts scripts above mode duration caps so writer guards can retry or fail", () => {
    const scenes = Array.from({ length: 57 }, (_, i) => ({
      ...validScene,
      sceneNumber: i + 1,
      sceneType: i === 0 ? "overview" : i === 56 ? "summary" : "code_walkthrough",
      durationSeconds: 8,
    }));
    const result = videoScriptSchema.safeParse({
      ...validScript,
      scenes,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-positive totalWordCount", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      totalWordCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty scenes array", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      scenes: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects scene with non-positive durationSeconds", () => {
    expect(sceneSchema.safeParse({ ...validScene, durationSeconds: 0 }).success).toBe(false);
    expect(sceneSchema.safeParse({ ...validScene, durationSeconds: -1 }).success).toBe(false);
    expect(sceneSchema.safeParse({ ...validScene, durationSeconds: 3.5 }).success).toBe(false);
  });

  it("accepts any positive integer duration", () => {
    for (const d of [4, 5, 6, 8, 10]) {
      const result = sceneSchema.safeParse({ ...validScene, durationSeconds: d });
      expect(result.success).toBe(true);
    }
  });

  it("validates scene with codeBroll", () => {
    const result = sceneSchema.safeParse({
      ...validScene,
      sceneType: "code_walkthrough",
      productionAudio: "impact hit, low ambience",
      codeBroll: [{
        filePath: "src/auth.ts",
        code: "function auth() { return true; }",
        language: "typescript",
        lineRange: [1, 5],
        highlights: [3],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("defaults codeBroll to empty array when omitted", () => {
    const result = sceneSchema.parse({
      sceneNumber: 1,
      sceneType: "hook",
      durationSeconds: 8,
      narration: "Test",
    });
    expect(result.codeBroll).toEqual([]);
  });

  it("coerces codeBroll null to empty array (backward compat)", () => {
    const result = sceneSchema.parse({
      sceneNumber: 1,
      sceneType: "hook",
      durationSeconds: 8,
      narration: "Test",
      codeBroll: null,
    });
    expect(result.codeBroll).toEqual([]);
  });

  it("coerces codeBroll single object to one-element array (backward compat)", () => {
    const result = sceneSchema.parse({
      sceneNumber: 2,
      sceneType: "code_walkthrough",
      durationSeconds: 10,
      narration: "Test",
      codeBroll: { filePath: "src/auth.ts", code: "const x = 1;", language: "typescript" },
    });
    expect(result.codeBroll).toHaveLength(1);
    expect(result.codeBroll[0]?.filePath).toBe("src/auth.ts");
  });

  it("validates codeBroll with null lineRange", () => {
    const result = codeBrollSchema.safeParse({
      filePath: "src/index.ts",
      code: "const x = 1;",
      language: "typescript",
      lineRange: null,
      highlights: [],
    });
    expect(result.success).toBe(true);
  });

  it("validates codeBroll defaults highlights to empty array", () => {
    const result = codeBrollSchema.parse({
      filePath: "src/index.ts",
      code: "const x = 1;",
      language: "typescript",
    });
    expect(result.highlights).toEqual([]);
    expect(result.lineRange).toBeNull();
  });

  it("rejects invalid changeType", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      changeType: "invalid",
    });
    expect(result.success).toBe(false);
  });

  describe("overview scene type", () => {
    it("accepts overview as a valid sceneType", () => {
      const result = sceneSchema.safeParse({
        ...validScene,
        sceneType: "overview",
      });
      expect(result.success).toBe(true);
    });

    it("accepts a script with exactly 3 scenes (1 overview + 2 technical, last is closing)", () => {
      const result = videoScriptSchema.safeParse({
        changeType: "feature",
        summary: "Test summary",
        scenes: [
          { ...validScene, sceneNumber: 1, sceneType: "overview", durationSeconds: 8 },
          { ...validScene, sceneNumber: 2, sceneType: "code_walkthrough", durationSeconds: 8 },
          { ...validScene, sceneNumber: 3, sceneType: "closing", durationSeconds: 8 },
        ],
        totalDurationSeconds: 24,
        totalWordCount: 50,
        keyFiles: ["src/index.ts"],
        tags: ["feature"],
      });
      expect(result.success).toBe(true);
    });
  });

  it("auto-corrects totalDurationSeconds to match scene sum", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      totalDurationSeconds: 999,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const expectedSum = validScript.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
      expect(result.data.totalDurationSeconds).toBe(expectedSum);
    }
  });

  it("computes totalDurationSeconds when omitted from input", () => {
    const withoutTotal = Object.fromEntries(
      Object.entries(validScript).filter(([k]) => k !== "totalDurationSeconds"),
    );
    const result = videoScriptSchema.safeParse(withoutTotal);
    expect(result.success).toBe(true);
    if (result.success) {
      const expectedSum = validScript.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
      expect(result.data.totalDurationSeconds).toBe(expectedSum);
    }
  });

  it("rejects scripts when the first scene is not overview", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      scenes: [
        { ...validScript.scenes[0], sceneType: "hook" },
        ...validScript.scenes.slice(1),
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects scripts with overview scenes in middle positions", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      scenes: validScript.scenes.map((scene, index) =>
        index === 1 ? { ...scene, sceneType: "overview" } : scene,
      ),
    });
    expect(result.success).toBe(false);
  });

  it("accepts overview as both first and last scene (constellation closing)", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      scenes: validScript.scenes.map((scene, index) =>
        index === validScript.scenes.length - 1 ? { ...scene, sceneType: "overview" } : scene,
      ),
    });
    expect(result.success).toBe(true);
  });

  it("rejects last scene with non-closing type", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      scenes: validScript.scenes.map((scene, index) =>
        index === validScript.scenes.length - 1 ? { ...scene, sceneType: "code_walkthrough" } : scene,
      ),
    });
    expect(result.success).toBe(false);
  });

  it("rejects scripts with fewer than two technical scenes", () => {
    const result = videoScriptSchema.safeParse({
      changeType: "feature",
      summary: "Test summary",
      scenes: [
        { ...validScene, sceneNumber: 1, sceneType: "overview", durationSeconds: 10 },
        { ...validScene, sceneNumber: 2, sceneType: "summary", durationSeconds: 10 },
      ],
      totalDurationSeconds: 20,
      totalWordCount: 20,
      keyFiles: ["src/index.ts"],
      tags: ["feature"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid sceneType", () => {
    const result = sceneSchema.safeParse({
      ...validScene,
      sceneType: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts voiceSuggestion as optional string", () => {
    const result = videoScriptSchema.safeParse({
      ...validScript,
      voiceSuggestion: "en-US-Neural2-F",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.voiceSuggestion).toBe("en-US-Neural2-F");
    }
  });

  it("allows omitting voiceSuggestion", () => {
    const result = videoScriptSchema.safeParse(validScript);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.voiceSuggestion).toBeUndefined();
    }
  });

});

describe("minimumSceneCountForDurations", () => {
  it("returns MIN_SCRIPT_SCENES for empty array", () => {
    expect(minimumSceneCountForDurations([])).toBe(MIN_SCRIPT_SCENES);
  });

  it("returns MIN_SCRIPT_SCENES for zero duration", () => {
    expect(minimumSceneCountForDurations([0])).toBe(MIN_SCRIPT_SCENES);
  });

  it("returns MIN_SCRIPT_SCENES for negative duration", () => {
    expect(minimumSceneCountForDurations([-5])).toBe(MIN_SCRIPT_SCENES);
  });

  it("returns MIN_SCRIPT_SCENES when ceil result equals the floor", () => {
    // ceil(20/8) = 3 = MIN_SCRIPT_SCENES
    expect(minimumSceneCountForDurations([8])).toBe(MIN_SCRIPT_SCENES);
  });

  it("raises minimum when max duration is small", () => {
    // ceil(20/5) = 4 > MIN_SCRIPT_SCENES
    expect(minimumSceneCountForDurations([5])).toBe(4);
  });

  it("uses the largest duration from the array", () => {
    // max([4, 6, 8]) = 8, ceil(20/8) = 3
    expect(minimumSceneCountForDurations([4, 6, 8])).toBe(MIN_SCRIPT_SCENES);
  });

  it("returns MIN_SCRIPT_SCENES when max duration is large", () => {
    // max([5, 10]) = 10, ceil(20/10) = 2, floor is 3
    expect(minimumSceneCountForDurations([5, 10])).toBe(MIN_SCRIPT_SCENES);
  });
});

// ── Reviewer narration transport stability ─────────────────────────────
// VideoScript is the public transport — reviewer posture must stay implicit
// in narration content, not leak as new public fields.

describe("VideoScript reviewer narration stability", () => {
  it("videoScriptSchema does not contain reviewer-specific public fields", () => {
    const schema = videoScriptSchema;
    const jsonSchema = JSON.stringify(schema);
    // The transport should NOT expose reviewer internals
    expect(jsonSchema).not.toContain("reviewConcerns");
    expect(jsonSchema).not.toContain("reviewPosture");
    expect(jsonSchema).not.toContain("reviewVerdict");
  });
});
