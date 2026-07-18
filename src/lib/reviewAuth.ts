import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { createLogger } from "@/lib/logger";

const logger = createLogger("reviewAuth");

/**
 * Module augmentation for next-auth to carry GitHub-specific fields
 * on the JWT token and session without resorting to `any` casts.
 */
declare module "next-auth" {
  interface Session {
    accessToken?: string;
    user: {
      githubId?: number;
      githubLogin?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    accessToken?: string;
    githubId?: number;
    githubLogin?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  debug: process.env.NODE_ENV === "development",
  providers: [
    GitHub({
      clientId: process.env.GITHUB_APP_CLIENT_ID ?? (() => {
        logger.error("GITHUB_APP_CLIENT_ID is not set — OAuth login will fail");
        return "";
      })(),
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? (() => {
        logger.error("GITHUB_APP_CLIENT_SECRET is not set — OAuth login will fail");
        return "";
      })(),
      // GitHub sends iss=https://github.com/login/oauth in the OAuth callback (RFC 9207).
      // oauth4webapi v3+ validates this against the configured issuer; Auth.js defaults
      // to "https://authjs.dev" which causes a mismatch.
      issuer: "https://github.com/login/oauth",
      // GitHub Apps can fail PKCE verification — use state-only CSRF protection.
      checks: ["state"],
      authorization: {
        params: {
          // `repo` is required so the reviewer's OAuth token can create and
          // submit pending pull-request reviews (including on private repos).
          scope: "read:user user:email repo",
        },
      },
    }),
  ],
  pages: { signIn: "/signin" },
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.accessToken = account.access_token ?? undefined;
        token.githubId = (profile as { id?: number }).id;
        token.githubLogin = (profile as { login?: string }).login;
        logger.debug("JWT callback: stored GitHub profile on token", {
          githubId: token.githubId,
          githubLogin: token.githubLogin,
        });
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.user.githubId = token.githubId;
      session.user.githubLogin = token.githubLogin;
      return session;
    },
  },
});

export type RepositoryAccessResult =
  | { allowed: true }
  | { allowed: false; reason: "not_authorized" | "api_error" };

export type ReviewWriteAccessResult =
  | { allowed: true }
  | { allowed: false; reason: "not_authorized" | "api_error" | "missing_token" };

const GITHUB_API = "https://api.github.com";

export class GitHubOAuthTokenInvalidError extends Error {
  constructor(message = "GitHub OAuth token is invalid or expired") {
    super(message);
    this.name = "GitHubOAuthTokenInvalidError";
  }
}

/** Shared GitHub REST API fetch with standard Accept header. */
function ghFetch(url: string | URL, accessToken: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });
}

export async function canViewRepository(
  accessToken: string,
  repoFullName: string,
): Promise<RepositoryAccessResult> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    logger.warn("Malformed repoFullName — cannot check repository access", { repoFullName });
    return { allowed: false, reason: "api_error" };
  }
  try {
    const res = await ghFetch(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      accessToken,
    );

    if (res.ok) {
      return { allowed: true };
    }

    if ([401, 403, 404].includes(res.status)) {
      return { allowed: false, reason: "not_authorized" };
    }

    logger.warn("GitHub repository access check returned non-OK status", {
      repoFullName,
      status: res.status,
    });
    return { allowed: false, reason: "api_error" };
  } catch (err) {
    logger.error("GitHub repository access check failed", {
      repoFullName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: false, reason: "api_error" };
  }
}

/**
 * Best-effort reviewer write capability check for walkthrough-authored review drafts.
 * We currently treat repository visibility access as the minimum safe gate and require
 * a reviewer OAuth token to attempt sync/submit. GitHub will still enforce the final
 * write permission when the review mutation runs.
 */
export async function canWriteReviewComments(
  accessToken: string | undefined,
  repoFullName: string,
): Promise<ReviewWriteAccessResult> {
  if (!accessToken) {
    return { allowed: false, reason: "missing_token" };
  }

  const repositoryAccess = await canViewRepository(accessToken, repoFullName);
  if (repositoryAccess.allowed) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: repositoryAccess.reason,
  };
}
