import { NextRequest, NextResponse } from "next/server";
import { getContainer, type Container } from "@/config/container";
import {
  validateBearerToken,
  unauthorizedResponse,
  forbiddenResponse,
  FORBIDDEN_ADMIN,
  type AuthenticatedApiKey,
  type ErrorResponse,
  type ValidateOptions,
} from "@/lib/auth";
import { isJobsApiEnabled, jobsApiDisabledResponse } from "@/lib/jobsApiAccess";
import { createLogger } from "@/lib/logger";
import { randomUUID } from "crypto";

type Logger = ReturnType<typeof createLogger>;

export interface AuthContext {
  container: Container;
  auth: AuthenticatedApiKey;
  logger: Logger;
  requestId: string;
}

// Backward-compatible aliases
export type AdminContext = AuthContext;
export type AdminJobsContext = AuthContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteContext = any;

type AuthHandler = (
  request: NextRequest,
  ctx: AuthContext,
  routeContext: RouteContext,
) => Promise<NextResponse>;

/**
 * Base auth middleware: container init, bearer token validation, error boundary.
 * Does NOT check isAdmin or isJobsApiEnabled — callers compose those guards.
 */
function withBaseAuth(handler: AuthHandler, authOptions: ValidateOptions = {}) {
  return async (request: NextRequest, routeContext?: RouteContext): Promise<NextResponse> => {
    const requestId = randomUUID();
    const logger = createLogger(requestId);

    let container;
    try {
      container = await getContainer();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to initialize server dependencies";
      logger.error("Container initialization failed", { error: message });
      return NextResponse.json(
        { error: "SERVER_CONFIGURATION_ERROR", message },
        { status: 500 },
      );
    }

    const { error: authError, auth } = await validateBearerToken(request, container.apiKeyRepository, authOptions);
    if (authError) {
      return unauthorizedResponse(authError);
    }
    if (!auth) {
      return unauthorizedResponse({ error: "UNAUTHORIZED", message: "Missing or invalid authentication token" });
    }

    try {
      return await handler(request, { container, auth, logger, requestId }, routeContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      logger.error("Unhandled route handler error", {
        requestId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return NextResponse.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        { status: 500 },
      );
    }
  };
}

/**
 * Admin-only routes (e.g., key management).
 * Requires isAdmin: true. Does NOT gate on isJobsApiEnabled.
 */
export function withAdminAuth(handler: AuthHandler) {
  return withBaseAuth(async (request, ctx, routeContext) => {
    if (!ctx.auth.isAdmin) {
      return forbiddenResponse(FORBIDDEN_ADMIN);
    }
    return handler(request, ctx, routeContext);
  });
}

const FORBIDDEN_JOBS: ErrorResponse = {
  error: "FORBIDDEN",
  message: "Admin or one-time trial API key required",
};

/**
 * Authorization guard: only admin keys and one-time trial keys may access /api/jobs.
 * Rejects non-admin unlimited keys (isAdmin=false, maxUses=null).
 */
function isJobsAuthorized(auth: AuthenticatedApiKey): boolean {
  return auth.isAdmin || auth.maxUses !== null;
}

/**
 * Jobs API write routes (POST /api/jobs) accessible by admin keys AND active one-time keys.
 * Rejects non-admin unlimited keys. Gates on isJobsApiEnabled.
 */
export function withJobsAuth(handler: AuthHandler) {
  return async (request: NextRequest, routeContext?: RouteContext): Promise<NextResponse> => {
    if (!isJobsApiEnabled()) {
      return jobsApiDisabledResponse();
    }
    return withBaseAuth(async (req, ctx, rc) => {
      if (!isJobsAuthorized(ctx.auth)) {
        return forbiddenResponse(FORBIDDEN_JOBS);
      }
      return handler(req, ctx, rc);
    })(request, routeContext);
  };
}

/**
 * Jobs API read routes (GET /api/jobs/:id) — allows in_use/consumed one-time keys
 * so trial users can poll job status and download results after their key is consumed.
 * Rejects non-admin unlimited keys. Gates on isJobsApiEnabled.
 */
export function withJobsReadAuth(handler: AuthHandler) {
  return async (request: NextRequest, routeContext?: RouteContext): Promise<NextResponse> => {
    if (!isJobsApiEnabled()) {
      return jobsApiDisabledResponse();
    }
    return withBaseAuth(async (req, ctx, rc) => {
      if (!isJobsAuthorized(ctx.auth)) {
        return forbiddenResponse(FORBIDDEN_JOBS);
      }
      return handler(req, ctx, rc);
    }, { allowNonActiveOneTimeKey: true })(request, routeContext);
  };
}

/**
 * Admin-only jobs API routes (e.g., retry).
 * Requires isAdmin: true AND isJobsApiEnabled.
 */
export function withAdminJobsAuth(handler: AuthHandler) {
  return async (request: NextRequest, routeContext?: RouteContext): Promise<NextResponse> => {
    if (!isJobsApiEnabled()) {
      return jobsApiDisabledResponse();
    }
    return withAdminAuth(handler)(request, routeContext);
  };
}
