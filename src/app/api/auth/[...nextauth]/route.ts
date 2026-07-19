import { NextResponse } from "next/server";
import { handlers, isReviewOAuthConfigured } from "@/lib/reviewAuth";
import { createLogger } from "@/lib/logger";

const logger = createLogger("nextauth-route");

type AuthHandler = typeof handlers.GET;

/**
 * Fail loud, per request: without GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET
 * the NextAuth provider was booted with empty credentials and every OAuth flow
 * dies as an opaque callback error. Surface a clear 500 with remediation
 * instead (STORAGE_URL_SECRET precedent, enforced at request time because
 * NextAuth initializes at module load and must stay import-safe for builds
 * and tests that run without env).
 */
function withOAuthConfigGuard(handler: AuthHandler): AuthHandler {
  return async (...args: Parameters<AuthHandler>) => {
    if (!isReviewOAuthConfigured()) {
      logger.error(
        "GitHub OAuth is not configured — set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET",
        {
          hasClientId: Boolean(process.env.GITHUB_APP_CLIENT_ID),
          hasClientSecret: Boolean(process.env.GITHUB_APP_CLIENT_SECRET),
        },
      );
      return NextResponse.json(
        {
          error: "SERVICE_UNAVAILABLE",
          message: "GitHub sign-in is not configured on this server.",
        },
        { status: 500 },
      );
    }
    return handler(...args);
  };
}

export const GET = withOAuthConfigGuard(handlers.GET);
export const POST = withOAuthConfigGuard(handlers.POST);
