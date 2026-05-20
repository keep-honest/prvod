import { createPrivateKey, createSign } from "crypto";
import { createLogger } from "@/lib/logger";

const logger = createLogger("GitHubAppTokenService");

const GITHUB_API = "https://api.github.com";
// Evict token 5 min before GitHub's 1-hour expiry to avoid stale-token errors
const TOKEN_BUFFER_MS = 5 * 60 * 1000;

function normalisePem(raw: string): string {
  // Env vars may store the PEM with literal "\n" or "\\n" sequences instead of real newlines.
  // Additionally, some .env loaders wrap the value in quotes that leak into the string.
  let pem = raw.trim();
  // Strip surrounding quotes if present (some .env loaders leave them)
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1);
  }
  // Convert literal \n sequences to real newlines
  pem = pem.replace(/\\n/g, "\n");

  // Validate basic PEM structure
  if (!pem.includes("-----BEGIN")) {
    logger.error("GITHUB_APP_PRIVATE_KEY does not look like a PEM key", {
      startsWithDash: pem.startsWith("-"),
      length: pem.length,
    });
  }
  return pem;
}

function buildAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60, // 60s back for clock skew
      exp: now + 600, // 10-min max (GitHub's limit)
      iss: appId,
    }),
  ).toString("base64url");

  // Parse the PEM into a KeyObject first — this handles both PKCS#1 and PKCS#8
  // and gives a clear error if the key is malformed, rather than a cryptic OpenSSL code.
  const key = createPrivateKey(privateKeyPem);
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`, "utf8");
  return `${header}.${payload}.${sign.sign(key, "base64url")}`;
}

interface CachedToken {
  token: string;
  expiresAt: number; // ms since epoch
}

export class GitHubAppTokenService {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly cache = new Map<number, CachedToken>();

  constructor() {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId) throw new Error("GITHUB_APP_ID environment variable is not set");
    if (!privateKey) throw new Error("GITHUB_APP_PRIVATE_KEY environment variable is not set");
    this.appId = appId;
    this.privateKeyPem = normalisePem(privateKey);

    // Validate the key eagerly so a bad PEM fails at startup, not at first webhook
    try {
      createPrivateKey(this.privateKeyPem);
    } catch (err) {
      const lines = this.privateKeyPem.split("\n");
      logger.error("GITHUB_APP_PRIVATE_KEY is not a valid PEM private key", {
        error: err instanceof Error ? err.message : String(err),
        lineCount: lines.length,
        hasHeader: lines[0]?.startsWith("-----"),
        hasFooter: lines[lines.length - 1]?.startsWith("-----"),
      });
      throw new Error(
        `GITHUB_APP_PRIVATE_KEY is not a valid PEM private key: ${err instanceof Error ? err.message : err}`,
      );
    }
    logger.info("Private key validated successfully");
  }

  async getToken(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug("Using cached installation token", { installationId });
      return cached.token;
    }

    logger.debug("Fetching new installation token", { installationId });
    const jwt = buildAppJwt(this.appId, this.privateKeyPem);

    const url = `${GITHUB_API}/app/installations/${installationId}/access_tokens`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 500);
      } catch { /* ignore */ }
      throw new Error(
        `Failed to get installation token for installationId=${installationId}: ${res.status} ${body}`,
      );
    }

    const data = (await res.json()) as { token: string; expires_at: string };
    const expiresAt = new Date(data.expires_at).getTime() - TOKEN_BUFFER_MS;
    this.cache.set(installationId, { token: data.token, expiresAt });
    logger.info("Installation token acquired", { installationId });
    // Token value is never logged
    return data.token;
  }

  evict(installationId: number): void {
    this.cache.delete(installationId);
    logger.debug("Evicted cached installation token", { installationId });
  }
}
