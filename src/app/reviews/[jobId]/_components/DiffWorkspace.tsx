"use client";

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ReviewDiffLine,
  ReviewDiffSnapshot,
  SceneDiffAnchor,
} from "@/domain/entities/ReviewDiffSnapshot";
import type { LocalDraftComment, LocalDraftKind, LocalDraftSource } from "../useLocalDraftComments";
import {
  findFocusFilePath,
  findPrimaryAnchorForScene,
  findRowIndexForAnchor,
  flattenDiffWorkspaceRowsForFile,
} from "./diffWorkspaceState";

export interface DiffCommentComposer {
  threadId?: string | null;
  source: LocalDraftSource;
  kind: LocalDraftKind;
  filePath: string;
  startLineId: string;
  endLineId: string;
  lineIds: string[];
  body: string;
  isSaved: boolean;
}

interface DiffWorkspaceLineContext {
  filePath: string;
  line: ReviewDiffLine;
}

function rowTone(kind: "context" | "added" | "removed" | "meta"): string {
  switch (kind) {
    case "added":
      return "bg-[#12261e] text-[#c9d1d9]";
    case "removed":
      return "bg-[#30191b] text-[#c9d1d9]";
    case "meta":
      return "bg-[#161b22] text-[#8b949e]";
    default:
      return "bg-[#0d1117] text-[#c9d1d9]";
  }
}

function commentTone(kind: "context" | "added" | "removed" | "meta"): string {
  switch (kind) {
    case "added":
      return "bg-[#49371b] text-[#f0e6d2]";
    case "removed":
      return "bg-[#49371b] text-[#f0e6d2]";
    case "meta":
      return "bg-[#2f2516] text-[#c8b88f]";
    default:
      return "bg-[#3c2f1c] text-[#f0e6d2]";
  }
}

function pendingCommentTone(kind: "context" | "added" | "removed" | "meta"): string {
  switch (kind) {
    case "added":
    case "removed":
      return "bg-[#352912] text-[#f0e6d2]";
    case "meta":
      return "bg-[#241e14] text-[#c8b88f]";
    default:
      return "bg-[#2d2416] text-[#f0e6d2]";
  }
}

function markerTone(kind: "context" | "added" | "removed" | "meta"): string {
  switch (kind) {
    case "added":
      return "text-[#3fb950]";
    case "removed":
      return "text-[#f85149]";
    case "meta":
      return "text-[#8b949e]";
    default:
      return "text-[#6e7681]";
  }
}

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

function formatComposerLabel(composer: DiffCommentComposer): string {
  return composer.kind === "range" ? "Comment on selected range" : "Comment on line";
}

export function DiffWorkspace(props: {
  diffSnapshot: ReviewDiffSnapshot;
  sceneAnchors: SceneDiffAnchor[];
  activeSceneNumber: number | null;
  focusFilePath?: string | null;
  snapshotStatus: "current" | "outdated";
  fileThreads: LocalDraftComment[];
  syncableFileThreadCount: number;
  allDraftCount: number;
  canSyncDrafts: boolean;
  composer?: DiffCommentComposer | null;
  saveBlockedReason?: string | null;
  isSyncingFileComments?: boolean;
  isSyncingAllComments?: boolean;
  isSubmittingReview?: boolean;
  pendingReviewId?: number | null;
  orphanPendingReviewId?: number | null;
  detachedMode?: boolean;
  fillHeight?: boolean;
  onSelectLine?: (context: DiffWorkspaceLineContext) => void;
  onSelectThread?: (threadId: string) => void;
  onComposerBodyChange?: (body: string) => void;
  onComposerDiscard?: () => void;
  onComposerDelete?: () => void;
  onComposerSave?: () => void;
  onSyncFileComments?: () => void;
  onSyncAllComments?: () => void;
  onSubmitReview?: () => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRestoreEmbedded?: () => void;
  onResizePointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const deferredActiveSceneNumber = useDeferredValue(props.activeSceneNumber);

  const activeAnchor = useMemo(
    () => findPrimaryAnchorForScene(deferredActiveSceneNumber, props.sceneAnchors),
    [deferredActiveSceneNumber, props.sceneAnchors],
  );

  const activeFilePath = useMemo(
    () =>
      findFocusFilePath({
        activeAnchor,
        preferredFilePath: props.focusFilePath,
        availableFilePaths: props.diffSnapshot.files.map((file) => file.filePath),
      }),
    [activeAnchor, props.diffSnapshot.files, props.focusFilePath],
  );

  const activeFile = useMemo(
    () => props.diffSnapshot.files.find((file) => file.filePath === activeFilePath) ?? null,
    [activeFilePath, props.diffSnapshot.files],
  );

  const rows = useMemo(
    () => (activeFile ? flattenDiffWorkspaceRowsForFile(activeFile) : []),
    [activeFile],
  );

  const activeLineIds = useMemo(
    () => new Set(activeAnchor?.lineIds ?? []),
    [activeAnchor],
  );

  const commentedLineIds = useMemo(() => {
    const index = new Map<string, LocalDraftComment>();
    for (const thread of props.fileThreads) {
      for (const lineId of thread.lineIds) {
        if (!index.has(lineId)) {
          index.set(lineId, thread);
        }
      }
    }
    return index;
  }, [props.fileThreads]);

  const threadStarts = useMemo(() => {
    const index = new Map<string, LocalDraftComment[]>();
    for (const thread of props.fileThreads) {
      const bucket = index.get(thread.startLineId) ?? [];
      bucket.push(thread);
      index.set(thread.startLineId, bucket);
    }
    return index;
  }, [props.fileThreads]);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!viewportRef.current) {
      return;
    }

    const targetIndex = findRowIndexForAnchor(rows, activeAnchor);
    if (targetIndex < 0) {
      viewportRef.current.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const targetRow = rows[targetIndex];
    if (!targetRow || targetRow.type !== "line") {
      return;
    }

    const targetElement = viewportRef.current.querySelector<HTMLElement>(
      `[data-line-id="${targetRow.line.lineId}"]`,
    );
    targetElement?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [activeAnchor, rows]);

  const viewportClassName = props.fillHeight
    ? "min-h-[320px] flex-1 overflow-auto overscroll-contain rounded-b-[12px] bg-[#0d1117]"
    : "h-[420px] overflow-auto overscroll-contain rounded-b-[12px] bg-[#0d1117] md:h-[520px] xl:h-[560px]";

  const stopHeaderPointer = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[#30363d] bg-[#0d1117] shadow-[0_0_0_1px_rgba(48,54,61,0.18)]">
      <div
        data-testid="diff-workspace-header"
        className="cursor-grab border-b border-[#30363d] bg-[#161b22] px-4 py-3 active:cursor-grabbing"
        onPointerDown={props.onHeaderPointerDown}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <p
              data-testid="diff-workspace-active-file"
              className="truncate font-mono text-[13px] font-medium text-[#c9d1d9]"
            >
              {activeFilePath ?? "No diff available"}
            </p>
            {activeFile?.oldPath ? (
              <p className="truncate text-xs text-[#8b949e]">from {activeFile.oldPath}</p>
            ) : null}
          </div>
          <div className="relative flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onPointerDown={stopHeaderPointer}
              onClick={props.onSyncFileComments}
              disabled={!props.canSyncDrafts || props.syncableFileThreadCount === 0 || props.isSyncingFileComments}
              className="rounded-md border border-[#30363d] bg-[#1f6feb] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {props.isSyncingFileComments
                ? "Syncing file..."
                : `Sync file comments${props.syncableFileThreadCount > 0 ? ` (${props.syncableFileThreadCount})` : ""}`}
            </button>
            <button
              type="button"
              onPointerDown={stopHeaderPointer}
              onClick={props.onSyncAllComments}
              disabled={
                !props.canSyncDrafts
                || props.isSyncingAllComments
                || (props.allDraftCount === 0 && !props.orphanPendingReviewId)
              }
              className="rounded-md border border-[#30363d] bg-[#238636] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {props.isSyncingAllComments
                ? "Syncing all..."
                : props.orphanPendingReviewId && props.allDraftCount === 0
                  ? "Resync to drop deleted comment"
                  : `Sync all comments${props.allDraftCount > 0 ? ` (${props.allDraftCount})` : ""}`}
            </button>
            <button
              type="button"
              data-testid="diff-workspace-submit-review"
              onPointerDown={stopHeaderPointer}
              onClick={props.onSubmitReview}
              disabled={
                !props.canSyncDrafts ||
                !props.pendingReviewId ||
                props.isSubmittingReview ||
                props.isSyncingFileComments ||
                props.isSyncingAllComments ||
                props.snapshotStatus === "outdated" ||
                // Block submit while ANY draft is unsynced (status local /
                // sync_failed / edited synced-then-local) — otherwise we'd
                // publish the previous remote pending review whose body no
                // longer matches local state.
                props.allDraftCount > 0 ||
                // Block submit when a synced draft was discarded — the remote
                // pending review still contains the deleted comment until the
                // next sync recreates the review without it.
                Boolean(props.orphanPendingReviewId)
              }
              className="rounded-md border border-[#30363d] bg-[#8957e5] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {props.isSubmittingReview ? "Submitting review..." : "Submit review"}
            </button>
            {props.snapshotStatus === "outdated" ? (
              <span className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-200">
                Outdated snapshot
              </span>
            ) : null}
            {props.detachedMode ? (
              <button
                type="button"
                onPointerDown={stopHeaderPointer}
                onClick={props.onRestoreEmbedded}
                className="rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-1.5 text-xs font-medium text-[#c9d1d9]"
              >
                Restore diff
              </button>
            ) : (
              <span className="rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[#8b949e]">
                Drag to float
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={`px-3 py-3 ${props.fillHeight ? "flex min-h-0 flex-1 flex-col" : ""}`}>
        <div
          ref={viewportRef}
          data-testid="diff-workspace-viewport"
          className={viewportClassName}
        >
          <div className="min-w-[1120px]">
            {rows.length === 0 ? (
              <div className="px-5 py-6 text-sm text-[#8b949e]">
                {activeFilePath
                  ? `${activeFilePath} is not available in the captured diff snapshot.`
                  : "This scene does not currently map to a renderable diff region."}
              </div>
            ) : rows.map((row) => {
              if (row.type === "file") {
                return null;
              }

              if (row.type === "hunk") {
                return (
                  <div
                    key={row.id}
                    className="border-b border-[#30363d] bg-[#161b22] px-4 py-2 font-mono text-xs text-[#8b949e]"
                  >
                    {row.header}
                  </div>
                );
              }

              const threadAtLine = commentedLineIds.get(row.line.lineId) ?? null;
              const threadStartsAtLine = threadStarts.get(row.line.lineId) ?? [];
              const composerOpen = props.composer?.lineIds.includes(row.line.lineId) ?? false;
              const composerStartsHere = props.composer?.startLineId === row.line.lineId;
              const rowCommentState = threadAtLine ? "saved" : composerOpen ? "pending" : undefined;
              const activateLine = () => {
                if (threadAtLine?.threadId) {
                  props.onSelectThread?.(threadAtLine.threadId);
                  return;
                }
                if (row.line.kind === "meta") {
                  return;
                }
                props.onSelectLine?.({ filePath: row.filePath, line: row.line });
              };
              const shouldIgnoreLinePointer = (target: EventTarget | null) =>
                target instanceof HTMLElement &&
                Boolean(target.closest("button, textarea"));

              return (
                <div key={row.id}>
                  <div
                    data-testid={`diff-line-${row.line.lineId}`}
                    data-line-id={row.line.lineId}
                    data-comment-state={rowCommentState}
                    onClick={(event) => {
                      if (shouldIgnoreLinePointer(event.target)) {
                        return;
                      }
                      activateLine();
                    }}
                    className={`grid min-w-full cursor-pointer [grid-template-columns:28px_56px_56px_18px_minmax(860px,1fr)] items-stretch border-b border-[#21262d] font-mono text-[13px] leading-6 ${
                      activeLineIds.has(row.line.lineId)
                        ? "relative z-[1] shadow-[inset_3px_0_0_0_rgba(56,139,253,0.95)]"
                        : ""
                    } ${
                      composerOpen ? "shadow-[inset_0_0_0_1px_rgba(110,118,129,0.55)]" : ""
                    } ${
                      threadAtLine
                        ? commentTone(row.line.kind)
                        : composerOpen
                          ? pendingCommentTone(row.line.kind)
                          : rowTone(row.line.kind)
                    }`}
                  >
                    <div className="flex min-h-0 items-center justify-center gap-1 border-r border-[#21262d] bg-[#0d1117]">
                      {threadStartsAtLine.map((thread) => (
                        <button
                          key={thread.threadId}
                          type="button"
                          data-testid={`review-thread-dot-${thread.threadId}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onSelectThread?.(thread.threadId);
                          }}
                          className="h-3.5 w-3.5 rounded-full border border-[#c9d1d9]/70 bg-[#c9d1d9] transition-transform hover:scale-110"
                          title="Open comment"
                        />
                      ))}
                    </div>
                    <div className="border-r border-[#21262d] px-3 py-1 text-right text-[12px] text-[#8b949e]">
                      {row.line.oldLineNumber ?? ""}
                    </div>
                    <div className="border-r border-[#21262d] px-3 py-1 text-right text-[12px] text-[#8b949e]">
                      {row.line.newLineNumber ?? ""}
                    </div>
                    <div className={`border-r border-[#21262d] px-1 py-1 text-center text-[12px] ${markerTone(row.line.kind)}`}>
                      {row.line.kind === "added" ? "+" : row.line.kind === "removed" ? "-" : " "}
                    </div>
                    <div className="w-full overflow-x-auto px-3 py-1">
                      <pre className="m-0 whitespace-pre text-current">{row.line.text}</pre>
                    </div>
                  </div>

                  {composerStartsHere && props.composer ? (
                    <div className="grid min-w-full [grid-template-columns:28px_56px_56px_18px_minmax(860px,1fr)] border-b border-[#21262d] bg-[#0d1117]">
                      <div className="border-r border-[#21262d] bg-[#0d1117]" />
                      <div className="border-r border-[#21262d] bg-[#0d1117]" />
                      <div className="border-r border-[#21262d] bg-[#0d1117]" />
                      <div className="border-r border-[#21262d] bg-[#0d1117]" />
                      <div className="px-3 py-3">
                        <div className="rounded-[10px] border border-[#30363d] bg-[#161b22] p-3 shadow-[0_12px_30px_rgba(0,0,0,0.24)]">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-xs font-medium text-[#c9d1d9]">
                                {formatComposerLabel(props.composer)}
                              </p>
                              <p className="mt-1 text-xs text-[#8b949e]">
                                Write your own review comment, then add it to the diff.
                              </p>
                            </div>
                            {props.composer.threadId ? (
                              <span className="rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[#8b949e]">
                                {statusLabel(
                                  props.fileThreads.find((thread) => thread.threadId === props.composer?.threadId)?.status ?? "local",
                                )}
                              </span>
                            ) : null}
                          </div>
                          <textarea
                            data-testid="diff-inline-comment"
                            value={props.composer.body}
                            placeholder="Write your review comment..."
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => props.onComposerBodyChange?.(event.target.value)}
                            className="mt-3 min-h-[108px] w-full rounded-[8px] border border-[#30363d] bg-[#0d1117] px-3 py-3 text-sm text-[#c9d1d9] outline-none"
                          />
                          <div className="mt-3 flex items-center justify-between gap-3">
                            <p
                              data-testid={props.saveBlockedReason ? "diff-comment-save-blocked" : undefined}
                              className={`text-xs ${props.saveBlockedReason ? "text-amber-200" : "text-[#8b949e]"}`}
                            >
                              {props.saveBlockedReason ??
                                "Only added comments create gutter markers and sync to the pull request."}
                            </p>
                            <div className="flex items-center gap-2">
                              {props.composer.isSaved && props.composer.threadId ? (
                                <button
                                  type="button"
                                  onClick={props.onComposerDelete}
                                  className="rounded-md border border-[#da3633]/50 px-3 py-1.5 text-xs text-[#ff7b72]"
                                >
                                  Delete comment
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={props.onComposerDiscard}
                                className="rounded-md border border-[#30363d] px-3 py-1.5 text-xs text-[#8b949e]"
                              >
                                {props.composer.isSaved ? "Close" : "Discard"}
                              </button>
                              <button
                                type="button"
                                onClick={props.onComposerSave}
                                disabled={
                                  props.composer.body.trim().length === 0 ||
                                  Boolean(props.saveBlockedReason)
                                }
                                title={props.saveBlockedReason ?? undefined}
                                className="rounded-md border border-[#30363d] bg-[#1f6feb] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                              >
                                {props.composer.isSaved ? "Update comment" : "Add comment"}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {props.detachedMode ? (
        <div className="flex items-center justify-between gap-3 border-t border-[#30363d] bg-[#161b22] px-3 py-2">
          <p className="text-xs text-[#8b949e]">
            Drag the header to move. Drag the corner to resize.
          </p>
          <button
            type="button"
            onPointerDown={stopHeaderPointer}
            onClick={props.onRestoreEmbedded}
            className="rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-1.5 text-xs font-medium text-[#c9d1d9]"
          >
            Restore diff
          </button>
          <button
            type="button"
            data-testid="floating-diff-resize-handle"
            aria-label="Resize floating diff"
            title="Drag to resize floating diff"
            onPointerDown={props.onResizePointerDown}
            className="ml-2 flex h-10 w-10 cursor-nwse-resize items-end justify-end rounded-md border border-[#30363d] bg-[#0d1117] p-2 text-base leading-none text-[#c9d1d9] transition-colors hover:border-[#58a6ff] hover:text-white"
          >
            ↘
          </button>
        </div>
      ) : null}
    </div>
  );
}
