import type {
  DetectionDetail,
  IInputSanitizer,
  SanitizationResult,
  SanitizeOptions,
} from "@/interfaces/IPromptInjectionGuard";

export class MockInputSanitizer implements IInputSanitizer {
  sanitize(content: string, _field: DetectionDetail["field"], _options?: SanitizeOptions): SanitizationResult {
    return {
      content,
      injectionDetected: false,
      detections: [],
      contentHash: "mock-hash",
    };
  }
}
