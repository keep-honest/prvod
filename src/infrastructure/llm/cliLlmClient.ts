import { execFile, spawn } from "node:child_process";
import type { ILLMClient } from "@/interfaces/ILLMClient";
import { retryLlmCall } from "@/infrastructure/llm/retryLlmCall";

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

/**
 * Executes a CLI command with stdin input, returning stdout.
 *
 * Uses manual stdin.write + stdin.end instead of the `input` option
 * because promisify(execFile) silently drops the `input` option
 * (only supported by execFileSync/execSync).
 */
function execCliWithStdin(
  command: string,
  args: string[],
  input: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const timeoutMs = cliTimeoutMs(command);
  if (input === null) {
    return execCliNoStdin(command, args, env, timeoutMs);
  }

  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        maxBuffer: CLI_MAX_BUFFER_BYTES,
        env,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      },
      (error, stdout, stderr) => {
        if (error) {
          const signal = (error as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null }).signal ?? null;
          const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true &&
            signal === "SIGTERM";
          const timeoutMessage = `${command} CLI timed out after ${timeoutMs}ms`;
          const diagnostic = timedOut
            ? `${stderr ? `${stderr}\n` : ""}${timeoutMessage}`
            : stderr || error.message;
          reject(
            new Error(
              `${command} CLI failed (exit ${error.code ?? "unknown"}` +
              `${signal ? `, signal ${signal}` : ""}): ${diagnostic}`,
            ),
          );
          return;
        }
        resolve(String(stdout));
      },
    );
    if (!child.stdin) {
      reject(new Error(`${command} CLI spawned without stdin pipe — cannot send prompt`));
      return;
    }
    child.stdin.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
        reject(new Error(`${command} CLI stdin write failed: ${err.message}`));
      }
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function execCliNoStdin(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = cliTimeoutMs(command),
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
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
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const timeoutMessage = `${command} CLI timed out after ${timeoutMs}ms`;
      child.kill("SIGTERM");
      rejectOnce(
        new Error(
          `${command} CLI failed (exit timeout, signal SIGTERM): ` +
          `${stderr ? `${stderr}\n` : ""}${timeoutMessage}`,
        ),
      );
    }, timeoutMs);

    const capture = (chunks: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > CLI_MAX_BUFFER_BYTES) {
        child.kill();
        rejectOnce(new Error(`${command} CLI output exceeded ${CLI_MAX_BUFFER_BYTES} bytes`));
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
        const exit = code ?? "unknown";
        const fallback = signal
          ? `${command} exited with signal ${signal}`
          : `${command} exited with code ${code}`;
        reject(new Error(`${command} CLI failed (exit ${exit}): ${stderr || fallback}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export interface CliClientConfig {
  command: string;
  label: string;
  resolveModel: () => string;
  buildArgs: (model: string, prompt: string) => string[];
  /** Content piped to stdin. Return null if prompt is passed as an arg and stdin should be ignored. */
  stdinInput: (prompt: string) => string | null;
  env?: () => NodeJS.ProcessEnv;
}

export function createCliLlmClient(config: CliClientConfig): ILLMClient {
  return {
    complete: async (system, userPrompt) => {
      const prompt = `${system}\n\n${userPrompt}`;
      const model = config.resolveModel();
      const args = config.buildArgs(model, prompt);
      const env = config.env?.();
      const stdout = await retryLlmCall(
        () => execCliWithStdin(config.command, args, config.stdinInput(prompt), env),
        { label: config.label },
      );
      return stdout.trim();
    },
  };
}

export function createClaudeCliLlmClient(): ILLMClient {
  return createCliLlmClient({
    command: "claude",
    label: "claude.cli.complete",
    resolveModel: () => process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514",
    buildArgs: (model) => ["-p", "--model", model, "--output-format", "text"],
    stdinInput: (prompt) => prompt,
    env: () => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      return env;
    },
  });
}

export function createGeminiCliLlmClient(): ILLMClient {
  return createCliLlmClient({
    command: "gemini",
    label: "gemini.cli.complete",
    resolveModel: () => process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    buildArgs: (model) => ["-m", model, "--output-format", "text"],
    stdinInput: (prompt) => prompt,
  });
}

export function createCodexCliLlmClient(): ILLMClient {
  const reasoningEffort = () => process.env.CODEX_REASONING_EFFORT ?? "medium";
  return createCliLlmClient({
    command: "codex",
    label: "codex.cli.complete",
    resolveModel: () => process.env.CODEX_MODEL ?? process.env.CODEX_CLI_MODEL ?? "o4-mini",
    buildArgs: (model, prompt) => [
      "exec",
      "--sandbox", "read-only",
      "-c", `model_reasoning_effort="${reasoningEffort()}"`,
      "-c", `model="${model}"`,
      "--model", model,
      prompt,
    ],
    stdinInput: () => null,
  });
}

// Exported for testing
export { execCliWithStdin as _execCliWithStdin };
