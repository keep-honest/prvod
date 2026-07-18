"use client";

import { PlaybackModeBadge } from "./PlaybackModeBadge";

export function ReviewHeader(props: {
  repoFullName: string;
  prNumber: number;
  durationMode: string;
  headline: string;
  snapshotStatus?: "current" | "outdated";
  canSyncDrafts?: boolean;
}) {
  return (
    <header className="review-surface relative overflow-hidden rounded-[28px] px-5 py-5">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(84,214,255,0.18),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(59,109,255,0.16),transparent_35%)]" />
      <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--foreground-soft)]">
            Review VOD
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white md:text-3xl">
            {props.repoFullName} • PR #{props.prNumber}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--foreground-muted)]">
            {props.headline}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PlaybackModeBadge durationMode={props.durationMode} />
          {props.snapshotStatus === "outdated" ? (
            <span className="rounded-full border border-amber-400/50 bg-amber-400/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-200">
              Regeneration required
            </span>
          ) : null}
          {!props.canSyncDrafts ? (
            <span className="rounded-full border border-[var(--border)] bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--foreground-soft)]">
              Draft sync locked
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
}
