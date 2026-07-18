"use client";

function durationModeLabel(durationMode: string): string {
  switch (durationMode) {
    case "short":
      return "Short review";
    case "popcorn":
      return "Popcorn review";
    default:
      return "Review";
  }
}

export function PlaybackModeBadge(props: { durationMode: string }) {
  return (
    <span className="rounded-full border border-[var(--border-strong)] bg-[var(--background-panel-strong)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--accent-secondary)]">
      {durationModeLabel(props.durationMode)}
    </span>
  );
}
