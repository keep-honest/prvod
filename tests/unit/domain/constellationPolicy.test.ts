import { afterEach, describe, expect, it } from "vitest";
import type { VideoScript } from "@/domain/entities/VideoScript";
import {
  computeGraphLayoutIfApplicable,
  shouldInflateForConstellation,
} from "@/domain/services/constellationPolicy";

function makeScript(
  scenes: Array<{
    sceneNumber: number;
    filePath?: string;
    sceneType?: VideoScript["scenes"][number]["sceneType"];
  }>,
  keyFiles: string[] = [],
): VideoScript {
  return {
    changeType: "feature",
    summary: "",
    headline: "",
    totalDurationSeconds: scenes.length * 6,
    totalWordCount: scenes.length * 20,
    keyFiles,
    tags: [],
    narrativeRoles: [],
    voiceAssignments: [],
    scenes: scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      sceneType: s.sceneType ?? "code_walkthrough",
      durationSeconds: 6,
      narration: "narration",
      codeBroll: s.filePath
        ? [
            {
              filePath: s.filePath,
              code: "const x = 1;",
              language: "typescript",
              lineRange: [1, 1],
              highlights: [],
            },
          ]
        : [],
    })),
  };
}

describe("shouldInflateForConstellation", () => {
  it("returns false when VIDEO_COMPOSITOR is unset (ffmpeg is the default)", () => {
    expect(shouldInflateForConstellation({})).toBe(false);
  });

  it("returns false when VIDEO_COMPOSITOR=ffmpeg", () => {
    expect(shouldInflateForConstellation({ VIDEO_COMPOSITOR: "ffmpeg" })).toBe(false);
  });

  it("returns true when VIDEO_COMPOSITOR=remotion", () => {
    expect(shouldInflateForConstellation({ VIDEO_COMPOSITOR: "remotion" })).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(shouldInflateForConstellation({ VIDEO_COMPOSITOR: "REMOTION" })).toBe(true);
    expect(shouldInflateForConstellation({ VIDEO_COMPOSITOR: "FFmpeg" })).toBe(false);
  });

  it("defaults to process.env when no bag is provided", () => {
    const original = process.env.VIDEO_COMPOSITOR;
    try {
      process.env.VIDEO_COMPOSITOR = "remotion";
      expect(shouldInflateForConstellation()).toBe(true);
      process.env.VIDEO_COMPOSITOR = "ffmpeg";
      expect(shouldInflateForConstellation()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.VIDEO_COMPOSITOR;
      } else {
        process.env.VIDEO_COMPOSITOR = original;
      }
    }
  });
});

describe("computeGraphLayoutIfApplicable", () => {
  it("returns undefined for a narrative-only script (no codeBroll anywhere)", () => {
    const script = makeScript([
      { sceneNumber: 1, sceneType: "overview" },
      { sceneNumber: 2, sceneType: "summary" },
    ]);
    expect(computeGraphLayoutIfApplicable(script)).toBeUndefined();
  });

  it("returns a non-empty layout when the script has codeBroll", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2, filePath: "src/b.ts" },
      { sceneNumber: 3, filePath: "src/c.ts" },
    ]);
    const layout = computeGraphLayoutIfApplicable(script);
    expect(layout).toBeDefined();
    expect(layout?.nodes).toHaveLength(3);
  });

  it("still returns a layout when the file-path dedup collapses multiple scenes into one node", () => {
    // Scene 2 revisits the same file as scene 1 — dedup means only scene 1
    // owns the node, but the layout is still valid.
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts" },
      { sceneNumber: 2, filePath: "src/a.ts" },
      { sceneNumber: 3, filePath: "src/b.ts" },
    ]);
    const layout = computeGraphLayoutIfApplicable(script);
    expect(layout).toBeDefined();
    expect(layout?.nodes).toHaveLength(2);
    expect(layout?.nodes.map((n) => n.sceneNumber).sort()).toEqual([1, 3]);
  });

  it("handles the extreme dedup case: every scene uses the same file (single node)", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/only.ts" },
      { sceneNumber: 2, filePath: "src/only.ts" },
      { sceneNumber: 3, filePath: "src/only.ts" },
    ]);
    const layout = computeGraphLayoutIfApplicable(script);
    expect(layout).toBeDefined();
    expect(layout?.nodes).toHaveLength(1);
    expect(layout?.edges).toHaveLength(0);
  });
});

// ── Duration inflation (exercised via the generateClips code-first branch) ─

import { VideoOrchestrator } from "@/domain/services/VideoOrchestrator";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockStorageService } from "@/mocks/MockStorageService";
import { MockVideoCompositor } from "@/mocks/MockVideoCompositor";
import type { PRContext } from "@/domain/entities/PRContext";
import type { CompositionInput } from "@/interfaces/IVideoCompositor";
import {
  CONSTELLATION_SUFFIX_FRAMES,
  FINALE_ABSOLUTE_MIN_FRAMES,
  computeFinaleMinFrames,
} from "@/infrastructure/video/remotion/timing";

class CapturingCompositor extends MockVideoCompositor {
  public captured: CompositionInput | null = null;
  async compose(input: CompositionInput) {
    this.captured = input;
    return super.compose(input);
  }
}

const codeFirstContext: PRContext = {
  repoFullName: "owner/repo",
  prNumber: 42,
  prTitle: "Refactor auth",
  prDescription: "",
  diffSource: { kind: "github_pr" as const, repoFullName: "owner/repo", prNumber: 42, installationId: 1 },
  baseBranch: "main",
  headBranch: "feature/auth",
  headSha: "",
  issues: [],
  milestone: null,
  isPrivate: false,
  durationMode: "default" as const,
    deepdive: false,
};

describe("VideoOrchestrator code-first duration inflation", () => {
  const originalCompositor = process.env.VIDEO_COMPOSITOR;

  afterEach(() => {
    if (originalCompositor === undefined) {
      delete process.env.VIDEO_COMPOSITOR;
    } else {
      process.env.VIDEO_COMPOSITOR = originalCompositor;
    }
  });

  async function runAndCaptureCompose(): Promise<CompositionInput> {
    const compositor = new CapturingCompositor();
    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService: new MockTTSService(),
      videoCompositor: compositor,
      storageService: new MockStorageService(),
    });
    await orchestrator.execute("job-constellation", codeFirstContext);
    if (!compositor.captured) {
      throw new Error("compositor.compose was not called");
    }
    return compositor.captured;
  }

  it("inflates code-first scene durations by the constellation suffix when VIDEO_COMPOSITOR=remotion", async () => {
    process.env.VIDEO_COMPOSITOR = "remotion";
    const captured = await runAndCaptureCompose();

    const codeClips = captured.clips.filter((c) => c.sourceType === "code");
    expect(codeClips.length).toBeGreaterThan(0);

    for (const clip of codeClips) {
      // Every code clip should have been inflated. durationFrames is the
      // base narration frames + 75. Since narration can vary per scene, the
      // lower bound is the suffix itself.
      expect(clip.durationFrames ?? 0).toBeGreaterThanOrEqual(
        CONSTELLATION_SUFFIX_FRAMES + 1,
      );
    }
    // Compose must have received the graphLayout.
    expect(captured.graphLayout).toBeDefined();
    expect(captured.graphLayout?.nodes.length).toBeGreaterThan(0);
  });

  it("does NOT apply finale inflation to a single-scene script (isFirstScene guard)", async () => {
    // A one-scene script means the only scene is simultaneously first and last.
    // The !isFirstScene guard must prevent finale inflation in this case.
    process.env.VIDEO_COMPOSITOR = "remotion";

    const singleSceneScript: import("@/domain/entities/VideoScript").VideoScript = {
      changeType: "refactor",
      summary: "single scene",
      headline: "single",
      totalDurationSeconds: 6,
      totalWordCount: 10,
      keyFiles: ["src/only.ts"],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "code_walkthrough",
          durationSeconds: 6,
          narration: "ten words here to ensure audio covers the scene duration",
          codeBroll: [
            {
              filePath: "src/only.ts",
              code: "export const x = 1;",
              language: "typescript",
              lineRange: [1, 1],
              highlights: [],
            },
          ],
        },
      ],
    };

    const singleSceneWriter: import("@/interfaces/IScriptWriter").IScriptWriter = {
      async generateScript() {
        return {
          script: singleSceneScript,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      async retimeNarration(_ctx, _analysis, script) {
        return { scenes: script.scenes.map((s) => ({ sceneNumber: s.sceneNumber, narration: s.narration })) };
      },
    };

    const compositor = new CapturingCompositor();
    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: singleSceneWriter,
      ttsService: new MockTTSService(),
      videoCompositor: compositor,
      storageService: new MockStorageService(),
    });
    await orchestrator.execute("job-single-scene", codeFirstContext);

    const clip = compositor.captured?.clips.find((c) => c.sourceType === "code");
    expect(clip).toBeDefined();
    // isFirstScene = true, so suffix = 0 and finale inflation is suppressed.
    // 10 words × 400ms × 30fps = 120 frames — well below FINALE_ABSOLUTE_MIN_FRAMES.
    // If the !isFirstScene guard were missing, isLastScene would be true and
    // totalFrames = max(120, computeFinaleMinFrames(1)) = 240, failing this assertion.
    expect(clip?.durationFrames ?? 0).toBeLessThan(FINALE_ABSOLUTE_MIN_FRAMES);
  });

  it("does NOT inflate durations when VIDEO_COMPOSITOR=ffmpeg (default)", async () => {
    process.env.VIDEO_COMPOSITOR = "ffmpeg";
    const capturedFfmpeg = await runAndCaptureCompose();

    process.env.VIDEO_COMPOSITOR = "remotion";
    const capturedRemotion = await runAndCaptureCompose();

    const sumFrames = (input: CompositionInput) =>
      input.clips
        .filter((c) => c.sourceType === "code")
        .reduce((acc, c) => acc + (c.durationFrames ?? 0), 0);

    const codeClipsFfmpeg = capturedFfmpeg.clips.filter((c) => c.sourceType === "code");
    const codeCount = codeClipsFfmpeg.length;
    // Remotion inflates every non-first code scene EXCEPT the last:
    //   - Non-first, non-last scenes: base + CONSTELLATION_SUFFIX_FRAMES each
    //   - Last scene: max(base, computeFinaleMinFrames(nodeCount)) — the finale
    //     reveal needs more time than the standard shrink suffix.
    // In MockScript each scene has one unique file, so nodeCount ≈ codeCount.
    const lastSceneBaseFrames = codeClipsFfmpeg.at(-1)?.durationFrames ?? 0;
    const finaleMinFrames = computeFinaleMinFrames(codeCount);
    const lastSceneDelta = Math.max(0, finaleMinFrames - lastSceneBaseFrames);
    const expectedDelta = (codeCount - 2) * CONSTELLATION_SUFFIX_FRAMES + lastSceneDelta;
    expect(sumFrames(capturedRemotion) - sumFrames(capturedFfmpeg)).toBe(expectedDelta);
    // Both paths still receive the same graphLayout (layout doesn't depend on compositor).
    expect(capturedFfmpeg.graphLayout).toBeDefined();
    expect(capturedRemotion.graphLayout).toBeDefined();
  });

  it("inflates the last scene to finaleMinFrames even when it has no codeBroll of its own", async () => {
    // Scenario: 3-scene script where scenes 1+2 have codeBroll but scene 3 (last) does not.
    // finaleReveal runs on the last scene and animates nodes from earlier scenes, so
    // the last scene still needs the full finale duration regardless of its own codeBroll.
    process.env.VIDEO_COMPOSITOR = "remotion";

    const scriptWithNarrativeLast: import("@/domain/entities/VideoScript").VideoScript = {
      changeType: "refactor",
      summary: "narrative closing",
      headline: "test",
      totalDurationSeconds: 18,
      totalWordCount: 30,
      keyFiles: ["src/a.ts", "src/b.ts"],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "overview",
          durationSeconds: 6,
          narration: "overview narration with ten words here today",
          codeBroll: [{ filePath: "src/a.ts", code: "x", language: "typescript", lineRange: [1, 1], highlights: [] }],
        },
        {
          sceneNumber: 2,
          sceneType: "code_walkthrough",
          durationSeconds: 6,
          narration: "second scene narration with ten words here today",
          codeBroll: [{ filePath: "src/b.ts", code: "y", language: "typescript", lineRange: [1, 1], highlights: [] }],
        },
        {
          sceneNumber: 3,
          sceneType: "closing",
          durationSeconds: 6,
          narration: "closing narration with ten words here for today",
          codeBroll: [],
        },
      ],
    };

    const writerWithNarrativeLast: import("@/interfaces/IScriptWriter").IScriptWriter = {
      async generateScript() {
        return { script: scriptWithNarrativeLast, usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async retimeNarration(_ctx, _analysis, script) {
        return { scenes: script.scenes.map((s) => ({ sceneNumber: s.sceneNumber, narration: s.narration })) };
      },
    };

    const compositor = new CapturingCompositor();
    await new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: writerWithNarrativeLast,
      ttsService: new MockTTSService(),
      videoCompositor: compositor,
      storageService: new MockStorageService(),
    }).execute("job-narrative-last", codeFirstContext);

    if (!compositor.captured) throw new Error("compositor.compose was not called");
    const clips = compositor.captured.clips.filter((c) => c.sourceType === "code");
    const lastClip = clips.at(-1);
    expect(lastClip).toBeDefined();
    // nodeCount = 2 (src/a.ts, src/b.ts). computeFinaleMinFrames(2) = max(1*8+150, 240) = 240.
    // Last scene has 10-word narration = 4s = 120 frames base; 120 < 240, so finale min wins.
    expect(lastClip?.durationFrames ?? 0).toBeGreaterThanOrEqual(
      computeFinaleMinFrames(2),
    );
  });

  it("2-scene script: scene 1 gets no inflation, scene 2 gets finale inflation", async () => {
    // Verifies the !isFirstScene guard interacts correctly with isLastScene on adjacent scenes.
    process.env.VIDEO_COMPOSITOR = "remotion";

    const twoSceneScript: import("@/domain/entities/VideoScript").VideoScript = {
      changeType: "bugfix",
      summary: "two scenes",
      headline: "test",
      totalDurationSeconds: 12,
      totalWordCount: 20,
      keyFiles: ["src/x.ts", "src/y.ts"],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "overview",
          durationSeconds: 6,
          narration: "ten words here to ensure audio covers scene duration fully",
          codeBroll: [{ filePath: "src/x.ts", code: "x", language: "typescript", lineRange: [1, 1], highlights: [] }],
        },
        {
          sceneNumber: 2,
          sceneType: "code_walkthrough",
          durationSeconds: 6,
          narration: "ten more words here to ensure audio covers the scene",
          codeBroll: [{ filePath: "src/y.ts", code: "y", language: "typescript", lineRange: [1, 1], highlights: [] }],
        },
      ],
    };

    const twoSceneWriter: import("@/interfaces/IScriptWriter").IScriptWriter = {
      async generateScript() {
        return { script: twoSceneScript, usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async retimeNarration(_ctx, _analysis, script) {
        return { scenes: script.scenes.map((s) => ({ sceneNumber: s.sceneNumber, narration: s.narration })) };
      },
    };

    const compositor = new CapturingCompositor();
    await new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: twoSceneWriter,
      ttsService: new MockTTSService(),
      videoCompositor: compositor,
      storageService: new MockStorageService(),
    }).execute("job-two-scenes", codeFirstContext);

    if (!compositor.captured) throw new Error("compositor.compose was not called");
    const codeClips = compositor.captured.clips.filter((c) => c.sourceType === "code");
    expect(codeClips).toHaveLength(2);

    const [scene1Clip, scene2Clip] = codeClips;
    // Scene 1: isFirstScene=true → no suffix, no finale. Base only (≈ 10w×400ms×30fps = 120f).
    expect(scene1Clip?.durationFrames ?? 0).toBeLessThan(FINALE_ABSOLUTE_MIN_FRAMES);
    // Scene 2: isLastScene=true, nodeCount=2 → max(base, computeFinaleMinFrames(2)) = 240.
    expect(scene2Clip?.durationFrames ?? 0).toBeGreaterThanOrEqual(
      computeFinaleMinFrames(2),
    );
  });

  it("does NOT inflate last scene when nodeCount=0 (all-narrative script under Remotion)", async () => {
    // nodeCount is derived from codeBroll across all scenes. When no scene has codeBroll,
    // nodeCount = 0 → isLastScene = false → no finale inflation, even under Remotion.
    process.env.VIDEO_COMPOSITOR = "remotion";

    const allNarrativeScript: import("@/domain/entities/VideoScript").VideoScript = {
      changeType: "docs",
      summary: "docs only",
      headline: "test",
      totalDurationSeconds: 12,
      totalWordCount: 20,
      keyFiles: [],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "overview",
          durationSeconds: 6,
          narration: "ten words here to ensure audio covers the scene duration",
          codeBroll: [],
        },
        {
          sceneNumber: 2,
          sceneType: "closing",
          durationSeconds: 6,
          narration: "ten more words here to ensure audio covers the scene",
          codeBroll: [],
        },
      ],
    };

    const narrativeWriter: import("@/interfaces/IScriptWriter").IScriptWriter = {
      async generateScript() {
        return { script: allNarrativeScript, usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async retimeNarration(_ctx, _analysis, script) {
        return { scenes: script.scenes.map((s) => ({ sceneNumber: s.sceneNumber, narration: s.narration })) };
      },
    };

    const compositor = new CapturingCompositor();
    await new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: narrativeWriter,
      ttsService: new MockTTSService(),
      videoCompositor: compositor,
      storageService: new MockStorageService(),
    }).execute("job-all-narrative", codeFirstContext);

    // Verify graphLayout is absent (no codeBroll means no constellation).
    expect(compositor.captured?.graphLayout).toBeUndefined();
    // The last clip should have base-only duration (nodeCount=0 → isLastScene=false → no finale).
    // 10-word narration at 400ms/word = 4s = 120 frames base; well below FINALE_ABSOLUTE_MIN_FRAMES.
    const lastClip = compositor.captured?.clips.at(-1);
    if (lastClip) {
      expect(lastClip.durationFrames ?? 0).toBeLessThan(FINALE_ABSOLUTE_MIN_FRAMES);
    }
  });

  it("revisit scene (non-owner) receives no constellation suffix under Remotion", async () => {
    // Scene 1 owns src/a.ts. Scene 2 revisits src/a.ts (not an owner). Scene 3 owns src/b.ts
    // (last scene → finale inflation). Non-owner scene 2 gets baseFrames only (no +75 suffix).
    process.env.VIDEO_COMPOSITOR = "remotion";

    const revisitScript: import("@/domain/entities/VideoScript").VideoScript = {
      changeType: "refactor",
      summary: "revisit",
      headline: "test",
      totalDurationSeconds: 18,
      totalWordCount: 30,
      keyFiles: ["src/a.ts", "src/b.ts"],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "overview",
          durationSeconds: 6,
          narration: "ten words here to ensure audio covers the scene duration",
          codeBroll: [{ filePath: "src/a.ts", code: "x", language: "typescript", lineRange: [1, 1], highlights: [] }],
        },
        {
          sceneNumber: 2,
          sceneType: "code_walkthrough",
          durationSeconds: 6,
          narration: "ten more words here for the revisit scene duration today",
          codeBroll: [{ filePath: "src/a.ts", code: "y", language: "typescript", lineRange: [2, 2], highlights: [] }],
        },
        {
          sceneNumber: 3,
          sceneType: "code_walkthrough",
          durationSeconds: 6,
          narration: "final scene ten words here to cover the scene duration",
          codeBroll: [{ filePath: "src/b.ts", code: "z", language: "typescript", lineRange: [1, 1], highlights: [] }],
        },
      ],
    };

    const revisitWriter: import("@/interfaces/IScriptWriter").IScriptWriter = {
      async generateScript() {
        return { script: revisitScript, usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async retimeNarration(_ctx, _analysis, script) {
        return { scenes: script.scenes.map((s) => ({ sceneNumber: s.sceneNumber, narration: s.narration })) };
      },
    };

    const compositor = new CapturingCompositor();
    await new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: revisitWriter,
      ttsService: new MockTTSService(),
      videoCompositor: compositor,
      storageService: new MockStorageService(),
    }).execute("job-revisit", codeFirstContext);

    if (!compositor.captured) throw new Error("compositor.compose was not called");
    const codeClips = compositor.captured.clips.filter((c) => c.sourceType === "code");
    expect(codeClips).toHaveLength(3);

    const [scene1Clip, scene2Clip, scene3Clip] = codeClips;

    // Scene 1: isFirstScene → no suffix. Base ≈ 120f.
    expect(scene1Clip?.durationFrames ?? 0).toBeLessThan(FINALE_ABSOLUTE_MIN_FRAMES);

    // Scene 2: revisits src/a.ts → isOwner=false → no suffix (same base as scene 1).
    // A revisit gets the same base frames as its narration but NO +75 suffix.
    // Both scene 1 and scene 2 have 10-word narrations → same base.
    expect(scene2Clip?.durationFrames ?? 0).toBe(scene1Clip?.durationFrames ?? 0);

    // Scene 3: isLastScene=true, nodeCount=2 → max(base, computeFinaleMinFrames(2)) = 240.
    expect(scene3Clip?.durationFrames ?? 0).toBeGreaterThanOrEqual(
      computeFinaleMinFrames(2),
    );
  });
});
