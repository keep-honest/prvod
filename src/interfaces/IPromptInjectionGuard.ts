/** Result of sanitizing a single content string. */
export interface SanitizationResult {
  /** Cleaned content safe for downstream use. */
  content: string;
  /** Whether any injection pattern was found. */
  injectionDetected: boolean;
  /** All pattern matches found during sanitization. */
  detections: DetectionDetail[];
  /** SHA-256 hash of original input for audit trail. */
  contentHash: string;
}

/** A single pattern match found during content analysis. */
export interface DetectionDetail {
  field:
    | "prTitle"
    | "prDescription"
    | "diff"
    | "issueTitle"
    | "issueBody"
    | "milestoneTitle"
    | "milestoneDescription";
  /** Pattern identifier, e.g. "instruction_override", "role_hijack". */
  patternId: string;
  category: "injection" | "sensitive_data";
  action: "sanitized" | "redacted";
  position: { start: number; end: number };
}

/** Structured event emitted when injection activity is detected. */
export interface InjectionEvent {
  timestamp: string;
  jobId: string;
  /** PR identifier in "owner/repo#number" format. */
  prIdentifier: string;
  installationId: number;
  /** Fields where detections occurred. */
  fields: string[];
  detections: DetectionDetail[];
  layer:
    | "input_sanitization"
    | "output_validation"
    | "canary_detection";
  severity: "low" | "medium" | "high";
}

/** Job metadata threaded to sanitizer/validator for audit log enrichment. */
export interface JobContext {
  jobId: string;
  /** PR identifier in "owner/repo#number" format. */
  prIdentifier: string;
  installationId: number;
}

/** Content strictness level based on content type. */
export type ContentContext = "strict" | "permissive" | "code";

/** Optional configuration for sanitize/validate calls. */
export interface SanitizeOptions {
  /** Strictness: "strict" for titles, "permissive" for descriptions, "code" for diffs/issue bodies. */
  contentContext?: ContentContext;
  /** Job metadata for structured audit logging. */
  jobContext?: JobContext;
  /** Field being validated — used for accurate audit log attribution. */
  outputField?: string;
}

/** Strips or neutralises injection patterns from untrusted PR input. */
export interface IInputSanitizer {
  /** Sanitize a single field value, returning cleaned content and detection metadata. */
  sanitize(
    content: string,
    field: DetectionDetail["field"],
    options?: SanitizeOptions,
  ): SanitizationResult;
}

/** Validates LLM-generated output for leaked instructions or canary tokens. */
export interface IOutputValidator {
  /** Check narration text for injection artifacts that survived the pipeline. */
  validate(narration: string, options?: SanitizeOptions): SanitizationResult;
  /** Return true if the canary token appears in the output (indicating prompt leakage). */
  checkCanary(output: string, canaryToken: string, jobContext?: JobContext): boolean;
}
