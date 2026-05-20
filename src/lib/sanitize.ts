/** Strip likely GitHub tokens/secrets from error text and truncate. */
export function sanitizeErrorBody(text: string, maxLen = 200): string {
  return text
    .replace(/gh[psuo]_[a-zA-Z0-9]+/g, "[REDACTED]")
    .replace(/github_pat_[a-zA-Z0-9_]+/g, "[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]")
    .slice(0, maxLen);
}
