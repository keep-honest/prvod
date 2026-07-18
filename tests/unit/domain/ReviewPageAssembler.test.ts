import { describe, expect, it } from "vitest";
import { ReviewPageAssembler } from "@/domain/services/ReviewPageAssembler";
import { MockStorageService } from "@/mocks/MockStorageService";
import {
  makeReviewVideoJob,
  makeReviewVideoScript,
} from "../../integration/helpers/reviewPageFixtures";

describe("ReviewPageAssembler", () => {
  it("builds ordered replay metadata and refreshes the signed walkthrough URL", async () => {
    const storage = new MockStorageService();
    const assembler = new ReviewPageAssembler(storage);
    const job = makeReviewVideoJob();
    const script = makeReviewVideoScript();

    await storage.upload((job.objectKey as string), Buffer.from("video"), "video/mp4");

    const enrichedScript = { ...script, keyFiles: ["src/lib/auth.ts", "src/app/page.tsx"] };
    const sceneTimeline = enrichedScript.scenes.map(s => ({
      sceneNumber: s.sceneNumber,
      durationMs: s.durationSeconds * 1000,
    }));
    const payload = await assembler.build(job, enrichedScript, sceneTimeline);

    expect(payload.videoUrl).toContain((job.objectKey as string));
    expect(payload.visibility).toBe("public");
    expect(payload.accessPolicy).toBe("open");
    expect(payload.files).toEqual([
      {
        filePath: "src/lib/auth.ts",
        sceneNumbers: [3],
        primarySceneNumber: 3,
        changeSummary: "modified / +2/-1",
      },
      {
        filePath: "src/app/page.tsx",
        sceneNumbers: [2],
        primarySceneNumber: 2,
        changeSummary: "modified / +3/-1",
      },
    ]);
    expect(payload.scenes[0]).toMatchObject({
      sceneNumber: 1,
      startTimeMs: 0,
      endTimeMs: 8000,
      replayable: false,
      filePaths: [],
      anchorIds: [],
    });
    expect(payload.scenes[2]).toMatchObject({
      sceneNumber: 3,
      startTimeMs: 18000,
      endTimeMs: 28000,
      replayable: true,
      filePaths: ["src/lib/auth.ts"],
      anchorIds: ["anchor-scene-3-auth"],
    });
    expect(payload.diffSnapshot.totalFiles).toBe(2);
    expect(payload.sceneAnchors).toHaveLength(2);
    expect(payload.pins).toHaveLength(2);
    expect(payload.snapshotStatus).toBe("current");
  });

  it("derives private visibility from installation-backed jobs", async () => {
    const storage = new MockStorageService();
    const assembler = new ReviewPageAssembler(storage);
    const job = makeReviewVideoJob({
      installationRef: "inst_123",
      githubInstallationId: 321,
      repoIsPrivate: true,
    });
    const script = makeReviewVideoScript();

    await storage.upload((job.objectKey as string), Buffer.from("video"), "video/mp4");

    const sceneTimeline = script.scenes.map(s => ({
      sceneNumber: s.sceneNumber,
      durationMs: s.durationSeconds * 1000,
    }));
    const payload = await assembler.build(job, script, sceneTimeline);

    expect(payload.visibility).toBe("private");
    expect(payload.accessPolicy).toBe("github_authenticated");
  });

  it("populates reviewGraph with semantic edges when code contains inheritance", async () => {
    const storage = new MockStorageService();
    const assembler = new ReviewPageAssembler(storage);
    const job = makeReviewVideoJob();
    const baseScript = makeReviewVideoScript();

    // Rewrite two scenes' codeBroll to contain inheritance so the UML
    // analyzer produces at least one edge.
    const script = {
      ...baseScript,
      scenes: baseScript.scenes.map((scene) => {
        if (scene.sceneNumber === 2) {
          return {
            ...scene,
            codeBroll: [
              {
                filePath: "src/app/page.tsx",
                code: "export class Page {}",
                language: "typescript",
                lineRange: [1, 1] as [number, number],
                highlights: [],
              },
            ],
          };
        }
        if (scene.sceneNumber === 3) {
          return {
            ...scene,
            codeBroll: [
              {
                filePath: "src/lib/auth.ts",
                code: "import { Page } from '../../app/page'; class Auth extends Page {}",
                language: "typescript",
                lineRange: [1, 1] as [number, number],
                highlights: [],
              },
            ],
          };
        }
        return scene;
      }),
    };

    await storage.upload((job.objectKey as string), Buffer.from("video"), "video/mp4");

    const sceneTimeline = script.scenes.map(s => ({
      sceneNumber: s.sceneNumber,
      durationMs: s.durationSeconds * 1000,
    }));
    const payload = await assembler.build(job, script, sceneTimeline);

    expect(payload.reviewGraph).toBeDefined();
    const reviewGraph = payload.reviewGraph;
    if (!reviewGraph) throw new Error("reviewGraph should be defined for this fixture");
    expect(reviewGraph.nodes.length).toBeGreaterThanOrEqual(2);
    // Exactly one semantic edge — inheritance wins over dependency
    const inheritanceEdges = reviewGraph.edges.filter(
      (e) => e.relationship === "inheritance",
    );
    expect(inheritanceEdges.length).toBe(1);
    expect(reviewGraph.viewport.initialCamera.zoom).toBeGreaterThan(0);
    // Should NOT contain legacy in-video relationships
    expect(
      reviewGraph.edges.some((e) =>
        e.relationship === "same_directory" || e.relationship === "key_file_adjacency",
      ),
    ).toBe(false);
  });

  it("uses persisted canonical review-graph source from metricsJson when present", async () => {
    const storage = new MockStorageService();
    const assembler = new ReviewPageAssembler(storage);
    const job = makeReviewVideoJob({
      metricsJson: {
        reviewGraphSource: {
          version: 1,
          files: {
            "src/domain/entities/PromptPipelineV2.ts": "export type PromptPipelineV2Artifacts = { enabled: boolean };",
            "src/domain/services/VideoOrchestrator.ts": "import type { PromptPipelineV2Artifacts } from '@/domain/entities/PromptPipelineV2';\nexport function orchestrate(artifacts: PromptPipelineV2Artifacts) { return artifacts; }",
          },
        },
      },
    });
    const baseScript = makeReviewVideoScript();
    const script = {
      ...baseScript,
      scenes: [
        {
          ...baseScript.scenes[1],
          sceneNumber: 2,
          codeBroll: [{
            filePath: "src/domain/entities/PromptPipelineV2.ts",
            code: "export const snippetOnly = true;",
            language: "typescript",
            lineRange: [1, 1] as [number, number],
            highlights: [],
          }],
        },
        {
          ...baseScript.scenes[2],
          sceneNumber: 3,
          codeBroll: [{
            filePath: "src/domain/services/VideoOrchestrator.ts",
            code: "const snippetOnly = true;",
            language: "typescript",
            lineRange: [1, 1] as [number, number],
            highlights: [],
          }],
        },
      ],
    };

    await storage.upload((job.objectKey as string), Buffer.from("video"), "video/mp4");
    const sceneTimeline = script.scenes.map((scene) => ({
      sceneNumber: scene.sceneNumber,
      durationMs: scene.durationSeconds * 1000,
    }));
    const payload = await assembler.build(job, script, sceneTimeline);

    expect(
      payload.reviewGraph?.edges.some((edge) =>
        edge.relationship === "dependency"
        && edge.sourceId === "src/domain/services/VideoOrchestrator.ts"
        && edge.targetId === "src/domain/entities/PromptPipelineV2.ts",
      ),
    ).toBe(true);
  });

  it("omits reviewGraph when the script has fewer than 2 code-bearing scenes", async () => {
    const storage = new MockStorageService();
    const assembler = new ReviewPageAssembler(storage);
    const job = makeReviewVideoJob();
    const baseScript = makeReviewVideoScript();

    // Strip codeBroll from all but one scene so the graph would have <2 nodes
    const script = {
      ...baseScript,
      scenes: baseScript.scenes.map((scene, idx) => ({
        ...scene,
        codeBroll: idx === 0 ? [] : idx === 1 ? scene.codeBroll : [],
      })),
    };

    await storage.upload((job.objectKey as string), Buffer.from("video"), "video/mp4");
    const sceneTimeline = script.scenes.map(s => ({
      sceneNumber: s.sceneNumber,
      durationMs: s.durationSeconds * 1000,
    }));
    const payload = await assembler.build(job, script, sceneTimeline);

    expect(payload.reviewGraph).toBeUndefined();
  });
});
