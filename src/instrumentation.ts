/**
 * Next.js instrumentation hook — runs once when the server worker starts.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Fails fast on misconfiguration so the server exits immediately (instead of
 * silently accepting requests that will all fail) when required env vars are
 * missing or invalid.
 */
import { assertRuntimeMockConfigurationAllowed } from "@/config/runtimeMocks";

export async function register() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.NEXT_RUNTIME !== "nodejs"
  ) {
    return;
  }

  try {
    assertRuntimeMockConfigurationAllowed(process.env);
  } catch (error) {
    console.error(
      "[startup] Invalid mock provider configuration — server will not start:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }

  if (process.env.USE_MOCK_SERVICES === "true") {
    console.log("[startup] USE_MOCK_SERVICES=true — skipping database validation");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "[startup] DATABASE_URL is not set — server will not start",
    );
    process.exit(1);
  }

  try {
    const { hostname: host, port: portStr } = new URL(databaseUrl);
    const port = parseInt(portStr, 10) || 5432;

    // Dynamic import keeps `net` out of webpack's static import graph so it
    // is not bundled. Node.js resolves it at runtime from the built-in list.
    const net = await import("net");

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", (err) => { socket.destroy(); reject(err); });
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error(`TCP connection to ${host}:${port} timed out`));
      });
    });

    console.log("[startup] Database reachable");
  } catch (error) {
    console.error(
      "[startup] Database unreachable — server will not start",
      error,
    );
    process.exit(1);
  }

  // Prefetch Chrome Headless Shell so the first render does not block on a
  // ~110 MB download. Gated on the active compositor — the ffmpeg path never
  // touches a browser. Failure is non-fatal because the renderer's lazy
  // download covers transient network blips. Non-transient classes (missing
  // package, EACCES/EROFS, ENOSPC) will recur at render time as user-facing
  // failures — we log enough context here so an operator triaging from logs
  // can tell network failure from disk-full from configuration drift.
  if (process.env.VIDEO_COMPOSITOR === "remotion") {
    const startedAt = Date.now();
    try {
      // @remotion/renderer pulls Node-only transitive deps (child_process via
      // execa/cross-spawn). Keep this as a runtime Node import so Next's
      // instrumentation bundle does not try to resolve those deps for webpack.
      const { ensureBrowser } = await import(
        /* webpackIgnore: true */ "@remotion/renderer"
      );
      await ensureBrowser();
      console.log("[startup] chrome-headless-shell ready", {
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        cause?: { message?: string };
      };
      console.warn(
        "[startup] ensureBrowser failed — first render will pay the download cost:",
        {
          durationMs: Date.now() - startedAt,
          code: err?.code,
          name: err?.name,
          message: err?.message,
          cause: err?.cause?.message,
        },
      );
    }
  }
}
