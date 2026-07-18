import React from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getContainer } from "@/config/container";
import { auth } from "@/lib/reviewAuth";
import { createLogger } from "@/lib/logger";
import { loadReviewPage } from "@/lib/reviews/loadReviewPage";
import { isValidUuid } from "@/lib/validation";
import { ReviewPageClient } from "./ReviewPageClient";

const logger = createLogger("reviews/[jobId]/page");

function isCategoryMappingEnabled(): boolean {
  return process.env.CATEGORY_MAPPING === "true";
}

export async function generateMetadata(
  props: {
    params: Promise<{ jobId: string }>;
    searchParams: Promise<{ shareToken?: string }>;
  },
): Promise<Metadata> {
  const { jobId } = await props.params;
  try {
    if (isValidUuid(jobId)) {
      const container = await getContainer();
      const job = await container.jobRepository.findById(jobId);
      // For private repos we intentionally skip enriched metadata — repo name
      // and PR number are leakable signals that should only surface after the
      // share-token is verified in the page body.
      if (job?.status === "completed" && !job.repoIsPrivate) {
        return {
          title: `${job.repoFullName} PR #${job.prNumber} | PrVod Review`,
          description: `Code-first walkthrough for ${job.repoFullName} pull request #${job.prNumber}.`,
        };
      }
    }
  } catch (err) {
    logger.warn("Metadata enrichment failed — using generic metadata", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    title: `Review ${jobId} | PrVod`,
    description: "Code-first pull request review page.",
    robots: "noindex",
  };
}

export default async function ReviewPage(
  props: {
    params: Promise<{ jobId: string }>;
    searchParams: Promise<{ shareToken?: string }>;
  },
) {
  const { jobId } = await props.params;
  const { shareToken } = await props.searchParams;
  // Viewing stays share-token gated; the GitHub session only unlocks the
  // draft-comment workflow (canSyncDrafts / reviewerKey on the payload).
  const session = await auth();
  const result = await loadReviewPage({ jobId, shareToken, session });

  if (!result.ok) {
    if (result.status === 404) {
      notFound();
    }

    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-10">
        <div className="review-surface max-w-xl rounded-[28px] p-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--foreground-soft)]">
            Review page unavailable
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-white">
            {result.status === 401
              ? "Sign in to continue"
              : result.status === 503
                ? "Verification temporarily unavailable"
                : "Review page unavailable"}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--foreground-muted)]">
            {result.message}
          </p>
          <div className="mt-6 flex items-center gap-3">
            {result.status === 401 ? (
              <Link
                href={`/signin?callbackUrl=${encodeURIComponent(
                  // Preserve the shareToken across OAuth so external reviewers
                  // don't lose their access through the sign-in callback.
                  shareToken ? `/reviews/${jobId}?shareToken=${encodeURIComponent(shareToken)}` : `/reviews/${jobId}`,
                )}`}
                className="cine-transition rounded-full border border-[var(--border-strong)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-white hover:border-[var(--accent)]"
              >
                Sign in with GitHub
              </Link>
            ) : null}
            <Link
              href="/"
              className="cine-transition rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--foreground-muted)] hover:border-[var(--border-strong)] hover:text-white"
            >
              Back home
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      {result.payload.snapshotStatus === "outdated" ? (
        <main className="px-3 pt-3 md:px-6 md:pt-4">
          <div className="mx-auto max-w-[1600px] rounded-[24px] border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            This walkthrough is tied to an older pull request snapshot. You can still inspect the narrated diff, but fresh sync and submit actions stay locked until the walkthrough is regenerated.
          </div>
        </main>
      ) : null}
      <ReviewPageClient
        reviewPage={result.payload}
        categoryMappingEnabled={isCategoryMappingEnabled()}
      />
    </>
  );
}
