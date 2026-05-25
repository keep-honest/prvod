import { randomBytes } from "node:crypto";
import type { GoogleGenAI } from "@google/genai";
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from "zod";
import { StructuredOutputValidationError } from "@/infrastructure/llm/promptPipelineV2Repair";
import { createLogger } from "@/lib/logger";
import {
  DEFAULT_MODE_MAX_DURATION,
  MAX_VIDEO_DURATION_SECONDS,
  POPCORN_MODE_MIN_DURATION,
  videoScriptSchema,
  videoScriptTransportSchema,
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
import { generateScriptWithPromptPipelineV2 } from "@/infrastructure/llm/promptPipelineV2Runner";
import { attachPromptPipelineRolloutComparison } from "@/infrastructure/llm/promptPipelineV2Comparison";
import { ensureLastSceneOverview } from "@/domain/entities/VideoScript";
import { enforceReviewerNarration } from "@/infrastructure/llm/promptPipelineV2Validators";
import {
  isReviewerViolationWarnOnly,
  isPromptPipelineV2Enabled,
  isPromptPipelineV2CompareV1Enabled,
} from "@/lib/featureFlags";
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
import type { IInputSanitizer, IOutputValidator, JobContext, SanitizeOptions } from "@/interfaces/IPromptInjectionGuard";
import { buildGenAiStructuredOutputJsonSchema } from "@/infrastructure/llm/structuredOutputSchema";
import { retryLlmCall } from "@/infrastructure/llm/retryLlmCall";
import { extractGenAiResponseText, readGenAiUsage } from "@/infrastructure/llm/genaiClient";
import {
  buildDurationGuard,
  formatDurationGuardExceededError,
  type DurationGuard,
} from "@/lib/durationGuard";

const logger = createLogger("GeminiSdkScriptWriter");

const DEFAULT_MODEL = "gemini-2.5-pro";
// Gemini 2.5 Pro has a mandatory non-zero "thinking" budget that is counted
// against `maxOutputTokens`. Internal reasoning regularly consumes 8–16k
// before any visible output. Defaulting to a much larger budget than the
// Anthropic equivalents (8192 / 4096) is the right call here — ops can dial
// down via GEMINI_SCRIPT_MAX_TOKENS / GEMINI_RETIME_MAX_TOKENS for non-Pro
// models or thinking-disabled Flash deployments.
const DEFAULT_SCRIPT_MAX_TOKENS = 32768;
const DEFAULT_RETIME_MAX_TOKENS = 16384;

function resolveMaxTokens(envValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(envValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface DurationRetrySpec {
  mode: string;
  target: number;
  direction: "max" | "min";
  isBetter: (candidate: number, current: number) => boolean;
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
    retryLabel: "genai.sdk.defaultModeRetry",
  },
  {
    mode: "short",
    target: 60,
    direction: "max",
    isBetter: (c, cur) => c < cur,
    hardFail: true,
    retryLabel: "genai.sdk.shortModeRetry",
  },
  {
    mode: "popcorn",
    target: POPCORN_MODE_MIN_DURATION,
    direction: "min",
    isBetter: (c, cur) => c > cur,
    hardFail: false,
    retryLabel: "genai.sdk.popcornModeRetry",
  },
  {
    mode: "popcorn",
    target: MAX_VIDEO_DURATION_SECONDS,
    direction: "max",
    isBetter: (c, cur) => c < cur,
    hardFail: true,
    retryLabel: "genai.sdk.popcornModeMaxRetry",
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

/**
 * Sanitises every PR-sourced field that is interpolated into the prompt.
 * Mirrors `ClaudeScriptWriter`'s flow so both SDK-backed writers share the
 * same prompt-injection guarantee. CLI-backed writers do not run this.
 */
function applyInputSanitization(
  context: PRContext,
  analysis: DiffAnalysis,
  sanitizer: IInputSanitizer,
  sanitizeOpts: SanitizeOptions,
): { context: PRContext; analysis: DiffAnalysis } {
  const s = (content: string, field: Parameters<IInputSanitizer["sanitize"]>[1]) =>
    sanitizer.sanitize(content, field, sanitizeOpts).content;

  const sanitizedContext: PRContext = {
    ...context,
    prTitle: s(context.prTitle, "prTitle"),
    prDescription: s(context.prDescription, "prDescription"),
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

  const pathMap = new Map<string, string>();
  const sanitizedDiffs: Record<string, string> = {};
  for (const [path, diff] of Object.entries(analysis.topFileDiffs)) {
    let safePath = s(path, "prTitle");
    let dedup = 2;
    const basePath = safePath;
    while (safePath in sanitizedDiffs) {
      safePath = `${basePath} (${dedup++})`;
    }
    pathMap.set(path, safePath);
    sanitizedDiffs[safePath] = s(diff, "diff");
  }
  const sanitizedAnalysis: DiffAnalysis = {
    ...analysis,
    topFileDiffs: sanitizedDiffs,
    topFiles: analysis.topFiles.map((f) => ({
      ...f,
      filePath: pathMap.get(f.filePath) ?? s(f.filePath, "prTitle"),
    })),
  };

  return { context: sanitizedContext, analysis: sanitizedAnalysis };
}

function validateSceneOutputs(
  script: VideoScript,
  outputValidator: IOutputValidator,
  sanitizeOpts: SanitizeOptions,
  pathLabel: "v2" | "legacy",
): void {
  for (const scene of script.scenes) {
    const narrationResult = outputValidator.validate(scene.narration, sanitizeOpts);
    if (narrationResult.injectionDetected) {
      scene.narration = narrationResult.content;
      logger.warn(`${pathLabel} output validation redacted narration content`, {
        sceneNumber: scene.sceneNumber,
        detections: narrationResult.detections.length,
      });
    }
    // codeBroll.filePath intentionally excluded: it's a structured key already
    // sanitised on input, and grounding restricts it to the allowed evidence
    // set. Validating here would false-positive on real fixture filenames
    // containing PII patterns (e.g. fixtures/alice@example.com.json).
    if (scene.productionAudio) {
      const audioResult = outputValidator.validate(scene.productionAudio, sanitizeOpts);
      if (audioResult.injectionDetected) {
        scene.productionAudio = audioResult.content;
        logger.warn(`${pathLabel} output validation redacted productionAudio`, {
          sceneNumber: scene.sceneNumber,
        });
      }
    }
  }
}

/**
 * Script writer backed by the `@google/genai` SDK.
 *
 * Parallels `ClaudeScriptWriter` — same prompt-injection guard wiring, same
 * V2/legacy branching, same duration-mode retry contract. Differences:
 *
 * - Structured output uses Gemini's `responseJsonSchema` + `responseMimeType`
 *   instead of Anthropic's `output_config.format` or `tool_choice`.
 * - The legacy path requests a JSON object validated against
 *   `videoScriptTransportSchema`, then runs the same Zod transform that
 *   ClaudeScriptWriter applies via `videoScriptSchema.parse(toolBlock.input)`.
 * - V2 path provides `family: "gemini"` and `supportsNativeStructuredOutput:
 *   true` to the V2 runner so it skips prompt-embedded schema hints.
 */
export class GeminiSdkScriptWriter implements IScriptWriter {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly validDurations: readonly number[];
  private readonly scriptMaxTokens: number;
  private readonly retimeMaxTokens: number;
  private readonly inputSanitizer?: IInputSanitizer;
  private readonly outputValidator?: IOutputValidator;

  constructor(
    client: GoogleGenAI,
    validDurations: readonly number[] = [4, 6, 8],
    outputValidator?: IOutputValidator,
    inputSanitizer?: IInputSanitizer,
  ) {
    this.client = client;
    this.model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.validDurations = validDurations;
    this.scriptMaxTokens = resolveMaxTokens(
      process.env.GEMINI_SCRIPT_MAX_TOKENS,
      DEFAULT_SCRIPT_MAX_TOKENS,
    );
    this.retimeMaxTokens = resolveMaxTokens(
      process.env.GEMINI_RETIME_MAX_TOKENS,
      DEFAULT_RETIME_MAX_TOKENS,
    );
    this.inputSanitizer = inputSanitizer;
    this.outputValidator = outputValidator;
    logger.info("GeminiSdkScriptWriter initialized", {
      model: this.model,
      validDurations: [...this.validDurations],
      scriptMaxTokens: this.scriptMaxTokens,
      retimeMaxTokens: this.retimeMaxTokens,
    });
    if (!inputSanitizer) {
      logger.warn("GeminiSdkScriptWriter initialized without InputSanitizer — input injection scanning disabled");
    }
    if (!outputValidator) {
      logger.warn("GeminiSdkScriptWriter initialized without OutputValidator — output validation and canary detection disabled");
    }
  }

  async generateScript(
    context: PRContext,
    analysis: DiffAnalysis,
  ): Promise<ScriptWriterResult> {
    const canaryToken = randomBytes(16).toString("hex");
    logger.debug("Canary token generated", { canaryPrefix: canaryToken.substring(0, 8) });

    const jobContext: JobContext = {
      jobId: `script-${context.repoFullName}#${context.prNumber}`,
      prIdentifier: `${context.repoFullName}#${context.prNumber}`,
      installationId: 0,
    };
    const sanitizeOpts: SanitizeOptions = { jobContext };

    let sanitizedContext = context;
    let sanitizedAnalysis = analysis;
    if (this.inputSanitizer) {
      const result = applyInputSanitization(context, analysis, this.inputSanitizer, sanitizeOpts);
      sanitizedContext = result.context;
      sanitizedAnalysis = result.analysis;
      logger.debug("PR content sanitized for prompt construction");
    }

    if (isPromptPipelineV2Enabled()) {
      // The V2 runner passes hard-coded per-stage budgets (e.g. 6144 / 8192 /
      // 12288) sized for non-thinking models like Claude. Gemini 2.5 Pro has a
      // mandatory thinking budget that consumes a chunk of `maxOutputTokens`
      // before any visible output, so those provider-agnostic numbers truncate
      // immediately. We treat `this.scriptMaxTokens` as a floor and only let
      // V2 push the budget HIGHER, never below the Gemini-thinking-aware
      // default. Operators can still raise it via GEMINI_SCRIPT_MAX_TOKENS.
      const floorBudget = (override: number | undefined): number =>
        Math.max(override ?? 0, this.scriptMaxTokens);

      const v2Result = await generateScriptWithPromptPipelineV2({
        model: {
          family: "gemini",
          supportsNativeStructuredOutput: true,
          completeText: async (system, userPrompt, maxTokens) => {
            const budget = floorBudget(maxTokens);
            const response = await retryLlmCall(
              () => this.client.models.generateContent({
                model: this.model,
                contents: userPrompt,
                config: {
                  systemInstruction: system,
                  maxOutputTokens: budget,
                },
              }),
              { label: "genai.sdk.completeText" },
            );
            return extractGenAiResponseText(response, { label: "completeText", budget });
          },
          completeJson: async <S extends ZodTypeAny>(
            system: string,
            userPrompt: string,
            schema: S,
            options?: CompleteJsonOptions,
          ): Promise<ZodInfer<S>> => {
            const schemaName = options?.schemaName ?? "unknown";
            const responseJsonSchema = buildGenAiStructuredOutputJsonSchema(schema);
            const budget = floorBudget(options?.maxTokens);
            const response = await retryLlmCall(
              () => this.client.models.generateContent({
                model: this.model,
                contents: userPrompt,
                config: {
                  systemInstruction: system,
                  maxOutputTokens: budget,
                  responseMimeType: "application/json",
                  responseJsonSchema,
                },
              }),
              { label: `genai.sdk.completeJson:${schemaName}` },
            );
            const text = extractGenAiResponseText(response, { label: `completeJson:${schemaName}`, budget });
            // Separate JSON syntax errors from Zod validation errors. Zod failures
            // throw `StructuredOutputValidationError` carrying rawJson so callers can
            // hand the failure to repairLoop for retry-with-feedback. Syntax errors
            // surface as ordinary Error (repair-loop's SyntaxError path catches them).
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch (err) {
              logger.error("GenAI structured output JSON parse failed", {
                schemaName,
                rawTextPreview: text.slice(0, 500),
                error: err instanceof Error ? err.message : String(err),
              });
              throw new Error(
                `GenAI structured output for "${schemaName}" failed: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
            try {
              return schema.parse(parsed);
            } catch (err) {
              logger.error("GenAI structured output schema validation failed", {
                schemaName,
                rawTextPreview: text.slice(0, 500),
                error: err instanceof Error ? err.message : String(err),
              });
              if (err instanceof ZodError) {
                throw new StructuredOutputValidationError(
                  `GenAI structured output for "${schemaName}" failed: ${err.message}`,
                  text,
                  err,
                  schemaName,
                  { cause: err },
                );
              }
              throw new Error(
                `GenAI structured output for "${schemaName}" failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
        },
        context: sanitizedContext,
        analysis: sanitizedAnalysis,
        validDurations: this.validDurations,
      });

      if (this.outputValidator) {
        validateSceneOutputs(v2Result.script, this.outputValidator, sanitizeOpts, "v2");
      }

      // Shadow-comparison: when PROMPT_PIPELINE_V2_COMPARE_V1 is enabled, also
      // run the legacy generation pass and attach the comparison metadata for
      // rollout telemetry. Failures here must NOT take down V2 delivery.
      if (!isPromptPipelineV2CompareV1Enabled()) {
        return v2Result;
      }
      try {
        const legacyResult = await this.generateLegacyScript(
          sanitizedContext,
          sanitizedAnalysis,
          canaryToken,
          sanitizeOpts,
          jobContext,
        );
        return attachPromptPipelineRolloutComparison(v2Result, legacyResult);
      } catch (err) {
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
    logger.info("Generating video script (legacy path)", {
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
    const responseJsonSchema = buildGenAiStructuredOutputJsonSchema(videoScriptTransportSchema);
    logger.debug("Built prompt for legacy script generation", {
      promptLength: userPrompt.length,
      maxScenes,
    });

    const generate = async (label: string) => {
      const response = await retryLlmCall(
        () => this.client.models.generateContent({
          model: this.model,
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: this.scriptMaxTokens,
            responseMimeType: "application/json",
            responseJsonSchema,
          },
        }),
        { label },
      );
      const text = extractGenAiResponseText(response, {
        label: "legacy generation",
        budget: this.scriptMaxTokens,
      });
      const usage = readGenAiUsage(response, label);
      return { text, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    };

    const initial = await generate("genai.sdk.generateLegacyScript");

    let parsedTransport;
    try {
      parsedTransport = JSON.parse(initial.text) as unknown;
    } catch (err) {
      logger.error("GenAI legacy output is not valid JSON", {
        rawTextPreview: initial.text.slice(0, 500),
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`GenAI legacy script JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let script: VideoScript;
    try {
      script = videoScriptSchema.parse(parsedTransport);
    } catch (err) {
      logger.error("Script validation failed — GenAI returned invalid structure", {
        zodError: err instanceof Error ? err.message : String(err),
        rawInput: JSON.stringify(parsedTransport).slice(0, 2000),
      });
      throw err;
    }

    try {
      warnOnScriptDefaults(parsedTransport, script, this.validDurations, logger);
    } catch (warnErr) {
      logger.warn("warnOnScriptDefaults threw unexpectedly — skipping default detection", {
        error: warnErr instanceof Error ? warnErr.message : String(warnErr),
      });
    }

    let totalInputTokens = initial.inputTokens;
    let totalOutputTokens = initial.outputTokens;

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
        const retry = await generate(spec.retryLabel);
        totalInputTokens += retry.inputTokens;
        totalOutputTokens += retry.outputTokens;

        let retryParsed: unknown;
        try {
          retryParsed = JSON.parse(retry.text);
        } catch (err) {
          logger.warn(`${spec.mode}-mode retry produced invalid JSON, keeping original`, {
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        try {
          const retryScript = videoScriptSchema.parse(retryParsed);
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

    if (this.outputValidator) {
      validateSceneOutputs(script, this.outputValidator, sanitizeOpts, "legacy");

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
      enforceReviewerNarration(script, logger, isReviewerViolationWarnOnly);
    }

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
    let sanitizedContext = context;
    if (this.inputSanitizer) {
      sanitizedContext = {
        ...context,
        prTitle: this.inputSanitizer.sanitize(context.prTitle, "prTitle").content,
      };
    }

    const responseJsonSchema = buildGenAiStructuredOutputJsonSchema(narrationRetimeSchema);
    const response = await retryLlmCall(
      () => this.client.models.generateContent({
        model: this.model,
        contents: buildNarrationRetimeUserPrompt(
          sanitizedContext,
          analysis,
          script,
          sceneBudgets,
          targetSceneNumbers,
        ),
        config: {
          systemInstruction: buildNarrationRetimeSystemPrompt(),
          maxOutputTokens: this.retimeMaxTokens,
          responseMimeType: "application/json",
          responseJsonSchema,
        },
      }),
      { label: "genai.sdk.retimeNarration" },
    );

    const retimeContext = {
      repo: context.repoFullName,
      pr: context.prNumber,
      sceneCount: script.scenes.length,
      targetSceneNumbers,
    };

    const text = extractGenAiResponseText(response, {
      label: "narration retime",
      budget: this.retimeMaxTokens,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error("GenAI narration retime is not valid JSON", {
        ...retimeContext,
        rawTextPreview: text.slice(0, 500),
      });
      throw new Error(`GenAI narration retime JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let result;
    try {
      result = narrationRetimeSchema.parse(parsed);
    } catch (err) {
      logger.error("Narration retime validation failed — GenAI returned invalid structure", {
        ...retimeContext,
        zodError: err instanceof Error ? err.message : String(err),
        rawInput: JSON.stringify(parsed).slice(0, 2000),
      });
      throw err;
    }

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

    const usage = readGenAiUsage(response, "genai.sdk.retimeNarration");
    return {
      scenes: result.scenes,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    };
  }
}
