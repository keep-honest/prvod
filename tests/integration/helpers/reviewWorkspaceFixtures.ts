import type {
  ReviewDiffSnapshot,
  ReviewPin,
  SceneDiffAnchor,
} from "@/domain/entities/ReviewDiffSnapshot";

export function makeReviewDiffSnapshot(): ReviewDiffSnapshot {
  return {
    headSha: "reviewed-head-sha-123",
    headRepoFullName: "acme/repo",
    capturedAt: "2026-04-19T09:00:00.000Z",
    totalFiles: 2,
    totalRenderableLines: 13,
    files: [
      {
        filePath: "src/app/page.tsx",
        changeType: "modified",
        oldPath: null,
        hunks: [
          {
            hunkId: "f0-src-app-page-tsx-h1",
            header: "@@ -1,3 +1,11 @@",
            lines: [
              {
                lineId: "f0-src-app-page-tsx-1",
                kind: "context",
                oldLineNumber: 1,
                newLineNumber: 1,
                text: "import { ReviewPage } from \"@/components/ReviewPage\";",
                position: 1,
              },
              {
                lineId: "f0-src-app-page-tsx-2",
                kind: "context",
                oldLineNumber: 2,
                newLineNumber: 2,
                text: "",
                position: 2,
              },
              {
                lineId: "f0-src-app-page-tsx-3",
                kind: "removed",
                oldLineNumber: 3,
                newLineNumber: null,
                text: "export default function Page() {",
                position: 3,
              },
              {
                lineId: "f0-src-app-page-tsx-4",
                kind: "added",
                oldLineNumber: null,
                newLineNumber: 3,
                text: "export default function Page() {",
                position: 4,
              },
              {
                lineId: "f0-src-app-page-tsx-5",
                kind: "added",
                oldLineNumber: null,
                newLineNumber: 4,
                text: "  const playback = useReviewPlayback(reviewPage);",
                position: 5,
              },
              {
                lineId: "f0-src-app-page-tsx-6",
                kind: "added",
                oldLineNumber: null,
                newLineNumber: 5,
                text: "  return <ReviewSurface playback={playback} />;",
                position: 6,
              },
              {
                lineId: "f0-src-app-page-tsx-7",
                kind: "context",
                oldLineNumber: 4,
                newLineNumber: 6,
                text: "}",
                position: 7,
              },
            ],
          },
        ],
      },
      {
        filePath: "src/lib/auth.ts",
        changeType: "modified",
        oldPath: null,
        hunks: [
          {
            hunkId: "f1-src-lib-auth-ts-h1",
            header: "@@ -1,3 +1,6 @@",
            lines: [
              {
                lineId: "f1-src-lib-auth-ts-1",
                kind: "context",
                oldLineNumber: 1,
                newLineNumber: 1,
                text: "export async function canViewRepository() {",
                position: 1,
              },
              {
                lineId: "f1-src-lib-auth-ts-2",
                kind: "removed",
                oldLineNumber: 2,
                newLineNumber: null,
                text: "  return { allowed: true };",
                position: 2,
              },
              {
                lineId: "f1-src-lib-auth-ts-3",
                kind: "added",
                oldLineNumber: null,
                newLineNumber: 2,
                text: "  return { allowed: true, reason: \"authorized\" };",
                position: 3,
              },
              {
                lineId: "f1-src-lib-auth-ts-4",
                kind: "added",
                oldLineNumber: null,
                newLineNumber: 3,
                text: "}",
                position: 4,
              },
              {
                lineId: "f1-src-lib-auth-ts-5",
                kind: "meta",
                oldLineNumber: null,
                newLineNumber: null,
                text: "\\ No newline at end of file",
                position: 5,
              },
            ],
          },
        ],
      },
    ],
  };
}

export function makeSceneDiffAnchors(): SceneDiffAnchor[] {
  return [
    {
      anchorId: "anchor-scene-2-page",
      sceneNumber: 2,
      filePath: "src/app/page.tsx",
      startLine: 3,
      endLine: 5,
      precision: "exact",
      lineIds: ["f0-src-app-page-tsx-4", "f0-src-app-page-tsx-5", "f0-src-app-page-tsx-6"],
    },
    {
      anchorId: "anchor-scene-3-page",
      sceneNumber: 3,
      filePath: "src/app/page.tsx",
      startLine: 4,
      endLine: 5,
      precision: "exact",
      lineIds: ["f0-src-app-page-tsx-5", "f0-src-app-page-tsx-6"],
    },
    {
      anchorId: "anchor-scene-4-auth",
      sceneNumber: 4,
      filePath: "src/lib/auth.ts",
      startLine: 1,
      endLine: 2,
      precision: "exact",
      lineIds: ["f1-src-lib-auth-ts-1", "f1-src-lib-auth-ts-3"],
    },
  ];
}

export function makeReviewPins(): ReviewPin[] {
  return [
    {
      pinId: "pin-risk-playback",
      category: "risk",
      sceneNumbers: [3],
      anchorIds: ["anchor-scene-3-page"],
      filePaths: ["src/app/page.tsx"],
      prose: "This replay state now controls the main review surface, so regressions here would desynchronize playback and narration.",
      suggestedComment: "Could this replay handoff drift out of sync if playback state updates during a scene change?",
    },
    {
      pinId: "pin-test-gap-auth",
      category: "test_gap",
      sceneNumbers: [4],
      anchorIds: ["anchor-scene-4-auth"],
      filePaths: ["src/lib/auth.ts"],
      prose: "The new repository visibility check is important, but there is no evidence in the walkthrough that the private-repo path is covered by tests.",
      suggestedComment: "Can we add coverage for the private repository access path before merge?",
    },
    {
      pinId: "pin-question-auth",
      category: "question",
      sceneNumbers: [4],
      anchorIds: ["anchor-scene-4-auth"],
      filePaths: ["src/lib/auth.ts"],
      prose: "The narration calls this helper the main authorization gate, but the diff does not show what happens when GitHub access verification fails transiently.",
      suggestedComment: "What should the user see when the repository access check fails because GitHub is unavailable?",
    },
    {
      pinId: "pin-intent-page",
      category: "intent",
      sceneNumbers: [2],
      anchorIds: ["anchor-scene-2-page"],
      filePaths: ["src/app/page.tsx"],
      prose: "This hook-up is the architectural intent of the change: the walkthrough should become the primary cursor for reviewing the diff.",
      suggestedComment: "Noting intent: this page now treats playback as the primary control surface for the review workflow.",
    },
  ];
}
