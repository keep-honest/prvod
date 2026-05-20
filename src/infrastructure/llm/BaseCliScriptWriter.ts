import { execFile, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jsonrepair } from "jsonrepair";
import type { ZodTypeAny, infer as ZodInfer } from "zod";
import type { ILLMClient } from "@/interfaces/ILLMClient";
import { createLogger } from "@/lib/logger";
import {
  DEFAULT_MODE_MAX_DURATION,
  MAX_VIDEO_DURATION_SECONDS,
  POPCORN_MODE_MIN_DURATION,
  videoScriptSchema,
} from "@/domain/entities/VideoScript";
import {
  buildJsonShapeHint,
  buildNarrationRetimeJsonShapeHint,
  buildNarrationRetimeSystemPrompt,
  buildNarrationRetimeUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  narrationRetimeSchema,
  warnOnScriptDefaults,
} from "@/infrastructure/llm/script-prompt";
import { attachPromptPipelineRolloutComparison } from "@/infrastructure/llm/promptPipelineV2Comparison";
import { stripMarkdownFences } from "@/infrastructure/llm/promptPipelineV2Repair";
import { generateScriptWithPromptPipelineV2 } from "@/infrastructure/llm/promptPipelineV2Runner";
import { ensureLastSceneOverview } from "@/domain/entities/VideoScript";
import { enforceReviewerNarration } from "@/infrastructure/llm/promptPipelineV2Validators";
import { isReviewerViolationWarnOnly } from "@/lib/featureFlags";
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
import { buildStructuredOutputJsonSchema, buildOpenAIStructuredOutputJsonSchema, buildTextModeSchemaHint } from "@/infrastructure/llm/structuredOutputSchema";
import type { CompleteJsonOptions } from "@/infrastructure/llm/promptPipelineV2Runner";
import { retryLlmCall } from "@/infrastructure/llm/retryLlmCall";
import {
  buildDurationGuard,
  formatDurationGuardExceededError,
  type DurationGuard,
} from "@/lib/durationGuard";
type Logger = ReturnType<typeof createLogger>;

export interface CliScriptWriterConfig {
  /** CLI binary name (e.g. "claude", "gemini", "codex") */
  command: string;
  /** Default model when no env var is set */
  defaultModel: string;
  /** Env var names to check for model override, in priority order */
  modelEnvVars: string[];
  /** CLI flag for specifying the model (e.g. "--model" or "-m") */
  modelFlag: string;
  /** Logger label */
  loggerName: string;
  /** Whether to strip CLAUDECODE from the env (needed for Claude CLI) */
  cleanEnv?: boolean;
  /** Flag that signals "read prompt from stdin" (e.g. "-p" for Claude). Omit if CLI reads stdin by default. */
  promptFlag?: string;
  /** CLI flag for passing a JSON schema (e.g. "--json-schema", "--output-schema"). Omit if CLI doesn't support structured output. */
  jsonSchemaFlag?: string;
  /** Subcommand prepended before all other args (e.g. "exec" for Codex CLI). */
  subCommand?: string;
  /** Extra flags always appended to every invocation (e.g. ["--full-auto"] for Codex). */
  extraFlags?: string[];
  /** Flags for text output mode. Defaults to ["--output-format", "text"]. Set to [] for CLIs without this concept. */
  textOutputFlags?: string[];
  /** Flags for JSON output mode (used with jsonSchemaFlag). Defaults to ["--output-format", "json"]. Set to [] if not applicable. */
  jsonOutputFlags?: string[];
  /** If true, the prompt is passed as the last positional arg instead of piped to stdin. */
  promptAsArg?: boolean;
  /** If true, the JSON schema is written to a temp file and the file path is passed to the CLI (e.g. Codex CLI). When false (default), the schema is passed inline. */
  jsonSchemaAsFile?: boolean;
  /** Config overrides passed as `-c key=value` pairs (e.g. Codex CLI's `-c model_reasoning_effort="medium"`). */
  configFlags?: string[];
}

function buildEnv(clean: boolean): NodeJS.ProcessEnv {
  if (!clean) return process.env;
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

/**
 * Capped preview length for each stream in CLI failure messages. Kept at
 * 2000 chars because that's long enough to capture the tail of a JSON
 * envelope or a full Python traceback without flooding the log line.
 */
const CLI_FAILURE_PREVIEW_LIMIT = 2000;
const CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_CLI_TIMEOUT_MS = 90_000;

function readPositiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw == null) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cliTimeoutMs(command: string): number {
  const commandEnvName = `${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLI_TIMEOUT_MS`;
  return readPositiveIntEnv(commandEnvName) ??
    readPositiveIntEnv("CLI_LLM_TIMEOUT_MS") ??
    DEFAULT_CLI_TIMEOUT_MS;
}

function previewCliStream(text: string | null | undefined): string {
  if (!text) return "";
  if (text.length <= CLI_FAILURE_PREVIEW_LIMIT) return text;

  const omitted = text.length - CLI_FAILURE_PREVIEW_LIMIT;
  const marker = `\n...[truncated ${omitted} chars]...\n`;
  const budget = CLI_FAILURE_PREVIEW_LIMIT - marker.length;
  if (budget <= 0) {
    return text.slice(-CLI_FAILURE_PREVIEW_LIMIT);
  }

  const headLength = Math.ceil(budget / 2);
  const tailLength = Math.floor(budget / 2);
  return text.slice(0, headLength) + marker + text.slice(-tailLength);
}

/**
 * Formats a CLI process failure into a single diagnostic string.
 *
 * Extracted as a pure helper (a) so `execFileAsync` stays readable and
 * (b) so we can unit-test the formatting without spawning a child
 * process. This is the operator's debugging lifeline — a regression
 * here (wrong stream order, wrong truncation, dropped fall-through)
 * would reproduce exactly the "meaningless Node error message" problem
 * this refactor was made to fix.
 *
 * Exported via the `_` prefix convention used elsewhere in this file
 * for helpers that are public to tests but not to application code.
 */
export function _formatCliFailure(args: {
  cmd: string;
  exitCode: number | string | null | undefined;
  signal?: NodeJS.Signals | null;
  stdout: string | null | undefined;
  stderr: string | null | undefined;
  fallbackMessage: string;
}): string {
  const stderrPreview = previewCliStream(args.stderr);
  const stdoutPreview = previewCliStream(args.stdout);
  const parts: string[] = [];
  if (stderrPreview) parts.push(`stderr: ${stderrPreview}`);
  if (stdoutPreview) parts.push(`stdout: ${stdoutPreview}`);
  if (parts.length === 0) parts.push(args.fallbackMessage);

  const exit = args.exitCode ?? "unknown";
  const signal = args.signal ? `, signal ${args.signal}` : "";
  return `${args.cmd} CLI failed (exit ${exit}${signal}): ${parts.join(" | ")}`;
}

function execFileAsync(
  cmd: string,
  args: string[],
  input: string | null,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = cliTimeoutMs(cmd);
  if (input === null) {
    return execFileNoStdinAsync(cmd, args, env, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      maxBuffer: CLI_MAX_BUFFER_BYTES,
      env,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    }, (error, stdout, stderr) => {
      if (error) {
        // Claude/Gemini/Codex CLIs sometimes print diagnostic output to stdout
        // (as a JSON envelope or plain text) and exit non-zero. Until this
        // change we surfaced only stderr and then fell through to the
        // meaningless Node error message ("Command failed: claude -p ..."),
        // which left operators with zero signal to debug from. Include a
        // capped preview of both streams so the real reason — rate limit,
        // auth failure, schema rejection, etc. — lands in the logs.
        const errWithSignal = error as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null };
        const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true &&
          errWithSignal.signal === "SIGTERM";
        const timeoutMessage = `${cmd} CLI timed out after ${timeoutMs}ms`;
        reject(
          new Error(
            _formatCliFailure({
              cmd,
              exitCode: error.code,
              signal: errWithSignal.signal ?? null,
              stdout,
              stderr: timedOut ? `${stderr}\n${timeoutMessage}` : stderr,
              fallbackMessage: timedOut
                ? timeoutMessage
                : error.message,
            }),
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
    if (!child.stdin) {
      reject(new Error(`${cmd} CLI spawned without stdin pipe — cannot send prompt`));
      return;
    }
    child.stdin.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
        reject(new Error(`${cmd} CLI stdin write failed: ${err.message}`));
      }
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function execFileNoStdinAsync(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };

    timeout = setTimeout(() => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const timeoutMessage = `${cmd} CLI timed out after ${timeoutMs}ms`;
      child.kill("SIGTERM");
      rejectOnce(
        new Error(
          _formatCliFailure({
            cmd,
            exitCode: "timeout",
            signal: "SIGTERM",
            stdout,
            stderr: `${stderr}\n${timeoutMessage}`,
            fallbackMessage: timeoutMessage,
          }),
        ),
      );
    }, timeoutMs);

    const capture = (chunks: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > CLI_MAX_BUFFER_BYTES) {
        child.kill();
        rejectOnce(new Error(`${cmd} CLI output exceeded ${CLI_MAX_BUFFER_BYTES} bytes`));
        return;
      }
      chunks.push(buffer);
    };

    child.stdout?.on("data", (chunk) => capture(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk) => capture(stderrChunks, chunk));
    child.on("error", rejectOnce);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0 || signal) {
        reject(
          new Error(
            _formatCliFailure({
              cmd,
              exitCode: code ?? "unknown",
              signal,
              stdout,
              stderr,
              fallbackMessage: signal
                ? `${cmd} exited with signal ${signal}`
                : `${cmd} exited with code ${code}`,
            }),
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function extractJsonCandidate(raw: string): string {
  let text = stripMarkdownFences(raw);

  // Extract the JSON object/array — strip preamble ("Here is the JSON:")
  // and epilogue ("Let me know if you need changes!")
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const start = Math.min(
    firstBrace >= 0 ? firstBrace : Infinity,
    firstBracket >= 0 ? firstBracket : Infinity,
  );
  if (start !== Infinity) {
    const lastBrace = text.lastIndexOf("}");
    const lastBracket = text.lastIndexOf("]");
    const end = Math.max(lastBrace, lastBracket);
    text = end > start ? text.substring(start, end + 1) : text.substring(start);
  }

  return sanitizeJsonControlChars(text);
}

/**
 * Escapes control characters that appear inside JSON string literals while
 * preserving structural whitespace (\t, \n, \r) outside of strings.
 *
 * LLM CLI tools (Gemini, Claude) sometimes emit raw newlines or tabs inside
 * JSON string values, which is invalid per RFC 8259. JSON.parse rejects these
 * with "Bad control character in string literal".
 */
function sanitizeJsonControlChars(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    // Inside a string literal: escape control chars that JSON forbids as raw bytes
    if (inString && code < 0x20) {
      if (code === 0x09) result += "\\t";
      else if (code === 0x0a) result += "\\n";
      else if (code === 0x0d) result += "\\r";
      // Drop other control chars (NUL, BEL, etc.)
      continue;
    }

    // Outside strings: strip non-whitespace control chars, keep \t \n \r
    if (!inString && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      continue;
    }

    // Strip DEL
    if (code === 0x7f) continue;

    result += ch;
  }

  return result;
}

function hasBalancedJsonDelimiters(text: string): boolean {
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth < 0) return false;
    } else if (ch === "[") bracketDepth++;
    else if (ch === "]") {
      bracketDepth--;
      if (bracketDepth < 0) return false;
    }
  }

  return !inString && braceDepth === 0 && bracketDepth === 0;
}

/**
 * Full repair pipeline for raw LLM CLI output → valid JSON string.
 *
 * 1. Strip markdown fences (```json ... ```)
 * 2. Strip preamble/epilogue text outside the JSON object
 * 3. Escape control characters inside string literals
 * 4. Run jsonrepair to fix trailing commas, single quotes, unquoted keys,
 *    comments, NaN/Infinity, incomplete JSON, etc.
 */
function repairCliJson(raw: string): string {
  return jsonrepair(extractJsonCandidate(raw));
}

/**
 * Cleanup for `completeText()` JSON parsing.
 *
 * This keeps the CLI's tolerance for wrappers / trailing commas, but avoids
 * using `jsonrepair` on obviously truncated payloads where it would silently
 * invent missing braces or other structure.
 */
const normalizeLogger = createLogger("normalizeCliTextForJsonParse");

function normalizeCliTextForJsonParse(raw: string): string {
  const candidate = extractJsonCandidate(raw);
  const trimmed = candidate.trim();
  const endsLikeJson = trimmed.endsWith("}") || trimmed.endsWith("]");
  if (endsLikeJson && hasBalancedJsonDelimiters(trimmed)) {
    return jsonrepair(trimmed);
  }
  normalizeLogger.warn("CLI output appears truncated or non-JSON — skipping jsonrepair", {
    endsLikeJson,
    candidateLength: trimmed.length,
    tail: trimmed.slice(-80),
  });
  return trimmed;
}

/**
 * Extract structured output from Claude CLI JSON envelope.
 *
 * Claude CLI with `--output-format json` + `--json-schema` wraps output in:
 *   {
 *     "type": "result",
 *     "subtype": "success" | "error_max_structured_output_retries",
 *     "result": "<free-text agent response>",
 *     "structured_output": { ... },   // ← validated JSON matching the schema
 *     ...
 *   }
 *
 * The `structured_output` field contains the already-parsed JSON object.
 * The `result` field is the agent's conversational response (irrelevant for schema output).
 *
 * Returns `{ extracted: true, data }` with the parsed object, or `{ extracted: false }`
 * if the stdout is not a recognizable envelope.
 */
function extractClaudeCliStructuredOutput(
  raw: string,
  logger: Logger,
): { extracted: true; data: unknown } | { extracted: false } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { extracted: false };

  try {
    const envelope = JSON.parse(trimmed);
    if (
      envelope &&
      typeof envelope === "object" &&
      "type" in envelope &&
      envelope.type === "result"
    ) {
      logger.debug("Parsed Claude CLI envelope", {
        subtype: envelope.subtype,
        hasStructuredOutput: "structured_output" in envelope,
        resultPreview: typeof envelope.result === "string"
          ? envelope.result.slice(0, 100)
          : undefined,
      });

      if (envelope.subtype === "error_max_structured_output_retries") {
        return { extracted: true, data: null };
      }

      if ("structured_output" in envelope && envelope.structured_output != null) {
        return { extracted: true, data: envelope.structured_output };
      }

      // Envelope present but no structured_output — try parsing the result field
      // (older CLI versions or --json-schema not used)
      if (typeof envelope.result === "string" && envelope.result.trim()) {
        try {
          return { extracted: true, data: JSON.parse(envelope.result) };
        } catch {
          // result field is not JSON — let the generic text parser handle it
          return { extracted: false };
        }
      }

      return { extracted: true, data: null };
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  return { extracted: false };
}

function resolveModel(config: CliScriptWriterConfig): string {
  for (const envVar of config.modelEnvVars) {
    const value = process.env[envVar];
    if (value) return value;
  }
  return config.defaultModel;
}

export class BaseCliScriptWriter implements IScriptWriter {
  private readonly config: CliScriptWriterConfig;
  private readonly model: string;
  private readonly validDurations: readonly number[];
  private readonly logger: Logger;

  constructor(config: CliScriptWriterConfig, validDurations: readonly number[] = [4, 6, 8]) {
    this.config = config;
    this.model = resolveModel(config);
    this.validDurations = validDurations;
    this.logger = createLogger(config.loggerName);

    this.logger.info(`${config.loggerName} initialized`, {
      model: this.model,
      validDurations: [...this.validDurations],
    });
  }

  /** Build CLI args for text-output invocations. */
  private buildTextArgs(): string[] {
    const args: string[] = [];
    if (this.config.subCommand) args.push(this.config.subCommand);
    if (this.config.promptFlag) args.push(this.config.promptFlag);
    args.push(this.config.modelFlag, this.model);
    args.push(...(this.config.textOutputFlags ?? ["--output-format", "text"]));
    args.push(...(this.config.extraFlags ?? []));
    for (const cf of this.config.configFlags ?? []) args.push("-c", cf);
    return args;
  }

  /** Build CLI args for structured JSON output invocations. Returns whether a schema hint should be embedded in the prompt and an optional cleanup function for temp files. */
  private buildJsonArgs(jsonSchema: Record<string, unknown>): { args: string[]; needsSchemaHint: boolean; cleanup?: () => void } {
    const args: string[] = [];
    if (this.config.subCommand) args.push(this.config.subCommand);
    if (this.config.promptFlag) args.push(this.config.promptFlag);
    args.push(this.config.modelFlag, this.model);

    let needsSchemaHint: boolean;
    let cleanup: (() => void) | undefined;
    if (this.config.jsonSchemaFlag) {
      args.push(...(this.config.jsonOutputFlags ?? ["--output-format", "json"]));
      if (this.config.jsonSchemaAsFile) {
        const tmpPath = join(tmpdir(), `prvod-schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(tmpPath, JSON.stringify(jsonSchema));
        args.push(this.config.jsonSchemaFlag, tmpPath);
        cleanup = () => { try { unlinkSync(tmpPath); } catch { /* temp file cleanup is best-effort */ } };
      } else {
        args.push(this.config.jsonSchemaFlag, JSON.stringify(jsonSchema));
      }
      needsSchemaHint = false;
    } else {
      args.push(...(this.config.textOutputFlags ?? ["--output-format", "text"]));
      needsSchemaHint = true;
    }

    args.push(...(this.config.extraFlags ?? []));
    for (const cf of this.config.configFlags ?? []) args.push("-c", cf);
    return { args, needsSchemaHint, cleanup };
  }

  /**
   * Execute the CLI, routing the prompt to either stdin or the last positional
   * arg based on config. Wraps the child-process call in an LLM-level
   * exponential-backoff retry so transient errors from the provider (429,
   * RESOURCE_EXHAUSTED, overloaded, 5xx, network flakes) are retried inside
   * this single call instead of bubbling all the way up and re-running the
   * entire pipeline. After the retry budget is exhausted, the helper throws
   * an `LlmRateLimitedError` which the pipeline treats as non-retryable.
   */
  private execCli(args: string[], prompt: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
    const label = `${this.config.command}.exec`;
    return retryLlmCall(
      () => {
        if (this.config.promptAsArg) {
          return execFileAsync(this.config.command, [...args, prompt], null, env);
        }
        return execFileAsync(this.config.command, args, prompt, env);
      },
      { label },
    );
  }

  /** Returns an ILLMClient that uses this writer's resolved CLI config (model, flags, env). */
  createLlmClient(): ILLMClient {
    return {
      complete: async (system: string, userPrompt: string): Promise<string> => {
        const args = this.buildTextArgs();
        const fullPrompt = `${system}\n\n${userPrompt}`;
        const env = buildEnv(this.config.cleanEnv ?? false);
        const { stdout } = await this.execCli(args, fullPrompt, env);
        return stdout.trim();
      },
    };
  }

  async generateScript(
    context: PRContext,
    analysis: DiffAnalysis,
  ): Promise<ScriptWriterResult> {
    if (isPromptPipelineV2Enabled()) {
      const v2Result = await generateScriptWithPromptPipelineV2({
        model: {
          family: this.config.command === "gemini" ? "gemini" : this.config.command === "codex" ? "codex" : "claude",
          supportsNativeStructuredOutput: Boolean(this.config.jsonSchemaFlag),
          completeText: async (system: string, userPrompt: string, _maxTokens?: number): Promise<string> => {
            const args = this.buildTextArgs();
            const fullPrompt = [system, "", userPrompt].join("\n");
            const env = buildEnv(this.config.cleanEnv ?? false);
            const { stdout } = await this.execCli(args, fullPrompt, env);
            return normalizeCliTextForJsonParse(stdout);
          },
          completeJson: async <S extends ZodTypeAny>(system: string, userPrompt: string, schema: S, options?: CompleteJsonOptions): Promise<ZodInfer<S>> => {
            const schemaName = options?.schemaName ?? "unknown";
            const jsonSchema = this.config.jsonSchemaAsFile
              ? buildOpenAIStructuredOutputJsonSchema(schema)
              : buildStructuredOutputJsonSchema(schema);
            const { args, needsSchemaHint, cleanup } = this.buildJsonArgs(jsonSchema);

            const fullPrompt = needsSchemaHint
              ? [system + buildTextModeSchemaHint(jsonSchema), "", userPrompt].join("\n")
              : [system, "", userPrompt].join("\n");

            const env = buildEnv(this.config.cleanEnv ?? false);
            try {
              const { stdout } = await this.execCli(args, fullPrompt, env);

              // Claude CLI: extract structured_output from JSON envelope
              if (this.config.command === "claude") {
                const envelope = extractClaudeCliStructuredOutput(stdout, this.logger);
                if (envelope.extracted) {
                  if (envelope.data == null) {
                    this.logger.error("Claude CLI returned no structured output", {
                      schemaName,
                      rawPreview: stdout.slice(0, 500),
                    });
                    throw new Error(`CLI structured output for "${schemaName}" failed: model returned no structured output`);
                  }
                  try {
                    return schema.parse(envelope.data);
                  } catch (err) {
                    this.logger.error("Claude CLI structured output schema validation failed", {
                      schemaName,
                      data: JSON.stringify(envelope.data).slice(0, 500),
                      error: err instanceof Error ? err.message : String(err),
                    });
                    throw new Error(`CLI structured output for "${schemaName}" failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                // No envelope detected — fall through to generic text parsing
                this.logger.warn("Claude CLI output missing JSON envelope — falling back to text parsing", {
                  schemaName,
                  rawPreview: stdout.slice(0, 200),
                });
              }

              // Generic path (Gemini CLI, Codex CLI, or Claude CLI without envelope)
              const cleaned = repairCliJson(stdout);
              try {
                return schema.parse(JSON.parse(cleaned));
              } catch (err) {
                this.logger.error("CLI structured output parse/validate failed", {
                  schemaName,
                  command: this.config.command,
                  rawPreview: stdout.slice(0, 500),
                  error: err instanceof Error ? err.message : String(err),
                });
                throw new Error(`CLI structured output for "${schemaName}" failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            } finally {
              cleanup?.();
            }
          },
        },
        context,
        analysis,
        validDurations: this.validDurations,
      });

      if (!isPromptPipelineV2CompareV1Enabled()) {
        return v2Result;
      }

      try {
        const legacyResult = await this.generateLegacyScript(context, analysis);
        return attachPromptPipelineRolloutComparison(v2Result, legacyResult);
      } catch (err) {
        this.logger.warn("Prompt Pipeline V2 shadow comparison against v1 failed", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return v2Result;
      }
    }

    return this.generateLegacyScript(context, analysis);
  }

  private async generateLegacyScript(
    context: PRContext,
    analysis: DiffAnalysis,
  ): Promise<ScriptWriterResult> {
    const { command } = this.config;

    this.logger.info(`Generating video script via ${command} CLI`, {
      repo: context.repoFullName,
      pr: context.prNumber,
      changeType: analysis.suggestedChangeType,
    });

    const systemPrompt = buildSystemPrompt(this.validDurations, context.durationMode, undefined, context.deepdive);
    const jsonHint = buildJsonShapeHint(this.validDurations, context.durationMode);
    const userPrompt = buildUserPrompt(
      context,
      analysis,
      this.validDurations,
      context.durationMode,
    );
    const fullPrompt = [systemPrompt, "", jsonHint, "", userPrompt].join("\n");
    this.logger.debug("Built CLI prompt", { promptLength: fullPrompt.length });

    const args = this.buildTextArgs();
    this.logger.debug(`Executing ${command} CLI`, { args });

    const env = buildEnv(this.config.cleanEnv ?? false);
    const { stdout } = await this.execCli(args, fullPrompt, env);
    this.logger.debug("Received CLI response", { stdoutLength: stdout.length });

    let parsed: unknown;
    try {
      parsed = JSON.parse(repairCliJson(stdout));
    } catch (parseErr) {
      this.logger.error("Failed to parse CLI output as JSON", {
        rawOutput: stdout.slice(0, 500),
        parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      throw new Error(`${command} CLI returned invalid JSON: ${stdout.slice(0, 200)}`);
    }

    let script: ZodInfer<typeof videoScriptSchema>;
    try {
      script = videoScriptSchema.parse(parsed);
    } catch (err) {
      this.logger.error("Script validation failed — CLI returned invalid structure", {
        zodError: err instanceof Error ? err.message : String(err),
        rawInput: JSON.stringify(parsed).slice(0, 2000),
      });
      throw err;
    }

    try {
      warnOnScriptDefaults(parsed, script, this.validDurations, this.logger);
    } catch (warnErr) {
      this.logger.warn("warnOnScriptDefaults threw unexpectedly — skipping default detection", {
        error: warnErr instanceof Error ? warnErr.message : String(warnErr),
      });
    }

    let totalInputTokens = Math.ceil(fullPrompt.length / 4);
    let totalOutputTokens = Math.ceil(stdout.length / 4);

    const retryUpperDurationGuard = async (
      mode: string,
      guard: DurationGuard,
      invalidJsonMessage: string,
      invalidScriptMessage: string,
      executionFailureMessage: string,
    ): Promise<void> => {
      if (script.totalDurationSeconds <= guard.guardCapSeconds) {
        return;
      }

      this.logger.warn(`${mode}-mode script exceeds duration guard, retrying once`, {
        totalDurationSeconds: script.totalDurationSeconds,
        requestedSeconds: guard.requestedSeconds,
        guardCapSeconds: guard.guardCapSeconds,
        coefficient: guard.coefficient,
      });

      let retrySucceeded = false;
      try {
        const retryResult = await this.execCli(args, fullPrompt, env);
        totalInputTokens += Math.ceil(fullPrompt.length / 4);
        totalOutputTokens += Math.ceil(retryResult.stdout.length / 4);

        let retryParsed: unknown;
        try {
          retryParsed = JSON.parse(repairCliJson(retryResult.stdout));
        } catch (jsonErr) {
          this.logger.warn(invalidJsonMessage, {
            error: jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
          });
          retryParsed = null;
        }

        if (retryParsed !== null) {
          try {
            const retryScript = videoScriptSchema.parse(retryParsed);
            if (retryScript.totalDurationSeconds <= guard.guardCapSeconds) {
              this.logger.info(`${mode}-mode retry produced script within duration guard`, {
                totalDurationSeconds: retryScript.totalDurationSeconds,
                requestedSeconds: guard.requestedSeconds,
                guardCapSeconds: guard.guardCapSeconds,
                coefficient: guard.coefficient,
              });
              script = retryScript;
              retrySucceeded = true;
            } else {
              const originalDurationSeconds = script.totalDurationSeconds;
              const kept = retryScript.totalDurationSeconds < script.totalDurationSeconds ? "retry" : "original";
              if (kept === "retry") script = retryScript;
              this.logger.warn(`${mode}-mode retry still exceeds duration guard, keeping ${kept} (shorter)`, {
                retryDurationSeconds: retryScript.totalDurationSeconds,
                originalDurationSeconds,
                requestedSeconds: guard.requestedSeconds,
                guardCapSeconds: guard.guardCapSeconds,
                coefficient: guard.coefficient,
                kept,
              });
            }
          } catch (zodErr) {
            this.logger.warn(invalidScriptMessage, {
              error: zodErr instanceof Error ? zodErr.message : String(zodErr),
            });
          }
        }
      } catch (retryErr) {
        this.logger.warn(executionFailureMessage, {
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }

      if (!retrySucceeded && script.totalDurationSeconds > guard.guardCapSeconds) {
        throw new Error(formatDurationGuardExceededError(mode, guard, script.totalDurationSeconds));
      }
    };

    if (!context.durationMode || context.durationMode === "default") {
      await retryUpperDurationGuard(
        "default",
        buildDurationGuard(DEFAULT_MODE_MAX_DURATION),
        "Default-mode retry returned invalid JSON",
        "Default-mode retry failed schema validation",
        "Default-mode retry CLI execution failed",
      );
    }

    if (context.durationMode === "short") {
      await retryUpperDurationGuard(
        "short",
        buildDurationGuard(60),
        "Short-mode retry returned invalid JSON, keeping original script",
        "Short-mode retry failed schema validation, keeping original script",
        "Short-mode retry CLI execution failed, keeping original script",
      );
    }

    // Soft enforcement: retry once if popcorn-mode script is too short
    if (context.durationMode === "popcorn" && script.totalDurationSeconds < POPCORN_MODE_MIN_DURATION) {
      this.logger.warn("Popcorn-mode script is too short, retrying once", {
        totalDurationSeconds: script.totalDurationSeconds,
        target: POPCORN_MODE_MIN_DURATION,
      });

      try {
        const retryResult = await this.execCli(args, fullPrompt, env);
        totalInputTokens += Math.ceil(fullPrompt.length / 4);
        totalOutputTokens += Math.ceil(retryResult.stdout.length / 4);

        let retryParsed: unknown;
        try {
          retryParsed = JSON.parse(repairCliJson(retryResult.stdout));
        } catch (jsonErr) {
          this.logger.warn("Popcorn-mode retry returned invalid JSON, keeping original script", {
            error: jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
          });
          retryParsed = null;
        }

        if (retryParsed !== null) {
          try {
            const retryScript = videoScriptSchema.parse(retryParsed);
            if (retryScript.totalDurationSeconds >= POPCORN_MODE_MIN_DURATION) {
              this.logger.info("Popcorn-mode retry produced script meeting duration target", {
                totalDurationSeconds: retryScript.totalDurationSeconds,
                target: POPCORN_MODE_MIN_DURATION,
              });
              script = retryScript;
            } else {
              // Both attempts too short — keep whichever is longer as best-effort
              const originalDurationSeconds = script.totalDurationSeconds;
              const kept = retryScript.totalDurationSeconds > script.totalDurationSeconds ? "retry" : "original";
              if (kept === "retry") script = retryScript;
              this.logger.warn(`Popcorn-mode retry still too short, keeping ${kept} (longer)`, {
                retryDurationSeconds: retryScript.totalDurationSeconds,
                originalDurationSeconds,
                target: POPCORN_MODE_MIN_DURATION,
                kept,
              });
            }
          } catch (zodErr) {
            this.logger.warn("Popcorn-mode retry failed schema validation, keeping original script", {
              error: zodErr instanceof Error ? zodErr.message : String(zodErr),
            });
          }
        }
      } catch (retryErr) {
        this.logger.warn("Popcorn-mode retry CLI execution failed, keeping original script", {
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }
    }

    if (context.durationMode === "popcorn") {
      await retryUpperDurationGuard(
        "popcorn",
        buildDurationGuard(MAX_VIDEO_DURATION_SECONDS),
        "Popcorn-mode max retry returned invalid JSON",
        "Popcorn-mode max retry failed schema validation",
        "Popcorn-mode max retry CLI execution failed",
      );
    }

    if (context.deepdive) {
      // Enforce reviewer narration rules only for explicit reviewer-mode runs.
      enforceReviewerNarration(script, this.logger, isReviewerViolationWarnOnly);
    }

    // Force last scene to overview for constellation graph overlay.
    script = ensureLastSceneOverview(script);

    this.logger.info(`Video script generated successfully via ${command} CLI`, {
      scenes: script.scenes.length,
      duration: script.totalDurationSeconds,
      words: script.totalWordCount,
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
    const { command } = this.config;
    const systemPrompt = buildNarrationRetimeSystemPrompt();
    const jsonHint = buildNarrationRetimeJsonShapeHint();
    const userPrompt = buildNarrationRetimeUserPrompt(
      context,
      analysis,
      script,
      sceneBudgets,
      targetSceneNumbers,
    );
    const fullPrompt = [systemPrompt, "", jsonHint, "", userPrompt].join("\n");

    const args = this.buildTextArgs();

    const env = buildEnv(this.config.cleanEnv ?? false);
    const { stdout } = await this.execCli(args, fullPrompt, env);

    let parsed: unknown;
    try {
      parsed = JSON.parse(repairCliJson(stdout));
    } catch (parseErr) {
      this.logger.error("Failed to parse CLI narration retime JSON", {
        rawOutput: stdout.slice(0, 500),
        parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      throw new Error(`${command} CLI returned invalid narration retime JSON: ${stdout.slice(0, 200)}`);
    }

    let result;
    try {
      result = narrationRetimeSchema.parse(parsed);
    } catch (err) {
      this.logger.error("Narration retime validation failed — CLI returned invalid structure", {
        zodError: err instanceof Error ? err.message : String(err),
        rawInput: JSON.stringify(parsed).slice(0, 2000),
      });
      throw err;
    }
    return {
      scenes: result.scenes,
      usage: {
        inputTokens: Math.ceil(fullPrompt.length / 4),
        outputTokens: Math.ceil(stdout.length / 4),
      },
    };
  }
}

// Exported for testing
export { extractClaudeCliStructuredOutput as _extractClaudeCliStructuredOutput };
