import { describe, expect, it } from "vitest";
import { buildGitHubDraftComments } from "@/lib/reviews/reviewDraftSync";
import type { ReviewPageModel } from "@/domain/entities/ReviewPage";
import { makeReviewDiffSnapshot } from "../../../integration/helpers/reviewWorkspaceFixtures";

function makeReviewPage(overrides: Partial<ReviewPageModel> = {}): ReviewPageModel {
  return {
    jobId: "job-1",
    repoFullName: "acme/repo",
    prNumber: 42,
    durationMode: "default",
    headline: "Test PR",
    visibility: "public",
    accessPolicy: "open",
    autoplayMode: "auto_if_permitted",
    videoUrl: "https://example.com/video.mp4",
    durationSeconds: 30,
    snapshotStatus: "current",
    reviewedHeadSha: "sha123",
    diffSnapshot: makeReviewDiffSnapshot(),
    sceneAnchors: [
      {
        anchorId: "anchor-exact",
        sceneNumber: 2,
        filePath: "src/app/page.tsx",
        startLine: 3,
        endLine: 3,
        precision: "exact",
        lineIds: ["f0-src-app-page-tsx-4"],
      },
      {
        anchorId: "anchor-overview",
        sceneNumber: 1,
        filePath: "src/app/page.tsx",
        startLine: null,
        endLine: null,
        precision: "overview",
        lineIds: [],
      },
    ],
    pins: [],
    canSyncDrafts: true,
    reviewerKey: "octocat",
    files: [],
    scenes: [],
    ...overrides,
  };
}

describe("buildGitHubDraftComments", () => {
  it("maps a draft with an explicit file path and position directly", () => {
    const page = makeReviewPage();
    const result = buildGitHubDraftComments(page, [
      {
        localDraftId: "d1",
        body: "Looks good",
        anchorIds: [],
        pinIds: [],
        filePath: "src/app/page.tsx",
        position: 4,
      },
    ]);

    expect(result).toEqual([
      { localDraftId: "d1", path: "src/app/page.tsx", position: 4, body: "Looks good" },
    ]);
  });

  it("resolves a draft position from an exact-precision anchor", () => {
    const page = makeReviewPage();
    const result = buildGitHubDraftComments(page, [
      {
        localDraftId: "d2",
        body: "Nice change",
        anchorIds: ["anchor-exact"],
        pinIds: [],
      },
    ]);

    expect(result).toEqual([
      { localDraftId: "d2", path: "src/app/page.tsx", position: 4, body: "Nice change" },
    ]);
  });

  it("silently skips a draft whose anchor has overview precision (no lineIds)", () => {
    const page = makeReviewPage();
    const result = buildGitHubDraftComments(page, [
      {
        localDraftId: "d3",
        body: "General thought",
        anchorIds: ["anchor-overview"],
        pinIds: [],
      },
    ]);

    expect(result).toHaveLength(0);
  });

  it("silently skips a draft with no anchor and no explicit position", () => {
    const page = makeReviewPage();
    const result = buildGitHubDraftComments(page, [
      {
        localDraftId: "d4",
        body: "Unmapped draft",
        anchorIds: [],
        pinIds: [],
      },
    ]);

    expect(result).toHaveLength(0);
  });

  it("prefers an added line over a removed one when an anchor spans both sides of a modified line", () => {
    // The src/app/page.tsx fixture has a removed line at position 3
    // (lineId f0-src-app-page-tsx-3) and the corresponding added line at
    // position 4 (lineId f0-src-app-page-tsx-4). buildSceneDiffAnchors emits
    // the removed id first because it appears first in the unified diff.
    const page = makeReviewPage({
      sceneAnchors: [
        {
          anchorId: "anchor-modified-line",
          sceneNumber: 2,
          filePath: "src/app/page.tsx",
          startLine: 3,
          endLine: 3,
          precision: "exact",
          // Removed-then-added: a naive lineIds[0] would attach the comment
          // to the deleted side at position 3 instead of the current line at
          // position 4.
          lineIds: ["f0-src-app-page-tsx-3", "f0-src-app-page-tsx-4"],
        },
      ],
    });

    const result = buildGitHubDraftComments(page, [
      {
        localDraftId: "d-modified",
        body: "Refactor question",
        anchorIds: ["anchor-modified-line"],
        pinIds: [],
      },
    ]);

    expect(result).toEqual([
      { localDraftId: "d-modified", path: "src/app/page.tsx", position: 4, body: "Refactor question" },
    ]);
  });

  it("maps mixed drafts, emitting only the mappable ones", () => {
    const page = makeReviewPage();
    const result = buildGitHubDraftComments(page, [
      { localDraftId: "d-exact", body: "Exact", anchorIds: ["anchor-exact"], pinIds: [] },
      { localDraftId: "d-overview", body: "Overview", anchorIds: ["anchor-overview"], pinIds: [] },
      { localDraftId: "d-explicit", body: "Explicit", anchorIds: [], pinIds: [], filePath: "src/lib/auth.ts", position: 2 },
    ]);

    expect(result.map((c) => c.localDraftId)).toEqual(["d-exact", "d-explicit"]);
  });
});
