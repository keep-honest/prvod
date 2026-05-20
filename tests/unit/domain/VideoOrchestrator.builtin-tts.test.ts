import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { VideoOrchestrator } from "@/domain/services/VideoOrchestrator";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockVideoCompositor } from "@/mocks/MockVideoCompositor";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockStorageService } from "@/mocks/MockStorageService";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import {
  mockContext as baseMockContext,
} from "../../fixtures/orchestrator";

vi.mock("@/infrastructure/video/prepareClipAssets", () => ({
  prepareClipAssets: async (clips: Array<{
    sceneNumber: number;
    clipIndex: number;
    clipUrl: string;
    durationSeconds: number;
    durationFrames?: number;
  }>) =>
    clips.map((clip) => {
      const durationFrames = clip.durationFrames ?? Math.max(1, Math.round(clip.durationSeconds * 30));
      return { ...clip, durationFrames, durationSeconds: durationFrames / 30 };
    }),
}));

const mockContext = { ...baseMockContext};

describe("VideoOrchestrator — builtin TTS", () => {
  let ttsService: MockTTSService;
  let compositor: MockVideoCompositor;
  let storageService: MockStorageService;

  beforeEach(() => {
    ttsService = new MockTTSService();
    compositor = new MockVideoCompositor();
    storageService = new MockStorageService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createOrchestrator() {
    return new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService,
      videoCompositor: compositor,
      storageService,
    });
  }

  it("skips TTS when USE_BUILTIN_TTS=true", async () => {
    vi.stubEnv("USE_BUILTIN_TTS", "true");
    const ttsSpy = vi.spyOn(ttsService, "synthesize");

    const orchestrator = createOrchestrator();
    const result = await orchestrator.execute("job-1", mockContext);

    expect(ttsSpy).not.toHaveBeenCalled();
    expect(result.videoUrl).toBeDefined();
    expect(result.script.scenes.length).toBeGreaterThan(0);
  });

  it("passes audioIncluded to compositor when USE_BUILTIN_TTS=true", async () => {
    vi.stubEnv("USE_BUILTIN_TTS", "true");
    const composeSpy = vi.spyOn(compositor, "compose");

    const orchestrator = createOrchestrator();
    await orchestrator.execute("job-3", mockContext);

    expect(composeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ audioIncluded: true }),
    );
  });

  it("populates sceneTimelineFrames but omits audioSrc when USE_BUILTIN_TTS=true", async () => {
    vi.stubEnv("USE_BUILTIN_TTS", "true");
    const composeSpy = vi.spyOn(compositor, "compose");

    const orchestrator = createOrchestrator();
    await orchestrator.execute("job-4", mockContext);

    const input = composeSpy.mock.calls[0][0];
    // Builtin TTS: native audio is embedded in clips — no external audioSrc needed
    expect(input.sceneTimelineFrames.length).toBeGreaterThan(0);
    expect(input.sceneTimelineFrames.every((e: { audioSrc?: string }) => !e.audioSrc)).toBe(true);
  });

  it("does not upload audio when USE_BUILTIN_TTS=true", async () => {
    vi.stubEnv("USE_BUILTIN_TTS", "true");
    const uploadSpy = vi.spyOn(storageService, "upload");

    const orchestrator = createOrchestrator();
    await orchestrator.execute("job-5", mockContext);

    // No audio upload — only video and script artifacts
    const uploadKeys = uploadSpy.mock.calls.map((c) => c[0]);
    expect(uploadKeys.every((k) => k.startsWith("videos/") || k.startsWith("scripts/"))).toBe(true);
    expect(uploadKeys.some((k) => k.startsWith("audio/"))).toBe(false);
  });

  it("uses external TTS when USE_BUILTIN_TTS is unset", async () => {
    const ttsSpy = vi.spyOn(ttsService, "synthesize");

    const orchestrator = createOrchestrator();
    await orchestrator.execute("job-6", mockContext);

    expect(ttsSpy).toHaveBeenCalled();
  });

  // Theme-specific trailer voice tests removed — theme-based TTS voice selection no longer applies.

  // Narration sanitization for builtin native-voice clips is not applicable — AI clip generator is not called in code-first mode.
});
