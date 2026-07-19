import { beforeEach, describe, expect, it } from "vitest";
import { PipelineRunner } from "@/domain/services/PipelineRunner";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockVideoCompositor } from "@/mocks/MockVideoCompositor";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockStorageService } from "@/mocks/MockStorageService";
import { MockJobRepository } from "@/mocks/MockJobRepository";
import { MockDiffSource } from "@/mocks/MockDiffSource";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import type { OrchestratorDeps } from "@/domain/services/VideoOrchestrator";
import type { IScriptWriter } from "@/interfaces/IScriptWriter";
import type { FileChangeSummary } from "@/domain/entities/FileChangeSummary";
import type { DiffSegment } from "@/domain/entities/DiffSegment";
import type { PromptPipelineV2Artifacts } from "@/domain/entities/PromptPipelineV2";
import type {
  IPipelineCheckpointStore,
  PipelineCheckpoint,
} from "@/interfaces/IPipelineCheckpoint";
import type {
  ReviewDiffSnapshot,
  ReviewPin,
  SceneDiffAnchor,
} from "@/domain/entities/ReviewDiffSnapshot";
import { mockContext } from "../../fixtures/orchestrator";
import {
  makeReviewDiffSnapshot,
  makeReviewPins,
  makeSceneDiffAnchors,
} from "../../integration/helpers/reviewWorkspaceFixtures";

class MemoryCheckpointStore implements IPipelineCheckpointStore {
  private store = new Map<string, PipelineCheckpoint>();

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    this.store.set(checkpoint.jobId, checkpoint);
  }

  async load(jobId: string): Promise<PipelineCheckpoint | null> {
    return this.store.get(jobId) ?? null;
  }

  async delete(jobId: string): Promise<void> {
    this.store.delete(jobId);
  }
}

function makeFile(overrides: Partial<FileChangeSummary>): FileChangeSummary {
  return {
    filePath: "src/example.ts",
    previousFilePath: null,
    language: "typescript",
    changeType: "modified",
    linesAdded: 1,
    linesRemoved: 1,
    isBinary: false,
    snippets: [],
    analysis: null,
    importanceScore: 0.5,
    ...overrides,
  };
}

/** Corpus covering added/modified/renamed/binary files. */
function makeSegments(): DiffSegment[] {
  return [
    {
      segmentIndex: 0,
      isFinal: true,
      cumulativeLines: 0,
      files: [
        makeFile({
          // Matches MockScriptWriter scene 2 codeBroll (lineRange [1,4]) so
          // an exact-precision anchor is produced.
          filePath: "src/domain/services/PipelineRunner.ts",
          changeType: "modified",
          linesAdded: 2,
          linesRemoved: 1,
          snippets: [{
            kind: "hunk",
            content: "@@ -1,3 +1,4 @@\n export {};\n-const old = 1;\n+const orchestrator = 1;\n+const result = 2;\n // done",
          }],
        }),
        makeFile({
          filePath: "src/app/api/jobs/route.ts",
          changeType: "added",
          linesAdded: 2,
          linesRemoved: 0,
          snippets: [{
            kind: "hunk",
            content: "@@ -0,0 +1,2 @@\n+const scriptOnly = true;\n+export { scriptOnly };",
          }],
        }),
        makeFile({
          filePath: "src/lib/renamed.ts",
          previousFilePath: "src/lib/old-name.ts",
          changeType: "renamed",
          linesAdded: 1,
          linesRemoved: 1,
          snippets: [{
            kind: "hunk",
            content: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const b = 2;",
          }],
        }),
        makeFile({
          filePath: "assets/logo.png",
          changeType: "modified",
          isBinary: true,
          linesAdded: 0,
          linesRemoved: 0,
          snippets: [],
        }),
      ],
    },
  ];
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    diffAnalyzer: new HeuristicDiffAnalyzer(),
    scriptWriter: new MockScriptWriter(),
    ttsService: new MockTTSService(),
    videoCompositor: new MockVideoCompositor(),
    storageService: new MockStorageService(),
    checkpointStore: new MemoryCheckpointStore(),
    ...overrides,
  };
}

interface WorkspaceMetrics {
  reviewDiffSnapshot?: ReviewDiffSnapshot;
  sceneDiffAnchors?: SceneDiffAnchor[];
  reviewPins?: ReviewPin[];
}

describe("PipelineRunner review-workspace metrics", () => {
  let jobRepository: MockJobRepository;

  beforeEach(() => {
    jobRepository = new MockJobRepository();
  });

  it("persists reviewDiffSnapshot/sceneDiffAnchors/reviewPins reconstructed from the corpus", async () => {
    const deps = makeDeps();
    const runner = new PipelineRunner(
      deps,
      jobRepository,
      undefined,
      undefined,
      () => new MockDiffSource(makeSegments()),
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
    await runner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("completed");

    const metrics = updated?.metricsJson as WorkspaceMetrics;
    const snapshot = metrics.reviewDiffSnapshot;
    expect(snapshot).toBeDefined();
    expect(metrics.sceneDiffAnchors).toBeDefined();
    expect(metrics.reviewPins).toEqual([]); // no V2 reviewConcerns in this run

    // Round trip: the reconstructed unified diff parses back into the
    // expected file/hunk structure. Binary files never reach the corpus
    // (DiffCorpusBuilder skips them), so only the 3 textual files appear.
    const byPath = new Map(snapshot!.files.map((file) => [file.filePath, file] as const));
    expect(snapshot!.totalFiles).toBe(3);

    const modified = byPath.get("src/domain/services/PipelineRunner.ts");
    expect(modified?.changeType).toBe("modified");
    expect(modified?.hunks).toHaveLength(1);
    expect(modified?.hunks[0].lines.map((line) => line.kind)).toEqual([
      "context", "removed", "added", "added", "context",
    ]);
    expect(modified?.hunks[0].lines.map((line) => line.position)).toEqual([1, 2, 3, 4, 5]);

    const added = byPath.get("src/app/api/jobs/route.ts");
    expect(added?.changeType).toBe("added");
    expect(added?.hunks[0].lines.every((line) => line.kind === "added")).toBe(true);

    const renamed = byPath.get("src/lib/renamed.ts");
    expect(renamed?.changeType).toBe("renamed");
    expect(renamed?.oldPath).toBe("src/lib/old-name.ts");

    expect(byPath.has("assets/logo.png")).toBe(false);

    // MockScriptWriter scene 2 discusses PipelineRunner.ts lines 1-4 — the
    // anchor for it must resolve to exact precision with real line ids.
    const exactAnchor = metrics.sceneDiffAnchors!.find(
      (anchor) => anchor.filePath === "src/domain/services/PipelineRunner.ts",
    );
    expect(exactAnchor?.precision).toBe("exact");
    expect(exactAnchor?.lineIds.length).toBeGreaterThan(0);
  });

  it("retry without a checkpoint corpus retains previously-persisted workspace fields", async () => {
    const checkpointStore = new MemoryCheckpointStore();
    const deps = makeDeps({ checkpointStore });
    const runner = new PipelineRunner(deps, jobRepository);

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });

    // Job failed after a first run that DID persist workspace metrics.
    const persistedSnapshot = makeReviewDiffSnapshot();
    await jobRepository.updateStatus(job.id, "failed", {
      metricsJson: {
        reviewDiffSnapshot: persistedSnapshot,
        sceneDiffAnchors: makeSceneDiffAnchors(),
        reviewPins: makeReviewPins(),
      },
    });

    // Common retry shape: VideoOrchestrator re-saved the checkpoint after
    // step 2 WITHOUT diffCorpus.
    await checkpointStore.save({
      jobId: job.id,
      completedStep: 2,
      prContext: mockContext,
    });

    await runner.retry(job.id);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("completed");

    const metrics = updated?.metricsJson as WorkspaceMetrics;
    // Without the fallback this would be an EMPTY snapshot (no corpus →
    // reconstructed diff is "") wiping the populated one.
    expect(metrics.reviewDiffSnapshot?.totalFiles).toBe(persistedSnapshot.totalFiles);
    expect(metrics.reviewDiffSnapshot?.headSha).toBe(persistedSnapshot.headSha);
    expect(metrics.sceneDiffAnchors?.map((anchor) => anchor.anchorId)).toEqual(
      makeSceneDiffAnchors().map((anchor) => anchor.anchorId),
    );
    expect(metrics.reviewPins?.map((pin) => pin.pinId)).toEqual(
      makeReviewPins().map((pin) => pin.pinId),
    );
  });

  it("completes the job (workspace omitted) when the workspace builder throws", async () => {
    // Malformed V2 artifacts: a reviewConcern without evidenceFilePaths makes
    // buildReviewPins throw. Before the guard this failed an already-rendered
    // video job; now the job completes without workspace fields.
    const malformedArtifacts = {
      enabled: true,
      llmFamily: "claude",
      coveragePlan: { clusters: [] },
      sceneOutline: { scenes: [] },
      reviewConcerns: [{
        concernId: "c1",
        issueClass: "correctness",
        riskStatement: "Risk statement",
        // evidenceFilePaths intentionally missing
      }],
    } as unknown as PromptPipelineV2Artifacts;

    const malformedScriptWriter: IScriptWriter = {
      generateScript: async (context, analysis) => {
        const base = await new MockScriptWriter().generateScript(context, analysis);
        return { ...base, promptPipelineV2: malformedArtifacts };
      },
      retimeNarration: async () => ({ scenes: [] }),
    };
    const deps = makeDeps({ scriptWriter: malformedScriptWriter });
    const runner = new PipelineRunner(
      deps,
      jobRepository,
      undefined,
      undefined,
      () => new MockDiffSource(makeSegments()),
    );

    const job = await jobRepository.create({ repoFullName: "owner/repo", prNumber: 42 });
    await runner.run(job.id, mockContext);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.videoUrl).toBeDefined();

    const metrics = updated?.metricsJson as WorkspaceMetrics & { promptPipeline?: { version: string } };
    expect(metrics.promptPipeline?.version).toBe("v2");
    expect(metrics.reviewDiffSnapshot).toBeUndefined();
    expect(metrics.sceneDiffAnchors).toBeUndefined();
    expect(metrics.reviewPins).toBeUndefined();
  });
});
