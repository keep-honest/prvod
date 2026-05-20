import { z } from "zod";

/**
 * Discriminated union describing where the pipeline should fetch the diff from.
 * Replaces the old `diff: string` field (spec 005, contracts/PRContext-v2.md).
 */
export const diffSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_pr"),
    repoFullName: z.string(),
    prNumber: z.number().int().positive(),
    installationId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("local_diff_file"),
    /** Absolute path to the temp file written by the job-create route. */
    tempPath: z.string(),
  }),
]);

export type DiffSource = z.infer<typeof diffSourceSchema>;

export const prContextSchema = z.object({
  repoFullName: z
    .string()
    .regex(
      /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/,
      "Must be in owner/repo format",
    ),
  prNumber: z.number().int().positive(),
  prTitle: z.string().max(500),
  prDescription: z.string().max(65536).default(""),
  /**
   * Opaque handle the pipeline passes to DiffCorpusBuilder.
   * Replaces the v1 `diff: string` field (spec 005 FR-001, contracts/PRContext-v2.md).
   */
  diffSource: diffSourceSchema,
  /**
   * Auto-generated title for local-diff-file jobs (FR-021).
   * Pattern: `YYYY-MM-DD-git-diff`. Required when diffSource.kind === "local_diff_file".
   */
  customDiffTitle: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}-git-diff$/)
    .optional(),
  baseBranch: z.string().max(256),
  headBranch: z.string().max(256),
  /** Full name of the PR head repository — needed for fork PR file fetches. */
  headRepoFullName: z
    .string()
    .regex(
      /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/,
      "Must be in owner/repo format",
    )
    .optional(),
  /** Commit SHA of the PR head — immutable, safe for fork PRs. */
  headSha: z.string().max(40).default(""),
  issues: z
    .array(
      z.object({
        number: z.number().int(),
        title: z.string().max(500),
        body: z.string().max(65536),
      }),
    )
    .default([]),
  milestone: z
    .object({
      title: z.string().max(500),
      description: z.string().max(65536),
    })
    .nullable()
    .default(null),
  isPrivate: z.boolean(),
  durationMode: z.enum(["default", "short", "popcorn"]).default("default"),
  deepdive: z.boolean().default(false),
});

export const durationModeEnum = prContextSchema.shape.durationMode;
export type DurationMode = z.infer<typeof durationModeEnum>;

/** Parsed and validated PR context. */
export type PRContext = z.infer<typeof prContextSchema>;
