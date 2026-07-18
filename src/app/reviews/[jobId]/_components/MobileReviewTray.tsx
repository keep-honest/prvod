"use client";

type MobilePanel = "playback" | "diff";

export function MobileReviewTray(props: {
  activePanel: MobilePanel;
  onChange: (panel: MobilePanel) => void;
  pinCount: number;
  snapshotStatus: "current" | "outdated";
}) {
  const buttonClass = (panel: MobilePanel) =>
    `flex-1 rounded-full border px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] ${
      props.activePanel === panel
        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-white"
        : "border-[var(--border)] bg-black/20 text-[var(--foreground-soft)]"
    }`;

  return (
    <div className="review-surface rounded-[24px] p-3 xl:hidden">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--foreground-soft)]">
            Mobile review
          </p>
          <p className="mt-1 text-sm text-[var(--foreground-muted)]">
            Switch between playback and diff.
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${
          props.snapshotStatus === "outdated"
            ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
            : "border-[var(--border)] bg-white/5 text-[var(--foreground-soft)]"
        }`}>
          {props.snapshotStatus === "outdated" ? "Outdated" : `${props.pinCount} pins`}
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" className={buttonClass("playback")} onClick={() => props.onChange("playback")}>
          Playback
        </button>
        <button type="button" className={buttonClass("diff")} onClick={() => props.onChange("diff")}>
          Diff
        </button>
      </div>
    </div>
  );
}
