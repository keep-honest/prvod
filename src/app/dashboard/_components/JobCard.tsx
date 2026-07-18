"use client";

import { useState } from "react";
import { ShareDialog } from "./ShareDialog";
import { mapJobErrorToUserMessage } from "@/lib/jobErrorMessages";

interface JobCardProps {
  job: {
    id: string;
    status: string;
    repoFullName: string;
    prNumber: number;
    prTitle: string;
    createdAt: string;
    completedAt: string | null;
    hasReview: boolean;
    errorCode?: string | null;
  };
}

export function JobCard({ job }: JobCardProps) {
  const [shareOpen, setShareOpen] = useState(false);

  const isCompleted = job.status === "completed";
  const userErrorMessage = mapJobErrorToUserMessage(job.status, job.errorCode ?? null);
  const completedDate = job.completedAt
    ? new Date(job.completedAt).toLocaleDateString()
    : null;

  return (
    <div className="cine-transition rounded-xl border border-[var(--border)] bg-[var(--background-panel)] p-5 hover:border-[var(--border-strong)]">
      {/* Header: repo/PR + status badge */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={`https://github.com/${job.repoFullName}/pull/${job.prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-1.5 text-sm text-[var(--foreground-muted)] hover:text-[var(--accent)]"
          >
            <span className="truncate font-mono">{job.repoFullName}</span>
            <ExternalLinkIcon className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" />
          </a>
          <p className="mt-0.5 truncate text-base font-medium text-[var(--foreground)]">
            {job.prTitle}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {/* Meta row */}
      {completedDate && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--foreground-soft)]">
          <span>{completedDate}</span>
        </div>
      )}

      {userErrorMessage && (
        <p
          data-testid="job-error-message"
          className="mb-4 break-words text-xs text-[var(--danger)]"
        >
          {userErrorMessage}
        </p>
      )}

      {/* Actions */}
      {isCompleted && (
        <div className="flex items-center gap-2">
          {job.hasReview && (
            <a
              href={`/reviews/${job.id}`}
              className="cine-transition rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              View Walkthrough
            </a>
          )}
          <button
            onClick={() => setShareOpen(true)}
            className="cine-transition rounded-lg border border-[var(--border)] px-3.5 py-1.5 text-sm font-medium text-[var(--foreground-muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
          >
            Share
          </button>
          <ShareDialog
            jobId={job.id}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    completed: {
      label: "Completed",
      className: "bg-[var(--success)]/15 text-[var(--success)]",
    },
    processing: {
      label: "Processing",
      className: "bg-[var(--accent-soft)] text-[var(--accent)]",
    },
    queued: {
      label: "Queued",
      className: "bg-[var(--warning)]/15 text-[var(--warning)]",
    },
    failed: {
      label: "Failed",
      className: "bg-[var(--danger)]/15 text-[var(--danger)]",
    },
    cancelled: {
      label: "Cancelled",
      className: "bg-[var(--danger)]/15 text-[var(--danger)]",
    },
  };

  const { label, className } = config[status] ?? {
    label: status,
    className: "bg-[var(--background-panel-strong)] text-[var(--foreground-soft)]",
  };

  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7 1h4v4M11 1L5 7M9 7v3.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5v-7A.5.5 0 011.5 3H5" />
    </svg>
  );
}
