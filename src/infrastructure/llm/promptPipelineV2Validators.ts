import {
  coveragePlanValidationSchema,
  sceneOutlineValidationSchema,
  scriptEvidenceValidationSchema,
} from "@/domain/entities/PromptPipelineV2";
import type {
  CoveragePlan,
  CoveragePlanValidationResult,
  SceneOutline,
  SceneOutlineValidationResult,
  ScriptEvidenceValidationResult,
} from "@/domain/entities/PromptPipelineV2";
import type { DurationMode } from "@/domain/entities/PRContext";
import type { VideoScript } from "@/domain/entities/VideoScript";
import { countSpokenWords, sanitizeSpokenNarrationText } from "@/lib/narrationText";
import {
  computeMaxSpokenWordsForDuration,
  computeTotalWordBudgetForMode,
  describeActualTtsTiming,
  parseTtsSpeedMultiplier,
} from "@/infrastructure/llm/wordBudget";

const REQUIRED_EVIDENCE_SCENE_TYPES = new Set([
  "code_walkthrough",
  "before_after",
  "architecture",
]);

const EXEMPT_SCENE_TYPES = new Set(["overview", "closing"]);

const REQUIRED_TEACHING_FIELDS = [
  "whatChanged",
  "whyItMatters",
  "failureWithoutIt",
  "validation",
] as const;

const COMMON_BARE_FILE_EXTENSIONS = new Set([
  "bash",
  "cjs",
  "conf",
  "css",
  "csv",
  "cts",
  "env",
  "example",
  "go",
  "gql",
  "graphql",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "local",
  "lock",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "proto",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const SPECIAL_BARE_FILENAMES = [
  /^README(?:\.[A-Za-z0-9_-]+)?$/i,
  /^Dockerfile(?:\.[A-Za-z0-9_-]+)?$/,
  /^Makefile(?:\.[A-Za-z0-9_-]+)?$/,
  /^Procfile(?:\.[A-Za-z0-9_-]+)?$/,
];

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function findDuplicates<T>(values: T[]): T[] {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value);
}

function extractIdentifiers(text: string): string[] {
  return unique(
    (text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])
      .filter((value) => value.length >= 3),
  );
}

/** Adds all identifiers extracted from `text` into `target`. */
function collectIdentifiers(text: string, target: Set<string>): void {
  for (const id of extractIdentifiers(text)) target.add(id);
}

/** Builds a clusterId-to-cluster lookup map from a coverage plan. */
function buildClusterMap(coveragePlan: CoveragePlan): Map<string, CoveragePlan["clusters"][number]> {
  return new Map(coveragePlan.clusters.map((c) => [c.clusterId, c]));
}

/**
 * Pushes a formatted issue string to `issues` if `values` is non-empty.
 * Eliminates the repetitive `if (arr.length > 0) issues.push(...)` pattern.
 */
function pushIssueIfPresent(issues: string[], label: string, values: { length: number; join(sep: string): string }): void {
  if (values.length > 0) issues.push(`${label}: ${values.join(", ")}`);
}

function extractBacktickReferences(text: string): string[] {
  return unique([...text.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean));
}

function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  // Slash means it's a path (e.g., "src/middleware/auth.ts")
  if (trimmed.includes("/")) return true;
  // Dotfiles like .env and .env.example should still count as file paths.
  if (/^\.[A-Za-z0-9._-]+$/.test(trimmed)) return true;
  // Common root filenames like README.md and Dockerfile.local are bare filenames.
  if (SPECIAL_BARE_FILENAMES.some((pattern) => pattern.test(trimmed))) return true;
  // For generic bare filenames, require a known file extension so dotted member
  // expressions like JSON.parse do not get treated as file paths.
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return false;
  const extension = trimmed.slice(dotIndex + 1).toLowerCase();
  return COMMON_BARE_FILE_EXTENSIONS.has(extension);
}

function looksLikeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function normalizeFilePath(value: string): string {
  let trimmed = value.trim();
  // Strip trailing sentence punctuation that may be captured by regex
  trimmed = trimmed.replace(/[.,;:!?)]+$/, "");
  // Strip leading ./ or /
  if (trimmed.startsWith("./")) {
    trimmed = trimmed.slice(2);
  } else if (trimmed.startsWith("/")) {
    trimmed = trimmed.slice(1);
  } else if (trimmed.startsWith(".") && !trimmed.startsWith("..") && trimmed.includes("/")) {
    trimmed = trimmed.slice(1).replace(/^\/+/, "");
  }
  return trimmed;
}

function extractPathLikeReferences(text: string): string[] {
  return unique(
    (text.match(/\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\b/g) ?? [])
      .map((value) => value.trim())
      .filter((value) => {
        // Require a file extension to distinguish real paths from prose ("client/server", "before/after")
        if (/\.[A-Za-z0-9]+$/.test(value)) return true;
        // Or at least 2 slashes (e.g., "src/middleware/auth")
        return (value.match(/\//g) ?? []).length >= 2;
      }),
  );
}

export function buildAllowedIdentifiers(coveragePlan: CoveragePlan, clusterIds: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const clusterId of clusterIds) {
    const cluster = coveragePlan.clusters.find((candidate) => candidate.clusterId === clusterId);
    if (!cluster) continue;
    for (const filePath of cluster.files) collectIdentifiers(filePath, allowed);
    collectIdentifiers(cluster.title, allowed);
    collectIdentifiers(cluster.technicalMechanism, allowed);
    collectIdentifiers(cluster.impact, allowed);
    collectIdentifiers(cluster.riskIfAbsent, allowed);
    for (const evidence of cluster.evidenceSnippets) {
      collectIdentifiers(evidence.filePath, allowed);
      collectIdentifiers(evidence.summary, allowed);
      collectIdentifiers(evidence.diffExcerpt, allowed);
    }
    for (const validationEvidence of cluster.validationEvidence) {
      collectIdentifiers(validationEvidence, allowed);
    }
  }
  return allowed;
}

export function validateCoveragePlanConsistency(
  coveragePlan: CoveragePlan,
): CoveragePlanValidationResult {
  const clusterIds = coveragePlan.clusters.map((cluster) => cluster.clusterId);
  const knownClusters = new Set(clusterIds);
  const ledgerIds = coveragePlan.ledger.map((entry) => entry.clusterId);

  const duplicateClusterIds = findDuplicates(clusterIds);
  const duplicateLedgerClusterIds = findDuplicates(
    ledgerIds.filter((clusterId) => knownClusters.has(clusterId)),
  );
  const missingLedgerClusterIds = clusterIds.filter(
    (clusterId) => !coveragePlan.ledger.some((entry) => entry.clusterId === clusterId),
  );
  const unknownLedgerClusterIds = unique(
    ledgerIds.filter((clusterId) => !knownClusters.has(clusterId)),
  );
  const blankOmissionReasonClusterIds = coveragePlan.ledger
    .filter(
      (entry) =>
        entry.disposition === "omitted_low_priority" &&
        entry.reason.trim().length === 0,
    )
    .map((entry) => entry.clusterId);
  const unknownMajorClusterIds = unique(
    coveragePlan.majorClusterIds.filter((clusterId) => !knownClusters.has(clusterId)),
  );

  const issues: string[] = [];
  pushIssueIfPresent(issues, "Duplicate cluster ids", duplicateClusterIds);
  pushIssueIfPresent(issues, "Coverage ledger repeats clusters", duplicateLedgerClusterIds);
  pushIssueIfPresent(issues, "Coverage ledger is missing clusters", missingLedgerClusterIds);
  pushIssueIfPresent(issues, "Coverage ledger references unknown clusters", unknownLedgerClusterIds);
  pushIssueIfPresent(issues, "Omitted clusters require reasons", blankOmissionReasonClusterIds);
  pushIssueIfPresent(issues, "majorClusterIds references unknown clusters", unknownMajorClusterIds);

  return coveragePlanValidationSchema.parse({
    passed: issues.length === 0,
    issues,
    duplicateClusterIds,
    duplicateLedgerClusterIds,
    missingLedgerClusterIds,
    unknownLedgerClusterIds,
    blankOmissionReasonClusterIds,
    unknownMajorClusterIds,
  });
}

/**
 * Strip evidence file paths that don't belong to any of the scene's assigned
 * clusters. Returns the cleaned outline and the list of removed references.
 * Downstream grounding validation (stage 7) catches real issues in the final script.
 */
export function stripInvalidEvidenceFileRefs(
  coveragePlan: CoveragePlan,
  sceneOutline: SceneOutline,
): { sceneOutline: SceneOutline; stripped: Array<{ sceneNumber: number; filePaths: string[] }> } {
  const knownClusters = buildClusterMap(coveragePlan);
  const stripped: Array<{ sceneNumber: number; filePaths: string[] }> = [];
  const scenes = sceneOutline.scenes.map((scene) => {
    const allowedFiles = new Set(
      scene.clusterIds.flatMap((clusterId) => knownClusters.get(clusterId)?.files ?? []),
    );
    const invalidFiles = scene.evidenceFilePaths.filter((fp) => !allowedFiles.has(fp));
    if (invalidFiles.length === 0) return scene;
    stripped.push({ sceneNumber: scene.sceneNumber, filePaths: invalidFiles });
    return { ...scene, evidenceFilePaths: scene.evidenceFilePaths.filter((fp) => allowedFiles.has(fp)) };
  });
  return { sceneOutline: { ...sceneOutline, scenes }, stripped };
}

export const POPCORN_MIN_SCENE_COUNT = 10;

export function validateSceneOutlineConsistency(
  coveragePlan: CoveragePlan,
  sceneOutline: SceneOutline,
  durationMode?: string,
): SceneOutlineValidationResult {
  const knownClusters = buildClusterMap(coveragePlan);
  const sceneNumbers = sceneOutline.scenes.map((scene) => scene.sceneNumber);
  const duplicateSceneNumbers = findDuplicates(sceneNumbers);
  const maxSceneNumber = sceneNumbers.length > 0 ? Math.max(...sceneNumbers) : 0;
  const missingSceneNumbers = Array.from({ length: maxSceneNumber }, (_, index) => index + 1)
    .filter((sceneNumber) => !sceneNumbers.includes(sceneNumber));

  const unknownClusterIds = unique(
    sceneOutline.scenes.flatMap((scene) =>
      scene.clusterIds.filter((clusterId) => !knownClusters.has(clusterId))),
  );
  const coveredClusterIds = new Set(
    sceneOutline.scenes.flatMap((scene) => scene.clusterIds),
  );
  const uncoveredMajorClusterIds = coveragePlan.majorClusterIds.filter(
    (clusterId) => !coveredClusterIds.has(clusterId),
  );
  const uncoveredRequiredClusterIds = coveragePlan.ledger
    .filter((entry) => entry.disposition !== "omitted_low_priority")
    .map((entry) => entry.clusterId)
    .filter((clusterId) => !coveredClusterIds.has(clusterId));

  const scenesMissingRequiredEvidence = sceneOutline.scenes
    .filter((scene) =>
      REQUIRED_EVIDENCE_SCENE_TYPES.has(scene.sceneType) &&
      (scene.clusterIds.length === 0 || scene.evidenceFilePaths.length === 0))
    .map((scene) => scene.sceneNumber);
  const scenesMissingTeachingFields = sceneOutline.scenes
    .map((scene) => {
      const missingFields = REQUIRED_TEACHING_FIELDS.filter(
        (field) => scene[field].trim().length === 0,
      );
      return missingFields.length > 0
        ? { sceneNumber: scene.sceneNumber, fields: missingFields }
        : null;
    })
    .filter(notNull);

  const invalidEvidenceFileRefs = sceneOutline.scenes
    .map((scene) => {
      const allowedFiles = new Set(
        scene.clusterIds.flatMap((clusterId) => knownClusters.get(clusterId)?.files ?? []),
      );
      const invalidFiles = scene.evidenceFilePaths.filter((filePath) => !allowedFiles.has(filePath));
      return invalidFiles.length > 0
        ? { sceneNumber: scene.sceneNumber, filePaths: invalidFiles }
        : null;
    })
    .filter(notNull);

  const issues: string[] = [];
  pushIssueIfPresent(issues, "Scene outline repeats scene numbers", duplicateSceneNumbers);
  pushIssueIfPresent(issues, "Scene outline is missing scene numbers", missingSceneNumbers);
  pushIssueIfPresent(issues, "Scene outline references unknown clusters", unknownClusterIds);
  pushIssueIfPresent(issues, "Scene outline omits major clusters", uncoveredMajorClusterIds);
  pushIssueIfPresent(issues, "Scene outline omits non-omitted ledger clusters", uncoveredRequiredClusterIds);
  pushIssueIfPresent(issues, "Technical scenes missing evidence", scenesMissingRequiredEvidence);
  if (scenesMissingTeachingFields.length > 0) {
    issues.push(
      `Scene outline scenes missing teaching fields: ${scenesMissingTeachingFields.map((item) => item.sceneNumber).join(", ")}`,
    );
  }
  if (invalidEvidenceFileRefs.length > 0) {
    issues.push(
      `Scene outline includes out-of-cluster evidence files for scenes: ${invalidEvidenceFileRefs.map((item) => item.sceneNumber).join(", ")}`,
    );
  }
  const overviewScenes = sceneOutline.scenes.filter((scene) => scene.sceneType === "overview");
  if (overviewScenes.length !== 1) {
    issues.push(`Scene outline must contain exactly one overview scene, found ${overviewScenes.length}.`);
  }
  if (sceneOutline.scenes.find((scene) => scene.sceneNumber === 1)?.sceneType !== "overview") {
    issues.push('Scene outline scene 1 must be an "overview" scene.');
  }
  if (durationMode === "popcorn" && sceneOutline.scenes.length < POPCORN_MIN_SCENE_COUNT) {
    issues.push(
      `Popcorn mode requires at least ${POPCORN_MIN_SCENE_COUNT} scenes, got ${sceneOutline.scenes.length}. Split only the largest deep_dive clusters into 2 scenes; most clusters should fit in a single scene.`,
    );
  }

  return sceneOutlineValidationSchema.parse({
    passed: issues.length === 0,
    issues,
    duplicateSceneNumbers,
    missingSceneNumbers,
    unknownClusterIds,
    uncoveredMajorClusterIds,
    uncoveredRequiredClusterIds,
    scenesMissingRequiredEvidence,
    scenesMissingTeachingFields,
    invalidEvidenceFileRefs,
  });
}

export function validateScriptEvidenceGrounding(
  coveragePlan: CoveragePlan,
  sceneOutline: SceneOutline,
  script: VideoScript,
): ScriptEvidenceValidationResult {
  const sceneIntentByNumber = new Map(
    sceneOutline.scenes.map((sceneIntent) => [sceneIntent.sceneNumber, sceneIntent]),
  );

  const unmappedSceneNumbers: number[] = [];
  const missingOutlineSceneNumbers = sceneOutline.scenes
    .map((scene) => scene.sceneNumber)
    .filter((sceneNumber) => !script.scenes.some((scene) => scene.sceneNumber === sceneNumber));
  const invalidCodeBrollFileRefs: Array<{ sceneNumber: number; filePath: string }> = [];
  const unknownFileReferences: Array<{ sceneNumber: number; filePaths: string[] }> = [];
  const crossSceneFileReferences: Array<{ sceneNumber: number; filePaths: string[] }> = [];
  const unknownBacktickReferences: Array<{ sceneNumber: number; identifiers: string[] }> = [];

  const clusterById = buildClusterMap(coveragePlan);

  // Corpus-wide allow-list: every file retained by the coverage planner.
  // Note: the planner intentionally drops cosmetic/style-only changes from clusters,
  // so this set is a SUBSET of the diff — not the full diff. A real-but-cosmetic file
  // mentioned in narration will still classify as hallucination (fatal). That is
  // acceptable: the planner judged it not worth narrating, so the LLM citing it is
  // still a grounding mistake.
  // A narration mentioning a corpus-retained file assigned to a different scene
  // is prose drift (real file, wrong scene) — demoted to warning.
  const corpusFilePaths = new Set<string>();
  for (const cluster of coveragePlan.clusters) {
    for (const filePath of cluster.files) {
      corpusFilePaths.add(normalizeFilePath(filePath));
    }
  }

  for (const scene of script.scenes) {
    const sceneIntent = sceneIntentByNumber.get(scene.sceneNumber);
    if (!sceneIntent) {
      unmappedSceneNumbers.push(scene.sceneNumber);
      continue;
    }

    const normalizedAllowedFiles = new Set(
      sceneIntent.evidenceFilePaths.map((filePath) => normalizeFilePath(filePath)),
    );
    // Also allow files from assigned clusters — the outliner selects a subset as
    // evidenceFilePaths, but the LLM may legitimately reference other cluster files
    for (const clusterId of sceneIntent.clusterIds) {
      const cluster = clusterById.get(clusterId);
      if (!cluster) continue;
      for (const filePath of cluster.files) {
        normalizedAllowedFiles.add(normalizeFilePath(filePath));
      }
    }
    const isExemptSceneType = EXEMPT_SCENE_TYPES.has(sceneIntent.sceneType);

    if (!isExemptSceneType) {
      const allowedIdentifiers = buildAllowedIdentifiers(coveragePlan, sceneIntent.clusterIds);
      const explicitFileReferences = unique([
        ...extractPathLikeReferences(scene.narration),
        ...extractBacktickReferences(scene.narration).filter(looksLikeFilePath),
      ]);
      const invalidFileRefs = explicitFileReferences.filter(
        (filePath) => !normalizedAllowedFiles.has(normalizeFilePath(filePath)),
      );
      if (invalidFileRefs.length > 0) {
        // Split: corpus-known paths → cross-scene drift (warning),
        //        unknown paths → hallucination (fatal).
        const driftPaths: string[] = [];
        const hallucinatedPaths: string[] = [];
        for (const filePath of invalidFileRefs) {
          if (corpusFilePaths.has(normalizeFilePath(filePath))) {
            driftPaths.push(filePath);
          } else {
            hallucinatedPaths.push(filePath);
          }
        }
        if (driftPaths.length > 0) {
          crossSceneFileReferences.push({
            sceneNumber: scene.sceneNumber,
            filePaths: driftPaths,
          });
        }
        if (hallucinatedPaths.length > 0) {
          unknownFileReferences.push({
            sceneNumber: scene.sceneNumber,
            filePaths: hallucinatedPaths,
          });
        }
      }

      const explicitIdentifierRefs = unique([
        ...extractBacktickReferences(scene.narration).filter(looksLikeIdentifier),
      ]);
      const invalidIdentifierRefs = explicitIdentifierRefs.filter(
        (identifier) => !allowedIdentifiers.has(identifier),
      );
      if (invalidIdentifierRefs.length > 0) {
        unknownBacktickReferences.push({
          sceneNumber: scene.sceneNumber,
          identifiers: invalidIdentifierRefs,
        });
      }
    }

    for (const cb of scene.codeBroll) {
      if (!normalizedAllowedFiles.has(normalizeFilePath(cb.filePath))) {
        invalidCodeBrollFileRefs.push({
          sceneNumber: scene.sceneNumber,
          filePath: cb.filePath,
        });
      }
    }
  }

  // Fatal issues: structural or evidence-grounding problems that break the contract
  // of the final writer and should never ship to users.
  const issues: string[] = [];
  pushIssueIfPresent(issues, "Final script scenes missing outline mapping", unmappedSceneNumbers);
  pushIssueIfPresent(issues, "Final script omitted outline scenes", missingOutlineSceneNumbers);
  pushIssueIfPresent(
    issues,
    "Final script codeBroll references files outside assigned evidence for scenes",
    invalidCodeBrollFileRefs.map((item) => item.sceneNumber),
  );
  pushIssueIfPresent(
    issues,
    "Final script mentions unassigned file paths for scenes",
    unknownFileReferences.map((item) => item.sceneNumber),
  );
  pushIssueIfPresent(
    issues,
    "Final script cites ungrounded backtick references for scenes",
    unknownBacktickReferences.map((item) => item.sceneNumber),
  );
  const warnings: string[] = [];
  const missingTechnicalCodeBroll = script.scenes
    .filter(
      (scene) =>
        (scene.sceneType === "code_walkthrough" || scene.sceneType === "before_after") &&
        scene.codeBroll.length === 0,
    )
    .map((scene) => scene.sceneNumber);
  pushIssueIfPresent(warnings, "Technical scenes missing codeBroll anchors", missingTechnicalCodeBroll);
  pushIssueIfPresent(
    warnings,
    "Final script narration mentions corpus files outside per-scene allow-list (prose drift) for scenes",
    crossSceneFileReferences.map((item) => item.sceneNumber),
  );

  return scriptEvidenceValidationSchema.parse({
    passed: issues.length === 0,
    issues,
    warnings,
    unmappedSceneNumbers,
    missingOutlineSceneNumbers,
    invalidCodeBrollFileRefs,
    unknownFileReferences,
    crossSceneFileReferences,
    unknownBacktickReferences,
  });
}

// ── Reviewer narration validation ──────────────────────────────────────

/** Patterns that indicate merge verdicts or confidence language (FR-016, FR-017). */
const VERDICT_PATTERNS = [
  // Scoped to PR/merge contexts to avoid false-positives on code that
  // "rejects invalid input" or "approval workflow" domain logic.
  /\b(?:approv(?:e[ds]?|al|ing)|reject(?:ed|ing|s)?)\s+(?:this|the\s+(?:pr|change[s]?|pull\s+request)|it)\b/i,
  /\blgtm\b/i,
  /\bblock\s+(this|the\s+pr|merge|it)\b/i,
  /\bchanges\s+requested\b/i,
  /\bmerge\s+(this|it|the\s+pr)\b/i,
  /\bready\s+to\s+merge\b/i,
  /\b(high|medium|low)\s+confidence\b/i,
  /\bconfidence\s*:\s*\d/i,
  /\b(?:review|pr|finding)\s+severity\s*:\s*(critical|high|medium|low)\b/i,
];

/** Patterns that indicate client-facing, marketing, or executive language (FR-007).
 * Bare domain terms like "customer" are allowed when used as code/entity references;
 * only marketing-tone phrases are flagged. */
const CLIENT_FACING_PATTERNS = [
  /\bstakeholder[s]?\b/i,
  /\bcustomer\s+(satisfaction|experience|facing|journey|impact|value|success)\b/i,
  /\bour\s+customer[s]?\b/i,
  /\bexecutive\s+summary\b/i,
  /\bvalue\s+proposition\b/i,
  /\bROI\b/,
];

export interface ReviewerNarrationViolation {
  sceneNumber: number;
  field: "narration" | "summary";
  rule: "verdict_language" | "client_facing_language";
  matchedText: string;
}

export interface ReviewerNarrationValidationResult {
  passed: boolean;
  violations: ReviewerNarrationViolation[];
}

/**
 * Validate that a script's narration and summary do not contain
 * merge verdicts, confidence language, or client-facing tone.
 * This is a deterministic post-generation check — no LLM needed.
 */
export function validateReviewerNarration(
  script: VideoScript,
): ReviewerNarrationValidationResult {
  const violations: ReviewerNarrationViolation[] = [];

  const checkText = (
    text: string,
    sceneNumber: number,
    field: "narration" | "summary",
  ) => {
    for (const pattern of VERDICT_PATTERNS) {
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      for (const match of text.matchAll(globalPattern)) {
        violations.push({
          sceneNumber,
          field,
          rule: "verdict_language",
          matchedText: match[0],
        });
      }
    }
    for (const pattern of CLIENT_FACING_PATTERNS) {
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      for (const match of text.matchAll(globalPattern)) {
        violations.push({
          sceneNumber,
          field,
          rule: "client_facing_language",
          matchedText: match[0],
        });
      }
    }
  };

  // Check summary
  checkText(script.summary, 0, "summary");

  // Check each scene's narration
  for (const scene of script.scenes) {
    checkText(scene.narration, scene.sceneNumber, "narration");
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Enforce reviewer narration rules on a finalized script. Throws if
 * violations are found and `REVIEWER_VIOLATION_WARN` is not set.
 * Shared by both V2 and legacy writer paths to satisfy FR-013.
 */
export function enforceReviewerNarration(
  script: VideoScript,
  logger: { warn: (msg: string, meta: Record<string, unknown>) => void },
  isWarnOnly: () => boolean,
): void {
  const result = validateReviewerNarration(script);
  if (result.passed) return;

  const violationSummary = result.violations
    .map((v) => `${v.field === "summary" ? "Summary" : `Scene ${v.sceneNumber}`}: ${v.rule} ("${v.matchedText}")`)
    .join(" | ");

  if (isWarnOnly()) {
    logger.warn("Reviewer narration violations detected — proceeding (REVIEWER_VIOLATION_WARN=true)", {
      violations: result.violations,
    });
  } else {
    throw new Error(`Reviewer narration validation failed: ${violationSummary}`);
  }
}

// ── Word budget validation ────────────────────────────────────────────

export interface WordBudgetViolation {
  sceneNumber: number;
  wordCount: number;
  maxWords: number;
  durationSeconds: number;
}

export interface WordBudgetValidationResult {
  passed: boolean;
  violations: WordBudgetViolation[];
  repairMessage: string;
}

/**
 * Validate that each scene's narration fits within its duration at actual
 * runtime TTS pacing. Scenes that exceed this budget will cause TTS to extend
 * beyond the scripted duration, inflating the video.
 */
export function validateSceneWordBudgets(
  script: VideoScript,
): WordBudgetValidationResult {
  const violations: WordBudgetViolation[] = [];
  const spokenTexts = new Map<number, string>();
  const speedMultiplier = parseTtsSpeedMultiplier();
  const timingDescription = describeActualTtsTiming(speedMultiplier);
  for (const scene of script.scenes) {
    const wordCount = countSpokenWords(scene.narration);
    const maxWords = computeMaxSpokenWordsForDuration(scene.durationSeconds, speedMultiplier);
    if (wordCount > maxWords) {
      spokenTexts.set(scene.sceneNumber, sanitizeSpokenNarrationText(scene.narration));
      violations.push({
        sceneNumber: scene.sceneNumber,
        wordCount,
        maxWords,
        durationSeconds: scene.durationSeconds,
      });
    }
  }

  const repairMessage =
    violations.length > 0
      ? violations
          .map(
            (v) =>
              `Scene ${v.sceneNumber} narration has ${v.wordCount} spoken words but its ${v.durationSeconds}-second duration allows max ${v.maxWords} words for ${timingDescription}. Spoken text (what TTS will say): "${spokenTexts.get(v.sceneNumber)}" — shorten the narration to fit within ${v.maxWords} spoken words.`,
          )
          .join("\n")
      : "";

  return { passed: violations.length === 0, violations, repairMessage };
}

/**
 * Code-first total word budget validation. Checks the sum of spoken words
 * across all scenes against the mode's total budget instead of per-scene limits.
 */
export function validateTotalWordBudget(
  script: VideoScript,
  durationMode?: DurationMode,
): WordBudgetValidationResult {
  const speedMultiplier = parseTtsSpeedMultiplier();
  const budget = computeTotalWordBudgetForMode(durationMode, speedMultiplier);
  const totalWords = script.scenes.reduce(
    (sum, s) => sum + countSpokenWords(s.narration), 0,
  );

  if (totalWords > budget.maxWords) {
    return {
      passed: false,
      violations: [{
        sceneNumber: -1,
        wordCount: totalWords,
        maxWords: budget.maxWords,
        durationSeconds: script.totalDurationSeconds,
      }],
      repairMessage: `Total script narration has ${totalWords} spoken words but the ${durationMode ?? "default"} mode allows max ${budget.maxWords}. Shorten narration across scenes to fit within ${budget.maxWords} total spoken words.`,
    };
  }

  return { passed: true, violations: [], repairMessage: "" };
}
