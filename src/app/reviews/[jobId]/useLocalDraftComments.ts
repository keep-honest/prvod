"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReviewDiffLine } from "@/domain/entities/ReviewDiffSnapshot";

export type LocalDraftStatus = "local" | "sync_failed" | "unmappable" | "synced" | "submitted";
export type LocalDraftSource = "manual";
export type LocalDraftKind = "line" | "range";

export interface LocalDraftComment {
  localDraftId: string;
  threadId: string;
  jobId: string;
  reviewerKey: string;
  source: LocalDraftSource;
  kind: LocalDraftKind;
  filePath: string;
  startLineId: string;
  endLineId: string;
  lineIds: string[];
  oldLineNumber: number | null;
  newLineNumber: number | null;
  position: number | null;
  pinIds: string[];
  anchorIds: string[];
  body: string;
  status: LocalDraftStatus;
  updatedAt: string;
  pendingReviewId: number | null;
}

export interface SaveLocalDraftThreadInput {
  threadId?: string | null;
  source: LocalDraftSource;
  kind: LocalDraftKind;
  filePath: string;
  startLine: ReviewDiffLine;
  endLine?: ReviewDiffLine | null;
  lineIds: string[];
  anchorIds: string[];
  pinIds: string[];
  body: string;
}

function storageKey(jobId: string, reviewerKey: string): string {
  return `prvod:review-drafts:${jobId}:${reviewerKey}`;
}

function backupStorageKey(jobId: string, reviewerKey: string): string {
  return `${storageKey(jobId, reviewerKey)}:backup`;
}

function createThreadId(startLineId: string): string {
  return `thread:${startLineId}:${Date.now()}`;
}

function normalizeDraftSource(): LocalDraftSource {
  return "manual";
}

function normalizeDraft(
  draft: Partial<LocalDraftComment> & { localDraftId?: string; threadId?: string },
  jobId: string,
  reviewerKey: string,
): LocalDraftComment {
  const lineIds = draft.lineIds ?? [];
  const startLineId = draft.startLineId ?? lineIds[0] ?? "";
  const endLineId = draft.endLineId ?? lineIds[lineIds.length - 1] ?? startLineId;
  const threadId = draft.threadId ?? draft.localDraftId ?? createThreadId(startLineId);

  return {
    localDraftId: draft.localDraftId ?? threadId,
    threadId,
    jobId,
    reviewerKey,
    source: normalizeDraftSource(),
    kind: draft.kind ?? (lineIds.length > 1 ? "range" : "line"),
    filePath: draft.filePath ?? "",
    startLineId,
    endLineId,
    lineIds,
    oldLineNumber: draft.oldLineNumber ?? null,
    newLineNumber: draft.newLineNumber ?? null,
    position: draft.position ?? null,
    pinIds: draft.pinIds ?? [],
    anchorIds: draft.anchorIds ?? [],
    body: draft.body ?? "",
    status: draft.status ?? "local",
    updatedAt: draft.updatedAt ?? new Date().toISOString(),
    pendingReviewId: draft.pendingReviewId ?? null,
  };
}

export function useLocalDraftComments(args: {
  jobId: string;
  reviewerKey: string | null;
}) {
  const [drafts, setDrafts] = useState<LocalDraftComment[]>([]);
  // Tracks a remote pending review whose comments no longer match local state
  // because the user discarded a synced draft. Cleared on successful sync.
  const [orphanPendingReviewId, setOrphanPendingReviewId] = useState<number | null>(null);
  // True when the persisted blob could not be parsed. The corrupt blob is
  // preserved under a backup key and the user is told drafts were lost.
  const [restoreError, setRestoreError] = useState(false);
  // Storage key whose initial load has been applied to state. The persist
  // effect must not run before the loaded drafts land in state — otherwise the
  // first mount persists the initial empty state and clobbers saved drafts.
  // State (not a ref) so the guard only opens on the post-load render.
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);

  useEffect(() => {
    const reviewerKey = args.reviewerKey;
    setLoadedStorageKey(null);
    setRestoreError(false);
    if (!reviewerKey || typeof window === "undefined") {
      setDrafts([]);
      setOrphanPendingReviewId(null);
      return;
    }

    const key = storageKey(args.jobId, reviewerKey);
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      setDrafts([]);
      setOrphanPendingReviewId(null);
      setLoadedStorageKey(key);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as
        | Array<Partial<LocalDraftComment>>
        | {
            drafts?: Array<Partial<LocalDraftComment>>;
            orphanPendingReviewId?: number | null;
          };
      // Backward compatible: legacy localStorage entries stored only the
      // drafts array. The new format is an object so we can persist the
      // orphan pending review marker through reloads.
      if (Array.isArray(parsed)) {
        setDrafts(parsed.map((draft) => normalizeDraft(draft, args.jobId, reviewerKey)));
        setOrphanPendingReviewId(null);
      } else {
        setDrafts(
          (parsed.drafts ?? []).map((draft) => normalizeDraft(draft, args.jobId, reviewerKey)),
        );
        setOrphanPendingReviewId(
          typeof parsed.orphanPendingReviewId === "number" ? parsed.orphanPendingReviewId : null,
        );
      }
    } catch (err) {
      console.warn("[useLocalDraftComments] Failed to parse draft comments from localStorage", err);
      // Preserve the corrupt blob before resetting so the user's drafts are
      // recoverable (manually or by a future migration) instead of silently
      // destroyed, and surface a visible restore-failure state.
      try {
        window.localStorage.setItem(backupStorageKey(args.jobId, reviewerKey), raw);
      } catch (backupErr) {
        console.warn("[useLocalDraftComments] Failed to back up corrupt draft blob", backupErr);
      }
      setDrafts([]);
      setOrphanPendingReviewId(null);
      setRestoreError(true);
    }
    setLoadedStorageKey(key);
  }, [args.jobId, args.reviewerKey]);

  useEffect(() => {
    if (!args.reviewerKey || typeof window === "undefined") {
      return;
    }

    const key = storageKey(args.jobId, args.reviewerKey);
    // Skip persisting until the initial load for this key has been applied to
    // state — prevents the first-mount effect ordering race from clobbering
    // previously saved drafts with the initial empty state.
    if (loadedStorageKey !== key) {
      return;
    }

    try {
      window.localStorage.setItem(
        key,
        JSON.stringify({ drafts, orphanPendingReviewId }),
      );
    } catch (err) {
      console.warn("[useLocalDraftComments] Failed to persist draft comments to localStorage", err);
    }
  }, [args.jobId, args.reviewerKey, drafts, orphanPendingReviewId, loadedStorageKey]);

  const saveThread = (input: SaveLocalDraftThreadInput) => {
    const reviewerKey = args.reviewerKey;
    if (!reviewerKey) {
      return null;
    }

    const nextThreadId = input.threadId ?? createThreadId(input.startLine.lineId);
    const startLine = input.startLine;
    const endLine = input.endLine ?? input.startLine;

    setDrafts((current) => {
      const nextDraft = normalizeDraft(
        {
          localDraftId: nextThreadId,
          threadId: nextThreadId,
          source: input.source,
          kind: input.kind,
          filePath: input.filePath,
          startLineId: startLine.lineId,
          endLineId: endLine.lineId,
          lineIds: input.lineIds,
          oldLineNumber: startLine.oldLineNumber,
          newLineNumber: startLine.newLineNumber,
          position: startLine.position,
          pinIds: input.pinIds,
          anchorIds: input.anchorIds,
          body: input.body,
          status: "local",
          pendingReviewId: null,
        },
        args.jobId,
        reviewerKey,
      );

      const existingIndex = current.findIndex((draft) => draft.threadId === nextThreadId);
      if (existingIndex < 0) {
        return [nextDraft, ...current];
      }

      const next = current.slice();
      next[existingIndex] = {
        ...nextDraft,
        pendingReviewId: current[existingIndex]?.pendingReviewId ?? null,
      };
      return next;
    });

    return nextThreadId;
  };

  const updateThreadBody = (threadId: string, body: string) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.threadId === threadId
          ? {
              ...draft,
              body,
              status: draft.status === "submitted" ? "submitted" : "local",
              updatedAt: new Date().toISOString(),
            }
          : draft),
    );
  };

  const discardThread = (threadId: string) => {
    setDrafts((current) => {
      const target = current.find((draft) => draft.threadId === threadId);
      // Track the orphan whenever a draft holding a remote pending-review
      // pointer is removed locally — regardless of local status. Editing a
      // synced draft via saveThread resets status to "local" but preserves
      // pendingReviewId, so we cannot gate orphan-tracking on status === "synced".
      // Submitted drafts are excluded because their pending review has already
      // been converted to a real review server-side and is no longer pending.
      if (target?.pendingReviewId != null && target.status !== "submitted") {
        // The remote pending review still contains this comment. Remember it
        // so the UI can block submit until the next sync recreates the
        // pending review without the discarded draft.
        setOrphanPendingReviewId(target.pendingReviewId);
      }
      return current.filter((draft) => draft.threadId !== threadId);
    });
  };

  const markSynced = (localDraftIds: string[], pendingReviewId: number) => {
    setDrafts((current) =>
      current.map((draft) =>
        localDraftIds.includes(draft.localDraftId)
          ? {
              ...draft,
              status: "synced",
              pendingReviewId,
              updatedAt: new Date().toISOString(),
            }
          : draft),
    );
    // The sync just recreated the remote pending review from current local
    // state, so any prior orphan reference is now reconciled.
    setOrphanPendingReviewId(null);
  };

  const markSyncFailed = (localDraftIds: string[]) => {
    setDrafts((current) =>
      current.map((draft) =>
        localDraftIds.includes(draft.localDraftId)
          ? {
              ...draft,
              status: "sync_failed",
              updatedAt: new Date().toISOString(),
            }
          : draft),
    );
  };

  // The server skipped these drafts during sync: their anchors have overview
  // precision or their lines are missing from the captured snapshot, so no
  // GitHub diff position exists in this walkthrough. Distinct from "local"
  // (never attempted) and "sync_failed" (transport error) — retrying will not
  // help until the walkthrough is regenerated. Editing the draft resets it to
  // "local" via updateThreadBody.
  const markUnmappable = (localDraftIds: string[]) => {
    if (localDraftIds.length === 0) return;
    setDrafts((current) =>
      current.map((draft) =>
        localDraftIds.includes(draft.localDraftId)
          ? {
              ...draft,
              status: "unmappable",
              updatedAt: new Date().toISOString(),
            }
          : draft),
    );
  };

  const markPendingReviewDiscarded = (discardedPendingReviewId: number) => {
    // The orphaned pending review was deleted on GitHub. Strip the now-stale
    // pendingReviewId from any drafts that still referenced it so the next
    // sync starts fresh, and clear the orphan marker.
    setDrafts((current) =>
      current.map((draft) =>
        draft.pendingReviewId === discardedPendingReviewId
          ? { ...draft, pendingReviewId: null, status: draft.status === "synced" ? "local" : draft.status }
          : draft),
    );
    setOrphanPendingReviewId(null);
  };

  const markSubmitted = (pendingReviewId: number) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.pendingReviewId === pendingReviewId
          ? {
              ...draft,
              status: "submitted",
              updatedAt: new Date().toISOString(),
            }
          : draft),
    );
  };

  const activeDrafts = useMemo(
    () => drafts.filter((draft) => draft.status !== "submitted"),
    [drafts],
  );

  const latestPendingReviewId = useMemo(
    () => activeDrafts.find((draft) => draft.pendingReviewId !== null)?.pendingReviewId ?? null,
    [activeDrafts],
  );

  const threadsById = useMemo(() => {
    const index = new Map<string, LocalDraftComment>();
    for (const draft of activeDrafts) {
      index.set(draft.threadId, draft);
    }
    return index;
  }, [activeDrafts]);

  const threadStartsByLineId = useMemo(() => {
    const index = new Map<string, LocalDraftComment[]>();
    for (const draft of activeDrafts) {
      const bucket = index.get(draft.startLineId) ?? [];
      bucket.push(draft);
      index.set(draft.startLineId, bucket);
    }
    return index;
  }, [activeDrafts]);

  const threadContainsByLineId = useMemo(() => {
    const index = new Map<string, LocalDraftComment[]>();
    for (const draft of activeDrafts) {
      for (const lineId of draft.lineIds) {
        const bucket = index.get(lineId) ?? [];
        bucket.push(draft);
        index.set(lineId, bucket);
      }
    }
    return index;
  }, [activeDrafts]);

  const getThreadById = (threadId: string) => threadsById.get(threadId) ?? null;

  const getThreadsStartingAtLineId = (lineId: string) => threadStartsByLineId.get(lineId) ?? [];

  const getThreadContainingLineId = (lineId: string) =>
    threadContainsByLineId.get(lineId)?.[0] ?? null;

  const getDraftsForFile = (filePath: string | null) =>
    activeDrafts.filter((draft) => draft.filePath === filePath);

  const getUnsyncedDraftsForFile = (filePath: string | null) =>
    activeDrafts.filter(
      (draft) =>
        draft.filePath === filePath
        // Unmappable drafts have no diff position in this walkthrough — a
        // retry cannot sync them, so they don't count as pending-sync work.
        && draft.status !== "synced"
        && draft.status !== "unmappable",
    );

  return {
    drafts: activeDrafts,
    latestPendingReviewId,
    orphanPendingReviewId,
    restoreError,
    saveThread,
    updateThreadBody,
    discardThread,
    markSynced,
    markSyncFailed,
    markUnmappable,
    markSubmitted,
    markPendingReviewDiscarded,
    getThreadById,
    getThreadsStartingAtLineId,
    getThreadContainingLineId,
    getDraftsForFile,
    getUnsyncedDraftsForFile,
  };
}
