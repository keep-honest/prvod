import { createLogger } from "@/lib/logger";

const logger = createLogger("durationGuard");
const warnedFallbackKeys = new Set<string>();

export const SCRIPT_DURATION_GUARD_COEFFICIENT_ENV = "SCRIPT_DURATION_GUARD_COEFFICIENT";
export const DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT = 1.4;

interface WarnLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface DurationGuard {
  requestedSeconds: number;
  coefficient: number;
  guardCapSeconds: number;
}

function isValidCoefficient(value: number): boolean {
  return Number.isFinite(value) && value >= 1;
}

function warnFallback(
  warnLogger: WarnLogger,
  message: string,
  meta: Record<string, unknown>,
): void {
  if (warnLogger !== logger) {
    warnLogger.warn(message, meta);
    return;
  }

  const key = `${message}:${String(meta.value ?? "")}`;
  if (warnedFallbackKeys.has(key)) {
    return;
  }
  warnedFallbackKeys.add(key);
  warnLogger.warn(message, meta);
}

export function parseScriptDurationGuardCoefficient(
  raw = process.env[SCRIPT_DURATION_GUARD_COEFFICIENT_ENV],
  warnLogger: WarnLogger = logger,
): number {
  const trimmed = raw?.trim();
  if (trimmed == null || trimmed.length === 0) {
    warnFallback(warnLogger, "Missing script duration guard coefficient; using default", {
      envVar: SCRIPT_DURATION_GUARD_COEFFICIENT_ENV,
      defaultValue: DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT,
    });
    return DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT;
  }

  const parsed = Number(trimmed);
  if (isValidCoefficient(parsed)) {
    return parsed;
  }

  warnFallback(warnLogger, "Invalid script duration guard coefficient; using default", {
    envVar: SCRIPT_DURATION_GUARD_COEFFICIENT_ENV,
    value: raw ?? null,
    defaultValue: DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT,
  });
  return DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT;
}

export function buildDurationGuard(
  requestedSeconds: number,
  coefficient = parseScriptDurationGuardCoefficient(),
): DurationGuard {
  return {
    requestedSeconds,
    coefficient,
    guardCapSeconds: Math.ceil(requestedSeconds * coefficient),
  };
}

export function formatDurationGuardExceededError(
  mode: string,
  guard: DurationGuard,
  actualSeconds: number,
): string {
  return [
    `${mode}-mode script exceeds duration guard after retry`,
    `(requested=${guard.requestedSeconds}s,`,
    `coefficient=${guard.coefficient},`,
    `guardCap=${guard.guardCapSeconds}s,`,
    `actual=${actualSeconds}s)`,
  ].join(" ");
}
