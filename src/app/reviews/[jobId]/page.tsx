import React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getContainer } from "@/config/container";
import { createLogger } from "@/lib/logger";
import { loadReviewPage } from "@/lib/reviews/loadReviewPage";
import { isValidUuid } from "@/lib/validation";
import { ReviewPageClient } from "./ReviewPageClient";

const logger = createLogger("reviews/[jobId]/page");

export async function generateMetadata(
  props: { params: Promise<{ jobId: string }> },
): Promise<Metadata> {
  const { jobId } = await props.params;
  try {
    if (isValidUuid(jobId)) {
      const container = await getContainer();
      const job = await container.jobRepository.findById(jobId);
      if (job?.status === "completed") {
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
  };
}

export default async function ReviewPage(
  props: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await props.params;
  const result = await loadReviewPage({ jobId });

  if (!result.ok) {
    if (result.status === 404) {
      notFound();
    }

    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-white/10 bg-black/40 p-8">
          <h1 className="text-2xl font-semibold text-white">Review page unavailable</h1>
          <p className="mt-3 text-sm text-white/70">{result.message}</p>
        </div>
      </main>
    );
  }

  return <ReviewPageClient reviewPage={result.payload} />;
}
