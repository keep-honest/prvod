import { BaseCliScriptWriter } from "@/infrastructure/llm/BaseCliScriptWriter";

export class GeminiCliScriptWriter extends BaseCliScriptWriter {
  constructor(validDurations: readonly number[] = [4, 6, 8]) {
    super(
      {
        command: "gemini",
        defaultModel: "gemini-2.5-flash",
        modelEnvVars: ["GEMINI_MODEL", "GEMINI_CLI_MODEL"],
        modelFlag: "-m",
        loggerName: "GeminiCliScriptWriter",
      },
      validDurations,
    );
  }
}
