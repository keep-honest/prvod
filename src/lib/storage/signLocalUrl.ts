import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-signed URL helpers for the local-storage streaming route.
 *
 * Mirrors S3 presigned URL semantics: every URL carries an `exp` (Unix
 * seconds) and `sig` (hex HMAC) query string. Tampering with the key,
 * exp, or sig invalidates the signature. Once `exp` has passed the
 * route rejects, so leaked URLs go dead within SIGNED_URL_EXPIRY_HOURS.
 *
 * Used by:
 *   - LocalStorageService.getSignedUrl (signing)
 *   - src/app/api/local-storage/[...key]/route.ts (verifying)
 */

export const STORAGE_URL_SECRET_ENV = "STORAGE_URL_SECRET";
export const STORAGE_URL_PATH_PREFIX = "/api/local-storage/";

/**
 * Read STORAGE_URL_SECRET from env. Throws with a clear remediation
 * message if unset — fail loud at boot, not per-request.
 */
export function readStorageUrlSecret(): string {
  const value = process.env[STORAGE_URL_SECRET_ENV];
  if (!value || value.length === 0) {
    throw new Error(
      `${STORAGE_URL_SECRET_ENV} is required when STORAGE_PROVIDER=local. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  return value;
}

function computeSignature(key: string, exp: number, secret: string): string {
  // The payload is `key|exp`. A pipe-separator is unambiguous because
  // we URL-encode segments on the way out and parse exp as integer on
  // the way in, so the verifier reconstructs the exact same bytes.
  return createHmac("sha256", secret).update(`${key}|${exp}`).digest("hex");
}

function encodeKey(key: string): string {
  // URL-encode each path segment individually so `/` stays a path
  // separator but spaces, plus signs, and other reserved chars get
  // escaped. encodeURIComponent handles all of `! * ' ( ) ; : @ & = + $ , ?`.
  return key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/**
 * Build a signed local-storage URL.
 *
 * @param key            Storage key (e.g. `videos/owner/repo/12/uuid.mp4`).
 * @param expirySeconds  How long the URL stays valid from `now`.
 * @param secret         HMAC secret (from `readStorageUrlSecret()`).
 * @param now            Injectable clock for tests. Returns Unix milliseconds.
 */
export function signLocalUrl(
  key: string,
  expirySeconds: number,
  secret: string,
  now: () => number = Date.now,
): string {
  const exp = Math.floor(now() / 1000) + Math.max(0, Math.floor(expirySeconds));
  const sig = computeSignature(key, exp, secret);
  return `${STORAGE_URL_PATH_PREFIX}${encodeKey(key)}?exp=${exp}&sig=${sig}`;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: "missing" | "expired" | "bad-signature" };

/**
 * Verify a signed local-storage URL's query parameters.
 *
 * Constant-time signature comparison via `timingSafeEqual`. Length
 * mismatch in `timingSafeEqual` would throw, so we guard the length
 * up front and return `bad-signature` in both cases.
 *
 * The route MUST call this BEFORE any filesystem touch — never let an
 * unauthenticated request reach `fs.stat`.
 */
export function verifyLocalUrl(
  key: string,
  exp: string | null,
  sig: string | null,
  secret: string,
  now: () => number = Date.now,
): VerifyResult {
  if (exp === null || sig === null) {
    return { valid: false, reason: "missing" };
  }

  // Strict integer parse. Reject anything non-numeric, leading zeros
  // would be accepted by parseInt — but the signature comparison would
  // then fail because we sign with `${exp}` (which has no leading zeros
  // since exp comes from Math.floor()). So we accept the parse and let
  // the signature check catch any normalisation mismatch.
  if (!/^[0-9]+$/.test(exp)) {
    return { valid: false, reason: "bad-signature" };
  }
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0) {
    return { valid: false, reason: "bad-signature" };
  }

  // Signature must be hex of the right byte length. computeSignature
  // returns 64 hex chars (sha256 -> 32 bytes). Reject up front so the
  // timingSafeEqual length-mismatch path never throws.
  if (!/^[0-9a-f]{64}$/i.test(sig)) {
    return { valid: false, reason: "bad-signature" };
  }

  const expectedHex = computeSignature(key, expNum, secret);
  const providedBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  // Length is guaranteed equal here by the regex above, but assert
  // defensively before timingSafeEqual to avoid the throw path.
  if (providedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: "bad-signature" };
  }

  // Expiry check AFTER signature verify so a tampered exp value
  // (which the attacker controls) reports as "bad-signature" rather
  // than "expired" — preserves the uniform 401 the route returns.
  const nowSeconds = Math.floor(now() / 1000);
  if (expNum <= nowSeconds) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true };
}
