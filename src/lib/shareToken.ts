import { createHmac, timingSafeEqual } from "crypto";
import { createLogger } from "@/lib/logger";

const logger = createLogger("lib/shareToken");

export type ShareType = "full" | "video";

export interface ShareTokenPayload {
  jobId: string;
  type: ShareType;
  exp: number; // Unix timestamp (seconds)
}

export interface ShareTokenResult {
  url: string;
  expiresAt: Date;
}

const SEVEN_DAYS_SECONDS = 7 * 24 * 3600;
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

// ── Base64url helpers ────────────────────────────────────────────────

function toBase64url(data: string): string {
  return Buffer.from(data, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

// ── Core signing/verification ────────────────────────────────────────

function hmacSign(payload: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(payload, "utf-8").digest();
  return sig
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Sign a share token payload. Returns `<b64url-payload>.<b64url-signature>`.
 */
export function signToken(payload: ShareTokenPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const encoded = toBase64url(json);
  const sig = hmacSign(encoded, secret);
  return `${encoded}.${sig}`;
}

/**
 * Verify and decode a share token. Returns the payload if valid, null otherwise.
 *
 * Checks:
 * 1. Format: exactly two dot-separated parts
 * 2. Signature: constant-time HMAC-SHA256 comparison
 * 3. Expiry: `exp` must be in the future (with 60s clock skew tolerance)
 */
export function verifyToken(
  token: string,
  secret: string,
): ShareTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    logger.debug("Share token rejected: invalid format (expected 2 parts)", {
      partCount: parts.length,
    });
    return null;
  }

  const [encodedPayload, providedSig] = parts;

  // Recompute signature and compare (constant-time)
  const expectedSig = hmacSign(encodedPayload, secret);
  const sigA = Buffer.from(providedSig, "utf-8");
  const sigB = Buffer.from(expectedSig, "utf-8");

  if (sigA.length !== sigB.length || !timingSafeEqual(sigA, sigB)) {
    logger.debug("Share token rejected: signature mismatch");
    return null;
  }

  // Decode payload
  let payload: ShareTokenPayload;
  try {
    const json = fromBase64url(encodedPayload);
    payload = JSON.parse(json);
  } catch {
    logger.debug("Share token rejected: payload decode failed");
    return null;
  }

  // Validate payload shape
  if (
    typeof payload.jobId !== "string" ||
    typeof payload.exp !== "number" ||
    (payload.type !== "full" && payload.type !== "video")
  ) {
    logger.debug("Share token rejected: invalid payload shape");
    return null;
  }

  // Check expiry
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSeconds - CLOCK_SKEW_TOLERANCE_SECONDS) {
    logger.debug("Share token rejected: expired", {
      exp: payload.exp,
      now: nowSeconds,
    });
    return null;
  }

  return payload;
}

/**
 * Generate a signed share URL for a job.
 *
 * @param jobId - Target job UUID
 * @param type - `"full"` for authenticated walkthrough, `"video"` for public player
 * @param baseUrl - App origin (e.g. `https://prvod.dev`)
 * @param secret - HMAC signing secret
 * @returns URL string and expiry date
 */
export function makeShareUrl(
  jobId: string,
  type: ShareType,
  baseUrl: string,
  secret: string,
): ShareTokenResult {
  const exp = Math.floor(Date.now() / 1000) + SEVEN_DAYS_SECONDS;
  const token = signToken({ jobId, type, exp }, secret);

  const path =
    type === "full"
      ? `/reviews/${jobId}?shareToken=${token}`
      : `/watch/${jobId}?token=${token}`;

  return {
    url: `${baseUrl.replace(/\/+$/, "")}${path}`,
    expiresAt: new Date(exp * 1000),
  };
}
