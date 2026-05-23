import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from "zod";
import { StructuredOutputValidationError } from "@/infrastructure/llm/promptPipelineV2Repair";
import { createLogger } from "@/lib/logger";
import {
  DEFAULT_MODE_MAX_DURATION,
  MAX_SCRIPT_SCENES,
  MAX_VIDEO_DURATION_SECONDS,
  POPCORN_MODE_MIN_DURATION,
  minimumSceneCountForDurations,
  videoScriptSchema,
} from "@/domain/entities/VideoScript";
import {
  buildNarrationRetimeSystemPrompt,
  buildNarrationRetimeUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  effectiveMaxScenesForMode,
  narrationRetimeSchema,
  warnOnScriptDefaults,
} from "@/infrastructure/llm/script-prompt";
import { attachPromptPipelineRolloutComparison } from "@/infrastructure/llm/promptPipelineV2Comparison";
import { generateScriptWithPromptPipelineV2 } from "@/infrastructure/llm/promptPipelineV2Runner";
import { ensureLastSceneOverview } from "@/domain/entities/VideoScript";
import { enforceReviewerNarration } from "@/infrastructure/llm/promptPipelineV2Validators";
import { isReviewerViolationWarnOnly } from "@/lib/featureFlags";
import type { CompleteJsonOptions } from "@/infrastructure/llm/promptPipelineV2Runner";
import type {
  IScriptWriter,
  NarrationRetimeBudget,
  NarrationRetimeResult,
  ScriptWriterResult,
} from "@/interfaces/IScriptWriter";
import type { PRContext } from "@/domain/entities/PRContext";
import type { VideoScript } from "@/domain/entities/VideoScript";
import type { DiffAnalysis } from "@/interfaces/IDiffAnalyzer";
import {
  isPromptPipelineV2CompareV1Enabled,
  isPromptPipelineV2Enabled,
} from "@/lib/featureFlags";
import type { IInputSanitizer, IOutputValidator, JobContext, SanitizeOptions } from "@/interfaces/IPromptInjectionGuard";
import { buildAnthropicStructuredOutputFormat } from "@/infrastructure/llm/structuredOutputSchema";
import { retryLlmCall } from "@/infrastructure/llm/retryLlmCall";
import {
  buildDurationGuard,
  formatDurationGuardExceededError,
  type DurationGuard,
} from "@/lib/durationGuard";

const logger = createLogger("ClaudeScriptWriter");

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_SCRIPT_MAX_TOKENS = 8192;
const DEFAULT_RETIME_MAX_TOKENS = 4096;
function resolveMaxTokens(envValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(envValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Describes a duration-mode retry: when to trigger, how to compare, whether failure is hard. */
interface DurationRetrySpec {
  mode: string;
  /** Requested target threshold in seconds. */
  target: number;
  direction: "max" | "min";
  /** Given two violating durations, returns true if `candidate` is a better best-effort pick. */
  isBetter: (candidate: number, current: number) => boolean;
  /** If true, throw when both original and retry violate the constraint. */
  hardFail: boolean;
  retryLabel: string;
}

const DURATION_RETRY_SPECS: DurationRetrySpec[] = [
  {
    mode: "default",
    target: DEFAULT_MODE_MAX_DURATION,
    direction: "max",
    isBetter: (c, cur) => c < cur,
    hardFail: true,
    retryLabel: "claude.sdk.defaultModeRetry",
  },
  {
    mode: "short",
    target: 60,
    direction: "max",
    isBetter: (c, cur) => c < cur,
    hardFail: true,
    retryLabel: "claude.sdk.shortModeRetry",
  },
  {
    mode: "popcorn",
    target: POPCORN_MODE_MIN_DURATION,
    direction: "min",
    isBetter: (c, cur) => c > cur,
    hardFail: false,
    retryLabel: "claude.sdk.popcornModeRetry",
  },
  {
    mode: "popcorn",
    target: MAX_VIDEO_DURATION_SECONDS,
    direction: "max",
    isBetter: (c, cur) => c < cur,
    hardFail: true,
    retryLabel: "claude.sdk.popcornModeMaxRetry",
  },
];

function durationGuardForSpec(spec: DurationRetrySpec): DurationGuard | null {
  return spec.direction === "max" ? buildDurationGuard(spec.target) : null;
}

function isDurationViolation(
  spec: DurationRetrySpec,
  durationSeconds: number,
  guard: DurationGuard | null,
): boolean {
  return spec.direction === "min"
    ? durationSeconds < spec.target
    : durationSeconds > (guard?.guardCapSeconds ?? spec.target);
}

function buildToolSchema(validDurations: readonly number[], maxScenes?: number) {
  const minSceneCount = minimumSceneCountForDurations(validDurations);
  const effectiveMaxScenes = maxScenes ?? MAX_SCRIPT_SCENES;

  return {
    type: "object" as const,
    properties: {
      changeType: {
        type: "string" as const,
        enum: ["feature", "bugfix", "refactor", "docs", "dependency", "config", "mixed"],
      },
      summary: { type: "string" as const },
      scenes: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            sceneNumber: { type: "integer" as const },
            sceneType: {
              type: "string" as const,
              enum: ["overview", "hook", "code_walkthrough", "before_after", "architecture", "summary", "closing"],
            },
            durationSeconds: { type: "number" as const, enum: [...validDurations] },
            narration: { type: "string" as const },
            productionAudio: { type: "string" as const },
            codeBroll: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  filePath: { type: "string" as const },
                  code: { type: "string" as const },
                  language: { type: "string" as const },
                  lineRange: {
                    type: ["array", "null"] as const,
                    items: { type: "number" as const },
                  },
                  highlights: {
                    type: "array" as const,
                    items: { type: "number" as const },
                  },
                },
                required: ["filePath", "code", "language"],
              },
            },
          },
          required: ["sceneNumber", "sceneType", "durationSeconds", "narration"],
        },
        minItems: minSceneCount,
        maxItems: effectiveMaxScenes,
      },
      totalWordCount: { type: "integer" as const },
      keyFiles: { type: "array" as const, items: { type: "string" as const } },
      tags: { type: "array" as const, items: { type: "string" as const } },
      voiceSuggestion: { type: "string" as const, description: "Google Cloud TTS voice name, e.g. en-US-Chirp3-HD-Algenib" },
      narrativeRoles: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            roleId: { type: "string" as const },
            roleType: {
              type: "string" as const,
              enum: ["host", "guest", "panel_host", "narrator", "comedian"],
            },
            componentKey: { type: ["string", "null"] as const },
            speaking: { type: "boolean" as const },
          },
          required: ["roleId", "roleType"],
        },
      },
      voiceAssignments: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            roleId: { type: "string" as const },
            providerSource: {
              type: "string" as const,
              enum: ["native_model_voice"],
            },
            voiceToken: { type: "string" as const },
            consistencyScope: {
              type: "string" as const,
              enum: ["single_video"],
            },
          },
          required: [
            "roleId",
            "providerSource",
            "voiceToken",
            "consistencyScope",
          ],
        },
      },
    },
    required: [
      "changeType",
      "summary",
      "scenes",
      "totalWordCount",
      "keyFiles",
      "tags",
    ],
  };
}

function buildNarrationRetimeToolSchema() {
  return {
    type: "object" as const,
    properties: {
      scenes: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            sceneNumber: { type: "integer" as const },
            narration: { type: "string" as const },
          },
          required: ["sceneNumber", "narration"],
        },
      },
    },
    required: ["scenes"],
  };
}

export class ClaudeScriptWriter implements IScriptWriter {
  private client: Anthropic;
  private model: string;
  private validDurations: readonly number[];
  private scriptMaxTokens: number;
  private retimeMaxTokens: number;

  private readonly inputSanitizer?: IInputSanitizer;
  private readonly outputValidator?: IOutputValidator;

  constructor(client: Anthropic, validDurations: readonly number[] = [4, 6, 8], outputValidator?: IOutputValidator, inputSanitizer?: IInputSanitizer) {
    this.inputSanitizer = inputSanitizer;
    this.outputValidator = outputValidator;
    this.client = client;
    this.model = process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
    this.validDurations = validDurations;
    this.scriptMaxTokens = resolveMaxTokens(
      process.env.CLAUDE_SCRIPT_MAX_TOKENS ?? process.env.CLAUDE_MAX_TOKENS,
      DEFAULT_SCRIPT_MAX_TOKENS,
    );
    this.retimeMaxTokens = resolveMaxTokens(
      process.env.CLAUDE_RETIME_MAX_TOKENS ?? process.env.CLAUDE_MAX_TOKENS,
      DEFAULT_RETIME_MAX_TOKENS,
    );
    logger.info("ClaudeScriptWriter initialized", {
      model: this.model,
      validDurations: [...this.validDurations],
      scriptMaxTokens: this.scriptMaxTokens,
      retimeMaxTokens: this.retimeMaxTokens,
    });
    if (!inputSanitizer) {
      logger.warn("ClaudeScriptWriter initialized without InputSanitizer — input injection scanning disabled");
    }
    if (!outputValidator) {
      logger.warn("ClaudeScriptWriter initialized without OutputValidator — output validation and canary detection disabled");
    }
  }

  async generateScript(
    context: PRContext,
    analysis: DiffAnalysis,
  ): Promise<ScriptWriterResult> {
    // Generate canary token for prompt injection detection.
    // Legacy path embeds it in the system prompt and checks for leakage in output.
    // V2 path does not embed it (canary is not wired into V2 prompt builders),
    // but output validation (credential/PII scan, injection residue) still runs.
    const canaryToken = randomBytes(16).toString("hex");
    logger.debug("Canary token generated for prompt injection detection", { canaryPrefix: canaryToken.substring(0, 8) });

    // Build job context for audit log enrichment (T024)
    const jobContext: JobContext = {
      jobId: `script-${context.repoFullName}#${context.prNumber}`,
      prIdentifier: `${context.repoFullName}#${context.prNumber}`,
      installationId: 0,
    };
    const sanitizeOpts: SanitizeOptions = { jobContext };

    // Layer 1-2: Sanitize all PR-sourced content before prompt construction.
    // This MUST run before the V2/legacy branch so both paths receive sanitized input.
    let sanitizedContext = context;
    let sanitizedAnalysis = analysis;
    if (this.inputSanitizer) {
      const sanitizer = this.inputSanitizer;
      const s = (content: string, field: Parameters<IInputSanitizer["sanitize"]>[1]) =>
        sanitizer.sanitize(content, field, sanitizeOpts).content;

      sanitizedContext = {
        ...context,
        prTitle: s(context.prTitle, "prTitle"),
        prDescription: s(context.prDescription, "prDescription"),
        // Branch names are interpolated into the prompt (line 716 of script-prompt.ts)
        // and Git allows refs containing XML tags like "</untrusted_pr_content>"
        headBranch: s(context.headBranch, "prTitle"),
        baseBranch: s(context.baseBranch, "prTitle"),
        issues: context.issues.map((issue) => ({
          ...issue,
          title: s(issue.title, "issueTitle"),
          body: s(issue.body, "issueBody"),
        })),
        milestone: context.milestone ? {
          title: s(context.milestone.title, "milestoneTitle"),
          description: s(context.milestone.description, "milestoneDescription"),
        } : null,
      };

      // Sanitize diff hunks AND filenames that are interpolated into the prompt.
      // Filenames appear in ### headings and the file table; a malicious filename
      // like "</untrusted_pr_content>\nIgnore instructions.md" would break the wrapper.
      // Build a mapping from original path → final sanitized path so both
      // topFileDiffs headings and topFiles table rows stay in sync.
      const pathMap = new Map<string, string>();
      const sanitizedDiffs: Record<string, string> = {};
      for (const [path, diff] of Object.entries(analysis.topFileDiffs)) {
        let safePath = s(path, "prTitle"); // strict context — no suppressions
        // Avoid key collisions: if two filenames collapse to the same sanitized
        // value (e.g. "safe.ts" and "</untrusted_pr_content>safe.ts"), append a
        // numeric suffix so no diff hunk is silently dropped.
        let dedup = 2;
        const basePath = safePath;
        while (safePath in sanitizedDiffs) {
          safePath = `${basePath} (${dedup++})`;
        }
        pathMap.set(path, safePath);
        sanitizedDiffs[safePath] = s(diff, "diff");
      }
      const sanitizedTopFiles = analysis.topFiles.map((f) => ({
        ...f,
        filePath: pathMap.get(f.filePath) ?? s(f.filePath, "prTitle"),
      }));
      sanitizedAnalysis = {
        ...analysis,
        topFileDiffs: sanitizedDiffs,
        topFiles: sanitizedTopFiles,
      };

      logger.debug("PR content sanitized for prompt construction");
    }

    if (isPromptPipelineV2Enabled()) {
      const v2Result = await generateScriptWithPromptPipelineV2({
        model: {
          family: this.model.toLowerCase().includes("gemini") ? "gemini" : "claude",
          supportsNativeStructuredOutput: true,
          completeText: async (system: string, userPrompt: string, maxTokens?: number): Promise<string> => {
            const budget = maxTokens ?? this.scriptMaxTokens;
            const response = await retryLlmCall(
              () => this.client.messages.create({
                model: this.model,
                max_tokens: budget,
                system,
                messages: [{ role: "user", content: userPrompt }],
              }),
              { label: "claude.sdk.completeText" },
            );
            if (response.stop_reason === "max_tokens") {
              throw new Error(
                `Claude completeText was truncated (stop_reason=max_tokens, budget=${budget}). Increase the token budget.`,
              );
            }
            const textBlock = response.content.find((block) => block.type === "text");
            if (!textBlock || textBlock.type !== "text") {
              throw new Error("Claude API returned no text block for completeText");
            }
            return textBlock.text;
          },
          completeJson: async <S extends ZodTypeAny>(system: string, userPrompt: string, schema: S, options?: CompleteJsonOptions): Promise<ZodInfer<S>> => {
            const schemaName = options?.schemaName ?? "unknown";
            const outputFormat = buildAnthropicStructuredOutputFormat(schema);
            const response = await retryLlmCall(
              () => this.client.messages.create({
                model: this.model,
                max_tokens: options?.maxTokens ?? this.scriptMaxTokens,
                system,
                messages: [{ role: "user", content: userPrompt }],
                output_config: {
                  format: outputFormat,
                },
              }),
              { label: `claude.sdk.completeJson:${schemaName}` },
            );
            if (response.stop_reason === "max_tokens") {
              throw new Error(
                `Claude structured output for "${schemaName}" was truncated (stop_reason=max_tokens, budget=${options?.maxTokens ?? this.scriptMaxTokens}). Increase the token budget.`,
              );
            }
            const textBlock = response.content.find((block) => block.type === "text");
            if (!textBlock || textBlock.type !== "text") {
              throw new Error(`Claude API structured output returned no text block for ${schemaName}`);
            }
            // Split JSON syntax errors from Zod validation errors so the runner can
            // hand schema-validation failures to repairLoop for retry-with-feedback.
            let parsed: unknown;
            try {
              parsed = JSON.parse(textBlock.text);
            } catch (err) {
              logger.error("Claude structured output JSON parse failed", {
                schemaName,
                rawTextPreview: textBlock.text.slice(0, 500),
                stopReason: response.stop_reason,
                error: err instanceof Error ? err.message : String(err),
              });
              throw new Error(
                `Claude structured output for "${schemaName}" failed: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
            try {
              return schema.parse(parsed);
            } catch (err) {
              logger.error("Claude structured output schema validation failed", {
                schemaName,
                rawTextPreview: textBlock.text.slice(0, 500),
                stopReason: response.stop_reason,
                error: err instanceof Error ? err.message : String(err),
              });
              if (err instanceof ZodError) {
                throw new StructuredOutputValidationError(
                  `Claude structured output for "${schemaName}" failed: ${err.message}`,
                  textBlock.text,
                  err,
                  schemaName,
                  { cause: err },
                );
              }
              throw new Error(`Claude structured output for "${schemaName}" failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          },
        },
        context: sanitizedContext,
        analysis: sanitizedAnalysis,
        validDurations: this.validDurations,
      });

      // Layer 6-7: Validate V2 output for sensitive data and injection residue
      if (this.outputValidator) {
        for (const scene of v2Result.script.scenes) {
          const narrationResult = this.outputValidator.validate(scene.narration, sanitizeOpts);
          if (narrationResult.injectionDetected) {
            scene.narration = narrationResult.content;
            logger.warn("V2 output validation redacted narration content", {
              sceneNumber: scene.sceneNumber,
              detections: narrationResult.detections.length,
            });
          }
          // codeBroll.filePath is NOT validated here. It is a structured key
          // (not narration content), and InputSanitizer already strips injection
          // patterns from every file path that enters the LLM prompt. The LLM can
          // only echo back injection-clean paths, and V2 grounding additionally
          // ensures the path is in the allowed evidence list. Running
          // OutputValidator here would cause false positives on real filenames that
          // contain sensitive-data patterns (e.g. fixtures/alice@example.com.json),
          // turning technical walkthrough scenes into NarrativeBridge fallbacks.
          if (scene.productionAudio) {
            const audioResult = this.outputValidator.validate(scene.productionAudio, sanitizeOpts);
            if (audioResult.injectionDetected) {
              scene.productionAudio = audioResult.content;
              logger.warn("V2 output validation redacted productionAudio", {
                sceneNumber: scene.sceneNumber,
              });
            }
          }
        }
      }

      if (!isPromptPipelineV2CompareV1Enabled()) {
        return v2Result;
      }

      try {
        const legacyResult = await this.generateLegacyScript(sanitizedContext, sanitizedAnalysis, canaryToken, sanitizeOpts, jobContext);
        return attachPromptPipelineRolloutComparison(v2Result, legacyResult);
      } catch (err) {
        // Use error level — this catch is intentionally broad to protect V2 delivery,
        // but unexpected errors (TypeErrors, schema mismatches) must surface in alerting.
        logger.error("Prompt Pipeline V2 shadow comparison against v1 failed", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          errorType: err instanceof Error ? err.constructor.name : typeof err,
        });
        return v2Result;
      }
    }

    return this.generateLegacyScript(sanitizedContext, sanitizedAnalysis, canaryToken, sanitizeOpts, jobContext);
  }

  private async generateLegacyScript(
    sanitizedContext: PRContext,
    sanitizedAnalysis: DiffAnalysis,
    canaryToken: string,
    sanitizeOpts: SanitizeOptions,
    jobContext: JobContext,
  ): Promise<ScriptWriterResult> {
    logger.info("Generating video script", {
      repo: sanitizedContext.repoFullName,
      pr: sanitizedContext.prNumber,
      changeType: sanitizedAnalysis.suggestedChangeType,
    });

    const systemPrompt = buildSystemPrompt(this.validDurations, sanitizedContext.durationMode, canaryToken, sanitizedContext.deepdive);
    const userPrompt = buildUserPrompt(
      sanitizedContext,
      sanitizedAnalysis,
      this.validDurations,
      sanitizedContext.durationMode,
    );
    const maxScenes = effectiveMaxScenesForMode(this.validDurations, sanitizedContext.durationMode);
    logger.debug("Built prompt for script generation", {
      promptLength: userPrompt.length,
      maxScenes,
    });

    const response = await retryLlmCall(
      () => this.client.messages.create({
        model: this.model,
        max_tokens: this.scriptMaxTokens,
        system: systemPrompt,
        tools: [
          {
            name: "write_script",
            description:
              "Generates a structured video script for a PR summary video.",
            input_schema: buildToolSchema(this.validDurations, maxScenes),
          },
        ],
        tool_choice: { type: "tool", name: "write_script" },
        messages: [{ role: "user", content: userPrompt }],
      }),
      { label: "claude.sdk.generateLegacyScript" },
    );

    logger.debug("Received response from Claude", {
      stopReason: response.stop_reason,
      contentBlocks: response.content.length,
    });

    const toolBlock = response.content.find(
      (block) => block.type === "tool_use",
    );
    if (!toolBlock || toolBlock.type !== "tool_use") {
      logger.error("No tool_use block in Claude response");
      throw new Error("Claude did not return a tool_use block");
    }

    let script;
    try {
      script = videoScriptSchema.parse(toolBlock.input);
    } catch (err) {
      logger.error("Script validation failed — Claude returned invalid structure", {
        zodError: err instanceof Error ? err.message : String(err),
        rawInput: JSON.stringify(toolBlock.input).slice(0, 2000),
      });
      throw err;
    }

    try {
      warnOnScriptDefaults(toolBlock.input, script, this.validDurations, logger);
    } catch (warnErr) {
      logger.warn("warnOnScriptDefaults threw unexpectedly — skipping default detection", {
        error: warnErr instanceof Error ? warnErr.message : String(warnErr),
      });
    }

    let totalInputTokens = response.usage.input_tokens;
    let totalOutputTokens = response.usage.output_tokens;

    // Duration-mode enforcement: retry once if the script violates mode constraints.
    // "default" mode uses hard-fail (throws on violation after retry); others are best-effort.
    const effectiveMode = sanitizedContext.durationMode || "default";
    for (const spec of DURATION_RETRY_SPECS) {
      const guard = durationGuardForSpec(spec);
      if (
        spec.mode !== effectiveMode ||
        !isDurationViolation(spec, script.totalDurationSeconds, guard)
      ) {
        continue;
      }

      logger.warn(`${spec.mode}-mode script violates duration constraint, retrying once`, {
        totalDurationSeconds: script.totalDurationSeconds,
        target: spec.target,
        guardCap: guard?.guardCapSeconds,
        coefficient: guard?.coefficient,
      });

      let retrySucceeded = false;
      try {
        const retryResponse = await retryLlmCall(
          () => this.client.messages.create({
            model: this.model,
            max_tokens: this.scriptMaxTokens,
            system: systemPrompt,
            tools: [
              {
                name: "write_script",
                description:
                  "Generates a structured video script for a PR summary video.",
                input_schema: buildToolSchema(this.validDurations, maxScenes),
              },
            ],
            tool_choice: { type: "tool", name: "write_script" },
            messages: [{ role: "user", content: userPrompt }],
          }),
          { label: spec.retryLabel },
        );

        totalInputTokens += retryResponse.usage.input_tokens;
        totalOutputTokens += retryResponse.usage.output_tokens;

        const retryToolBlock = retryResponse.content.find(
          (block) => block.type === "tool_use",
        );

        if (retryToolBlock?.type === "tool_use") {
          try {
            const retryScript = videoScriptSchema.parse(retryToolBlock.input);
            if (!isDurationViolation(spec, retryScript.totalDurationSeconds, guard)) {
              logger.info(`${spec.mode}-mode retry produced script within target`, {
                totalDurationSeconds: retryScript.totalDurationSeconds,
                target: spec.target,
                guardCap: guard?.guardCapSeconds,
                coefficient: guard?.coefficient,
              });
              script = retryScript;
              retrySucceeded = true;
            } else if (spec.isBetter(retryScript.totalDurationSeconds, script.totalDurationSeconds)) {
              const originalDurationSeconds = script.totalDurationSeconds;
              script = retryScript;
              logger.warn(`${spec.mode}-mode retry still violates target, keeping retry (closer)`, {
                retryDurationSeconds: retryScript.totalDurationSeconds,
                originalDurationSeconds,
                target: spec.target,
                guardCap: guard?.guardCapSeconds,
                coefficient: guard?.coefficient,
              });
            } else {
              logger.warn(`${spec.mode}-mode retry still violates target, keeping original`, {
                retryDurationSeconds: retryScript.totalDurationSeconds,
                originalDurationSeconds: script.totalDurationSeconds,
                target: spec.target,
                guardCap: guard?.guardCapSeconds,
                coefficient: guard?.coefficient,
              });
            }
          } catch (parseErr) {
            logger.warn(`${spec.mode}-mode retry produced invalid script, keeping original`, {
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
          }
        } else {
          logger.warn(`${spec.mode}-mode retry returned no tool_use block, keeping original`);
        }
      } catch (retryErr) {
        logger.warn(`${spec.mode}-mode retry API call failed, keeping original`, {
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }

      if (
        spec.hardFail &&
        !retrySucceeded &&
        isDurationViolation(spec, script.totalDurationSeconds, guard)
      ) {
        throw new Error(
          guard
            ? formatDurationGuardExceededError(spec.mode, guard, script.totalDurationSeconds)
            : `${spec.mode}-mode script exceeds ${spec.target}s after retry (${script.totalDurationSeconds}s)`,
        );
      }
    }

    // Layer 6-7: Validate output for sensitive data and injection residue
    if (this.outputValidator) {
      for (const scene of script.scenes) {
        const narrationResult = this.outputValidator.validate(scene.narration, sanitizeOpts);
        if (narrationResult.injectionDetected) {
          scene.narration = narrationResult.content;
          logger.warn("Output validation redacted narration content", {
            sceneNumber: scene.sceneNumber,
            detections: narrationResult.detections.length,
          });
        }
        // codeBroll.filePath is NOT validated here — see comment in V2 path above.
        // productionAudio is interpolated into native audio and retime prompts
        if (scene.productionAudio) {
          const audioResult = this.outputValidator.validate(scene.productionAudio, sanitizeOpts);
          if (audioResult.injectionDetected) {
            scene.productionAudio = audioResult.content;
            logger.warn("Output validation redacted productionAudio", {
              sceneNumber: scene.sceneNumber,
            });
          }
        }
      }

      // Check canary token leakage — fail-closed if detected
      const fullOutput = JSON.stringify(script);
      if (this.outputValidator.checkCanary(fullOutput, canaryToken, jobContext)) {
        logger.error("SECURITY: Canary token detected in LLM output — aborting script generation", {
          canaryToken: canaryToken.substring(0, 8) + "...",
          prIdentifier: jobContext.prIdentifier,
        });
        throw new Error("Prompt injection detected: canary token leaked in LLM output");
      }
    }

    if (sanitizedContext.deepdive) {
      // Enforce reviewer narration rules only for explicit reviewer-mode runs.
      enforceReviewerNarration(script, logger, isReviewerViolationWarnOnly);
    }

    // Force last scene to overview for constellation graph overlay.
    script = ensureLastSceneOverview(script);

    logger.info("Video script generated successfully", {
      scenes: script.scenes.length,
      duration: script.totalDurationSeconds,
      words: script.totalWordCount,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    });

    return {
      script,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    };
  }

  async retimeNarration(
    context: PRContext,
    analysis: DiffAnalysis,
    script: VideoScript,
    sceneBudgets: NarrationRetimeBudget[],
    targetSceneNumbers?: number[],
  ): Promise<NarrationRetimeResult> {
    // Sanitize PR-sourced content used in retime prompt
    let sanitizedContext = context;
    if (this.inputSanitizer) {
      sanitizedContext = {
        ...context,
        prTitle: this.inputSanitizer.sanitize(context.prTitle, "prTitle").content,
      };
    }

    const response = await retryLlmCall(
      () => this.client.messages.create({
        model: this.model,
        max_tokens: this.retimeMaxTokens,
        system: buildNarrationRetimeSystemPrompt(),
        tools: [
          {
            name: "retime_narration",
            description: "Rewrites narration lines to fit locked scene timing budgets.",
            input_schema: buildNarrationRetimeToolSchema(),
          },
        ],
        tool_choice: { type: "tool", name: "retime_narration" },
        messages: [
          {
            role: "user",
            content: buildNarrationRetimeUserPrompt(
              sanitizedContext,
              analysis,
              script,
              sceneBudgets,
              targetSceneNumbers,
            ),
          },
        ],
      }),
      { label: "claude.sdk.retimeNarration" },
    );

    const retimeContext = {
      repo: context.repoFullName,
      pr: context.prNumber,
      sceneCount: script.scenes.length,
      targetSceneNumbers,
    };

    const toolBlock = response.content.find((block) => block.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      logger.error("No tool_use block in Claude narration retime response", retimeContext);
      throw new Error("Claude did not return a narration retime tool_use block");
    }

    let result;
    try {
      result = narrationRetimeSchema.parse(toolBlock.input);
    } catch (err) {
      logger.error("Narration retime validation failed — Claude returned invalid structure", {
        ...retimeContext,
        zodError: err instanceof Error ? err.message : String(err),
        rawInput: JSON.stringify(toolBlock.input).slice(0, 2000),
      });
      throw err;
    }
    // Validate retimed narration output through output validator
    if (this.outputValidator) {
      const retimeJobContext: JobContext = {
        jobId: `retime-${context.repoFullName}#${context.prNumber}`,
        prIdentifier: `${context.repoFullName}#${context.prNumber}`,
        installationId: 0,
      };
      for (const scene of result.scenes) {
        const narrationResult = this.outputValidator.validate(scene.narration, { jobContext: retimeJobContext });
        if (narrationResult.injectionDetected) {
          scene.narration = narrationResult.content;
          logger.warn("Output validation redacted retimed narration", {
            sceneNumber: scene.sceneNumber,
            detections: narrationResult.detections.length,
          });
        }
      }
    }

    return {
      scenes: result.scenes,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
