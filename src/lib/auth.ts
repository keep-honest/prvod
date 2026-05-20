import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createLogger } from "@/lib/logger";
import type { IApiKeyRepository } from "@/interfaces/IApiKeyRepository";

const logger = createLogger("auth");

export interface ErrorResponse {
  error: string;
  message: string;
}

export interface AuthenticatedApiKey {
  id: string;
  keyId: string;
  isAdmin: boolean;
  installationRef: string | null;
  scopes: string[];
  source: "db" | "legacy_env";
  maxUses: number | null;
  usesCount: number;
  status: "active" | "in_use" | "consumed" | "revoked";
}

export interface AuthValidationResult {
  error: ErrorResponse | null;
  auth: AuthenticatedApiKey | null;
}

const UNAUTHORIZED: ErrorResponse = {
  error: "UNAUTHORIZED",
  message: "Missing or invalid authentication token",
};

const SERVICE_UNAVAILABLE: ErrorResponse = {
  error: "SERVICE_UNAVAILABLE",
  message: "Authentication service is temporarily unavailable",
};

export const FORBIDDEN_ADMIN: ErrorResponse = {
  error: "FORBIDDEN",
  message: "Admin API key required",
};

export function deriveLegacyApiKeyId(secret: string): string {
  const digest = createHash("sha256").update(secret, "utf8").digest("hex");
  return `legacy_${digest.slice(0, 16)}`;
}

type VerifyResult =
  | { ok: true; auth: AuthenticatedApiKey }
  | { ok: false; error: ErrorResponse | null };

interface VerifyOptions {
  /** When true, allows in_use/consumed one-time keys through auth (for job polling/download). */
  allowNonActiveOneTimeKey?: boolean;
}

async function verifyDbApiKey(
  keyId: string,
  secret: string,
  apiKeyRepo: IApiKeyRepository,
  source: "db" | "legacy_env",
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const record = await apiKeyRepo.findByKeyId(keyId);
  if (!record) {
    logger.info("API key not found", { keyId });
    return { ok: false, error: null };
  }

  const isOneTimeKey = record.maxUses !== null;
  if (isOneTimeKey) {
    if (record.status === "revoked") {
      logger.info("One-time key revoked", { keyId });
      return { ok: false, error: { error: "KEY_REVOKED", message: "This API key has been revoked" } };
    }
    if (record.status === "consumed") {
      if (!options.allowNonActiveOneTimeKey) {
        logger.info("One-time key already consumed", { keyId });
        return { ok: false, error: { error: "KEY_CONSUMED", message: "This API key has already been used" } };
      }
    }
    if (record.status === "in_use") {
      if (!options.allowNonActiveOneTimeKey) {
        logger.info("One-time key already in use", { keyId });
        return { ok: false, error: { error: "KEY_IN_USE", message: "A job is already in progress for this key" } };
      }
    }
  } else {
    // Regular keys: only 'active' is allowed
    if (record.status !== "active") {
      logger.info("API key is not active", { keyId, status: record.status });
      return { ok: false, error: null };
    }
  }

  const pepper = process.env.APP_ENCRYPTION_KEY ?? "";
  if (!pepper) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ENCRYPTION_KEY must be set in production");
    }
    logger.warn("APP_ENCRYPTION_KEY is not set — API key verification uses no pepper (insecure in production)");
  }

  let isValid: boolean;
  try {
    const { verify } = await import("@node-rs/argon2");
    isValid = await verify(record.keyHash, pepper + secret);
  } catch (err) {
    logger.error("Argon2 verification failed — native module may be missing or hash is corrupt", {
      keyId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Argon2 verification unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValid) {
    logger.warn("API key hash verification failed", { keyId });
    return { ok: false, error: null };
  }

  // Fire-and-forget: update last_used_at without blocking the request
  apiKeyRepo.touchLastUsed(record.id).catch((err) => {
    logger.warn("Failed to update API key last_used_at", {
      keyId: record.keyId,
      id: record.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    ok: true,
    auth: {
      id: record.id,
      keyId: record.keyId,
      isAdmin: record.isAdmin,
      installationRef: record.installationRef,
      scopes: record.scopes,
      source,
      maxUses: record.maxUses,
      usesCount: record.usesCount,
      status: record.status,
    },
  };
}

/**
 * Validate Bearer token using DB-backed Argon2id key lookup.
 *
 * Token formats:
 *   - New:    "keyId.secret"   — DB lookup + Argon2id verify
 *   - Legacy: raw value        — mapped to deterministic keyId and verified via DB hash
 *
 * @param request   Incoming Next.js request
 * @param apiKeyRepo  API key repository (from container)
 */
export interface ValidateOptions {
  /** When true, allows in_use/consumed one-time keys (for job polling/download). */
  allowNonActiveOneTimeKey?: boolean;
}

export async function validateBearerToken(
  request: NextRequest,
  apiKeyRepo: IApiKeyRepository,
  options: ValidateOptions = {},
): Promise<AuthValidationResult> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: UNAUTHORIZED, auth: null };
  }

  const token = authHeader.slice(7);
  if (!token) {
    return { error: UNAUTHORIZED, auth: null };
  }

  // Legacy path: no dot separator. First confirm token matches API_SECRET_KEY value,
  // then verify against DB-backed hash using derived keyId.
  if (!token.includes(".")) {
    const legacySecret = process.env.API_SECRET_KEY;
    if (!legacySecret) {
      return { error: UNAUTHORIZED, auth: null };
    }

    const presented = Buffer.from(token);
    const configured = Buffer.from(legacySecret);
    if (
      presented.length !== configured.length ||
      !timingSafeEqual(presented, configured)
    ) {
      return { error: UNAUTHORIZED, auth: null };
    }

    const legacyKeyId = deriveLegacyApiKeyId(legacySecret);
    try {
      const result = await verifyDbApiKey(legacyKeyId, legacySecret, apiKeyRepo, "legacy_env", options);
      if (!result.ok) {
        logger.error("Legacy key passed timing-safe compare but failed DB verify — pepper mismatch or key not seeded", { legacyKeyId });
        return { error: result.error ?? UNAUTHORIZED, auth: null };
      }
      return { error: null, auth: result.auth };
    } catch (err) {
      logger.error("Legacy key verification infrastructure failure", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { error: SERVICE_UNAVAILABLE, auth: null };
    }
  }

  // New path: "keyId.secret" → DB lookup + Argon2id verify
  const dotIdx = token.indexOf(".");
  const keyId = token.slice(0, dotIdx);
  const secret = token.slice(dotIdx + 1);
  if (!keyId || !secret) {
    return { error: UNAUTHORIZED, auth: null };
  }

  try {
    const result = await verifyDbApiKey(keyId, secret, apiKeyRepo, "db", options);
    if (!result.ok) {
      return { error: result.error ?? UNAUTHORIZED, auth: null };
    }
    return { error: null, auth: result.auth };
  } catch (err) {
    logger.error("API key verification infrastructure failure", {
      keyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: SERVICE_UNAVAILABLE, auth: null };
  }
}

export function unauthorizedResponse(error: ErrorResponse): NextResponse {
  const statusMap: Record<string, number> = {
    SERVICE_UNAVAILABLE: 503,
    KEY_IN_USE: 429,
    KEY_CONSUMED: 403,
    KEY_REVOKED: 403,
  };
  const status = statusMap[error.error] ?? 401;
  return NextResponse.json(error, { status });
}

export function forbiddenResponse(error: ErrorResponse): NextResponse {
  return NextResponse.json(error, { status: 403 });
}
