import { describe, expect, it } from "vitest";
import { VideoOrchestrator } from "@/domain/services/VideoOrchestrator";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockStorageService } from "@/mocks/MockStorageService";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import type { PRContext } from "@/domain/entities/PRContext";
import type { CompositionInput, CompositionResult, IVideoCompositor } from "@/interfaces/IVideoCompositor";

class CapturingVideoCompositor implements IVideoCompositor {
  lastInput: CompositionInput | null = null;

  async compose(input: CompositionInput): Promise<CompositionResult> {
    this.lastInput = input;
    return { videoBuffer: Buffer.from("MOCK_VIDEO_DATA") };
  }
}

const testPRContext: PRContext = {
  repoFullName: "keep-honest/prvod",
  prNumber: 42,
  prTitle: "Add rate limiting to auth endpoint",
  prDescription: "Adds rate limiting to the auth endpoint.",
  diffSource: { kind: "github_pr" as const, repoFullName: "keep-honest/prvod", prNumber: 42, installationId: 1 },
  baseBranch: "main",
  headBranch: "feature/rate-limit",
  headSha: "",
  issues: [],
  milestone: null,
  isPrivate: false,
  durationMode: "default",
    deepdive: false,
};

describe("Code-first pipeline", () => {
  it("does not call the AI clip generator for the default code-first walkthrough", async () => {
    const videoCompositor = new CapturingVideoCompositor();
    const storageService = new MockStorageService();
    const orchestrator = new VideoOrchestrator({
      diffAnalyzer: new HeuristicDiffAnalyzer(),
      scriptWriter: new MockScriptWriter(),
      ttsService: new MockTTSService(),
      videoCompositor,
      storageService,
    });

    const result = await orchestrator.execute("job-code-first", testPRContext);

    expect(result.videoUrl).toBeTruthy();
    expect(videoCompositor.lastInput?.clips.every((clip) => clip.sourceType === "code")).toBe(true);
  });

  // visualPromptJudge test removed — the judge was a no-op and has been
  // removed from OrchestratorDeps.
});
