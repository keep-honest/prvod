import type { VideoJob } from "@/domain/entities/VideoJob";
import type { VideoScript } from "@/domain/entities/VideoScript";
import { makeReviewDiffSnapshot } from "./reviewWorkspaceFixtures";

export function makeReviewVideoJob(overrides: Partial<VideoJob> = {}): VideoJob {
  const now = new Date("2026-04-07T12:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000001",
    repoFullName: "acme/repo",
    prNumber: 42,
    status: "completed",
    videoUrl: "https://example.com/video.mp4",
    objectKey: "videos/acme/repo/42/00000000-0000-4000-8000-000000000001.mp4",
    errorCode: null,
    errorMessage: null,
    scriptJson: null,
    ttsAudioJson: null,
    durationMs: 36_000,
    metricsJson: {
      reviewDiffSnapshot: makeReviewDiffSnapshot(),
      sceneDiffAnchors: [
        {
          anchorId: "anchor-scene-2-page",
          sceneNumber: 2,
          filePath: "src/app/page.tsx",
          startLine: 1,
          endLine: 1,
          precision: "exact",
          lineIds: ["f0-src-app-page-tsx-4"],
        },
        {
          anchorId: "anchor-scene-3-auth",
          sceneNumber: 3,
          filePath: "src/lib/auth.ts",
          startLine: 1,
          endLine: 2,
          precision: "exact",
          lineIds: ["f1-src-lib-auth-ts-1", "f1-src-lib-auth-ts-3"],
        },
      ],
      reviewPins: [
        {
          pinId: "pin-risk-page",
          category: "risk",
          sceneNumbers: [2],
          anchorIds: ["anchor-scene-2-page"],
          filePaths: ["src/app/page.tsx"],
          prose: "The playback handoff changes the primary control flow of the review page.",
          suggestedComment: "Can we verify this playback handoff remains stable during seek transitions?",
        },
        {
          pinId: "pin-test-gap-auth",
          category: "test_gap",
          sceneNumbers: [3],
          anchorIds: ["anchor-scene-3-auth"],
          filePaths: ["src/lib/auth.ts"],
          prose: "The authorization helper needs coverage for the private review path.",
          suggestedComment: "Could we add a test for the private repository authorization path?",
        },
      ],
      sceneTimeline: [
        { sceneNumber: 1, durationFrames: 240 },
        { sceneNumber: 2, durationFrames: 300 },
        { sceneNumber: 3, durationFrames: 300 },
        { sceneNumber: 4, durationFrames: 240 },
      ],
    },
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    installationRef: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    triggeredVia: "api",
    triggeredBy: null,
    deliveryId: null,
    apiKeyId: null,
    statusCommentPosted: false,
    scriptOnly: false,
    repoIsPrivate: false,
    currentStage: null,
    ...overrides,
  };
}

export function makeReviewVideoScript(): VideoScript {
  return {
    changeType: "feature",
    summary: "Code-first walkthrough",
    headline: "",
    totalDurationSeconds: 36,
    totalWordCount: 100,
    keyFiles: ["src/app/page.tsx", "src/lib/auth.ts"],
    tags: ["review-page"],
    voiceSuggestion: "en-US-Chirp3-HD-Fenrir",
    narrativeRoles: [],
    voiceAssignments: [],
    scenes: [
      {
        sceneNumber: 1,
        sceneType: "overview",
        durationSeconds: 8,
        narration: "We start with the main flow.",
        codeBroll: [],
      },
      {
        sceneNumber: 2,
        sceneType: "code_walkthrough",
        durationSeconds: 10,
        narration: "This file now performs the auth handoff.",
        codeBroll: [{
          filePath: "src/app/page.tsx",
          code: "export default function Page() {}",
          language: "typescript",
          lineRange: [1, 1],
          highlights: [1],
        }],
      },
      {
        sceneNumber: 3,
        sceneType: "code_walkthrough",
        durationSeconds: 10,
        narration: "This helper validates the token.",
        codeBroll: [{
          filePath: "src/lib/auth.ts",
          code: "export function verify() {}",
          language: "typescript",
          lineRange: [1, 1],
          highlights: [1],
        }],
      },
      {
        sceneNumber: 4,
        sceneType: "overview",
        durationSeconds: 8,
        narration: "That covers the key changes in this PR.",
        codeBroll: [],
      },
    ],
  };
}
