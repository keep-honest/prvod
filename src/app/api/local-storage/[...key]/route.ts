import { NextRequest, NextResponse } from "next/server";
import { extname } from "node:path";
import { createLogger } from "@/lib/logger";
import {
  LocalStorageNotFoundError,
  LocalStoragePathEscapeError,
  LocalStorageService,
} from "@/infrastructure/storage/LocalStorageService";
import {
  readStorageUrlSecret,
  verifyLocalUrl,
} from "@/lib/storage/signLocalUrl";
import { parseRange } from "@/lib/storage/parseRange";
import { openStreamWithErrorHandler } from "@/lib/storage/openStreamWithErrorHandler";

const logger = createLogger("api/local-storage");

const ALLOWED_PREFIX = "videos/";

/**
 * Lazily-constructed singleton. The service constructor calls
 * `realpathSync` and emits an INFO log; doing that per request would
 * pollute the log + waste sync I/O on every Range chunk. Cache key is
 * `LOCAL_STORAGE_DIR` so tests changing the env between cases get a
 * fresh instance automatically.
 */
let cachedService: LocalStorageService | null = null;
let cachedDir: string | undefined;
function getLocalStorageService(): LocalStorageService {
  const currentDir = process.env.LOCAL_STORAGE_DIR;
  if (cachedService === null || cachedDir !== currentDir) {
    cachedService = new LocalStorageService();
    cachedDir = currentDir;
  }
  return cachedService;
}

/** Content-Type allowlist. Unknown extensions get application/octet-stream. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/**
 * Refuses requests unless the deployment is running against local
 * storage. The route is included in every build but must never serve a
 * single byte in prod.
 */
function isLocalStorageActive(): boolean {
  return (
    process.env.USE_LOCAL_STORAGE === "true" ||
    process.env.STORAGE_PROVIDER === "local"
  );
}

/**
 * Cheap pre-decode traversal guard: reject before the framework's
 * automatic decode runs. We assume Next has already decoded
 * percent-escapes in params.key, but a malicious caller could submit
 * raw URL bytes via fetch — guard both forms.
 */
function isKeyHostile(key: string): boolean {
  if (key.length === 0) return true;
  if (key.includes("\0")) return true;
  // After Next.js decode, traversal segments appear literally as `..`.
  // Reject any segment that is exactly `..` (or `.`) to be safe.
  for (const seg of key.split("/")) {
    if (seg === ".." || seg === ".") return true;
  }
  return false;
}

function contentTypeFor(absolutePath: string): string {
  const ext = extname(absolutePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Accept-Ranges": "bytes",
};

/** Identical 401 response for every signature/expiry failure so the
 * route doesn't leak "wrong sig vs expired vs missing" via headers. */
function unauthorized(): NextResponse {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
  });
}

function notFound(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
  });
}

export async function GET(
  request: NextRequest,
  routeContext: { params: Promise<{ key: string[] }> },
): Promise<NextResponse> {
  if (!isLocalStorageActive()) {
    // 404 (not 403) so the route's existence isn't confirmed in prod.
    return notFound();
  }

  const { key: keySegments } = await routeContext.params;
  const key = Array.isArray(keySegments) ? keySegments.join("/") : "";

  // Signature verify BEFORE any filesystem touch. The route is
  // public-by-network so the HMAC is the only gate.
  let secret: string;
  try {
    secret = readStorageUrlSecret();
  } catch {
    // Misconfiguration: the gate said local-storage is active but the
    // secret is unset. 500 is more honest than 401 here — operator
    // needs to fix env, not the URL.
    logger.error("STORAGE_URL_SECRET unset but local storage is active");
    return new NextResponse("Server misconfigured", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const exp = request.nextUrl.searchParams.get("exp");
  const sig = request.nextUrl.searchParams.get("sig");
  const verified = verifyLocalUrl(key, exp, sig, secret);
  if (!verified.valid) {
    logger.debug("Signed URL verification failed", { reason: verified.reason });
    return unauthorized();
  }

  if (isKeyHostile(key)) {
    logger.debug("Hostile key rejected");
    return notFound();
  }
  if (!key.startsWith(ALLOWED_PREFIX)) {
    logger.debug("Key outside allowed prefix");
    return notFound();
  }

  const service = getLocalStorageService();
  let resolved: { absolutePath: string; size: number };
  try {
    resolved = await service.resolveForStreaming(key);
  } catch (err) {
    if (err instanceof LocalStorageNotFoundError || err instanceof LocalStoragePathEscapeError) {
      return notFound();
    }
    logger.error("resolveForStreaming failed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new NextResponse("Internal Server Error", { status: 500 });
  }

  const { absolutePath, size } = resolved;
  const contentType = contentTypeFor(absolutePath);
  const rangeHeader = request.headers.get("range");
  const parsed = parseRange(rangeHeader, size);

  if (parsed === null) {
    // No Range header → full body 200
    return new NextResponse(openStreamWithErrorHandler(absolutePath, key, logger), {
      status: 200,
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": contentType,
        "Content-Length": String(size),
      },
    });
  }

  if (parsed.kind === "malformed" || parsed.kind === "unsatisfiable") {
    return new NextResponse("Range Not Satisfiable", {
      status: 416,
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "text/plain",
        "Content-Range": `bytes */${size}`,
      },
    });
  }

  const { start, end } = parsed;
  return new NextResponse(openStreamWithErrorHandler(absolutePath, key, logger, { start, end }), {
    status: 206,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  });
}
