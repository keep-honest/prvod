import type {
  IScriptWriter,
  NarrationRetimeBudget,
  NarrationRetimeResult,
  ScriptWriterResult,
} from "@/interfaces/IScriptWriter";
import type { PRContext } from "@/domain/entities/PRContext";
import type { Scene, VideoScript } from "@/domain/entities/VideoScript";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";
import { sanitizeSpokenNarrationText } from "@/lib/narrationText";

function buildCodeFirstScenes(): Scene[] {
  return [
    {
      sceneNumber: 1,
      sceneType: "overview" as const,
      durationSeconds: 8,
      narration:
        "We open on the request surface where the walkthrough mode is chosen. That decision sets up the rest of the review experience without changing the selected presentation theme.",
      codeBroll: [{
        filePath: "src/app/api/jobs/route.ts",
        code: "const scriptOnly = rawBody.scriptOnly === true;\nconst ttsOnly = rawBody.ttsOnly === true;\nconst deepdive = rawBody.deepdive === true;\nconst requestedMode = resolveRequestedJobMode({ scriptOnly, ttsOnly });",
        language: "typescript",
        lineRange: [1, 4] as [number, number],
        highlights: [3],
      }],
    },
    {
      sceneNumber: 2,
      sceneType: "code_walkthrough" as const,
      durationSeconds: 10,
      narration:
        "The pipeline runner coordinates the full generation lifecycle. It validates the request, delegates to the orchestrator, and reconciles credits on completion.",
      codeBroll: [{
        filePath: "src/domain/services/PipelineRunner.ts",
        code: "const orchestrator = new VideoOrchestrator(this.deps);\nconst result = await orchestrator.execute(\n  jobId, prContext, options,\n);",
        language: "typescript",
        lineRange: [1, 4] as [number, number],
        highlights: [2],
      }],
    },
    {
      sceneNumber: 3,
      sceneType: "code_walkthrough" as const,
      durationSeconds: 10,
      narration:
        "The orchestrator builds the entire sequence from code-native scenes, preserving motion through timing and composition.",
      codeBroll: [{
        filePath: "src/domain/services/VideoOrchestrator.ts",
        code: "const graphLayout = computeGraphLayoutIfApplicable(script);\nconst { videoBuffer } = await this.deps.videoCompositor.compose({\n  script, clips, sceneTimelineFrames,\n  ...(graphLayout ? { graphLayout } : {}),\n});",
        language: "typescript",
        lineRange: [1, 5] as [number, number],
        highlights: [1, 4],
      }],
    },
    {
      sceneNumber: 4,
      sceneType: "architecture" as const,
      durationSeconds: 6,
      narration:
        "The rendering contract now accepts code assets alongside video assets, so the pipeline can stay structurally consistent while the visual medium changes completely.",
      codeBroll: [{
        filePath: "src/interfaces/IClipAsset.ts",
        code: "export interface ClipAsset {\n  sceneNumber: number;\n  clipIndex: number;\n  clipUrl: string;\n  sourceType?: \"video\" | \"code\";\n  durationSeconds: number;\n}",
        language: "typescript",
        lineRange: [1, 6] as [number, number],
        highlights: [4],
      }],
    },
    {
      sceneNumber: 5,
      sceneType: "before_after" as const,
      durationSeconds: 8,
      narration:
        "On screen, the Remotion layer turns those snippets into a cinematic progression. The feeling comes from focus, framing, and pacing instead of provider-generated footage.",
      codeBroll: [{
        filePath: "src/infrastructure/video/remotion/components/CodeFirstScene.tsx",
        code: "export function CodeFirstScene(props: CodeFirstSceneProps) {\n  return (\n    <AbsoluteFill className=\"bg-[var(--color-bg)] text-[var(--color-fg)]\">\n      <CinematicCodeFrame excerpt={props.excerpt} progress={props.progress} />\n    </AbsoluteFill>\n  );\n}",
        language: "tsx",
        lineRange: [1, 6] as [number, number],
        highlights: [3, 4],
      }],
    },
    {
      sceneNumber: 6,
      sceneType: "summary" as const,
      durationSeconds: 8,
      narration:
        "The end result is still cinematic, but the cinematic feeling now comes directly from the code review material itself. Every beat stays anchored to a real file, a real change, and a real explanation.",
      codeBroll: [{
        filePath: "tests/integration/code-first-pipeline.test.ts",
        code: "expect(aiClipGeneratorCalls).toBe(0);\nexpect(composedClips.every((clip) => clip.sourceType === \"code\")).toBe(true);",
        language: "typescript",
        lineRange: [1, 2] as [number, number],
        highlights: [1, 2],
      }],
    },
    {
      sceneNumber: 7,
      sceneType: "closing" as const,
      durationSeconds: 10,
      narration:
        "That is the new default walkthrough: cinematic in feel, code-only in visual medium, and ready to carry reviewers from one meaningful snippet to the next.",
      codeBroll: [{
        filePath: "src/infrastructure/video/remotion/Root.tsx",
        code: "const useCodeFirstScene = sceneClips.length > 0 &&\n  sceneClips.every((clip) => clip.sourceType === \"code\");\n\nreturn useCodeFirstScene\n  ? <CodeFirstScene {...sceneProps} />\n  : <AIClipScene {...sceneProps} />;",
        language: "tsx",
        lineRange: [1, 6] as [number, number],
        highlights: [1, 4, 5],
      }],
    },
  ];
}

export class MockScriptWriter implements IScriptWriter {
  async generateScript(
    context: PRContext,
    _analysis: DiffAnalysis,
  ): Promise<ScriptWriterResult> {
    const scenes = buildCodeFirstScenes();
    const keyFiles = Array.from(
      new Set(
        scenes
          .map((scene) => scene.codeBroll[0]?.filePath)
          .filter((filePath): filePath is string => Boolean(filePath)),
      ),
    );

    return {
      script: {
        changeType: "feature",
        summary: `Mock summary for PR #${context.prNumber}: ${context.prTitle}`,
        headline: `${context.prTitle} walkthrough`,
        scenes,
        totalDurationSeconds: 60,
        totalWordCount: 150,
        keyFiles,
        tags: ["feature", "mock"],
        narrativeRoles: [
          {
            roleId: "narrator",
            roleType: "narrator",
            componentKey: null,
            speaking: true,
          },
        ],
        voiceAssignments: [
          {
            roleId: "narrator",
            providerSource: "native_model_voice",
            voiceToken: "voice_narrator",
            consistencyScope: "single_video",
          },
        ],
      },
      usage: {
        inputTokens: 2000,
        outputTokens: 800,
      },
    };
  }

  async retimeNarration(
    _context: PRContext,
    _analysis: DiffAnalysis,
    script: VideoScript,
    sceneBudgets: NarrationRetimeBudget[],
    targetSceneNumbers?: number[],
  ): Promise<NarrationRetimeResult> {
    const targetSet = new Set(targetSceneNumbers ?? sceneBudgets.map((scene) => scene.sceneNumber));

    return {
      scenes: script.scenes
        .filter((scene) => targetSet.has(scene.sceneNumber))
        .map((scene) => {
          const budget = sceneBudgets.find((entry) => entry.sceneNumber === scene.sceneNumber);
          const maxWords = Math.max(1, budget?.maxWords ?? 1);
          const words = sanitizeSpokenNarrationText(scene.narration).split(/\s+/).filter(Boolean);
          return {
            sceneNumber: scene.sceneNumber,
            narration: words.slice(0, maxWords).join(" "),
          };
        }),
    };
  }
}
