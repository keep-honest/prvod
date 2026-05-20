import { createLogger } from "@/lib/logger";

const logger = createLogger("remotionRendererConfig");

export const DEFAULT_REMOTION_RENDERER_PORT = 3300;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Default upper bound for a single Remotion render section (bundle + select +
 * renderMedia + readFile). Bounds the wedged-browser failure mode: without a
 * deadline, a single hang would queue every subsequent render forever because
 * the lock's `release()` is only reachable through `finally` and never fires
 * while `fn()` is suspended. 10 minutes is a generous ceiling for legitimately
 * long renders. Override via env REMOTION_RENDER_TIMEOUT_MS.
 */
export const DEFAULT_REMOTION_RENDER_TIMEOUT_MS = 10 * 60 * 1000;

interface WarnLogger {
  warn: (message: string, extra?: Record<string, unknown>) => void;
}

export function resolveRemotionRendererPort(
  rawValue = process.env.REMOTION_RENDERER_PORT,
  warnLogger: WarnLogger = logger,
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_REMOTION_RENDERER_PORT;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    warnLogger.warn("Invalid REMOTION_RENDERER_PORT; using default", {
      value: rawValue,
      defaultPort: DEFAULT_REMOTION_RENDERER_PORT,
      validRange: `${MIN_PORT}-${MAX_PORT}`,
    });
    return DEFAULT_REMOTION_RENDERER_PORT;
  }

  return parsed;
}

export function resolveRemotionRenderTimeoutMs(
  rawValue = process.env.REMOTION_RENDER_TIMEOUT_MS,
  warnLogger: WarnLogger = logger,
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_REMOTION_RENDER_TIMEOUT_MS;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warnLogger.warn("Invalid REMOTION_RENDER_TIMEOUT_MS; using default", {
      value: rawValue,
      defaultMs: DEFAULT_REMOTION_RENDER_TIMEOUT_MS,
    });
    return DEFAULT_REMOTION_RENDER_TIMEOUT_MS;
  }
  return parsed;
}

export class RemotionRenderTimeoutError extends Error {
  readonly code = "REMOTION_RENDER_TIMEOUT";
  readonly timeoutMs: number;
  readonly heldMs: number;

  constructor(timeoutMs: number, heldMs: number) {
    super(
      `Remotion render section exceeded ${timeoutMs}ms (held for ${heldMs}ms). ` +
        `The wedged browser still owns the renderer port; subsequent renders may ` +
        `fail with EADDRINUSE until the container restarts.`,
    );
    this.name = "RemotionRenderTimeoutError";
    this.timeoutMs = timeoutMs;
    this.heldMs = heldMs;
  }
}

let remotionRendererLock: Promise<void> = Promise.resolve();

export async function withRemotionRendererLock<T>(
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? resolveRemotionRenderTimeoutMs();
  let release: () => void = () => {};
  const previous = remotionRendererLock;
  remotionRendererLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  const acquiredAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const heldMs = Date.now() - acquiredAt;
        logger.error("Remotion render section timed out", { timeoutMs, heldMs });
        reject(new RemotionRenderTimeoutError(timeoutMs, heldMs));
      }, timeoutMs);
    });
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}
