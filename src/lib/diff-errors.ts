/** Error taxonomy for the diff-pagination pipeline (spec 005). */

export class DiffTooLargeError extends Error {
  readonly errorTag = "DIFF_TOO_LARGE" as const;

  constructor(
    readonly capLines: number,
    readonly observedLines: number,
    readonly segmentIndex: number,
  ) {
    super(
      `Diff exceeded hard cap of ${capLines} lines ` +
        `(observed ${observedLines} after segment ${segmentIndex}). ` +
        `See spec 005-diff-pagination-custom-diff FR-004.`,
    );
    this.name = "DiffTooLargeError";
  }
}

export class DiffFetchTimeoutError extends Error {
  readonly errorTag = "DIFF_FETCH_TIMEOUT" as const;

  constructor(
    readonly stage: "fetch" | "chunk_summarise" | "overall",
    options?: { cause?: Error; segmentIndex?: number },
  ) {
    const segMsg = options?.segmentIndex !== undefined ? ` (segment ${options.segmentIndex})` : "";
    const causeMsg = options?.cause ? ` — ${options.cause.message}` : "";
    super(`Diff ingest failed during stage: ${stage}${segMsg}${causeMsg}`, { cause: options?.cause });
    this.name = "DiffFetchTimeoutError";
  }
}

export class DiffParseError extends Error {
  readonly errorTag = "DIFF_PARSE_ERROR" as const;

  constructor(
    readonly lineNumber: number,
    readonly reason: string,
  ) {
    super(`Failed to parse diff at line ${lineNumber}: ${reason}`);
    this.name = "DiffParseError";
  }
}
