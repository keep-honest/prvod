import { ZodError } from "zod";
import { createLogger } from "@/lib/logger";
import type { ZodTypeAny, infer as ZodInfer, SafeParseReturnType } from "zod";
import {
  buildFinalScriptSystemPrompt,
  buildScriptRepairPrompt,
  type PromptPipelineLlmFamily,
} from "@/infrastructure/llm/promptPipelineV2";
import type { DurationMode } from "@/domain/entities/PRContext";

const logger = createLogger("PromptPipelineV2Repair");

// ── Utilities ─────────────────────────────────────────────────────────────────

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; rawJson: string; zodError: ZodError };

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

  return result;
}
