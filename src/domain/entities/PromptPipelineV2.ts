import { z } from "zod";
import { videoScriptSchema, videoScriptTransportSchema } from "@/domain/entities/VideoScript";

export const evidenceSnippetSchema = z.object({
  filePath: z.string(),
  summary: z.string(),
  diffExcerpt: z.string(),
});

export const changeClusterSchema = z.object({
  clusterId: z.string(),
  title: z.string(),
  files: z.array(z.string()).min(1),
  evidenceSnippets: z.array(evidenceSnippetSchema).min(1),
  technicalMechanism: z.string(),
  impact: z.string(),
  riskIfAbsent: z.string(),
  validationEvidence: z.array(z.string()).min(1),
  importanceRank: z.number().int().positive(),
});

export const coverageDispositionEnum = z.enum([
  "deep_dive",
  "summary",
  "omitted_low_priority",
]);

export const coverageLedgerEntrySchema = z.object({
  clusterId: z.string(),
  disposition: coverageDispositionEnum,
  reason: z.string(),
});

export const coveragePlanSchema = z.object({
  summary: z.string(),
  selectedEvidencePolicy: z.string(),
  clusters: z.array(changeClusterSchema).min(1),
  ledger: z.array(coverageLedgerEntrySchema).min(1),
  majorClusterIds: z.array(z.string()),
});

export const sceneIntentSchema = z.object({
  sceneNumber: z.number().int().positive(),
  sceneType: z.enum([
    "overview",
    "hook",
    "code_walkthrough",
    "before_after",
    "architecture",
    "summary",
    "closing",
  ]),
  title: z.string(),
  clusterIds: z.array(z.string()).default([]),
  evidenceFilePaths: z.array(z.string()).default([]),
  whatChanged: z.string(),
  whyItMatters: z.string(),
  failureWithoutIt: z.string(),
  validation: z.string(),
  visualFocus: z.string(),
});

export const sceneOutlineSchema = z.object({
  scenes: z.array(sceneIntentSchema).min(1),
});

export const coverageJudgeScoresSchema = z.object({
  completeness: z.number().min(0).max(10),
  evidenceGrounding: z.number().min(0).max(10),
  allocationQuality: z.number().min(0).max(10),
});

export const coverageJudgeResultSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  missingMajorClusterIds: z.array(z.string()).default([]),
  weakEvidenceClusterIds: z.array(z.string()).default([]),
  allocationIssues: z.array(z.string()).default([]),
  scores: coverageJudgeScoresSchema,
  revisedPlan: coveragePlanSchema.optional(),
});

export const narrationJudgeScoresSchema = z.object({
  hookStrength: z.number().min(0).max(10),
  explanatoryClarity: z.number().min(0).max(10),
  evidenceGrounding: z.number().min(0).max(10),
  sceneDistinctness: z.number().min(0).max(10),
  themeFidelity: z.number().min(0).max(10),
  topClusterCoverage: z.number().min(0).max(10),
  jargonDensity: z.number().min(0).max(10),
  boredomRisk: z.number().min(0).max(10),
  // Reviewer-oriented scores — optional for backward compatibility with
  // existing pipelines that do not evaluate reviewer posture.
  issueFirstOrdering: z.number().min(0).max(10).optional(),
  reviewerToneFidelity: z.number().min(0).max(10).optional(),
  verdictAbsence: z.number().min(0).max(10).optional(),
});

// ── Reviewer-oriented metadata ──────────────────────────────────────────

export const reviewConcernIssueClassEnum = z.enum([
  "correctness",
  "concurrency",
  "data_integrity",
  "security",
  "regression",
  "validation_gap",
]);

export const reviewConcernSchema = z.object({
  concernId: z.string(),
  sourceClusterIds: z.array(z.string()).min(1),
  evidenceFilePaths: z.array(z.string()).min(1),
  priorityRank: z.number().int().positive(),
  issueClass: reviewConcernIssueClassEnum,
  riskStatement: z.string(),
  validationNeed: z.string(),
  proseSupport: z.string().nullable().default(null),
});

export const reviewPostureSchema = z.object({
  audience: z.literal("teammate_reviewer"),
  evidencePolicy: z.literal("code_and_tests_primary"),
  concernBudget: z.literal("highest_value_only"),
  verdictPolicy: z.literal("no_verdict"),
  hintPolicy: z.literal("non_prescriptive"),
});

// Transport schema for the judge LLM response. `revisedScript` stays loose here so
// the pipeline can validate/repair it before persisting a strict NarrationJudgeResult.
export const narrationJudgeTransportResultSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  scores: narrationJudgeScoresSchema,
  revisedScript: videoScriptTransportSchema.optional(),
});

export const narrationJudgeResultSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  scores: narrationJudgeScoresSchema,
  revisedScript: videoScriptSchema.optional(),
});

const sceneFileMismatchSchema = z.object({
  sceneNumber: z.number().int().positive(),
  filePaths: z.array(z.string()).min(1),
});

const sceneIdentifierMismatchSchema = z.object({
  sceneNumber: z.number().int().positive(),
  identifiers: z.array(z.string()).min(1),
});

const sceneMissingFieldsSchema = z.object({
  sceneNumber: z.number().int().positive(),
  fields: z.array(z.string()).min(1),
});

const codeBrollMismatchSchema = z.object({
  sceneNumber: z.number().int().positive(),
  filePath: z.string(),
});

export const coveragePlanValidationSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  duplicateClusterIds: z.array(z.string()).default([]),
  duplicateLedgerClusterIds: z.array(z.string()).default([]),
  missingLedgerClusterIds: z.array(z.string()).default([]),
  unknownLedgerClusterIds: z.array(z.string()).default([]),
  blankOmissionReasonClusterIds: z.array(z.string()).default([]),
  unknownMajorClusterIds: z.array(z.string()).default([]),
});

export const sceneOutlineValidationSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  duplicateSceneNumbers: z.array(z.number().int().positive()).default([]),
  missingSceneNumbers: z.array(z.number().int().positive()).default([]),
  unknownClusterIds: z.array(z.string()).default([]),
  uncoveredMajorClusterIds: z.array(z.string()).default([]),
  uncoveredRequiredClusterIds: z.array(z.string()).default([]),
  scenesMissingRequiredEvidence: z.array(z.number().int().positive()).default([]),
  scenesMissingTeachingFields: z.array(sceneMissingFieldsSchema).default([]),
  invalidEvidenceFileRefs: z.array(sceneFileMismatchSchema).default([]),
});

export const scriptEvidenceValidationSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  unmappedSceneNumbers: z.array(z.number().int().positive()).default([]),
  missingOutlineSceneNumbers: z.array(z.number().int().positive()).default([]),
  invalidCodeBrollFileRefs: z.array(codeBrollMismatchSchema).default([]),
  unknownFileReferences: z.array(sceneFileMismatchSchema).default([]),
  // Narration paths that exist in the corpus but were assigned to a different scene.
  // Demoted to warnings (prose drift, not hallucination) — codeBroll mismatch stays fatal.
  crossSceneFileReferences: z.array(sceneFileMismatchSchema).default([]),
  unknownBacktickReferences: z.array(sceneIdentifierMismatchSchema).default([]),
});

const scriptMetricSnapshotSchema = z.object({
  sceneCount: z.number().int().nonnegative(),
  totalDurationSeconds: z.number().nonnegative(),
  totalWordCount: z.number().int().nonnegative(),
  keyFilesCount: z.number().int().nonnegative(),
  tagCount: z.number().int().nonnegative(),
});

const scriptMetricDeltaSchema = z.object({
  sceneCount: z.number().int(),
  totalDurationSeconds: z.number(),
  totalWordCount: z.number().int(),
  keyFilesCount: z.number().int(),
  tagCount: z.number().int(),
});

export const promptPipelineRolloutComparisonSchema = z.object({
  enabled: z.literal(true),
  legacyMetrics: scriptMetricSnapshotSchema,
  v2Metrics: scriptMetricSnapshotSchema,
  deltas: scriptMetricDeltaSchema,
  legacySummary: z.string(),
  v2Summary: z.string(),
});

export const promptPipelineV2ArtifactsSchema = z.object({
  enabled: z.literal(true),
  llmFamily: z.enum(["claude", "gemini", "codex"]),
  coveragePlan: coveragePlanSchema,
  sceneOutline: sceneOutlineSchema,
  coverageJudge: coverageJudgeResultSchema.optional(),
  narrationJudge: narrationJudgeResultSchema.optional(),
  coverageValidation: coveragePlanValidationSchema.optional(),
  sceneOutlineValidation: sceneOutlineValidationSchema.optional(),
  scriptValidation: scriptEvidenceValidationSchema.optional(),
  rolloutComparison: promptPipelineRolloutComparisonSchema.optional(),
  // Reviewer-oriented artifacts — present when reviewer narration is active
  reviewConcerns: z.array(reviewConcernSchema).optional(),
  reviewPosture: reviewPostureSchema.optional(),
});

export type EvidenceSnippet = z.infer<typeof evidenceSnippetSchema>;
export type ChangeCluster = z.infer<typeof changeClusterSchema>;
export type CoverageLedgerEntry = z.infer<typeof coverageLedgerEntrySchema>;
export type CoveragePlan = z.infer<typeof coveragePlanSchema>;
export type SceneIntent = z.infer<typeof sceneIntentSchema>;
export type SceneOutline = z.infer<typeof sceneOutlineSchema>;
export type CoverageJudgeResult = z.infer<typeof coverageJudgeResultSchema>;
export type NarrationJudgeTransportResult = z.infer<typeof narrationJudgeTransportResultSchema>;
export type NarrationJudgeResult = z.infer<typeof narrationJudgeResultSchema>;
export type CoveragePlanValidationResult = z.infer<typeof coveragePlanValidationSchema>;
export type SceneOutlineValidationResult = z.infer<typeof sceneOutlineValidationSchema>;
export type ScriptEvidenceValidationResult = z.infer<typeof scriptEvidenceValidationSchema>;
export type PromptPipelineRolloutComparison = z.infer<typeof promptPipelineRolloutComparisonSchema>;
export type ReviewConcern = z.infer<typeof reviewConcernSchema>;
export type ReviewPosture = z.infer<typeof reviewPostureSchema>;
export type PromptPipelineV2Artifacts = z.infer<typeof promptPipelineV2ArtifactsSchema>;
