type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVEL_PRIORITY) return envLevel as LogLevel;
  if (envLevel) {
    const fallback = process.env.NODE_ENV === "production" ? "info" : "debug";
    console.warn(
      `[logger] Invalid LOG_LEVEL="${process.env.LOG_LEVEL}". ` +
      `Valid: ${Object.keys(LOG_LEVEL_PRIORITY).join(", ")}. Using "${fallback}".`,
    );
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const activeLogLevel = resolveLogLevel();
const activeLogPriority = LOG_LEVEL_PRIORITY[activeLogLevel];

interface LogEntry {
  level: LogLevel;
  message: string;
  requestId?: string;
  [key: string]: unknown;
}

function log(entry: LogEntry): void {
  if (LOG_LEVEL_PRIORITY[entry.level] < activeLogPriority) return;

  const timestamp = new Date().toISOString();
  const output = { timestamp, ...entry };

  switch (entry.level) {
    case "error":
      console.error(JSON.stringify(output));
      break;
    case "warn":
      console.warn(JSON.stringify(output));
      break;
    case "debug":
      console.debug(JSON.stringify(output));
      break;
    default:
      console.log(JSON.stringify(output));
  }
}

export function createLogger(
  requestId?: string,
  baseContext: Record<string, unknown> = {},
) {
  const withId = (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ) => log({ level, message, requestId, ...baseContext, ...extra });

  return {
    debug: (msg: string, extra?: Record<string, unknown>) =>
      withId("debug", msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) =>
      withId("info", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      withId("warn", msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) =>
      withId("error", msg, extra),
  };
}
