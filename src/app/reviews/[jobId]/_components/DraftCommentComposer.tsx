"use client";

import type { LocalDraftComment } from "../useLocalDraftComments";

function statusLabel(status: LocalDraftComment["status"]): string {
  switch (status) {
    case "sync_failed":
      return "Sync failed";
    case "synced":
      return "Synced";
    case "submitted":
      return "Submitted";
    default:
      return "Local";
  }
}

export function DraftCommentComposer(props: {
  drafts: LocalDraftComment[];
  canSyncDrafts: boolean;
  isSyncing: boolean;
  isSubmitting: boolean;
  onChangeDraft: (localDraftId: string, body: string) => void;
  onDiscardDraft: (localDraftId: string) => void;
  onSyncDrafts: () => void;
  onSubmitReview: () => void;
}) {
  return (
    <div className="review-surface shrink-0 rounded-[24px] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--foreground-soft)]">
            Draft comments
          </p>
          <h3 className="mt-2 text-lg font-semibold text-white">
            Reviewer-authored feedback
          </h3>
        </div>
        <span className="rounded-full border border-[var(--border)] bg-white/5 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--foreground-soft)]">
          {props.drafts.length} drafts
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {props.drafts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-5 text-sm text-[var(--foreground-soft)]">
            Quote a pin to start drafting review comments.
          </div>
        ) : props.drafts.map((draft) => (
          <div key={draft.localDraftId} className="rounded-2xl border border-[var(--border)] bg-black/15 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--foreground-soft)]">
                {statusLabel(draft.status)}
              </span>
              <button
                type="button"
                onClick={() => props.onDiscardDraft(draft.localDraftId)}
                className="text-xs text-[var(--foreground-soft)]"
              >
                Discard
              </button>
            </div>
            <textarea
              value={draft.body}
              onChange={(event) => props.onChangeDraft(draft.localDraftId, event.target.value)}
              className="mt-3 min-h-28 w-full rounded-2xl border border-[var(--border)] bg-black/20 px-3 py-3 text-sm text-white outline-none"
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!props.canSyncDrafts || props.drafts.length === 0 || props.isSyncing}
          onClick={props.onSyncDrafts}
          className="rounded-full border border-[var(--border-strong)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {props.isSyncing ? "Syncing..." : "Sync drafts"}
        </button>
        <button
          type="button"
          disabled={!props.canSyncDrafts || props.drafts.length === 0 || props.isSubmitting}
          onClick={props.onSubmitReview}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--foreground)] disabled:opacity-40"
        >
          {props.isSubmitting ? "Submitting..." : "Submit review"}
        </button>
      </div>
    </div>
  );
}
