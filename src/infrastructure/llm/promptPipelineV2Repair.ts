import { ZodError } from "zod";
import { createLogger } from "@/lib/logger";
import type { ZodTypeAny, infer as ZodInfer, SafeParseReturnType } from "zod";
import {
  buildFinalScriptSystemPrompt,
  buildScriptRepairPrompt,
  type PromptPipelineLlmFamily,
} from "@/infrastructure/llm/promptPipelineV2";
import type { DurationMode } from "@/domain/entities/PRContext";
// Type-only import to avoid runtime circular dependency with promptPipelineV2Runner,
// which imports `repairLoop` / `tryParseJson` from this module.
import type { CompleteJsonOptions, PromptPipelineV2Model } from "@/infrastructure/llm/promptPipelineV2Runner";

const logger = createLogger("PromptPipelineV2Repair");

// ── Utilities ─────────────────────────────────────────────────────────────────

export type ParseResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      rawJson: string;
      zodError: ZodError;
      /**
       * When the final repair attempt produced unparseable JSON, this is the
       * SyntaxError message from that attempt. `rawJson`/`zodError` reflect
       * the LAST schema-failure (i.e. the second-to-last attempt) since
       * `result` is only reassigned on a successful parse. Surfacing this
       * lets the top-level error handler diagnose "model gave up by emitting
       * non-JSON" vs "model gave up emitting wrong-shape JSON."
       */
      lastSyntaxError?: string;
    };

export function formatZodErrors(error: ZodError): string {
  return error.issues
    .map((i) => `- ${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("\n");
}

/** Classify errors from LLM completions: validation errors (Zod, JSON syntax, structured output) are benign; everything else is infrastructure. */
export function isLlmValidationError(err: unknown): boolean {
  return err instanceof Error && (
    err.name === "ZodError" || err.name === "SyntaxError" || err.message.includes("structured output")
  );
}

/**
 * Parse raw LLM text as JSON and validate against a Zod schema.
 * Returns a discriminated union so callers can access the broken JSON for repair.
 * JSON syntax errors are thrown (callers may catch to retry).
 */
export function tryParseJson<S extends ZodTypeAny>(
  raw: string,
  schema: S,
): ParseResult<ZodInfer<S>> {
  const cleaned = stripMarkdownFences(raw);
  const parsed = JSON.parse(cleaned);
  const result: SafeParseReturnType<unknown, ZodInfer<S>> = schema.safeParse(parsed);
  if (result.success) return { success: true, data: result.data };
  return { success: false, rawJson: cleaned, zodError: result.error };
}

/** Validate an already-parsed object against a Zod schema. Avoids stringify→parse round-trip. */
export function tryValidate<S extends ZodTypeAny>(
  value: unknown,
  schema: S,
): ParseResult<ZodInfer<S>> {
  const result: SafeParseReturnType<unknown, ZodInfer<S>> = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, rawJson: JSON.stringify(value, null, 2), zodError: result.error };
}

export function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
}

// ── Repair Loop ───────────────────────────────────────────────────────────────

export function getMaxRepairAttempts(): number {
  return Math.max(0, parseInt(process.env.SCRIPT_REPAIR_MAX_ATTEMPTS ?? "2", 10) || 0);
}

export interface RepairContext {
  completeText: (system: string, userPrompt: string, maxTokens?: number) => Promise<string>;
  promptContext: {
    family: PromptPipelineLlmFamily;
    durationMode?: DurationMode;
  };
  validDurations: readonly number[];
  /** Label for logging (e.g. "final_script", "narration_revised_script") */
  label: string;
  /** Override the JSON shape reminder in the repair prompt (for batch schemas). */
  shapeHint?: string;
  /** Override the system prompt (for batch repair — avoids "write full VideoScript" framing). */
  systemPrompt?: string;
}

/**
 * Attempt to repair a broken JSON output by feeding the Zod errors back to the LLM.
 * Returns a successful ParseResult if repair succeeds, or the last failed result.
 */
export async function repairLoop<S extends ZodTypeAny>(
  initialResult: ParseResult<ZodInfer<S>>,
  schema: S,
  ctx: RepairContext,
): Promise<ParseResult<ZodInfer<S>>> {
  const maxAttempts = getMaxRepairAttempts();
  let result = initialResult;
  let lastSyntaxError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts && !result.success; attempt++) {
    const errors = formatZodErrors(result.zodError);
    logger.warn(`${ctx.label}: validation failed — attempting LLM repair`, {
      attempt,
      maxAttempts,
      errors,
    });
    const systemPrompt = ctx.systemPrompt
      ?? buildFinalScriptSystemPrompt(ctx.promptContext, ctx.validDurations);
    const repairRaw = await ctx.completeText(
      systemPrompt,
      buildScriptRepairPrompt(ctx.promptContext.family, result.rawJson, errors, ctx.validDurations, ctx.shapeHint),
      12288,
    );
    try {
      result = tryParseJson(repairRaw, schema);
      lastSyntaxError = undefined;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      lastSyntaxError = err.message;
      logger.warn(`${ctx.label}: repair attempt ${attempt} returned unparseable JSON`, {
        attempt,
        maxAttempts,
        error: err.message,
      });
    }
  }

  if (!result.success && maxAttempts > 0) {
    logger.error(`${ctx.label}: repair exhausted after ${maxAttempts} attempts`, {
      errors: formatZodErrors(result.zodError),
      ...(lastSyntaxError ? { lastSyntaxError } : {}),
    });
  }

  // Thread lastSyntaxError onto the returned failure variant so the
  // top-level rewrap (in completeJsonWithRepair) can surface it on the
  // exception itself, not just in the warn-level log.
  if (!result.success && lastSyntaxError !== undefined) {
    return { ...result, lastSyntaxError };
  }

  return result;
}

// ── Structured-output validation error ────────────────────────────────────────

/**
 * Thrown by model.completeJson implementations when the model returned
 * syntactically-valid JSON that failed Zod schema validation. Carries the
 * raw JSON text + ZodError so callers can hand the failure to repairLoop
 * for a text-mode retry-with-feedback pass instead of failing the job.
 *
 * Plain JSON syntax errors (model returned text that isn't valid JSON)
 * still surface as ordinary Error — those are a different failure mode
 * and the repair loop handles them via its own per-attempt SyntaxError
 * catch in tryParseJson.
 */
export class StructuredOutputValidationError extends Error {
  readonly name = "StructuredOutputValidationError";
  readonly rawJson: string;
  readonly zodError: ZodError;
  readonly schemaName: string;

  constructor(
    message: string,
    rawJson: string,
    zodError: ZodError,
    schemaName: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.rawJson = rawJson;
    this.zodError = zodError;
    this.schemaName = schemaName;
  }
}

// ── completeJson + repair wrapper ─────────────────────────────────────────────

export interface CompleteJsonWithRepairArgs<S extends ZodTypeAny> {
  model: PromptPipelineV2Model;
  system: string;
  userPrompt: string;
  schema: S;
  options: CompleteJsonOptions;
  /**
   * Repair context — passed to repairLoop on Zod failure. `completeText`
   * may be omitted by the caller (set via `model.completeText`); when it
   * is, the repair loop runs zero attempts and the original ZodError is
   * rethrown unchanged.
   */
  repair?: Omit<RepairContext, "completeText"> & { completeText?: RepairContext["completeText"] };
}

/**
 * Call `model.completeJson` with retry-with-feedback fallback on schema
 * validation failure. When the model emits JSON that fails Zod, this
 * helper:
 *
 *   1. Captures the rawJson + zodError from the thrown
 *      `StructuredOutputValidationError`.
 *   2. Calls `repairLoop` with the caller-supplied RepairContext to ask
 *      the model — in text-completion mode — to fix the validation
 *      errors and return corrected JSON.
 *   3. Returns the repaired data on success, or rethrows the final
 *      ZodError when all repair attempts fail.
 *
 * If `repair.completeText` is undefined (model has no text-completion
 * channel) or `SCRIPT_REPAIR_MAX_ATTEMPTS=0`, the original validation
 * error rethrows unchanged — preserving existing behaviour.
 *
 * Non-validation errors (network, syntax, infra) propagate untouched.
 */
export async function completeJsonWithRepair<S extends ZodTypeAny>(
  args: CompleteJsonWithRepairArgs<S>,
): Promise<ZodInfer<S>> {
  const schemaName = args.options.schemaName ?? "unknown";
  try {
    const value = await args.model.completeJson(args.system, args.userPrompt, args.schema, args.options);
    // Defensive re-validate: real implementations (BaseCliScriptWriter,
    // GeminiSdkScriptWriter, ClaudeScriptWriter) already Zod-validate before
    // returning, but this guards against a misbehaving impl (or a test
    // mock) returning an unvalidated payload — and lets us route it through
    // the same repair path as a thrown StructuredOutputValidationError.
    const reValidate = args.schema.safeParse(value);
    if (reValidate.success) {
      return reValidate.data;
    }
    throw new StructuredOutputValidationError(
      `structured output for "${schemaName}" failed: ${reValidate.error.message}`,
      safeStringifyForRepair(value, schemaName),
      reValidate.error,
      schemaName,
      { cause: reValidate.error },
    );
  } catch (err) {
    if (!(err instanceof StructuredOutputValidationError)) throw err;

    const completeText = args.repair?.completeText;
    if (!completeText || !args.repair) {
      throw err;
    }

    // Honour the docstring contract: SCRIPT_REPAIR_MAX_ATTEMPTS=0 rethrows
    // the ORIGINAL typed error unchanged (preserving identity for `.rejects.toBe(err)`
    // and operator-visible message stability). Without this early return, the
    // exhaust-rewrap path below would still fire — wrapping with "after 0 repair
    // attempt(s)" — which contradicts "rethrows unchanged".
    if (getMaxRepairAttempts() === 0) {
      throw err;
    }

    const failedResult: ParseResult<ZodInfer<S>> = {
      success: false,
      rawJson: err.rawJson,
      zodError: err.zodError,
    };
    const repaired = await repairLoop(failedResult, args.schema, {
      completeText,
      promptContext: args.repair.promptContext,
      validDurations: args.repair.validDurations,
      label: args.repair.label,
      ...(args.repair.shapeHint !== undefined ? { shapeHint: args.repair.shapeHint } : {}),
      ...(args.repair.systemPrompt !== undefined ? { systemPrompt: args.repair.systemPrompt } : {}),
    });
    if (!repaired.success) {
      // Re-wrap as StructuredOutputValidationError so the schemaName + rawJson
      // of the final repair attempt survive to the top-level error handler.
      // Otherwise the bare ZodError loses stage identity (operators reading
      // the stack trace can't tell whether the failure was coverage_plan,
      // scene_outline, video_script, batch_envelope, or batch_scenes) and
      // the model's final emitted payload.
      // `cause: err` preserves the chain to the ORIGINAL validation error so
      // structured-log consumers that walk `err.cause` see the first-attempt
      // rawJson + ZodError, not just the final attempt's.
      // `lastSyntaxError` (when present) surfaces the "final attempt emitted
      // non-JSON" failure mode on the exception itself, not just the log.
      const syntaxSuffix = repaired.lastSyntaxError !== undefined
        ? ` (final attempt returned unparseable JSON: ${repaired.lastSyntaxError})`
        : "";
      throw new StructuredOutputValidationError(
        `structured output for "${schemaName}" failed after ${getMaxRepairAttempts()} repair attempt(s): ${repaired.zodError.message}${syntaxSuffix}`,
        repaired.rawJson,
        repaired.zodError,
        schemaName,
        { cause: err },
      );
    }
    return repaired.data;
  }
}

/**
 * `JSON.stringify` throws on circular references and silently drops
 * `undefined`/function fields. In the defensive re-validate path we
 * already have a Zod failure — using JSON.stringify naively would mask
 * that with a `TypeError` (circular ref) or omit the exact fields Zod
 * flagged (undefined required). Fall back to `String(value)` so the
 * repair LLM still sees something, and the original ZodError survives.
 *
 * The fallback is lossy (e.g. `String({})` returns `"[object Object]"`
 * — the repair LLM gets no field data and will almost certainly fail
 * all repair attempts). Emit a warn so operators investigating burned
 * repair quota can see the degraded-input breadcrumb.
 */
function safeStringifyForRepair(value: unknown, schemaName: string): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    logger.warn("safeStringifyForRepair: JSON.stringify failed — repair LLM will receive degraded input", {
      schemaName,
      error: err instanceof Error ? err.message : String(err),
      valueType: typeof value,
    });
    return String(value);
  }
}
