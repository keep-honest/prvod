"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReviewDiffLine } from "@/domain/entities/ReviewDiffSnapshot";

export type LocalDraftStatus = "local" | "sync_failed" | "synced" | "submitted";
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

  useEffect(() => {
    const reviewerKey = args.reviewerKey;
    if (!reviewerKey || typeof window === "undefined") {
      setDrafts([]);
      setOrphanPendingReviewId(null);
      return;
    }

    const raw = window.localStorage.getItem(storageKey(args.jobId, reviewerKey));
    if (!raw) {
      setDrafts([]);
      setOrphanPendingReviewId(null);
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
        return;
      }

      setDrafts(
        (parsed.drafts ?? []).map((draft) => normalizeDraft(draft, args.jobId, reviewerKey)),
      );
      setOrphanPendingReviewId(
        typeof parsed.orphanPendingReviewId === "number" ? parsed.orphanPendingReviewId : null,
      );
    } catch (err) {
      console.warn("[useLocalDraftComments] Failed to parse draft comments from localStorage", err);
      setDrafts([]);
      setOrphanPendingReviewId(null);
    }
  }, [args.jobId, args.reviewerKey]);

  useEffect(() => {
    if (!args.reviewerKey || typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(
        storageKey(args.jobId, args.reviewerKey),
        JSON.stringify({ drafts, orphanPendingReviewId }),
      );
    } catch (err) {
      console.warn("[useLocalDraftComments] Failed to persist draft comments to localStorage", err);
    }
  }, [args.jobId, args.reviewerKey, drafts, orphanPendingReviewId]);

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
      (draft) => draft.filePath === filePath && draft.status !== "synced",
    );

  return {
    drafts: activeDrafts,
    latestPendingReviewId,
    orphanPendingReviewId,
    saveThread,
    updateThreadBody,
    discardThread,
    markSynced,
    markSyncFailed,
    markSubmitted,
    markPendingReviewDiscarded,
    getThreadById,
    getThreadsStartingAtLineId,
    getThreadContainingLineId,
    getDraftsForFile,
    getUnsyncedDraftsForFile,
  };
}
