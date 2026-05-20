import { describe, it, expect, vi } from "vitest";
import {
  buildJsonShapeHint,
  buildNarrationRetimeJsonShapeHint,
  buildNarrationRetimeSystemPrompt,
  buildNarrationRetimeUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  warnOnScriptDefaults,
} from "@/infrastructure/llm/script-prompt";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { PRContext } from "@/domain/entities/PRContext";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";

const mockContext: PRContext = {
  repoFullName: "owner/repo",
  prNumber: 42,
  prTitle: "Test PR",
  prDescription: "A test PR",
  diffSource: { kind: "github_pr" as const, repoFullName: "owner/repo", prNumber: 42, installationId: 1 },
  baseBranch: "main",
  headBranch: "feature",
  headSha: "",
  issues: [],
  milestone: null,
  isPrivate: false,
  durationMode: "default",
  deepdive: false,
};

const mockAnalysis: DiffAnalysis = {
  totalFilesChanged: 1,
  totalLinesAdded: 10,
  totalLinesRemoved: 5,
  suggestedChangeType: "feature",
  files: [],
  topFiles: [
    { filePath: "src/test.ts", linesAdded: 10, linesRemoved: 5, isNew: false, isDeleted: false, isRenamed: false, directory: "src", importanceScore: 10 },
  ],
  directoryGroups: {},
  topFileDiffs: { "src/test.ts": "+added\n-removed" },
};

describe("buildSystemPrompt", () => {
  it("throws on empty validDurations", () => {
    expect(() => buildSystemPrompt([])).toThrow("validDurations must not be empty");
  });

  it("includes Wan 2.5 durations (5, 10)", () => {
    const prompt = buildSystemPrompt([5, 10]);
    expect(prompt).toContain("MUST be exactly one of: 5, 10");
    expect(prompt).not.toContain("4, 6, or 8");
  });

  it("includes Veo 3 durations (4, 6, 8)", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("MUST be exactly one of: 4, 6, 8");
  });

  it("includes content focus constraints", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Content rules (CRITICAL)");
    expect(prompt).toContain("NEVER describe the project in general terms");
    expect(prompt).toContain("Every narration sentence must reference a specific change from THIS PR");
  });

  it("includes voice selection instructions with Chirp voices", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Voice selection");
    expect(prompt).toContain("voiceSuggestion");
    expect(prompt).toContain("Chirp HD");
    expect(prompt).toContain("Chirp3 HD");
    expect(prompt).toContain("en-US-Chirp3-HD-Algenib");
    expect(prompt).not.toContain("Journey");
  });

  it("includes file name pronunciation guidance", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("File name pronunciation");
    expect(prompt).toContain('spoken like "VideoOrchestrator dot ts"');
  });

  it("separates spoken narration from non-spoken production audio", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Narration is SPOKEN TEXT ONLY");
    expect(prompt).toContain("put it in productionAudio");
  });

  it("does not include removed cinematic visual grounding", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).not.toContain("Failure modes that count as wrong");
    expect(prompt).not.toContain("Character-driven examples");
  });

  it("includes instructor narrator style with progressive deepening", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("progressively explains");
  });

  it("does not include protagonist or visualWorld in system prompt", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).not.toContain("Story Foundation");
    expect(prompt).not.toContain("Protagonist");
    expect(prompt).not.toContain("Visual World");
  });

  it("does not include protagonist or visualWorld in JSON shape hint", () => {
    const hint = buildJsonShapeHint([4, 6, 8]);
    expect(hint).not.toContain("protagonist:");
    expect(hint).not.toContain("visualWorld:");
  });
});

describe("technical visual grounding instructions", () => {
  it("buildSystemPrompt does not include removed visual derivation tests", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).not.toContain("Narration swap test");
    expect(prompt).not.toContain("Technical mechanism test");
  });

  it("buildSystemPrompt recommends codeBroll for architecture scenes", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("architecture scenes: codeBroll is recommended");
  });

  it("buildSystemPrompt sets codeBroll to [] for overview scenes", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("overview scenes: always set codeBroll to []");
  });
});

describe("technical depth and scene grouping instructions", () => {
  it("buildSystemPrompt includes Technical Depth Strategy section", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Technical Depth Strategy");
  });

  it("buildSystemPrompt includes depth tiers for small, medium, and large PRs", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Small PRs (1–3 files)");
    expect(prompt).toContain("Medium PRs (4–10 files)");
    expect(prompt).toContain("Large PRs (10+ files)");
  });

  it("buildSystemPrompt includes Scene Grouping section", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Scene Grouping");
  });

  it("buildSystemPrompt defines technical detail dimensions", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("data flow");
    expect(prompt).toContain("control flow");
    expect(prompt).toContain("error handling");
  });

  it("buildSystemPrompt includes scaled word target", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("2.75 words per second");
  });

  it("buildSystemPrompt raises the minimum scene count for 5-second-only models", () => {
    const prompt = buildSystemPrompt([5]);
    expect(prompt).toContain("Use 4–24 scenes");
  });
});

describe("buildJsonShapeHint", () => {
  it("does not throw on empty validDurations (code-first fallback)", () => {
    expect(() => buildJsonShapeHint([])).not.toThrow();
  });

  it("uses advisory durationSeconds field for code-first", () => {
    const hint = buildJsonShapeHint([5, 10]);
    expect(hint).toContain("durationSeconds");
    expect(hint).toContain("Set durationSeconds to any positive integer");
  });

  it("includes content focus constraint", () => {
    const hint = buildJsonShapeHint([4, 6, 8]);
    expect(hint).toContain("CONTENT FOCUS (CRITICAL)");
    expect(hint).toContain("THIS PR's specific changes only");
  });

  it("instructs raw JSON output (no markdown fences)", () => {
    const hint = buildJsonShapeHint([4, 6, 8]);
    expect(hint).toContain("Return ONLY raw JSON (no markdown fences, no preamble)");
  });

  it("includes optional productionAudio in the JSON shape", () => {
    const hint = buildJsonShapeHint([4, 6, 8]);
    expect(hint).toContain("productionAudio?: string");
  });

  it("includes the dynamic minimum scene count for 5-second-only models", () => {
    const hint = buildJsonShapeHint([5]);
    expect(hint).toContain("Use 4-24 scenes to reach 20-120s total");
  });
});

describe("overview scene prompt instructions", () => {
  it("buildSystemPrompt includes Overview Scene section", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Overview Scene");
  });

  it("buildSystemPrompt instructs overview as scene 1", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain('sceneType: "overview"');
  });

  it("buildJsonShapeHint includes overview in sceneType union", () => {
    const hint = buildJsonShapeHint([4, 6, 8]);
    expect(hint).toContain("overview");
  });
});

describe("buildUserPrompt", () => {
  it("uses validDurations in the instruction text", () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis, [5, 10]);
    expect(prompt).toContain("Each scene must be exactly 5 or 10 seconds.");
  });

  it("uses a 4-scene minimum for 5-second-only models", () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis, [5]);
    expect(prompt).toContain("Generate a 4-24 scene video script");
  });

  it("falls back to default durations when not provided", () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis);
    expect(prompt).toContain("Each scene must be exactly 4, 6, or 8 seconds.");
  });

  it("includes PR metadata", () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis, [5, 10]);
    expect(prompt).toContain("PR #42: Test PR");
    expect(prompt).toContain("Files changed: 1");
  });

  it("includes content focus instructions", () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis, [5, 10]);
    expect(prompt).toContain("IMPORTANT: Content Instructions");
    expect(prompt).toContain("THIS SPECIFIC PR's changes, not the project in general");
  });

  it("requires scene visuals to be specific enough to fail when reused", () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis, [5, 10]);
    expect(prompt).toContain("The visual should fail if reused for a different PR");
  });
});

describe("narration retime prompts", () => {
  const script: VideoScript = {
    changeType: "feature",
    summary: "Retiming",
    headline: "",
    scenes: [
      {
        sceneNumber: 1,
        sceneType: "hook",
        durationSeconds: 8,
        narration: "The auth guard blocks duplicate requests before auth() runs.",
        productionAudio: "low bass hit",
        codeBroll: [{
          filePath: "src/auth.ts",
          code: "checkRateLimit();",
          language: "typescript",
          lineRange: [2, 2],
          highlights: [2],
        }],
      },
    ],
    totalDurationSeconds: 8,
    totalWordCount: 9,
    keyFiles: ["src/auth.ts"],
    tags: ["feature"],
    narrativeRoles: [],
    voiceAssignments: [],
  };

  it("builds retime system prompt with narration-only constraints", () => {
    const prompt = buildNarrationRetimeSystemPrompt();
    expect(prompt).toContain("Rewrite narration only");
    expect(prompt).toContain("Do not modify productionAudio");
    expect(prompt).toContain("SPOKEN TEXT ONLY");
  });

  it("builds retime system prompt with delivery guidance", () => {
    const prompt = buildNarrationRetimeSystemPrompt();
    // Should contain some delivery/tone guidance
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("builds retime system prompt with instructor narrator style", () => {
    // Already tested below but this replaces the removed theme-specific test
    const prompt = buildNarrationRetimeSystemPrompt();
    expect(prompt).toContain("instructor narrator");
  });

  it("builds retime system prompt with instructor narrator style", () => {
    const prompt = buildNarrationRetimeSystemPrompt();
    expect(prompt).toContain("instructor narrator");
  });

  it("builds retime user prompt with clip budgets and locked visual context", () => {
    const prompt = buildNarrationRetimeUserPrompt(
      mockContext,
      mockAnalysis,
      script,
      [{ sceneNumber: 1, durationFrames: 240, durationMs: 8000, maxWords: 18 }],
      [1],
    );
    expect(prompt).toContain("Rewrite ONLY these scenes: 1");
    expect(prompt).toContain("240 frames / 8000ms / max 18 words");
    expect(prompt).toContain("codeBrollFile: src/auth.ts");
  });

  it("describes the raw JSON retime shape", () => {
    const hint = buildNarrationRetimeJsonShapeHint();
    expect(hint).toContain("sceneNumber: number");
    expect(hint).toContain("narration: string");
    expect(hint).toContain("Return ONLY raw JSON");
  });
});

// ---------------------------------------------------------------------------
// warnOnScriptDefaults
// ---------------------------------------------------------------------------

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeScene(overrides: Partial<VideoScript["scenes"][0]> = {}): VideoScript["scenes"][0] {
  return {
    sceneNumber: 1,
    sceneType: "hook",
    durationSeconds: 8,
    narration: "Test narration.",
    codeBroll: [],
    ...overrides,
  };
}

function makeScriptFromScenes(scenes: VideoScript["scenes"]): VideoScript {
  return {
    changeType: "feature",
    summary: "Test",
    headline: "",
    scenes,
    totalDurationSeconds: scenes.reduce((s, sc) => s + sc.durationSeconds, 0),
    totalWordCount: 150,
    keyFiles: [],
    tags: [],
    narrativeRoles: [],
    voiceAssignments: [],
  };
}

describe("warnOnScriptDefaults", () => {
  it("emits no warnings when everything is valid", () => {
    const logger = makeLogger();
    const rawInput = {
      scenes: [{ sceneNumber: 1, sceneType: "hook", durationSeconds: 8, narration: "x", codeBroll: null }],
      voiceSuggestion: "en-US-Neural2-D",
    };
    const parsed = { ...makeScriptFromScenes([makeScene()]), voiceSuggestion: "en-US-Neural2-D" };
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when rawInput is null", () => {
    const logger = makeLogger();
    warnOnScriptDefaults(null, makeScriptFromScenes([makeScene()]), [4, 6, 8], logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a plain object"),
      expect.any(Object),
    );
  });

  it("warns when rawInput is an array", () => {
    const logger = makeLogger();
    warnOnScriptDefaults([], makeScriptFromScenes([makeScene()]), [4, 6, 8], logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a plain object"),
      expect.any(Object),
    );
  });

  it("warns when durationSeconds is not in validDurations", () => {
    const logger = makeLogger();
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "hook", durationSeconds: 5, narration: "x", codeBroll: null }] };
    const parsed = makeScriptFromScenes([makeScene({ durationSeconds: 5 })]);
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid durationSeconds"),
      expect.objectContaining({ returned: 5, validDurations: [4, 6, 8] }),
    );
  });

  it("does not warn when durationSeconds is valid", () => {
    const logger = makeLogger();
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "hook", durationSeconds: 8, narration: "x", codeBroll: null }] };
    const parsed = makeScriptFromScenes([makeScene({ durationSeconds: 8 })]);
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("invalid durationSeconds"), expect.anything());
  });

  it("warns when codeBroll is undefined in raw (Zod defaulted to null)", () => {
    const logger = makeLogger();
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "code_walkthrough", durationSeconds: 8, narration: "x" }] };
    const parsed = makeScriptFromScenes([makeScene({ sceneType: "code_walkthrough", codeBroll: [] })]);
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("omitted codeBroll"),
      expect.objectContaining({ sceneNumber: 1 }),
    );
  });

  it("does not warn when codeBroll is explicitly null in raw", () => {
    const logger = makeLogger();
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "hook", durationSeconds: 8, narration: "x", codeBroll: null }] };
    const parsed = makeScriptFromScenes([makeScene({ codeBroll: [] })]);
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("omitted codeBroll"), expect.anything());
  });

  it("warns when codeBroll.lineRange is omitted (Zod defaulted to null)", () => {
    const logger = makeLogger();
    const broll = { filePath: "src/foo.ts", code: "const x = 1;", language: "typescript" };
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "code_walkthrough", durationSeconds: 8, narration: "x", codeBroll: [broll] }] };
    const parsed = makeScriptFromScenes([makeScene({ sceneType: "code_walkthrough", codeBroll: [{ ...broll, lineRange: null, highlights: [] }] })]);
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("omitted codeBroll.lineRange"),
      expect.objectContaining({ filePath: "src/foo.ts" }),
    );
  });

  it("warns when codeBroll.highlights is omitted (Zod defaulted to [])", () => {
    const logger = makeLogger();
    const broll = { filePath: "src/bar.ts", code: "const y = 2;", language: "typescript" };
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "code_walkthrough", durationSeconds: 8, narration: "x", codeBroll: [broll] }] };
    const parsed = makeScriptFromScenes([makeScene({ sceneType: "code_walkthrough", codeBroll: [{ ...broll, lineRange: null, highlights: [] }] })]);
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("omitted codeBroll.highlights"),
      expect.objectContaining({ filePath: "src/bar.ts" }),
    );
  });

  it("warns when voiceSuggestion is omitted", () => {
    const logger = makeLogger();
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "hook", durationSeconds: 8, narration: "x", codeBroll: null }] };
    const parsed = makeScriptFromScenes([makeScene()]);
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("omitted voiceSuggestion"));
  });

  it("does not warn about voiceSuggestion when it is present", () => {
    const logger = makeLogger();
    const rawInput = { scenes: [{ sceneNumber: 1, sceneType: "hook", durationSeconds: 8, narration: "x", codeBroll: null }], voiceSuggestion: "en-US-Neural2-D" };
    const parsed = { ...makeScriptFromScenes([makeScene()]), voiceSuggestion: "en-US-Neural2-D" };
    warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("omitted voiceSuggestion"));
  });

  it("handles non-sequential sceneNumbers gracefully — no crash", () => {
    const logger = makeLogger();
    // rawInput has 1 scene at index 0, but the parsed scene has sceneNumber 99
    const rawInput = { scenes: [{ sceneNumber: 99, durationSeconds: 8, narration: "x" }] };
    const parsed = makeScriptFromScenes([makeScene({ sceneNumber: 99, durationSeconds: 8 })]);
    expect(() => warnOnScriptDefaults(rawInput, parsed, [4, 6, 8], logger)).not.toThrow();
  });

  it("does not warn about omitted codeBroll for non-code scene types (hook/summary/closing/architecture)", () => {
    // The LLM correctly omits codeBroll for non-code scenes; this must not produce a false-positive warning.
    for (const sceneType of ["overview", "hook", "summary", "closing", "architecture"] as const) {
      const logger = makeLogger();
      // codeBroll absent from raw — correct LLM behaviour for these scene types
      const rawInput = { scenes: [{ sceneNumber: 1, sceneType, durationSeconds: 8, narration: "x" }] };
      const parsed = makeScriptFromScenes([makeScene({ sceneType, codeBroll: [] })]);
      warnOnScriptDefaults(rawInput, parsed, [8], logger);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("omitted codeBroll"),
        expect.anything(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// short duration mode
// ---------------------------------------------------------------------------

describe("short duration mode", () => {
  it('buildSystemPrompt includes Duration Mode: SHORT section when durationMode is short', () => {
    const prompt = buildSystemPrompt([4, 6, 8], "short");
    expect(prompt).toContain("Duration Mode: SHORT");
  });

  it('buildSystemPrompt includes 20–60 range for short mode', () => {
    const prompt = buildSystemPrompt([4, 6, 8], "short");
    expect(prompt).toContain("20–60");
  });

  it('buildSystemPrompt does NOT include short mode for default', () => {
    const prompt = buildSystemPrompt([4, 6, 8], undefined, "default");
    expect(prompt).not.toContain("Duration Mode: SHORT");
  });

  it('buildSystemPrompt does NOT include short mode when omitted', () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).not.toContain("Duration Mode: SHORT");
  });

  it('buildUserPrompt targets shorter scenes for short mode', () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis, [4, 6, 8], "short");
    expect(prompt).toContain("20-60");
  });

  it('buildJsonShapeHint adjusts guidance for short mode', () => {
    const hint = buildJsonShapeHint([4, 6, 8], "short");
    expect(hint).toContain("20-60");
  });
});

// ---------------------------------------------------------------------------
// popcorn duration mode
// ---------------------------------------------------------------------------

describe("popcorn duration mode", () => {
  it('buildSystemPrompt includes Duration Mode: POPCORN section when durationMode is popcorn', () => {
    const prompt = buildSystemPrompt([4, 6, 8], "popcorn");
    expect(prompt).toContain("Duration Mode: POPCORN");
    expect(prompt).toContain("240–320");
  });

  it('buildSystemPrompt includes extended story arc for popcorn', () => {
    const prompt = buildSystemPrompt([4, 6, 8], "popcorn");
    expect(prompt).toContain("Story Arc (extended)");
    expect(prompt).toContain("Act 1");
    expect(prompt).toContain("Act 2");
    expect(prompt).toContain("Act 3");
  });

  it('buildSystemPrompt does NOT include popcorn for default', () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).not.toContain("Duration Mode: POPCORN");
  });

  it('buildUserPrompt targets popcorn scenes and duration', () => {
    const prompt = buildUserPrompt(mockContext, mockAnalysis, [4, 6, 8], "popcorn");
    expect(prompt).toContain("240-320");
  });

  it('buildJsonShapeHint adjusts guidance for popcorn mode', () => {
    const hint = buildJsonShapeHint([4, 6, 8], "popcorn");
    expect(hint).toContain("240-320");
  });
});

describe("closing scene instructions", () => {
  it("includes closing scene instructions with concluding reflection", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Closing Scene");
    expect(prompt).toContain("concluding reflection");
  });
});

describe("software engineering analysis instructions", () => {
  it("buildSystemPrompt includes SE Analysis section", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Software Engineering Analysis");
  });

  it("buildSystemPrompt includes pattern identification guidance", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Pattern identification");
    expect(prompt).toContain("Architectural fit");
    expect(prompt).toContain("Technique rationale");
  });

  it("buildSystemPrompt includes pattern narration examples", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Pattern narration examples");
    expect(prompt).toContain("Adapter pattern");
    expect(prompt).toContain("dependency injection");
  });

  it("buildSystemPrompt includes expanded design patterns checklist", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("architectural patterns");
    expect(prompt).toContain("implementation techniques");
    expect(prompt).toContain("GoF");
  });

  it("buildSystemPrompt guards against hallucinated patterns", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("Do NOT list patterns that are not visible in the diff");
  });

  it("short mode mentions pattern brevity constraint", () => {
    const prompt = buildSystemPrompt([4, 6, 8], "short");
    expect(prompt).toContain("name the pattern in one clause");
  });

  it("popcorn mode includes Engineering Depth subsection", () => {
    const prompt = buildSystemPrompt([4, 6, 8], "popcorn");
    expect(prompt).toContain("Engineering Depth");
  });

  it("default mode mentions weaving patterns into walkthrough", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).toContain("weave it into the code walkthrough");
  });
});

describe("visual prompt strengthening", () => {
  it("does not include removed cinematic visual derivation rules", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).not.toContain("Verb mirroring requirement");
    expect(prompt).not.toContain("Surface-artifact trap");
    expect(prompt).not.toContain("Underlying-value derivation examples");
  });

  // ── Reviewer-oriented legacy prompt coverage ─────────────────────────
  it("omits reviewer-oriented narration rules in standard mode", () => {
    const prompt = buildSystemPrompt([4, 6, 8]);
    expect(prompt).not.toContain("Reviewer-Oriented Narration");
    expect(prompt).not.toContain("OPENING SCENE");
  });

  it("includes reviewer-oriented narration rules in legacy system prompt when deepdive is enabled", () => {
    const prompt = buildSystemPrompt([4, 6, 8], undefined, undefined, true);
    expect(prompt).toContain("Reviewer-Oriented Narration");
    expect(prompt).toContain("engineering review");
    expect(prompt).toContain("verdict");
    expect(prompt).toContain("non-prescriptive");
    // Active risk surfacing rules (Change 2)
    expect(prompt).toContain("Active Risk Surfacing");
    expect(prompt).toContain("injection vectors");
    expect(prompt).toContain("god objects");
    expect(prompt).toContain("vulnerability class");
  });

  it("includes opening and closing posture instructions in legacy prompt when deepdive is enabled", () => {
    const prompt = buildSystemPrompt([4, 6, 8], undefined, undefined, true);
    expect(prompt).toContain("OPENING SCENE");
    expect(prompt).toContain("CLOSING SCENE");
    expect(prompt).toContain("teammate review handoff");
    expect(prompt).toContain("unresolved checks");
  });

  it("includes reviewer rules in deepdive mode", () => {
    const prompt = buildSystemPrompt([4, 6, 8], undefined, undefined, true);
    expect(prompt).toContain("Reviewer-Oriented Narration");
  });
});
