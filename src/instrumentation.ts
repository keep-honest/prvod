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
}
