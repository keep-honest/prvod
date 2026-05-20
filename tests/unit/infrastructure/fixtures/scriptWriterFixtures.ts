import { vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import type { PRContext } from "@/domain/entities/PRContext";
import type { VideoScript, Scene } from "@/domain/entities/VideoScript";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";


export const VALID_SCRIPT = {
  changeType: "feature",
  summary: "Added authentication middleware",
  headline: "",
  scenes: [
    {
      sceneNumber: 1,
      sceneType: "overview",
      durationSeconds: 8,
      narration: "This PR adds authentication middleware to secure incoming requests.",
      codeBroll: [],
    },
    {
      sceneNumber: 2,
      sceneType: "code_walkthrough",
      durationSeconds: 8,
      narration: "We validate JWT tokens.",
      codeBroll: [{
        filePath: "src/middleware/auth.ts",
        code: "function validateJWT() {}",
        language: "typescript",
        lineRange: null,
        highlights: [],
      }],
    },
    {
      sceneNumber: 3,
      sceneType: "before_after",
      durationSeconds: 6,
      narration: "Before: no auth. After: secured.",
      codeBroll: [{
        filePath: "src/routes/auth.ts",
        code: "router.use(authMiddleware())",
        language: "typescript",
        lineRange: [5, 10],
        highlights: [7],
      }],
    },
    {
      sceneNumber: 4,
      sceneType: "code_walkthrough",
      durationSeconds: 8,
      narration: "The middleware integrates seamlessly with existing routes.",
      codeBroll: [],
    },
    {
      sceneNumber: 5,
      sceneType: "architecture",
      durationSeconds: 6,
      narration: "The layered architecture keeps auth concerns separated.",
      codeBroll: [],
    },
    {
      sceneNumber: 6,
      sceneType: "code_walkthrough",
      durationSeconds: 8,
      narration: "Error handling ensures graceful failure on invalid tokens.",
      codeBroll: [],
    },
    {
      sceneNumber: 7,
      sceneType: "summary",
      durationSeconds: 6,
      narration: "All endpoints are now protected.",
      codeBroll: [],
    },
    {
      sceneNumber: 8,
      sceneType: "closing",
      durationSeconds: 4,
      narration: "PR forty-two. Auth secured.",
      codeBroll: [],
    },
  ],
  totalDurationSeconds: 54,
  totalWordCount: 49,
  keyFiles: ["src/middleware/auth.ts"],
  tags: ["security", "auth"],
};

export const fakePRContext: PRContext = {
  repoFullName: "owner/repo",
  prNumber: 42,
  prTitle: "Add auth",
  prDescription: "Adds JWT auth",
  diffSource: { kind: "github_pr" as const, repoFullName: "owner/repo", prNumber: 42, installationId: 1 },
  headBranch: "feature/auth",
  headSha: "",
  baseBranch: "main",
  issues: [],
  milestone: null,
  isPrivate: false,
  durationMode: "default",
  deepdive: false,
};

export const fakeDiffAnalysis: DiffAnalysis = {
  totalFilesChanged: 1,
  totalLinesAdded: 50,
  totalLinesRemoved: 0,
  suggestedChangeType: "feature",
  files: [],
  topFiles: [
    {
      filePath: "src/middleware/auth.ts",
      linesAdded: 50,
      linesRemoved: 0,
      isNew: true,
      isDeleted: false,
      isRenamed: false,
      directory: "src/middleware",
      importanceScore: 10,
    },
  ],
  directoryGroups: {},
  topFileDiffs: { "src/middleware/auth.ts": "diff content" },
};

export function mockExecFile(stdout: string, error?: Error): void {
  type ExecFileCallback = (
    err: Error | null,
    stdout: string,
    stderr: string,
  ) => void;

  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      const child = {
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      };
      if (error) {
        cb(error, "", error.message);
      } else {
        cb(null, stdout, "");
      }
      return child;
    },
  );
}

export function mockSpawn(stdout: string, error?: Error): void {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => createMockSpawnChild(stdout, error),
  );
}

export function createMockSpawnChild(stdout: string, error?: Error) {
  const stderr = error?.message ?? "";
  const errorCode = (error as (Error & { code?: unknown }) | undefined)?.code;
  const exitCode = typeof errorCode === "number"
    ? errorCode
    : error
    ? 1
    : 0;
  return {
    kill: vi.fn(),
    stdin: undefined,
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data" && stdout) {
          queueMicrotask(() => cb(Buffer.from(stdout)));
        }
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data" && stderr) {
          queueMicrotask(() => cb(Buffer.from(stderr)));
        }
      }),
    },
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      if (event === "close") {
        queueMicrotask(() => cb(exitCode));
      }
    }),
  };
}

/** Builds a valid scene outline matching all scenes in VALID_SCRIPT for V2 pipeline tests. */
export function buildValidOutline(clusterId = "c1") {
  return {
    scenes: VALID_SCRIPT.scenes.map((scene) => ({
      sceneNumber: scene.sceneNumber,
      sceneType: scene.sceneType,
      title: `scene-${scene.sceneNumber}`,
      clusterIds: scene.sceneNumber === 1 ? [] : [clusterId],
      evidenceFilePaths:
        scene.sceneNumber === 3
          ? ["src/routes/auth.ts"]
          : scene.sceneNumber === 1
          ? []
          : ["src/middleware/auth.ts"],
      whatChanged: "Adds auth",
      whyItMatters: "Protects requests",
      failureWithoutIt: "Unauthenticated access",
      validation: "Tests cover invalid tokens",
      visualFocus: "checkpoint",
    })),
  };
}

// ── Shared VideoScript factory ───────────────────────────────────────────

/** Builds a minimal valid VideoScript, merging per-scene and top-level overrides. */
export function makeVideoScript(
  scenes: Array<Partial<Scene> & { narration: string; durationSeconds: number }>,
  overrides: Partial<VideoScript> = {},
): VideoScript {
  return {
    changeType: "feature",
    summary: "Test script",
    headline: "",
    keyFiles: ["src/a.ts"],
    tags: ["test"],
    narrativeRoles: [],
    voiceAssignments: [],
    scenes: scenes.map((s, i) => ({
      sceneNumber: i + 1,
      sceneType: "code_walkthrough" as const,
      codeBroll: [],
      ...s,
    })),
    totalDurationSeconds: scenes.reduce((sum, s) => sum + s.durationSeconds, 0),
    totalWordCount: scenes.reduce(
      (sum, s) => sum + s.narration.split(/\s+/).filter(Boolean).length,
      0,
    ),
    ...overrides,
  };
}

// ── V2 pipeline shared judge / coverage helpers ──────────────────────────

export function passingJudgeScores() {
  return { completeness: 9, evidenceGrounding: 9, allocationQuality: 9 };
}

export function passingNarrationScores() {
  return {
    hookStrength: 8,
    explanatoryClarity: 9,
    evidenceGrounding: 9,
    sceneDistinctness: 8,
    themeFidelity: 8,
    topClusterCoverage: 9,
    jargonDensity: 4,
    boredomRisk: 3,
  };
}

export function passingCoverageJudge() {
  return {
    passed: true,
    issues: [],
    missingMajorClusterIds: [],
    weakEvidenceClusterIds: [],
    allocationIssues: [],
    scores: passingJudgeScores(),
  };
}

export function passingNarrationJudge() {
  return {
    passed: true,
    issues: [],
    scores: passingNarrationScores(),
  };
}

/** Single-cluster coverage plan used across most V2 pipeline tests. */
export function makeCoveragePlan(clusterId = "c1") {
  return {
    summary: "Plan",
    selectedEvidencePolicy: "Use cluster evidence only.",
    clusters: [
      {
        clusterId,
        title: "Authentication middleware",
        files: ["src/middleware/auth.ts", "src/routes/auth.ts"],
        evidenceSnippets: [
          { filePath: "src/middleware/auth.ts", summary: "Adds auth validation", diffExcerpt: "function validateJWT() {}" },
        ],
        technicalMechanism: "Validate JWT",
        impact: "Protects requests",
        riskIfAbsent: "Unauthorized access",
        validationEvidence: ["auth middleware test coverage"],
        importanceRank: 1,
      },
    ],
    ledger: [{ clusterId, disposition: "deep_dive", reason: "Primary change" }],
    majorClusterIds: [clusterId],
  };
}
