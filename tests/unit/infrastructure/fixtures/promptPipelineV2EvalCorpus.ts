import { videoScriptSchema, type VideoScript } from "@/domain/entities/VideoScript";
import type { CoveragePlan, SceneOutline } from "@/domain/entities/PromptPipelineV2";

interface EvalCorpusCase {
  id: string;
  description: string;
  coveragePlan: CoveragePlan;
  sceneOutline: SceneOutline;
  script: VideoScript;
}


function makeCase(input: {
  id: string;
  description: string;
  summary: string;
  filePath: string;
  identifier: string;
  changeDescription: string;
  visualFocus: string;
}): EvalCorpusCase {
  const coveragePlan: CoveragePlan = {
    summary: input.summary,
    selectedEvidencePolicy: "Cluster-selected evidence only.",
    clusters: [{
      clusterId: `${input.id}-cluster`,
      title: input.changeDescription,
      files: [input.filePath],
      evidenceSnippets: [{
        filePath: input.filePath,
        summary: input.changeDescription,
        diffExcerpt: `function ${input.identifier}() {}`,
      }],
      technicalMechanism: `${input.identifier} enforces the intended behavior`,
      impact: input.summary,
      riskIfAbsent: `Without ${input.identifier}, the change would not hold.`,
      validationEvidence: [`${input.identifier} test coverage`],
      importanceRank: 1,
    }],
    ledger: [{
      clusterId: `${input.id}-cluster`,
      disposition: "deep_dive",
      reason: "Primary change",
    }],
    majorClusterIds: [`${input.id}-cluster`],
  };

  const sceneOutline: SceneOutline = {
    scenes: [
      {
        sceneNumber: 1,
        sceneType: "overview",
        title: "Overview",
        clusterIds: [`${input.id}-cluster`],
        evidenceFilePaths: [input.filePath],
        whatChanged: input.changeDescription,
        whyItMatters: input.summary,
        failureWithoutIt: `Without ${input.identifier}, the problem remains.`,
        validation: `${input.identifier} test coverage verifies the change.`,
        visualFocus: input.visualFocus,
      },
      {
        sceneNumber: 2,
        sceneType: "code_walkthrough",
        title: "Mechanism",
        clusterIds: [`${input.id}-cluster`],
        evidenceFilePaths: [input.filePath],
        whatChanged: `${input.identifier} was added in ${input.filePath}.`,
        whyItMatters: input.summary,
        failureWithoutIt: `Without ${input.identifier}, the path stays unprotected.`,
        validation: `${input.identifier} test coverage verifies the change.`,
        visualFocus: input.visualFocus,
      },
      {
        sceneNumber: 3,
        sceneType: "closing",
        title: "Resolution",
        clusterIds: [`${input.id}-cluster`],
        evidenceFilePaths: [input.filePath],
        whatChanged: input.changeDescription,
        whyItMatters: input.summary,
        failureWithoutIt: `Without ${input.identifier}, the problem remains.`,
        validation: `${input.identifier} test coverage verifies the change.`,
        visualFocus: `${input.visualFocus} with visible resolution`,
      },
    ],
  };

  const script = videoScriptSchema.parse({
    changeType: "feature",
    summary: input.summary,
    scenes: [
      {
        sceneNumber: 1,
        sceneType: "overview",
        durationSeconds: 8,
        narration: `${input.changeDescription} changes the path in ${input.filePath}.`,
        codeBroll: [{
          filePath: input.filePath,
          code: `${input.identifier}();`,
          language: "typescript",
          lineRange: [1, 2],
          highlights: [1],
        }],
      },
      {
        sceneNumber: 2,
        sceneType: "code_walkthrough",
        durationSeconds: 8,
        narration: `The \`${input.identifier}\` mechanism enforces the new behavior.`,
        codeBroll: [{
          filePath: input.filePath,
          code: `function ${input.identifier}() {}`,
          language: "typescript",
          lineRange: [1, 4],
          highlights: [1],
        }],
      },
      {
        sceneNumber: 3,
        sceneType: "closing",
        durationSeconds: 4,
        narration: `${input.summary}. ${input.identifier} test coverage confirms it.`,
        codeBroll: [{
          filePath: input.filePath,
          code: `${input.identifier}();`,
          language: "typescript",
          lineRange: [2, 2],
          highlights: [2],
        }],
      },
    ],
    totalDurationSeconds: 20,
    totalWordCount: 45,
    keyFiles: [input.filePath],
    tags: [input.id],
    narrativeRoles: [],
    voiceAssignments: [],
  });

  return {
    id: input.id,
    description: input.description,
    coveragePlan,
    sceneOutline,
    script,
  };
}

// ── Reviewer-risk fixture factory ──────────────────────────────────────────
// Builds cases that model PRs with clear review risks. Used by reviewer-
// oriented prompt, judge, and validation tests to verify issue-first ordering,
// indirect question framing, and evidence grounding.

export interface ReviewerRiskInput {
  id: string;
  description: string;
  summary: string;
  filePath: string;
  identifier: string;
  changeDescription: string;
  visualFocus: string;
  /** The review risk class (e.g. "concurrency", "data_integrity"). */
  issueClass: string;
  /** Plain-language risk statement for the concern. */
  riskStatement: string;
  /** What evidence, safeguard, or test a reviewer should check. */
  validationNeed: string;
}

export function makeReviewerRiskCase(input: ReviewerRiskInput): EvalCorpusCase {
  const base = makeCase(input);
  // Tag the case so tests can filter for reviewer-risk scenarios
  return {
    ...base,
    id: `reviewer-risk-${input.id}`,
    description: `[reviewer-risk] ${input.description}`,
  };
}

export const REVIEWER_RISK_CASES: EvalCorpusCase[] = [
  makeReviewerRiskCase({
    id: "race-condition",
    description: "SQL UPDATE without row lock — concurrent writers yield lost updates",
    summary: "Adds a status update query that reads then writes without a transaction lock.",
    filePath: "src/services/orderService.ts",
    identifier: "updateOrderStatus",
    changeDescription: "Adds an order status update path",
    visualFocus: "Two gears spinning on the same axle, teeth clashing when they meet",
    issueClass: "concurrency",
    riskStatement: "Concurrent requests may overwrite each other because the read-modify-write is not atomic.",
    validationNeed: "Check whether a SELECT ... FOR UPDATE or serializable transaction wraps the update.",
  }),
  makeReviewerRiskCase({
    id: "missing-null-check",
    description: "Nullable DB column accessed without guard — runtime crash on NULL rows",
    summary: "Reads a nullable column and passes it to a function that requires a non-null value.",
    filePath: "src/repository/userRepo.ts",
    identifier: "getUserEmail",
    changeDescription: "Adds direct access to a nullable email column",
    visualFocus: "A lever pulls on an empty socket where a pin should be",
    issueClass: "correctness",
    riskStatement: "Rows with NULL email will cause a TypeError at runtime.",
    validationNeed: "Verify a null guard or coalesce protects the access before use.",
  }),
  makeReviewerRiskCase({
    id: "unvalidated-redirect",
    description: "User-controlled redirect URL used without allow-list — open redirect risk",
    summary: "Adds a login redirect that reads the target URL from a query parameter.",
    filePath: "src/auth/loginHandler.ts",
    identifier: "handleLoginRedirect",
    changeDescription: "Adds post-login redirect from query param",
    visualFocus: "A signpost spins freely, pointing visitors in any direction",
    issueClass: "security",
    riskStatement: "An attacker can craft a link that redirects users to a phishing site after login.",
    validationNeed: "Check for an allow-list or origin validation on the redirect target.",
  }),
  makeReviewerRiskCase({
    id: "missing-test-coverage",
    description: "New error path added with no corresponding test",
    summary: "Adds a retry-with-backoff path but the test file has no new assertions.",
    filePath: "src/infra/httpClient.ts",
    identifier: "retryWithBackoff",
    changeDescription: "Adds retry logic to the HTTP client",
    visualFocus: "A safety harness swings loose, unattached to the climber",
    issueClass: "validation_gap",
    riskStatement: "The retry path has no test coverage so regressions will go undetected.",
    validationNeed: "Verify test assertions exist for the retry and backoff branches.",
  }),
  makeReviewerRiskCase({
    id: "cascade-delete",
    description: "CASCADE delete added to FK — parent deletion silently removes child rows",
    summary: "Adds ON DELETE CASCADE to a foreign key that previously used RESTRICT.",
    filePath: "db/migrations/20260401_cascade_orders.sql",
    identifier: "alterForeignKey",
    changeDescription: "Changes FK constraint from RESTRICT to CASCADE",
    visualFocus: "Pulling one gear causes the entire train behind it to detach and fall",
    issueClass: "data_integrity",
    riskStatement: "Deleting a parent row will now silently remove all related child rows.",
    validationNeed: "Confirm this is intentional and that no orphan-prevention logic relied on RESTRICT.",
  }),
];

export const PROMPT_PIPELINE_V2_EVAL_CORPUS: EvalCorpusCase[] = [
  makeCase({
    id: "feature-auth",
    description: "Feature-heavy authentication middleware change",
    summary: "Adds middleware to validate auth before routes run.",
    filePath: "src/middleware/auth.ts",
    identifier: "validateJWT",
    changeDescription: "Introduces authentication middleware",
    visualFocus: "A checkpoint inspects each gear before it reaches the drive shaft",
  }),
  makeCase({
    id: "config-ci",
    description: "Config-heavy CI change",
    summary: "Tightens CI checks so misconfigurations fail earlier.",
    filePath: ".github/workflows/ci.yml",
    identifier: "verifyBuildMatrix",
    changeDescription: "Strengthens the CI workflow",
    visualFocus: "A set of gauges locks into a stricter alignment",
  }),
  makeCase({
    id: "migration-db",
    description: "Migration-heavy database change",
    summary: "Adds a migration so the new schema lands safely.",
    filePath: "db/migrations/20260326_add_status.sql",
    identifier: "applyStatusMigration",
    changeDescription: "Adds a database migration for status tracking",
    visualFocus: "A new gear ring slots into the main movement without stopping it",
  }),
  makeCase({
    id: "refactor-cache",
    description: "Refactor-heavy caching change",
    summary: "Refactors the cache layer to isolate invalidation logic.",
    filePath: "src/cache/cacheStore.ts",
    identifier: "invalidateCacheEntry",
    changeDescription: "Extracts cache invalidation into a dedicated path",
    visualFocus: "A side channel diverts spent gears away from the main mechanism",
  }),
  makeCase({
    id: "tests-rate-limit",
    description: "Test-heavy reliability change",
    summary: "Adds tests so rate limiting behavior is locked down.",
    filePath: "tests/auth/rateLimit.test.ts",
    identifier: "assertRateLimit",
    changeDescription: "Adds regression tests for rate limiting",
    visualFocus: "A measuring rig repeatedly stresses a spring until it holds its tolerance",
  }),
];
