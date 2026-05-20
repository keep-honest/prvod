import { BaseCliScriptWriter } from "@/infrastructure/llm/BaseCliScriptWriter";

const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_MODEL = "o4-mini";

/** Resolve the Codex model from env vars in priority order, falling back to the default. */
function resolveCodexModel(): string {
  return process.env.CODEX_MODEL ?? process.env.CODEX_CLI_MODEL ?? DEFAULT_MODEL;
}

export class CodexCliScriptWriter extends BaseCliScriptWriter {
  constructor(validDurations: readonly number[] = [4, 6, 8]) {
    const reasoningEffort = process.env.CODEX_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT;
    const model = resolveCodexModel();
    super(
      {
        command: "codex",
        subCommand: "exec",
        defaultModel: DEFAULT_MODEL,
        modelEnvVars: ["CODEX_MODEL", "CODEX_CLI_MODEL"],
        modelFlag: "--model",
        loggerName: "CodexCliScriptWriter",
        extraFlags: ["--full-auto"],
        textOutputFlags: [],
        jsonOutputFlags: [],
        jsonSchemaFlag: "--output-schema",
        jsonSchemaAsFile: true,
        promptAsArg: true,
        // Belt-and-suspenders: pass the model BOTH as `--model` (handled by the
        // base class) AND as `-c model="<value>"`. The `-c` override is the
        // hardest guarantee against config.toml defaults and profile fallbacks.
        // Without it we have seen Codex CLI silently fall back to `gpt-5-mini`
        // (its built-in default for ChatGPT accounts) in some invocations,
        // even though `--model` was supplied.
        configFlags: [
          `model="${model}"`,
          `model_reasoning_effort="${reasoningEffort}"`,
        ],
      },
      validDurations,
    );
  }
}
