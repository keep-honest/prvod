"use client";

import { useEffect, useState } from "react";

interface InProgressJobCardProps {
  job: {
    id: string;
    status: string;
    currentStage: string | null;
    repoFullName: string;
    prNumber: number;
    prTitle: string;
    createdAt: string;
    elapsedMs: number | null;
  };
}

const STAGE_LABELS: Record<string, string> = {
  analyzing: "Analyzing",
  scripting: "Scripting",
  generating_assets: "Generating Assets",
  composing: "Composing",
  uploading: "Uploading",
};

const STAGE_ORDER = ["analyzing", "scripting", "generating_assets", "composing", "uploading"];

export function InProgressJobCard({ job }: InProgressJobCardProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(
    Math.floor((job.elapsedMs ?? 0) / 1000),
  );

  useEffect(() => {
    const start = Date.now();
    const baseElapsed = job.elapsedMs ?? 0;
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((baseElapsed + Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [job.elapsedMs]);

  const currentStageIndex = job.currentStage
    ? STAGE_ORDER.indexOf(job.currentStage)
    : 0;
  const stageLabel =
    (job.currentStage && STAGE_LABELS[job.currentStage]) ?? "Processing";

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedDisplay = `${minutes}:${String(seconds).padStart(2, "0")}`;

  const isStale = elapsedSeconds > 600; // >10 minutes

  return (
    <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] p-5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={`https://github.com/${job.repoFullName}/pull/${job.prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--foreground-muted)] hover:text-[var(--accent)]"
          >
            <span className="font-mono">{job.repoFullName}</span>
          </a>
          <p className="mt-0.5 truncate text-base font-medium text-[var(--foreground)]">
            {job.prTitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
          <span className="text-xs font-medium tabular-nums text-[var(--accent)]">
            {elapsedDisplay}
          </span>
        </div>
      </div>

      {/* Stage progress */}
      <div className="mb-2 flex gap-1">
        {STAGE_ORDER.map((stage, i) => (
          <div
            key={stage}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
              i <= currentStageIndex
                ? "bg-[var(--accent)]"
                : "bg-[var(--foreground)]/10"
            }`}
          />
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--accent)]">
          {stageLabel}...
        </span>
      </div>

      {isStale && (
        <p className="mt-2 text-xs text-[var(--warning)]">
          Taking longer than expected
        </p>
      )}
    </div>
  );
}
