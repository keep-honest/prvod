import { z } from "zod";
import { countSpokenWords } from "@/lib/narrationText";
import { createLogger } from "@/lib/logger";

const logger = createLogger("VideoScript");

export const changeTypeEnum = z.enum([
  "feature",
  "bugfix",
  "refactor",
  "docs",
  "dependency",
  "config",
  "mixed",
]);
export type ChangeType = z.infer<typeof changeTypeEnum>;

export const sceneTypeEnum = z.enum([
  "overview",
  "hook",
  "code_walkthrough",
  "before_after",
  "architecture",
  "summary",
  "closing",
]);
export type SceneType = z.infer<typeof sceneTypeEnum>;

export const roleTypeEnum = z.enum([
  "host",
  "guest",
  "panel_host",
  "narrator",
  "comedian",
]);
export type RoleType = z.infer<typeof roleTypeEnum>;

export const narrativeRoleSchema = z.object({
  roleId: z.string(),
  roleType: roleTypeEnum,
  componentKey: z.string().nullable().default(null),
  speaking: z.boolean().default(true),
});

export const voiceAssignmentSchema = z.object({
  roleId: z.string(),
  providerSource: z.enum(["native_model_voice"]),
  voiceToken: z.string(),
  consistencyScope: z.enum(["single_video"]),
});

export const codeBrollSchema = z.object({
  filePath: z.string(),
  code: z.string(),
  language: z.string(),
  lineRange: z.tuple([z.number(), z.number()]).nullable().default(null),
  highlights: z.array(z.number()).default([]),
});

export const sceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  sceneType: sceneTypeEnum,
  durationSeconds: z.number().int().positive(),
  narration: z.string(),
  productionAudio: z.string().optional(),
  codeBroll: z.preprocess(
    (val) => (val === null || val === undefined ? [] : Array.isArray(val) ? val : [val]),
    z.array(codeBrollSchema).default([]),
  ),
});

export const MIN_SCRIPT_SCENES = 3;
export const MAX_SCRIPT_SCENES = 64;
export const MIN_VIDEO_DURATION_SECONDS = 20;
export const MAX_VIDEO_DURATION_SECONDS = 320;
/** Soft cap for short-mode scripts (60s target + 5s grace). */
export const SHORT_MODE_MAX_DURATION = 65;
/** Hard cap for default-mode scripts — reject/retry if longer. */
export const DEFAULT_MODE_MAX_DURATION = 120;
/** Minimum duration for popcorn-mode scripts — retry if shorter. */
export const POPCORN_MODE_MIN_DURATION = 240;

export function minimumSceneCountForDurations(validDurations: readonly number[]): number {
  const maximumSceneDuration = validDurations.length > 0
    ? Math.max(...validDurations)
    : 0;

  if (maximumSceneDuration <= 0) {
    return MIN_SCRIPT_SCENES;
  }

  return Math.max(
    MIN_SCRIPT_SCENES,
    Math.ceil(MIN_VIDEO_DURATION_SECONDS / maximumSceneDuration),
  );
}

export const videoScriptTransportSchema = z.object({
  changeType: changeTypeEnum,
  summary: z.string(),
  /** Short, engaging title for the review page (5-10 words, references actual changes). */
  headline: z.string().optional().default(""),
  scenes: z.array(sceneSchema).min(MIN_SCRIPT_SCENES).max(MAX_SCRIPT_SCENES),
  totalDurationSeconds: z.number().optional(),
  totalWordCount: z.number().positive(),
  keyFiles: z.array(z.string()),
  tags: z.array(z.string()),
  voiceSuggestion: z.string().optional(),
  narrativeRoles: z.array(narrativeRoleSchema).default([]),
  voiceAssignments: z.array(voiceAssignmentSchema).default([]),
});

export const videoScriptSchema = videoScriptTransportSchema.transform((script) => ({
  ...script,
  totalDurationSeconds: script.scenes.reduce((sum, s) => sum + s.durationSeconds, 0),
  totalWordCount: script.scenes.reduce(
    (sum, s) => sum + countSpokenWords(s.narration), 0,
  ),
})).superRefine((script, ctx) => {
  if (script.totalDurationSeconds < MIN_VIDEO_DURATION_SECONDS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `totalDurationSeconds (${script.totalDurationSeconds}) is below minimum ${MIN_VIDEO_DURATION_SECONDS}s`,
      path: ["totalDurationSeconds"],
    });
  }
  if (script.scenes[0]?.sceneType !== "overview") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scene 1 must be an "overview" scene',
      path: ["scenes", 0, "sceneType"],
    });
  }

  const lastScene = script.scenes[script.scenes.length - 1];
  const closingTypes: string[] = ["overview", "summary", "closing"];
  if (lastScene && !closingTypes.includes(lastScene.sceneType)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `last scene must be overview, summary, or closing; found "${lastScene.sceneType}"`,
      path: ["scenes", script.scenes.length - 1, "sceneType"],
    });
  }

  // Overview scenes allowed only at first and last positions
  const midOverviews = script.scenes.slice(1, -1).filter((s) => s.sceneType === "overview");
  if (midOverviews.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `overview scenes only allowed at first and last positions; found ${midOverviews.length} in the middle`,
      path: ["scenes"],
    });
  }

  const technicalSceneCount = script.scenes.filter(
    (scene) => scene.sceneType !== "overview",
  ).length;
  if (technicalSceneCount < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scripts must contain at least two technical scenes",
      path: ["scenes"],
    });
  }
});

/**
 * Transport schema for batch 0: full envelope (keyFiles, tags, etc.)
 * but allows as few as 1 scene (the overview scene alone). The assembled result
 * is still validated against the full `videoScriptSchema` which enforces
 * MIN_SCRIPT_SCENES and the overview/technical scene constraints.
 */
export const batchEnvelopeTransportSchema = videoScriptTransportSchema.extend({
  scenes: z.array(sceneSchema).min(1).max(MAX_SCRIPT_SCENES),
});

/**
 * Lightweight schema for batched scene generation — a wrapper around an array
 * of scenes without the full VideoScript envelope (keyFiles, tags, etc.).
 * Used by `runBatchedFinalScriptPass` for non-first batches.
 * Root object wrapper required by Anthropic structured output.
 */
export const batchScenesTransportSchema = z.object({
  scenes: z.array(sceneSchema).min(1),
});

export type CodeBroll = z.infer<typeof codeBrollSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type NarrativeRole = z.infer<typeof narrativeRoleSchema>;
export type VoiceAssignment = z.infer<typeof voiceAssignmentSchema>;
export type VideoScriptTransport = z.infer<typeof videoScriptTransportSchema>;
export type VideoScript = z.infer<typeof videoScriptSchema>;

/**
 * Force the last scene's sceneType to "overview" so the constellation graph
 * always sits on a summary-overview scene. Applied AFTER all schema validation
 * and repair loops. codeBroll is preserved (not cleared) because downstream
 * consumers (captureReviewGraphSource, ReviewPageAssembler) derive file sets
 * from it. The Remotion finale path uses the isLastScene prop instead.
 */
export function ensureLastSceneOverview(script: VideoScript): VideoScript {
  const lastIdx = script.scenes.length - 1;
  if (lastIdx < 0) return script;
  const lastScene = script.scenes[lastIdx];
  if (lastScene.sceneType === "overview") return script;
  logger.info("Forcing last scene to overview for constellation graph", {
    sceneNumber: lastScene.sceneNumber,
    originalType: lastScene.sceneType,
  });
  const scenes = [...script.scenes];
  scenes[lastIdx] = { ...lastScene, sceneType: "overview" };
  return { ...script, scenes };
}
