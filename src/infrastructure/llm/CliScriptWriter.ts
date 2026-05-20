import { BaseCliScriptWriter } from "@/infrastructure/llm/BaseCliScriptWriter";

export class CliScriptWriter extends BaseCliScriptWriter {
  constructor(validDurations: readonly number[] = [4, 6, 8]) {
    super(
      {
        command: "claude",
        defaultModel: "claude-sonnet-4-20250514",
        modelEnvVars: ["CLAUDE_MODEL", "CLAUDE_CLI_MODEL"],
        modelFlag: "--model",
        loggerName: "CliScriptWriter",
        cleanEnv: true,
        promptFlag: "-p",
        jsonSchemaFlag: "--json-schema",
      },
      validDurations,
    );
  }
}
