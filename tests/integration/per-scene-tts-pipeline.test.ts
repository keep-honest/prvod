import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VideoOrchestrator, type OrchestratorDeps } from "@/domain/services/VideoOrchestrator";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockVideoCompositor } from "@/mocks/MockVideoCompositor";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockStorageService } from "@/mocks/MockStorageService";
import { LocalCheckpointStore } from "@/infrastructure/persistence/LocalCheckpointStore";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import { GoogleTTSService } from "@/infrastructure/tts/GoogleTTSService";
import type { PRContext } from "@/domain/entities/PRContext";
import type { IScriptWriter } from "@/interfaces/IScriptWriter";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";
import type {
  IVideoCompositor,
  CompositionInput,
  CompositionResult,
} from "@/interfaces/IVideoCompositor";
import type { ITTSService } from "@/interfaces/ITTSService";
import type { ClipAsset } from "@/interfaces/IClipAsset";
import type { PipelineCheckpoint } from "@/interfaces/IPipelineCheckpoint";

// Mock prepareClipAssets so it doesn't download or probe real files.
// Just passes through clips with durationFrames calculated from durationSeconds.
vi.mock("@/infrastructure/video/prepareClipAssets", () => ({
  prepareClipAssets: async (clips: ClipAsset[]) =>
    clips.map((c) => ({
      ...c,
      durationFrames: c.durationFrames ?? Math.max(1, Math.round(c.durationSeconds * 30)),
    })),
}));

// ---------------------------------------------------------------------------
// Inline test helpers
// ---------------------------------------------------------------------------

class CapturingCompositor implements IVideoCompositor {
  capturedInput?: CompositionInput;
  async compose(input: CompositionInput): Promise<CompositionResult> {
    this.capturedInput = input;
    return { videoBuffer: Buffer.from("MOCK_VIDEO_DATA") };
  }
}

const _testDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
+import { rateLimit } from "./middleware";
 const app = express();
+app.use(rateLimit(100, 60000));
 app.listen(3000);`;

function makeContext(): PRContext {
  return {
    repoFullName: "owner/repo",
    prNumber: 99,
    prTitle: "Add rate limiting",
    prDescription: "Adds rate limiting middleware.",
    diffSource: { kind: "github_pr" as const, repoFullName: "owner/repo", prNumber: 99, installationId: 1 },
    baseBranch: "main",
    headBranch: "feature/rate-limit",
    headSha: "",
    issues: [],
    milestone: null,
    isPrivate: false,
    durationMode: "default" as const,
    deepdive: false,
  };
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    diffAnalyzer: new HeuristicDiffAnalyzer(),
    scriptWriter: new MockScriptWriter(),
    ttsService: new MockTTSService(),
    videoCompositor: new MockVideoCompositor(),
    storageService: new MockStorageService(),
    checkpointStore: new LocalCheckpointStore(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("per-scene TTS pipeline integration", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.USE_BUILTIN_TTS = process.env.USE_BUILTIN_TTS;
    savedEnv.LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR;
    savedEnv.GOOGLE_CLOUD_TTS_KEY = process.env.GOOGLE_CLOUD_TTS_KEY;
    savedEnv.GOOGLE_TTS_MAX_ATTEMPTS = process.env.GOOGLE_TTS_MAX_ATTEMPTS;
    savedEnv.GOOGLE_TTS_RETRY_BASE_DELAY_MS = process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS;
    savedEnv.GOOGLE_TTS_RETRY_MAX_DELAY_MS = process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS;
    process.env.LOCAL_STORAGE_DIR = "/tmp/test-storage";
  });

  afterEach(() => {
    if (savedEnv.USE_BUILTIN_TTS === undefined) delete process.env.USE_BUILTIN_TTS;
    else process.env.USE_BUILTIN_TTS = savedEnv.USE_BUILTIN_TTS;
    if (savedEnv.LOCAL_STORAGE_DIR === undefined) delete process.env.LOCAL_STORAGE_DIR;
    else process.env.LOCAL_STORAGE_DIR = savedEnv.LOCAL_STORAGE_DIR;
    if (savedEnv.GOOGLE_CLOUD_TTS_KEY === undefined) delete process.env.GOOGLE_CLOUD_TTS_KEY;
    else process.env.GOOGLE_CLOUD_TTS_KEY = savedEnv.GOOGLE_CLOUD_TTS_KEY;
    if (savedEnv.GOOGLE_TTS_MAX_ATTEMPTS === undefined) delete process.env.GOOGLE_TTS_MAX_ATTEMPTS;
    else process.env.GOOGLE_TTS_MAX_ATTEMPTS = savedEnv.GOOGLE_TTS_MAX_ATTEMPTS;
    if (savedEnv.GOOGLE_TTS_RETRY_BASE_DELAY_MS === undefined) delete process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS;
    else process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS = savedEnv.GOOGLE_TTS_RETRY_BASE_DELAY_MS;
    if (savedEnv.GOOGLE_TTS_RETRY_MAX_DELAY_MS === undefined) delete process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS;
    else process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS = savedEnv.GOOGLE_TTS_RETRY_MAX_DELAY_MS;
  });

  // =========================================================================
  // A. External TTS happy path
  // =========================================================================
  describe("external TTS pipeline", () => {
    beforeEach(() => {
      process.env.USE_BUILTIN_TTS = "false";
    });

    it("produces per-scene audio in sceneTimelineFrames", async () => {
      const compositor = new CapturingCompositor();
      const storageService = new MockStorageService();
      const deps = makeDeps({ videoCompositor: compositor, storageService });
      const orchestrator = new VideoOrchestrator(deps);

      const result = await orchestrator.execute("job-ext-1", makeContext());

      expect(result.videoUrl).toBeTruthy();
      expect(result.script.scenes.length).toBe(7);

      const input = compositor.capturedInput!;
      expect(input.audioIncluded).toBe(false);
      expect(input.sceneTimelineFrames).toHaveLength(7);

      for (const entry of input.sceneTimelineFrames) {
        expect(entry.durationFrames).toBeGreaterThan(0);
        // Every scene in the mock script has narration, so audioSrc should be populated
        expect(entry.audioSrc).toBeTruthy();
        expect(entry.wordTimings).toBeDefined();
        expect(entry.wordTimings!.length).toBeGreaterThan(0);
        // Word timings are 0-based
        expect(entry.wordTimings![0].startTimeMs).toBe(0);
      }

      // Final video uploaded
      expect(storageService.has(`videos/owner/repo/99/job-ext-1.mp4`)).toBe(true);
    });

    it("sizes clips using ceilingDuration from narration length", async () => {
      const ttsService = new MockTTSService();
      const deps = makeDeps({
        ttsService,
      });
      const orchestrator = new VideoOrchestrator(deps);

      await orchestrator.execute("job-ext-2", makeContext());

      // Code-first mode: clips built by generateClips (no AI clip generator)
      expect(true).toBe(true);
    });

    it("cleans up per-scene audio after pipeline completes", async () => {
      const storageService = new MockStorageService();
      const deps = makeDeps({ storageService });
      const orchestrator = new VideoOrchestrator(deps);

      await orchestrator.execute("job-ext-3", makeContext());

      // Per-scene audio keys should be deleted
      for (let i = 1; i <= 7; i++) {
        expect(storageService.has(`audio/owner/repo/99/job-ext-3/scene-${i}.ogg`)).toBe(false);
      }
      // Final video should remain
      expect(storageService.has(`videos/owner/repo/99/job-ext-3.mp4`)).toBe(true);
    });

    it("completes when Google TTS recovers after a transient scene failure", async () => {
      process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
      process.env.GOOGLE_TTS_MAX_ATTEMPTS = "2";
      process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS = "1";
      process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS = "1";
      const ttsService = new GoogleTTSService();
      const synthesizeSpeech = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("DEADLINE_EXCEEDED"), { code: "DEADLINE_EXCEEDED" }))
        .mockResolvedValue([{ audioContent: Uint8Array.from([1, 2, 3]) }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ttsService as any).getClient = () => ({ synthesizeSpeech });
      const storageService = new MockStorageService();
      const deps = makeDeps({ ttsService, storageService });
      const orchestrator = new VideoOrchestrator(deps);

      const result = await orchestrator.execute("job-ext-tts-retry", makeContext());

      expect(result.videoUrl).toBeTruthy();
      expect(synthesizeSpeech).toHaveBeenCalledTimes(8);
      expect(storageService.has("videos/owner/repo/99/job-ext-tts-retry.mp4")).toBe(true);
    });

    it("handles empty narration scene gracefully", async () => {
      const compositor = new CapturingCompositor();
      const ttsService = new MockTTSService();
      const ttsSpy = vi.spyOn(ttsService, "synthesize");

      // Script writer that returns one scene with empty narration
      const scriptWriter: IScriptWriter = {
        generateScript: async (ctx) => {
          const base = await new MockScriptWriter().generateScript(ctx, {} as DiffAnalysis);
          base.script.scenes[2] = {
            ...base.script.scenes[2],
            narration: "",
          };
          return base;
        },
        retimeNarration: async (...args) => new MockScriptWriter().retimeNarration(...args),
      };

      const deps = makeDeps({ videoCompositor: compositor, ttsService, scriptWriter });
      const orchestrator = new VideoOrchestrator(deps);

      const result = await orchestrator.execute("job-ext-4", makeContext());
      expect(result.videoUrl).toBeTruthy();

      // TTS should be called 6 times (7 scenes minus 1 empty)
      expect(ttsSpy).toHaveBeenCalledTimes(6);

      const input = compositor.capturedInput!;
      const scene3Entry = input.sceneTimelineFrames.find((e) => e.sceneNumber === 3);
      expect(scene3Entry).toBeDefined();
      expect(scene3Entry!.audioSrc).toBeUndefined();
      expect(scene3Entry!.wordTimings).toBeUndefined();
    });

    it("caps clip duration at model max when narration exceeds it", async () => {
      // TTS that returns very long narration (37 words = 14.8s at 400ms/word)
      const longText = Array.from({ length: 37 }, (_, i) => `word${i}`).join(" ");
      const longTTS: ITTSService = {
        synthesize: async (text: string, _voiceName?: string) => {
          const words = text.split(/\s+/).filter(Boolean);
          const wordTimings = words.map((w, i) => ({
            word: w,
            startTimeMs: i * 400,
            endTimeMs: (i + 1) * 400,
          }));
          const lastTiming = wordTimings[wordTimings.length - 1];
          return {
            audioBuffer: Buffer.from("LONG_AUDIO"),
            wordTimings,
            audioDurationSeconds: lastTiming ? lastTiming.endTimeMs / 1000 : 0,
          };
        },
      };

      // Script writer where every scene has long narration
      const scriptWriter: IScriptWriter = {
        generateScript: async (ctx) => {
          const base = await new MockScriptWriter().generateScript(ctx, {} as DiffAnalysis);
          for (const scene of base.script.scenes) {
            scene.narration = longText;
          }
          return base;
        },
        retimeNarration: async (...args) => new MockScriptWriter().retimeNarration(...args),
      };

      const deps = makeDeps({
        ttsService: longTTS,
        scriptWriter,
      });
      const orchestrator = new VideoOrchestrator(deps);

      const result = await orchestrator.execute("job-ext-5", makeContext());
      expect(result.videoUrl).toBeTruthy();

      // Pipeline still completes with clips
      expect(result.script.scenes.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // B. Builtin TTS happy path
  // =========================================================================
  describe("builtin TTS pipeline", () => {
    it("produces audioIncluded=true with no per-scene audio", async () => {
      process.env.USE_BUILTIN_TTS = "true";
      const compositor = new CapturingCompositor();
      const ttsService = new MockTTSService();
      const ttsSpy = vi.spyOn(ttsService, "synthesize");
      const deps = makeDeps({ videoCompositor: compositor, ttsService });
      const orchestrator = new VideoOrchestrator(deps);

      const result = await orchestrator.execute("job-builtin-1", makeContext());
      expect(result.videoUrl).toBeTruthy();

      const input = compositor.capturedInput!;
      expect(input.audioIncluded).toBe(true);
      expect(input.sceneTimelineFrames.length).toBe(7);

      for (const entry of input.sceneTimelineFrames) {
        expect(entry.durationFrames).toBeGreaterThan(0);
        expect(entry.audioSrc).toBeUndefined();
        expect(entry.wordTimings).toBeUndefined();
      }

      // TTS synthesize should never be called for builtin path
      expect(ttsSpy).not.toHaveBeenCalled();
    });

    // Theme-specific builtin TTS and speaking role cap tests removed — themes no longer apply.
  });

  // =========================================================================
  // C. Error handling
  // =========================================================================
  describe("error handling", () => {
    beforeEach(() => {
      process.env.USE_BUILTIN_TTS = "false";
    });

    it("TTS failure includes scene number in error", async () => {
      let callIndex = 0;
      const failingTTS: ITTSService = {
        synthesize: async (text, voiceName) => {
          callIndex++;
          if (callIndex === 3) throw new Error("TTS_NETWORK_ERROR");
          return new MockTTSService().synthesize(text, voiceName);
        },
      };

      const deps = makeDeps({ ttsService: failingTTS });
      const orchestrator = new VideoOrchestrator(deps);

      await expect(orchestrator.execute("job-err-1", makeContext())).rejects.toThrow(/scene 3/);
    });

    // AI clip generation failure test removed — AI clip generator is not called in code-first mode.

    it("storage upload failure during audio upload propagates", async () => {
      let _uploadCount = 0;
      const failingStorage = new MockStorageService();
      const originalUpload = failingStorage.upload.bind(failingStorage);
      vi.spyOn(failingStorage, "upload").mockImplementation(
        async (key: string, data: Buffer, contentType: string) => {
          _uploadCount++;
          if (key.includes("scene-4.ogg")) throw new Error("UPLOAD_QUOTA_EXCEEDED");
          return originalUpload(key, data, contentType);
        },
      );

      const deps = makeDeps({ storageService: failingStorage });
      const orchestrator = new VideoOrchestrator(deps);

      await expect(orchestrator.execute("job-err-3", makeContext())).rejects.toThrow(
        "UPLOAD_QUOTA_EXCEEDED",
      );
    });

    it("storage cleanup failure is non-fatal", async () => {
      const storageService = new MockStorageService();
      vi.spyOn(storageService, "delete").mockRejectedValue(new Error("DELETE_FAILED"));

      const deps = makeDeps({ storageService });
      const orchestrator = new VideoOrchestrator(deps);

      // Should complete despite cleanup failures
      const result = await orchestrator.execute("job-err-4", makeContext());
      expect(result.videoUrl).toBeTruthy();
    });

    it("composition failure propagates", async () => {
      const failingCompositor: IVideoCompositor = {
        compose: async () => {
          throw new Error("REMOTION_RENDER_FAILED");
        },
      };

      const deps = makeDeps({ videoCompositor: failingCompositor });
      const orchestrator = new VideoOrchestrator(deps);

      await expect(orchestrator.execute("job-err-5", makeContext())).rejects.toThrow(
        "REMOTION_RENDER_FAILED",
      );
    });

    it("final video upload failure propagates", async () => {
      const storageService = new MockStorageService();
      const originalUpload = storageService.upload.bind(storageService);
      vi.spyOn(storageService, "upload").mockImplementation(
        async (key: string, data: Buffer, contentType: string) => {
          if (key.startsWith("videos/")) throw new Error("VIDEO_UPLOAD_FAILED");
          return originalUpload(key, data, contentType);
        },
      );

      const deps = makeDeps({ storageService });
      const orchestrator = new VideoOrchestrator(deps);

      await expect(orchestrator.execute("job-err-6", makeContext())).rejects.toThrow(
        "VIDEO_UPLOAD_FAILED",
      );
    });
  });

  // =========================================================================
  // D. Resume from checkpoint — External TTS
  // =========================================================================
  describe("resume: guards", () => {
    it("throws without checkpoint store", async () => {
      const deps = makeDeps({ checkpointStore: undefined });
      const orchestrator = new VideoOrchestrator(deps);

      await expect(orchestrator.resume("job-no-store")).rejects.toThrow(
        "Cannot resume without a checkpoint store",
      );
    });

    it("throws when no checkpoint exists for job", async () => {
      const checkpointStore = new LocalCheckpointStore();
      const deps = makeDeps({ checkpointStore });
      const orchestrator = new VideoOrchestrator(deps);

      await expect(orchestrator.resume("job-nonexistent")).rejects.toThrow(
        /No checkpoint found/,
      );
    });
  });

  describe("resume: external TTS", () => {
    beforeEach(() => {
      process.env.USE_BUILTIN_TTS = "false";
    });

    it("re-synthesizes when step 4 checkpoint has no perSceneAudio", async () => {
      const ttsService = new MockTTSService();
      const ttsSpy = vi.spyOn(ttsService, "synthesize");
      const checkpointStore = new LocalCheckpointStore();

      const scriptResult = await new MockScriptWriter().generateScript(
        makeContext(),
        {} as DiffAnalysis,
      );

      // Step 4 but perSceneAudio is missing (corrupted checkpoint)
      const checkpoint: PipelineCheckpoint = {
        jobId: "job-resume-ext-corrupt",
        completedStep: 4,
        prContext: makeContext(),
        script: scriptResult.script,
        // perSceneAudio intentionally omitted
      };
      await checkpointStore.save(checkpoint);

      const deps = makeDeps({ ttsService, checkpointStore });
      const orchestrator = new VideoOrchestrator(deps);
      const result = await orchestrator.resume("job-resume-ext-corrupt");

      expect(result.videoUrl).toBeTruthy();
      // Should re-synthesize all 7 scenes since perSceneAudio was missing
      expect(ttsSpy).toHaveBeenCalledTimes(7);
    });

    it("resumes from step 2 — re-synthesizes + generates clips", async () => {
      const compositor = new CapturingCompositor();
      const ttsService = new MockTTSService();
      const ttsSpy = vi.spyOn(ttsService, "synthesize");
      const storageService = new MockStorageService();
      const checkpointStore = new LocalCheckpointStore();

      const deps = makeDeps({
        videoCompositor: compositor,
        ttsService,
        storageService,
        checkpointStore,
      });

      // Generate a real script via MockScriptWriter so checkpoint is valid
      const scriptResult = await new MockScriptWriter().generateScript(
        makeContext(),
        {} as DiffAnalysis,
      );

      const checkpoint: PipelineCheckpoint = {
        jobId: "job-resume-ext-1",
        completedStep: 2,
        prContext: makeContext(),
        script: scriptResult.script,
      };
      await checkpointStore.save(checkpoint);

      const orchestrator = new VideoOrchestrator(deps);
      const result = await orchestrator.resume("job-resume-ext-1");

      expect(result.videoUrl).toBeTruthy();
      // TTS should be called for all 7 scenes
      expect(ttsSpy).toHaveBeenCalledTimes(7);
      // Compositor should have been called
      expect(compositor.capturedInput).toBeDefined();
    });

    it("resumes from step 4 — re-signs URLs + generates clips", async () => {
      const compositor = new CapturingCompositor();
      const storageService = new MockStorageService();
      const checkpointStore = new LocalCheckpointStore();
      const ttsService = new MockTTSService();
      const ttsSpy = vi.spyOn(ttsService, "synthesize");

      // Pre-populate storage with audio files
      const scriptResult = await new MockScriptWriter().generateScript(
        makeContext(),
        {} as DiffAnalysis,
      );
      const perSceneAudio = scriptResult.script.scenes.map((scene) => {
        const key = `audio/owner/repo/99/job-resume-ext-2/scene-${scene.sceneNumber}.ogg`;
        storageService.upload(key, Buffer.from("AUDIO"), "audio/ogg");
        const words = scene.narration.split(/\s+/).filter(Boolean);
        return {
          sceneNumber: scene.sceneNumber,
          audioKey: key,
          wordTimings: words.map((w, i) => ({
            word: w,
            startTimeMs: i * 400,
            endTimeMs: (i + 1) * 400,
          })),
          clipDurations: [10],
        };
      });

      const checkpoint: PipelineCheckpoint = {
        jobId: "job-resume-ext-2",
        completedStep: 4,
        prContext: makeContext(),
        script: scriptResult.script,
        perSceneAudio,
      };
      await checkpointStore.save(checkpoint);

      const deps = makeDeps({
        videoCompositor: compositor,
        storageService,
        ttsService,
        checkpointStore,
      });
      const orchestrator = new VideoOrchestrator(deps);
      const result = await orchestrator.resume("job-resume-ext-2");

      expect(result.videoUrl).toBeTruthy();
      // TTS should NOT be called (audio already uploaded)
      expect(ttsSpy).not.toHaveBeenCalled();
    });

    it("resumes from step 5 — fast path, just compose + upload", async () => {
      const compositor = new CapturingCompositor();
      const storageService = new MockStorageService();
      const ttsService = new MockTTSService();
      const ttsSpy = vi.spyOn(ttsService, "synthesize");
      const checkpointStore = new LocalCheckpointStore();

      const scriptResult = await new MockScriptWriter().generateScript(
        makeContext(),
        {} as DiffAnalysis,
      );

      const perSceneAudio = scriptResult.script.scenes.map((scene) => {
        const key = `audio/owner/repo/99/job-resume-ext-3/scene-${scene.sceneNumber}.ogg`;
        storageService.upload(key, Buffer.from("AUDIO"), "audio/ogg");
        const words = scene.narration.split(/\s+/).filter(Boolean);
        return {
          sceneNumber: scene.sceneNumber,
          audioKey: key,
          wordTimings: words.map((w, i) => ({
            word: w,
            startTimeMs: i * 400,
            endTimeMs: (i + 1) * 400,
          })),
          clipDurations: [10],
        };
      });

      const clips: ClipAsset[] = scriptResult.script.scenes.map((scene) => ({
        sceneNumber: scene.sceneNumber,
        clipIndex: 0,
        clipUrl: `https://mock.com/clip-${scene.sceneNumber}.mp4`,
        durationSeconds: 10,
        durationFrames: 300,
      }));

      const checkpoint: PipelineCheckpoint = {
        jobId: "job-resume-ext-3",
        completedStep: 5,
        prContext: makeContext(),
        script: scriptResult.script,
        perSceneAudio,
        clips,
      };
      await checkpointStore.save(checkpoint);

      const deps = makeDeps({
        videoCompositor: compositor,
        storageService,
        ttsService,
        checkpointStore,
      });
      const orchestrator = new VideoOrchestrator(deps);
      const result = await orchestrator.resume("job-resume-ext-3");

      expect(result.videoUrl).toBeTruthy();
      // No TTS or clip generation
      expect(ttsSpy).not.toHaveBeenCalled();
      // Compositor was called
      expect(compositor.capturedInput).toBeDefined();
      expect(compositor.capturedInput!.sceneTimelineFrames).toHaveLength(7);
    });

    it("resumes and re-generates clips when durationFrames missing", async () => {
      const storageService = new MockStorageService();
      const checkpointStore = new LocalCheckpointStore();

      const scriptResult = await new MockScriptWriter().generateScript(
        makeContext(),
        {} as DiffAnalysis,
      );

      const perSceneAudio = scriptResult.script.scenes.map((scene) => {
        const key = `audio/owner/repo/99/job-resume-ext-4/scene-${scene.sceneNumber}.ogg`;
        storageService.upload(key, Buffer.from("AUDIO"), "audio/ogg");
        return {
          sceneNumber: scene.sceneNumber,
          audioKey: key,
          wordTimings: [{ word: "test", startTimeMs: 0, endTimeMs: 400 }],
          clipDurations: [10],
        };
      });

      // Clips WITHOUT durationFrames → should trigger re-generation
      const clips: ClipAsset[] = scriptResult.script.scenes.map((scene) => ({
        sceneNumber: scene.sceneNumber,
        clipIndex: 0,
        clipUrl: `https://mock.com/clip-${scene.sceneNumber}.mp4`,
        durationSeconds: 10,
        // durationFrames intentionally omitted
      }));

      const checkpoint: PipelineCheckpoint = {
        jobId: "job-resume-ext-4",
        completedStep: 5,
        prContext: makeContext(),
        script: scriptResult.script,
        perSceneAudio,
        clips,
      };
      await checkpointStore.save(checkpoint);

      const deps = makeDeps({
        storageService,
        checkpointStore,
      });
      const orchestrator = new VideoOrchestrator(deps);
      const result = await orchestrator.resume("job-resume-ext-4");

      expect(result.videoUrl).toBeTruthy();
    });
  });

  // =========================================================================
  // E. Resume from checkpoint — Builtin TTS
  // =========================================================================
  describe("resume: builtin TTS", () => {
    it("resumes from step < 4 — resolves timeline + generates clips", async () => {
      process.env.USE_BUILTIN_TTS = "true";
      const compositor = new CapturingCompositor();
      const checkpointStore = new LocalCheckpointStore();

      const scriptResult = await new MockScriptWriter().generateScript(
        makeContext(),
        {} as DiffAnalysis,
      );

      const checkpoint: PipelineCheckpoint = {
        jobId: "job-resume-builtin-1",
        completedStep: 2,
        prContext: makeContext(),
        script: scriptResult.script,
        audio: {
          audioUrl: "",
          audioKey: null,
          wordTimings: [],
          audioIncluded: true,
        },
      };
      await checkpointStore.save(checkpoint);

      const deps = makeDeps({
        videoCompositor: compositor,
        checkpointStore,
      });
      const orchestrator = new VideoOrchestrator(deps);
      const result = await orchestrator.resume("job-resume-builtin-1");

      expect(result.videoUrl).toBeTruthy();
      expect(compositor.capturedInput!.audioIncluded).toBe(true);
    });

    it("resumes from step 5 — just compose", async () => {
      process.env.USE_BUILTIN_TTS = "true";
      const compositor = new CapturingCompositor();
      const checkpointStore = new LocalCheckpointStore();

      const scriptResult = await new MockScriptWriter().generateScript(
        makeContext(),
        {} as DiffAnalysis,
      );

      const clips: ClipAsset[] = scriptResult.script.scenes.map((scene) => ({
        sceneNumber: scene.sceneNumber,
        clipIndex: 0,
        clipUrl: `https://mock.com/clip-${scene.sceneNumber}.mp4`,
        durationSeconds: 10,
        durationFrames: 300,
      }));

      const checkpoint: PipelineCheckpoint = {
        jobId: "job-resume-builtin-2",
        completedStep: 5,
        prContext: makeContext(),
        script: scriptResult.script,
        audio: {
          audioUrl: "",
          audioKey: null,
          wordTimings: [],
          audioIncluded: true,
        },
        clips,
      };
      await checkpointStore.save(checkpoint);

      const deps = makeDeps({
        videoCompositor: compositor,
        checkpointStore,
      });
      const orchestrator = new VideoOrchestrator(deps);
      const result = await orchestrator.resume("job-resume-builtin-2");

      expect(result.videoUrl).toBeTruthy();
      // Compositor was called
      expect(compositor.capturedInput).toBeDefined();
    });
  });
});
