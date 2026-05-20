import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSceneWordBudgets, validateTotalWordBudget } from "@/infrastructure/llm/promptPipelineV2Validators";
import { buildFinalScriptSystemPrompt, buildWordBudgetRepairPrompt } from "@/infrastructure/llm/promptPipelineV2";
import { computeTotalWordBudgetForMode, computeDurationSecondsFromWordCount } from "@/infrastructure/llm/wordBudget";
import { computeActualSceneDurations } from "@/infrastructure/llm/promptPipelineV2Runner";
import { buildJsonShapeHint } from "@/infrastructure/llm/script-prompt";
import { VALID_SCRIPT, makeVideoScript } from "./fixtures/scriptWriterFixtures";
import type { VideoScript } from "@/domain/entities/VideoScript";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validateSceneWordBudgets", () => {
  it("passes when all scenes are within budget", () => {
    // 5 words in 8s → max 20 words → passes
    const script = makeVideoScript([
      { narration: "one two three four five", durationSeconds: 8 },
    ]);
    const result = validateSceneWordBudgets(script);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects a single scene over budget", () => {
    // 30 words in 8s → max 20 → violation
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([{ narration: words, durationSeconds: 8 }]);
    const result = validateSceneWordBudgets(script);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({
      sceneNumber: 1,
      wordCount: 30,
      maxWords: 20,
      durationSeconds: 8,
    });
  });

  it("detects multiple scenes over budget", () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([
      { narration: long, durationSeconds: 6 },  // max 15
      { narration: "short", durationSeconds: 10 }, // max 25 → ok
      { narration: long, durationSeconds: 8 },  // max 20
    ]);
    const result = validateSceneWordBudgets(script);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].sceneNumber).toBe(1);
    expect(result.violations[1].sceneNumber).toBe(3);
  });

  it("computes maxWords from actual TTS timing by default", () => {
    const words16 = Array.from({ length: 16 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([{ narration: words16, durationSeconds: 6 }]);
    const result = validateSceneWordBudgets(script);
    expect(result.passed).toBe(false);
    expect(result.violations[0].maxWords).toBe(15);
  });

  it("accounts for TTS_SPEED_MULTIPLIER when computing maxWords", () => {
    vi.stubEnv("TTS_SPEED_MULTIPLIER", "1.2");
    const words31 = Array.from({ length: 31 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([{ narration: words31, durationSeconds: 10 }]);
    const result = validateSceneWordBudgets(script);
    expect(result.passed).toBe(false);
    expect(result.violations[0].maxWords).toBe(30);
  });

  it("counts dotted filenames using spoken expansion", () => {
    const script = makeVideoScript([
      { narration: "VideoOrchestrator.ts and config.prod.yaml changed fast", durationSeconds: 2 },
    ]);
    const result = validateSceneWordBudgets(script);
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatchObject({
      wordCount: 11,
      maxWords: 5,
    });
    expect(result.repairMessage).toContain("VideoOrchestrator dot ts and config dot prod dot Yaml changed fast");
  });

  it("handles empty narration (0 words, always passes)", () => {
    const script = makeVideoScript([{ narration: "", durationSeconds: 8 }]);
    const result = validateSceneWordBudgets(script);
    expect(result.passed).toBe(true);
  });

  it("VALID_SCRIPT fixture passes validation (regression guard)", () => {
    const result = validateSceneWordBudgets(VALID_SCRIPT as unknown as VideoScript);
    // VALID_SCRIPT has short narrations that should pass at 2.5 words/sec
    // If this fails, a test fixture was changed to have overlong narrations
    expect(result.passed).toBe(true);
  });

  it("includes scene numbers and word counts in repairMessage", () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([{ narration: words, durationSeconds: 8 }]);
    const result = validateSceneWordBudgets(script);
    expect(result.repairMessage).toContain("Scene 1");
    expect(result.repairMessage).toContain("30 spoken words");
    expect(result.repairMessage).toContain("max 20 words");
    expect(result.repairMessage).toContain("Spoken text (what TTS will say):");
  });
});

describe("buildWordBudgetRepairPrompt", () => {
  it("includes violation details and repair instructions", () => {
    const prompt = buildWordBudgetRepairPrompt(
      "gemini",
      '{"scenes": []}',
      "Scene 3 has 114 words but 10s allows max 25 words",
    );
    expect(prompt).toContain("Scene 3 has 114 words");
    expect(prompt).toContain('"task.ts" counts like "task dot ts"');
    expect(prompt).toContain("Shorten narration");
  });

  it("builds total word budget in system prompt", () => {
    vi.stubEnv("TTS_SPEED_MULTIPLIER", "1.2");
    const prompt = buildFinalScriptSystemPrompt(
      { family: "gemini", durationMode: "default" },
      [10],
    );
    expect(prompt).toContain("spoken words");
    expect(prompt).toContain('"task.ts" counts like "task dot ts"');
  });

  it("uses XML tags for claude family", () => {
    const prompt = buildWordBudgetRepairPrompt(
      "claude",
      '{"scenes": []}',
      "Scene 1 violation",
    );
    expect(prompt).toContain("<broken_script>");
    expect(prompt).toContain("<word_budget_errors>");
    expect(prompt).toContain("<repair_instructions>");
  });

  it("uses total-budget repair instructions for code-first", () => {
    const prompt = buildWordBudgetRepairPrompt(
      "gemini",
      '{"scenes": []}',
      "Total script has 400 words but max is 300",
    );
    expect(prompt).toContain("total narration exceeds the word budget");
    expect(prompt).not.toContain("actual TTS timing");
  });
});

// ── Code-First Flexible Duration Tests ─────────────────────────────────────

describe("computeTotalWordBudgetForMode", () => {
  it("returns correct range for default mode", () => {
    const budget = computeTotalWordBudgetForMode("default", 1.0);
    // 20s min → ceil(20 * 2.5) = 50 words; 120s max → floor(120 * 2.5) = 300 words
    expect(budget.minWords).toBe(50);
    expect(budget.maxWords).toBe(300);
    expect(budget.recommendedPerScene.min).toBeGreaterThan(0);
    expect(budget.recommendedPerScene.max).toBeGreaterThan(budget.recommendedPerScene.min);
  });

  it("returns tighter range for short mode", () => {
    const budget = computeTotalWordBudgetForMode("short", 1.0);
    expect(budget.maxWords).toBeLessThanOrEqual(163); // 65s * 2.5
    expect(budget.minWords).toBe(50); // 20s * 2.5
  });

  it("returns wider range for popcorn mode", () => {
    const budget = computeTotalWordBudgetForMode("popcorn", 1.0);
    expect(budget.minWords).toBe(600); // 240s * 2.5
    expect(budget.maxWords).toBe(800); // 320s * 2.5
  });

  it("scales budget with speed multiplier", () => {
    const normal = computeTotalWordBudgetForMode("default", 1.0);
    const fast = computeTotalWordBudgetForMode("default", 1.2);
    expect(fast.maxWords).toBeGreaterThan(normal.maxWords);
  });
});

describe("computeDurationSecondsFromWordCount", () => {
  it("returns 1 for zero words", () => {
    expect(computeDurationSecondsFromWordCount(0, 1.0)).toBe(1);
  });

  it("returns ceil(wordCount * 0.4) at default speed", () => {
    expect(computeDurationSecondsFromWordCount(10, 1.0)).toBe(4); // 10 * 0.4 = 4
    expect(computeDurationSecondsFromWordCount(7, 1.0)).toBe(3); // 7 * 0.4 = 2.8 → ceil = 3
  });

  it("shortens duration with faster speed multiplier", () => {
    const normal = computeDurationSecondsFromWordCount(10, 1.0);
    const fast = computeDurationSecondsFromWordCount(10, 1.5);
    expect(fast).toBeLessThan(normal);
  });

  it("always returns at least 1", () => {
    expect(computeDurationSecondsFromWordCount(-5, 1.0)).toBe(1);
  });
});

describe("validateTotalWordBudget", () => {
  it("passes when total words within budget", () => {
    const script = makeVideoScript([
      { narration: "one two three", durationSeconds: 4 },
      { narration: "four five six", durationSeconds: 4 },
    ]);
    const result = validateTotalWordBudget(script, "default");
    expect(result.passed).toBe(true);
  });

  it("fails when total words exceed budget", () => {
    // Default max is 300 words. Create 400 words.
    const longNarration = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([
      { narration: longNarration, durationSeconds: 80 },
      { narration: longNarration, durationSeconds: 80 },
    ]);
    const result = validateTotalWordBudget(script, "default");
    expect(result.passed).toBe(false);
    expect(result.violations[0].sceneNumber).toBe(-1);
    expect(result.repairMessage).toContain("default");
    expect(result.repairMessage).toContain("400");
  });

  it("uses different budgets per duration mode", () => {
    // 100 words — passes for default (max 300) but fails for short (max ~162)
    const narration = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const script = makeVideoScript([{ narration, durationSeconds: 40 }]);
    expect(validateTotalWordBudget(script, "default").passed).toBe(true);
    // 170 words exceeds short budget
    const longNarration = Array.from({ length: 170 }, (_, i) => `w${i}`).join(" ");
    const shortScript = makeVideoScript([{ narration: longNarration, durationSeconds: 40 }]);
    expect(validateTotalWordBudget(shortScript, "short").passed).toBe(false);
  });
});

describe("computeActualSceneDurations (isCodeFirst bypass)", () => {
  it("returns script unchanged when isCodeFirst is true", () => {
    const script = makeVideoScript([
      { narration: "one two three four five six seven eight nine ten", durationSeconds: 4 },
    ]);
    const result = computeActualSceneDurations(script, 1.0, true);
    expect(result).toBe(script); // same reference
  });
});

describe("buildJsonShapeHint", () => {
  it("does not throw on empty validDurations (code-first fallback)", () => {
    expect(() => buildJsonShapeHint([], undefined)).not.toThrow();
  });

  it("uses advisory durationSeconds field when no fixed durations", () => {
    const hint = buildJsonShapeHint([], "default");
    expect(hint).toContain("Set durationSeconds to any positive integer");
    expect(hint).not.toContain("MUST be exactly");
  });

  it("uses advisory durationSeconds even when fixed durations are provided", () => {
    const hint = buildJsonShapeHint([4, 6, 8], "default");
    expect(hint).toContain("Set durationSeconds to any positive integer");
  });
});

