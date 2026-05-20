import type {
  IOutputValidator,
  SanitizationResult,
  SanitizeOptions,
  JobContext,
} from "@/interfaces/IPromptInjectionGuard";

export class MockOutputValidator implements IOutputValidator {
  validate(narration: string, _options?: SanitizeOptions): SanitizationResult {
    return {
      content: narration,
      injectionDetected: false,
      detections: [],
      contentHash: "mock-hash",
    };
  }

  checkCanary(_output: string, _canaryToken: string, _jobContext?: JobContext): boolean {
    return false;
  }
}
