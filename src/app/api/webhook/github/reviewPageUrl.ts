/**
 * Builds the URL that the GitHub webhook posts in a PR comment after a job
 * completes. Extracted from `route.ts` because Next.js does not allow named
 * exports on route files (only HTTP verb handlers).
 *
 * For **private repos** the URL is an HMAC-signed share link with a 180-day
 * TTL — PR comments are permanent, so a short expiry would silently break
 * older links. Without the token the bare URL would leak repo/PR metadata,
 * narration, and a fresh signed video URL to anyone who guesses the jobId
 * (see security audit F-01/F-02).
 *
 * For **public repos** we keep the bare URL; the underlying data is already
 * public, and existing PR comments using the bare format keep working.
 */

import { makeShareUrl } from "@/lib/shareToken";

/** 180 days. Trade-off documented in module header. */
export const PRIVATE_REPO_REVIEW_TOKEN_TTL_SECONDS = 180 * 24 * 3600;

export function buildReviewPageUrl(
  jobId: string,
  opts: { repoIsPrivate: boolean },
): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://localhost:3000";
  const base = appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;

  let url: string;
  if (opts.repoIsPrivate) {
    const secret = process.env.SHARE_SIGNING_SECRET;
    if (!secret) {
      // Refuse to post a bare link for a private repo — that's exactly the
      // exposure F-01/F-02 close. The caller catches and posts an error
      // comment directing the user to support.
      throw new Error("SHARE_SIGNING_SECRET not configured — cannot mint review link for private repo");
    }
    const { url: signed } = makeShareUrl(
      jobId,
      "full",
      base,
      secret,
      PRIVATE_REPO_REVIEW_TOKEN_TTL_SECONDS,
    );
    url = signed;
  } else {
    url = `${base}/reviews/${encodeURIComponent(jobId)}`;
  }

  // Basic validation — catch misconfigured NEXT_PUBLIC_APP_URL early.
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid review page URL: "${url}" (check NEXT_PUBLIC_APP_URL)`);
  }
  return url;
}
