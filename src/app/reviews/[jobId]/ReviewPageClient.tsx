"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { ArrowLeft, Maximize2, Minimize2, Network, Pause, Play, RotateCcw } from "lucide-react";
import type { ReviewFileEntry, ReviewPageModel } from "@/domain/entities/ReviewPage";
import type {
  ReviewDiffLine,
  ReviewPinCategory,
} from "@/domain/entities/ReviewDiffSnapshot";
import {
  createReviewPageMetricEvent,
  emitReviewPageMetric,
} from "@/lib/reviews/reviewPageMetrics";
import { DraftSyncError, submitDraftComments, syncDraftComments } from "@/lib/reviews/reviewDraftSync";
import { findDiffLineById } from "@/lib/reviews/reviewDiffSnapshot";
import { DiffWorkspace, type DiffCommentComposer } from "./_components/DiffWorkspace";
import { FileRail } from "./_components/FileRail";
import { GraphModal } from "./_components/GraphModal";
import { MobileReviewTray } from "./_components/MobileReviewTray";
import { ReviewHeader } from "./_components/ReviewHeader";
import { ReviewShell } from "./_components/ReviewShell";
import { ScenePicker } from "./_components/ScenePicker";
import { LiveTranscript } from "./_components/LiveTranscript";
import { TranscriptTimeline } from "./_components/TranscriptTimeline";
import { findPrimaryAnchorForScene } from "./_components/diffWorkspaceState";
import { formatTimestamp } from "./_components/reviewFormatters";
import {
  _applyHandoffOnClose,
  _snapshotMainPlayback,
  type PipHandoffSnapshot,
} from "./pipHandoff";
import {
  type LocalDraftComment,
  useLocalDraftComments,
} from "./useLocalDraftComments";
import { useReviewPlayback } from "./useReviewPlayback";

const MIN_DETACHED_DIFF_WIDTH = 620;
const MIN_DETACHED_DIFF_HEIGHT = 360;
const DETACHED_DIFF_MARGIN = 16;
const FILE_BADGE_ORDER: ReviewPinCategory[] = ["risk", "test_gap", "question", "intent"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Maps a draft sync/submit failure to user-facing guidance. Branches on the
 * server's error code (preserved by DraftSyncError) — most importantly the
 * 409 OUTDATED_WALKTHROUGH conflict, which is only fixable by regenerating.
 */
function describeDraftActionError(err: unknown, fallback: string): string {
  if (err instanceof DraftSyncError) {
    if (err.code === "OUTDATED_WALKTHROUGH") {
      return "This walkthrough no longer matches the pull request. Regenerate the walkthrough, then try again.";
    }
    if (err.code === "AUTH_REQUIRED" || err.status === 401) {
      return "Your GitHub session is no longer valid. Sign in again to continue.";
    }
    if (err.code === "AUTH_FORBIDDEN" || err.status === 403) {
      return "You do not have permission to write review comments for this repository.";
    }
    return err.serverMessage ?? fallback;
  }
  return fallback;
}

interface ComposerThreadSelection {
  threadId?: string | null;
  filePath: string;
  startLine: ReviewDiffLine;
  endLine: ReviewDiffLine;
  lineIds: string[];
  anchorIds: string[];
  pinIds: string[];
  source: "manual";
  kind: "line" | "range";
  body: string;
  isSaved: boolean;
}

export function ReviewPageClient(props: {
  reviewPage: ReviewPageModel;
  categoryMappingEnabled?: boolean;
}) {
  const playback = useReviewPlayback(props.reviewPage);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileFocusSource, setFileFocusSource] = useState<"auto" | "manual">("auto");
  const [composer, setComposer] = useState<ComposerThreadSelection | null>(null);
  const [isSyncingFileComments, setIsSyncingFileComments] = useState(false);
  const [isSyncingAllComments, setIsSyncingAllComments] = useState(false);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"playback" | "diff">("playback");
  const [isHydrated, setIsHydrated] = useState(false);
  const [theaterMode, setTheaterMode] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("prvod-theater") !== "false" : true,
  );
  const hasGraph = Boolean(props.reviewPage.reviewGraph);
  const [graphModalOpen, setGraphModalOpen] = useState(false);
  const [isDiffDetached, setIsDiffDetached] = useState(false);
  const [detachedDiffRect, setDetachedDiffRect] = useState({
    x: 120,
    y: 120,
    width: 920,
    height: 620,
  });
  const desktopLayoutRef = useRef<ImperativePanelGroupHandle | null>(null);
  const desktopWorkspaceRef = useRef<ImperativePanelGroupHandle | null>(null);
  const dragStateRef = useRef<
    | {
        mode: "move";
        offsetX: number;
        offsetY: number;
      }
    | {
        mode: "resize";
        startX: number;
        startY: number;
        startRect: { x: number; y: number; width: number; height: number };
      }
    | null
  >(null);
  // Captures the main-page video state at the instant the modal opens
  // so we can hand control back when the modal closes.
  const pipHandoffRef = useRef<PipHandoffSnapshot | null>(null);
  const pageLoadStartedAtRef = useRef(
    typeof performance !== "undefined" ? performance.now() : 0,
  );
  const metadataMetricEmittedRef = useRef(false);
  const pendingTransitionMetricRef = useRef<{
    metricName: "review_file_focus_ready" | "review_return_to_main_ready";
    startedAt: number;
  } | null>(null);
  const localDrafts = useLocalDraftComments({
    jobId: props.reviewPage.jobId,
    reviewerKey: props.reviewPage.reviewerKey,
  });
  const saveBlockedReason = useMemo(() => {
    if (!props.reviewPage.reviewerKey) {
      return "Sign in with GitHub to add review comments.";
    }
    if (!props.reviewPage.canSyncDrafts) {
      return "You need PR comment access before adding review comments.";
    }
    return null;
  }, [props.reviewPage.canSyncDrafts, props.reviewPage.reviewerKey]);

  const selectedFile = useMemo(
    () =>
      props.reviewPage.files.find((file) => file.filePath === selectedFilePath) ?? null,
    [props.reviewPage.files, selectedFilePath],
  );

  const selectedFileScenes = useMemo(() => {
    if (!selectedFile) return [];
    return selectedFile.sceneNumbers
      .map((sceneNumber) =>
        props.reviewPage.scenes.find((scene) => scene.sceneNumber === sceneNumber) ?? null,
      )
      .filter((scene): scene is NonNullable<typeof scene> => Boolean(scene));
  }, [props.reviewPage.scenes, selectedFile]);

  const primarySelectedScene = selectedFileScenes[0] ?? null;
  const playbackModeLabel = props.reviewPage.headline;
  const anchorsById = useMemo(
    () => new Map(props.reviewPage.sceneAnchors.map((anchor) => [anchor.anchorId, anchor] as const)),
    [props.reviewPage.sceneAnchors],
  );
  const activeSceneAnchor = useMemo(
    () => findPrimaryAnchorForScene(playback.activeScene?.sceneNumber ?? null, props.reviewPage.sceneAnchors),
    [playback.activeScene?.sceneNumber, props.reviewPage.sceneAnchors],
  );
  const fileCategoriesByPath = useMemo(() => {
    if (!props.categoryMappingEnabled) {
      return {};
    }

    const next: Record<string, ReviewPinCategory[]> = {};

    for (const pin of props.reviewPage.pins) {
      const anchoredFiles = Array.from(
        new Set(
          pin.anchorIds
            .map((anchorId) => anchorsById.get(anchorId)?.filePath ?? null)
            .filter((filePath): filePath is string => Boolean(filePath)),
        ),
      );

      for (const filePath of anchoredFiles) {
        const existing = next[filePath] ?? [];
        if (!existing.includes(pin.category)) {
          existing.push(pin.category);
        }
        next[filePath] = existing;
      }
    }

    for (const filePath of Object.keys(next)) {
      next[filePath] = next[filePath]
        .slice()
        .sort((left, right) => FILE_BADGE_ORDER.indexOf(left) - FILE_BADGE_ORDER.indexOf(right));
    }

    return next;
  }, [anchorsById, props.categoryMappingEnabled, props.reviewPage.pins]);
  const allUnsyncedDrafts = useMemo(
    () => localDrafts.drafts.filter(
      (draft) =>
        draft.status !== "synced"
        // Unmappable drafts have no diff position in this walkthrough —
        // re-syncing cannot publish them, so they aren't pending-sync work.
        && draft.status !== "unmappable"
        && draft.body.trim().length > 0,
    ),
    [localDrafts.drafts],
  );
  const allFileThreads = useMemo(
    () => localDrafts.getDraftsForFile(selectedFilePath),
    [localDrafts, localDrafts.drafts, selectedFilePath],
  );
  const activeFileDrafts = useMemo(
    () =>
      localDrafts
        .getUnsyncedDraftsForFile(selectedFilePath)
        .filter((draft) => draft.body.trim().length > 0),
    [localDrafts, localDrafts.drafts, selectedFilePath],
  );
  const diffComposer = useMemo<DiffCommentComposer | null>(() => {
    if (!composer) {
      return null;
    }

    return {
      threadId: composer.threadId,
      source: composer.source,
      kind: composer.kind,
      filePath: composer.filePath,
      startLineId: composer.startLine.lineId,
      endLineId: composer.endLine.lineId,
      lineIds: composer.lineIds,
      body: composer.body,
      isSaved: composer.isSaved,
    };
  }, [composer]);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!activeSceneAnchor?.filePath) {
      return;
    }

    if (fileFocusSource === "manual") {
      return;
    }

    if (composer && !composer.isSaved) {
      return;
    }

    setSelectedFilePath((current) =>
      current === activeSceneAnchor.filePath ? current : activeSceneAnchor.filePath,
    );
  }, [activeSceneAnchor?.filePath, composer, fileFocusSource]);

  useEffect(() => {
    if (!composer?.isSaved || !selectedFilePath) {
      return;
    }

    if (composer.filePath !== selectedFilePath) {
      setComposer(null);
    }
  }, [composer, selectedFilePath]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (dragState.mode === "move") {
        setDetachedDiffRect((current) => ({
          ...current,
          x: clamp(
            event.clientX - dragState.offsetX,
            DETACHED_DIFF_MARGIN,
            viewportWidth - current.width - DETACHED_DIFF_MARGIN,
          ),
          y: clamp(
            event.clientY - dragState.offsetY,
            DETACHED_DIFF_MARGIN,
            viewportHeight - current.height - DETACHED_DIFF_MARGIN,
          ),
        }));
        return;
      }

      setDetachedDiffRect((current) => {
        const width = clamp(
          dragState.startRect.width + (event.clientX - dragState.startX),
          MIN_DETACHED_DIFF_WIDTH,
          viewportWidth - dragState.startRect.x - DETACHED_DIFF_MARGIN,
        );
        const height = clamp(
          dragState.startRect.height + (event.clientY - dragState.startY),
          MIN_DETACHED_DIFF_HEIGHT,
          viewportHeight - dragState.startRect.y - DETACHED_DIFF_MARGIN,
        );

        return {
          ...current,
          width,
          height,
        };
      });
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const toggleTheaterMode = () => {
    setTheaterMode((prev) => {
      const next = !prev;
      localStorage.setItem("prvod-theater", String(next));
      return next;
    });
  };

  useEffect(() => {
    desktopLayoutRef.current?.setLayout(theaterMode ? [12, 88] : [16, 84]);
    desktopWorkspaceRef.current?.setLayout(theaterMode ? [86, 14] : [80, 20]);
  }, [theaterMode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "t" && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        toggleTheaterMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    emitReviewPageMetric(
      createReviewPageMetricEvent(
        "review_shell_ready",
        performance.now() - pageLoadStartedAtRef.current,
        {
          fileCount: props.reviewPage.files.length,
          sceneCount: props.reviewPage.scenes.length,
          visibility: props.reviewPage.visibility,
        },
      ),
    );
  }, [props.reviewPage.files.length, props.reviewPage.scenes.length, props.reviewPage.visibility]);

  useEffect(() => {
    const pendingMetric = pendingTransitionMetricRef.current;
    if (!pendingMetric) {
      return;
    }

    const isReady =
      (pendingMetric.metricName === "review_file_focus_ready" &&
        playback.mode === "file_focus" &&
        playback.activeScene !== null) ||
      (pendingMetric.metricName === "review_return_to_main_ready" &&
        playback.mode === "full_review");

    if (!isReady) {
      return;
    }

    emitReviewPageMetric(
      createReviewPageMetricEvent(
        pendingMetric.metricName,
        performance.now() - pendingMetric.startedAt,
        {
          activeSceneNumber: playback.activeScene?.sceneNumber ?? null,
          selectedFilePath,
        },
      ),
    );
    pendingTransitionMetricRef.current = null;
  }, [playback.activeScene, playback.mode, selectedFilePath]);

  const handleSelectScene = (sceneNumber: number) => {
    pendingTransitionMetricRef.current = {
      metricName: "review_file_focus_ready",
      startedAt: performance.now(),
    };
    playback.selectScene(sceneNumber);
  };

  const handleSelectFile = (file: ReviewFileEntry) => {
    if (composer && composer.filePath !== file.filePath) {
      setComposer(null);
    }
    setFileFocusSource("manual");
    setSelectedFilePath(file.filePath);
    const targetScene = file.primarySceneNumber ?? file.sceneNumbers[0];
    if (targetScene !== undefined) {
      handleSelectScene(targetScene);
    }
  };

  const handleTimelineSelectScene = (sceneNumber: number) => {
    setComposer(null);
    setFileFocusSource("auto");
    setSelectedFilePath(null);
    playback.jumpToScene(sceneNumber);
  };

  const handleBackToReview = () => {
    pendingTransitionMetricRef.current = {
      metricName: "review_return_to_main_ready",
      startedAt: performance.now(),
    };
    setFileFocusSource("auto");
    setSelectedFilePath(null);
    playback.backToReview();
  };

  /**
   * Map button click — snapshot the main video state and hand off to
   * the in-modal PiP. The main `<video>` is paused so only one
   * decoder runs at a time. Pure decision logic lives in
   * `_snapshotMainPlayback` so tests can exercise the NaN-guard
   * branches without a real video element.
   */
  const handleOpenGraphModal = () => {
    const video = playback.videoRef.current;
    if (!video) {
      // Not fatal — the modal can still open and show the graph — but
      // this is an invariant violation worth surfacing because it
      // means the main video element never mounted.
      console.warn("[ReviewPageClient] Opened Map with null video ref");
    }
    pipHandoffRef.current = _snapshotMainPlayback({
      currentVideoTimeMs: playback.currentVideoTimeMs,
      isPlaying: playback.isPlaying,
    });
    if (video) {
      try {
        video.pause();
      } catch (err) {
        console.error("[ReviewPageClient] Failed to pause main video on Map open", err);
      }
    }
    setGraphModalOpen(true);
  };

  /**
   * Modal close (Escape / close X / overlay click). Delegates to
   * `_applyHandoffOnClose` so the full seek + resume decision matrix
   * is testable as a pure function. `activeScene` on the main hook
   * auto-updates via `handleTimeUpdate` once the seek lands (verified
   * by reading `useReviewPlayback.ts` lines 49-54).
   */
  const handleCloseGraphModal = (finalPipTimeMs: number) => {
    setGraphModalOpen(false);
    const video = playback.videoRef.current;
    const snapshot = pipHandoffRef.current;
    pipHandoffRef.current = null;
    _applyHandoffOnClose({
      video,
      finalPipTimeMs,
      snapshot,
      playVideo: () => playback.playVideo(),
    });
  };

  /**
   * Lookup table for scene → startTime so the modal's PiP can seek
   * on node clicks without dragging the full `ReviewScene[]` into
   * the modal. Stable per-page (scenes don't change).
   */
  const sceneStartTimesMs = useMemo(() => {
    const map = new Map<number, number>();
    for (const scene of props.reviewPage.scenes) {
      map.set(scene.sceneNumber, scene.startTimeMs);
    }
    return map;
  }, [props.reviewPage.scenes]);

  const handleLoadedMetadata = () => {
    playback.handleLoadedMetadata();
    if (metadataMetricEmittedRef.current) {
      return;
    }
    metadataMetricEmittedRef.current = true;
    emitReviewPageMetric(
      createReviewPageMetricEvent(
        "review_video_metadata_ready",
        performance.now() - pageLoadStartedAtRef.current,
        {
          durationSeconds: props.reviewPage.durationSeconds,
          autoplayMode: props.reviewPage.autoplayMode,
        },
      ),
    );
  };

  const createDetachedDiffRect = (clientX: number, clientY: number) => {
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1440;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 900;
    const width = clamp(viewportWidth - 180, MIN_DETACHED_DIFF_WIDTH, 1100);
    const height = clamp(viewportHeight - 160, MIN_DETACHED_DIFF_HEIGHT, 760);

    return {
      width,
      height,
      x: clamp(clientX - 180, DETACHED_DIFF_MARGIN, viewportWidth - width - DETACHED_DIFF_MARGIN),
      y: clamp(clientY - 24, DETACHED_DIFF_MARGIN, viewportHeight - height - DETACHED_DIFF_MARGIN),
    };
  };

  const openComposerFromThread = (thread: LocalDraftComment) => {
    const startLine = findDiffLineById(props.reviewPage.diffSnapshot, thread.startLineId);
    const endLine = findDiffLineById(props.reviewPage.diffSnapshot, thread.endLineId);
    if (!startLine || !endLine) {
      return;
    }

    setFileFocusSource("manual");
    setSelectedFilePath(thread.filePath);
    setComposer({
      threadId: thread.threadId,
      filePath: thread.filePath,
      startLine,
      endLine,
      lineIds: thread.lineIds,
      anchorIds: thread.anchorIds,
      pinIds: thread.pinIds,
      source: thread.source,
      kind: thread.kind,
      body: thread.body,
      isSaved: true,
    });
  };

  const handleSelectLine = (context: { filePath: string; line: ReviewDiffLine }) => {
    if (
      composer &&
      !composer.isSaved &&
      composer.filePath === context.filePath &&
      composer.lineIds.includes(context.line.lineId)
    ) {
      setComposer(null);
      return;
    }

    const existingThread = localDrafts.getThreadContainingLineId(context.line.lineId);
    if (existingThread) {
      openComposerFromThread(existingThread);
      return;
    }

    setFileFocusSource("manual");
    setSelectedFilePath(context.filePath);
    setComposer({
      filePath: context.filePath,
      startLine: context.line,
      endLine: context.line,
      lineIds: [context.line.lineId],
      anchorIds: [],
      pinIds: [],
      source: "manual",
      kind: "line",
      body: "",
      isSaved: false,
    });
  };

  const handleSelectThread = (threadId: string) => {
    if (composer?.threadId === threadId) {
      setComposer(null);
      return;
    }

    const thread = localDrafts.getThreadById(threadId);
    if (!thread) {
      return;
    }
    openComposerFromThread(thread);
  };

  const handleComposerBodyChange = (body: string) => {
    setComposer((current) => (current ? { ...current, body } : current));
  };

  const handleComposerDiscard = () => {
    setComposer(null);
  };

  const handleComposerDelete = () => {
    if (!composer?.threadId) {
      return;
    }

    localDrafts.discardThread(composer.threadId);
    setComposer(null);
  };

  const handleComposerSave = () => {
    if (!composer || composer.body.trim().length === 0) {
      return;
    }

    if (saveBlockedReason) {
      return;
    }

    const threadId = localDrafts.saveThread({
      threadId: composer.threadId,
      source: composer.source,
      kind: composer.kind,
      filePath: composer.filePath,
      startLine: composer.startLine,
      endLine: composer.endLine,
      lineIds: composer.lineIds,
      anchorIds: composer.anchorIds,
      pinIds: composer.pinIds,
      body: composer.body,
    });

    if (!threadId) {
      return;
    }

    setComposer((current) =>
      current
        ? {
            ...current,
            threadId,
            isSaved: true,
          }
        : current,
    );
  };

  const syncDraftSubset = async (
    triggerScope: "file" | "all",
    requireUnsynced: boolean,
  ) => {
    // The backend deletes the previous pending review and recreates it from the
    // payload, so every sync must include the full union of active drafts —
    // otherwise file-scoped syncs would drop previously synced comments from
    // other files.
    const allActiveDrafts = localDrafts.drafts.filter(
      (draft) => draft.body.trim().length > 0,
    );
    const orphanPendingReviewId = localDrafts.orphanPendingReviewId;
    const pendingReviewId = localDrafts.latestPendingReviewId ?? orphanPendingReviewId;

    // Discard-only path: the user deleted every draft tied to the remote
    // pending review. We still need to call sync so the server can delete
    // that orphaned remote review — short-circuiting here would leave submit
    // permanently blocked with the deleted comment still on GitHub.
    const isDiscardOnly = allActiveDrafts.length === 0 && orphanPendingReviewId !== null;

    if (allActiveDrafts.length === 0 && !isDiscardOnly) {
      return;
    }

    if (
      requireUnsynced
      && !isDiscardOnly
      && allActiveDrafts.every((draft) => draft.status === "synced")
    ) {
      return;
    }

    if (triggerScope === "file") {
      setIsSyncingFileComments(true);
    } else {
      setIsSyncingAllComments(true);
    }
    setSyncError(null);

    try {
      const result = await syncDraftComments(props.reviewPage.jobId, {
        pendingReviewId,
        drafts: allActiveDrafts.map((draft) => ({
          localDraftId: draft.localDraftId,
          body: draft.body,
          anchorIds: draft.anchorIds,
          pinIds: draft.pinIds,
          filePath: draft.filePath,
          lineId: draft.startLineId,
          position: draft.position,
        })),
      });
      if (result.pendingReviewId === null) {
        const discarded = result.discardedPendingReviewId
          ?? orphanPendingReviewId
          ?? pendingReviewId;
        if (discarded !== null && discarded !== undefined) {
          localDrafts.markPendingReviewDiscarded(discarded);
        }
      } else {
        localDrafts.markSynced(result.syncedDraftIds, result.pendingReviewId);
      }
      // Drafts the server could not map to a diff position were not sent to
      // GitHub — give them a distinct visible status instead of leaving them
      // looking merely "Local".
      localDrafts.markUnmappable(result.skippedDraftIds ?? []);
    } catch (err) {
      if (allActiveDrafts.length > 0) {
        localDrafts.markSyncFailed(allActiveDrafts.map((draft) => draft.localDraftId));
      }
      // Covers the discard-only path too (no drafts to flag): the banner is
      // the only signal that the orphaned pending review was NOT cleaned up.
      setSyncError(describeDraftActionError(err, "Could not sync draft comments to GitHub. Try again."));
      console.error("[ReviewPageClient] Failed to sync draft comments", err);
    } finally {
      if (triggerScope === "file") {
        setIsSyncingFileComments(false);
      } else {
        setIsSyncingAllComments(false);
      }
    }
  };

  const handleSyncFileComments = async () => {
    await syncDraftSubset("file", true);
  };

  const handleSyncAllComments = async () => {
    // When the previous pending review has been orphaned by a discarded
    // synced draft, all remaining drafts may already be marked synced — but
    // we still need to recreate the remote pending review so it stops
    // including the discarded comment.
    const requireUnsynced = localDrafts.orphanPendingReviewId === null;
    await syncDraftSubset("all", requireUnsynced);
  };

  const handleSubmitReview = async () => {
    const pendingReviewId = localDrafts.latestPendingReviewId;
    if (!pendingReviewId || isSubmittingReview) {
      return;
    }

    setIsSubmittingReview(true);
    setSubmitError(null);
    try {
      await submitDraftComments(props.reviewPage.jobId, { pendingReviewId });
      localDrafts.markSubmitted(pendingReviewId);
    } catch (err) {
      // Surface the failure — otherwise the user believes the review was
      // published while the pending review still sits unsubmitted on GitHub.
      setSubmitError(describeDraftActionError(err, "Could not submit the review to GitHub. Try again."));
      console.error("[ReviewPageClient] Failed to submit review", err);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  const handleDiffHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    const nextRect = isDiffDetached
      ? detachedDiffRect
      : createDetachedDiffRect(event.clientX, event.clientY);

    if (!isDiffDetached) {
      setIsDiffDetached(true);
      setDetachedDiffRect(nextRect);
    }

    dragStateRef.current = {
      mode: "move",
      offsetX: event.clientX - nextRect.x,
      offsetY: event.clientY - nextRect.y,
    };
  };

  const handleDetachedResizePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      mode: "resize",
      startX: event.clientX,
      startY: event.clientY,
      startRect: detachedDiffRect,
    };
  };

  const handleRestoreDiff = () => {
    dragStateRef.current = null;
    setIsDiffDetached(false);
  };

  return (
    <ReviewShell
      theaterMode={theaterMode}
      header={(
        <ReviewHeader
          repoFullName={props.reviewPage.repoFullName}
          prNumber={props.reviewPage.prNumber}
          durationMode={props.reviewPage.durationMode}
          headline={props.reviewPage.headline}
          snapshotStatus={props.reviewPage.snapshotStatus}
          canSyncDrafts={props.reviewPage.canSyncDrafts}
        />
      )}
    >
        {process.env.NODE_ENV !== "production" && isHydrated ? (
          <div data-testid="review-hydrated" className="hidden">
            <button
              type="button"
              data-testid="review-test-force-autoplay-blocked"
              onClick={playback.forceAutoplayBlocked}
            >
              Force autoplay blocked
            </button>
            <button
              type="button"
              data-testid="review-test-force-replay-unlocked"
              onClick={() => playback.forceReplayUnlocked(12_000)}
            >
              Force replay unlocked
            </button>
          </div>
        ) : null}
        <div className="xl:hidden">
          <MobileReviewTray
            activePanel={mobilePanel}
            onChange={setMobilePanel}
            pinCount={props.reviewPage.pins.length}
            snapshotStatus={props.reviewPage.snapshotStatus}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 xl:hidden">
          {mobilePanel === "playback" ? (
            <section className="review-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px]">
              <div className="border-b border-[var(--border)] px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={playback.isPlaying ? playback.pauseVideo : playback.playVideo}
                    className="cine-transition inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-white"
                  >
                    {playback.isPlaying ? <Pause size={16} /> : <Play size={16} />}
                    {playback.isPlaying ? "Pause" : "Play"}
                  </button>
                  {playback.mode === "file_focus" ? (
                    <button
                      type="button"
                      onClick={handleBackToReview}
                      className="cine-transition inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-black/20 px-4 py-2 text-sm text-[var(--foreground)]"
                    >
                      <ArrowLeft size={16} />
                      Back to review
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="p-4">
                <div className="overflow-hidden rounded-[24px] border border-[var(--border)] bg-black">
                  <video
                    ref={playback.videoRef}
                    data-testid="review-video"
                    src={props.reviewPage.videoUrl}
                    playsInline
                    preload="auto"
                    controls
                    className="aspect-video w-full bg-black object-contain"
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={playback.handleTimeUpdate}
                    onPlay={playback.handlePlay}
                    onPause={playback.handlePause}
                    onEnded={playback.handleEnded}
                  />
                </div>
                <LiveTranscript
                  scenes={props.reviewPage.scenes}
                  currentTimeMs={playback.currentVideoTimeMs}
                  activeSceneNumber={playback.activeScene?.sceneNumber ?? null}
                  compact
                />
              </div>
              <div className="grid gap-4 px-4 pb-4">
                <div className="max-h-[240px]">
                  <FileRail
                    files={props.reviewPage.files}
                    fileCategoriesByPath={fileCategoriesByPath}
                    locked={playback.railLocked}
                    selectedFilePath={selectedFilePath}
                    onSelectFile={handleSelectFile}
                  />
                </div>
                <div className="max-h-[280px]">
                  <TranscriptTimeline
                    scenes={props.reviewPage.scenes}
                    activeSceneNumber={playback.activeScene?.sceneNumber ?? null}
                    headline={props.reviewPage.headline}
                    onSelectScene={handleTimelineSelectScene}
                  />
                </div>
              </div>
            </section>
          ) : null}
          {mobilePanel === "diff" ? (
            <>
              <div className="min-h-[420px]">
                <DiffWorkspace
                  diffSnapshot={props.reviewPage.diffSnapshot}
                  sceneAnchors={props.reviewPage.sceneAnchors}
                  activeSceneNumber={playback.activeScene?.sceneNumber ?? null}
                  focusFilePath={selectedFilePath}
                  snapshotStatus={props.reviewPage.snapshotStatus}
                  fileThreads={allFileThreads}
                  syncableFileThreadCount={activeFileDrafts.length}
                  allDraftCount={allUnsyncedDrafts.length}
                  canSyncDrafts={props.reviewPage.canSyncDrafts}
                  saveBlockedReason={saveBlockedReason}
                  composer={diffComposer}
                  isSyncingFileComments={isSyncingFileComments}
                  isSyncingAllComments={isSyncingAllComments}
                  isSubmittingReview={isSubmittingReview}
                  syncError={syncError}
                  submitError={submitError}
                  draftRestoreError={localDrafts.restoreError}
                  draftBackupFailed={localDrafts.restoreBackupFailed}
                  pendingReviewId={localDrafts.latestPendingReviewId}
                  orphanPendingReviewId={localDrafts.orphanPendingReviewId}
                  onSelectLine={handleSelectLine}
                  onSelectThread={handleSelectThread}
                  onComposerBodyChange={handleComposerBodyChange}
                  onComposerDiscard={handleComposerDiscard}
                  onComposerDelete={handleComposerDelete}
                  onComposerSave={handleComposerSave}
                  onSyncFileComments={handleSyncFileComments}
                  onSyncAllComments={handleSyncAllComments}
                  onSubmitReview={handleSubmitReview}
                />
              </div>
            </>
          ) : null}
        </div>
        <PanelGroup
          ref={desktopLayoutRef}
          id="review-desktop-layout"
          direction="horizontal"
          className="hidden min-h-0 flex-1 gap-4 xl:flex"
        >
          <Panel
            id="review-file-rail-panel"
            order={1}
            defaultSize={theaterMode ? 12 : 16}
            minSize={10}
            maxSize={24}
          >
            <div
              data-testid="review-desktop-file-rail"
              className="flex h-full min-h-[640px] flex-col gap-4"
            >
              <FileRail
                files={props.reviewPage.files}
                fileCategoriesByPath={fileCategoriesByPath}
                locked={playback.railLocked}
                selectedFilePath={selectedFilePath}
                onSelectFile={handleSelectFile}
              />
              {selectedFile && selectedFileScenes.length > 1 ? (
                <ScenePicker
                  filePath={selectedFile.filePath}
                  scenes={selectedFileScenes}
                  onSelectScene={handleSelectScene}
                />
              ) : null}
            </div>
          </Panel>

          <PanelResizeHandle className="group relative mx-1 hidden w-2 items-stretch justify-center lg:flex">
            <div className="h-full w-px bg-[var(--border)] transition-colors group-hover:bg-[var(--accent)]" />
          </PanelResizeHandle>

          <Panel
            id="review-main-panel"
            order={2}
            defaultSize={theaterMode ? 88 : 84}
            minSize={64}
          >
            <div className="flex h-full min-h-[640px] flex-col gap-4">
              <section className="review-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px]">
                <div className="border-b border-[var(--border)] px-5 py-4">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <h2 className="text-xl font-semibold text-white">
                        {playbackModeLabel}
                      </h2>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {playback.mode === "file_focus" ? (
                        <button
                          type="button"
                          onClick={handleBackToReview}
                          className="cine-transition inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-black/20 px-4 py-2 text-sm text-[var(--foreground)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                        >
                          <ArrowLeft size={16} />
                          Back to review
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={playback.isPlaying ? playback.pauseVideo : playback.playVideo}
                        className="cine-transition inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-white hover:border-[var(--accent)]"
                      >
                        {playback.isPlaying ? <Pause size={16} /> : <Play size={16} />}
                        {playback.isPlaying ? "Pause" : "Play"}
                      </button>

                      {hasGraph ? (
                        <button
                          type="button"
                          data-testid="open-graph-modal"
                          onClick={handleOpenGraphModal}
                          disabled={playback.railLocked}
                          title={playback.railLocked ? "Unlock replay to open the map" : "Open the constellation map"}
                          className="cine-transition inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-black/20 px-4 py-2 text-sm text-[var(--foreground)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:pointer-events-none disabled:opacity-40"
                        >
                          <Network size={16} />
                          Map
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={toggleTheaterMode}
                        title={theaterMode ? "Exit theater mode (t)" : "Theater mode (t)"}
                        className="cine-transition inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-black/20 px-3 py-2 text-sm text-[var(--foreground)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                      >
                        {theaterMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                      </button>

                      {!playback.autoplayPermitted && playback.mode === "full_review" ? (
                        <span
                          data-testid="autoplay-fallback-badge"
                          className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-black/25 px-3 py-2 text-xs text-[var(--foreground-muted)]"
                        >
                          <RotateCcw size={14} />
                          Autoplay blocked, ready to start
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <PanelGroup
                  ref={desktopWorkspaceRef}
                  id="review-desktop-workspace"
                  direction="horizontal"
                  className="min-h-0 flex-1"
                >
                  <Panel
                    id="review-center-panel"
                    order={1}
                    defaultSize={theaterMode ? 86 : 80}
                    minSize={62}
                  >
                    <div
                      data-testid="review-desktop-center-column"
                      className="flex h-full min-h-0 flex-col gap-2 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(0,0,0,0.1))] p-4"
                    >
                      <div
                        data-testid="review-video-panel"
                        className="flex shrink-0 flex-col"
                      >
                        <div className="flex shrink-0 items-start justify-center px-2 pt-1">
                          <div className="aspect-video w-full max-w-[1120px] overflow-hidden rounded-[24px] border border-[var(--border)] bg-black shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
                            <video
                              ref={playback.videoRef}
                              data-testid="review-video"
                              src={props.reviewPage.videoUrl}
                              playsInline
                              preload="auto"
                              controls
                              className="h-full w-full bg-black object-contain"
                              onLoadedMetadata={handleLoadedMetadata}
                              onTimeUpdate={playback.handleTimeUpdate}
                              onPlay={playback.handlePlay}
                              onPause={playback.handlePause}
                              onEnded={playback.handleEnded}
                            />
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-4 px-2 pb-1 pt-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--foreground-soft)]">
                              {playbackModeLabel}
                            </div>
                            <div className="mt-1 text-sm text-[var(--foreground-muted)]">
                              {playback.activeScene
                                ? `Scene ${playback.activeScene.sceneNumber}: ${playback.activeScene.sceneType.replaceAll("_", " ")}`
                                : "Preparing walkthrough"}
                            </div>
                          </div>
                          {primarySelectedScene && playback.mode === "file_focus" ? (
                            <div className="rounded-full border border-[var(--border)] bg-black/35 px-3 py-1.5 text-xs text-[var(--accent-secondary)]">
                              {selectedFile?.filePath}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
                        <div className="min-h-0 flex-1">
                          {isDiffDetached ? (
                            <div className="flex h-full min-h-[320px] items-center justify-center rounded-[12px] border border-dashed border-[var(--border)] bg-black/10">
                              <div className="text-center">
                                <p className="text-sm font-medium text-white">Diff is floating</p>
                                <p className="mt-1 text-sm text-[var(--foreground-muted)]">
                                  Restore it here when you want the standard layout back.
                                </p>
                                <button
                                  type="button"
                                  onClick={handleRestoreDiff}
                                  className="mt-4 rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--foreground)]"
                                >
                                  Restore diff
                                </button>
                              </div>
                            </div>
                          ) : (
                            <DiffWorkspace
                              diffSnapshot={props.reviewPage.diffSnapshot}
                              sceneAnchors={props.reviewPage.sceneAnchors}
                              activeSceneNumber={playback.activeScene?.sceneNumber ?? null}
                              focusFilePath={selectedFilePath}
                              snapshotStatus={props.reviewPage.snapshotStatus}
                              fileThreads={allFileThreads}
                              syncableFileThreadCount={activeFileDrafts.length}
                              allDraftCount={allUnsyncedDrafts.length}
                              canSyncDrafts={props.reviewPage.canSyncDrafts}
                              saveBlockedReason={saveBlockedReason}
                              composer={diffComposer}
                              isSyncingFileComments={isSyncingFileComments}
                              isSyncingAllComments={isSyncingAllComments}
                              isSubmittingReview={isSubmittingReview}
                              syncError={syncError}
                              submitError={submitError}
                              draftRestoreError={localDrafts.restoreError}
                              draftBackupFailed={localDrafts.restoreBackupFailed}
                              pendingReviewId={localDrafts.latestPendingReviewId}
                              orphanPendingReviewId={localDrafts.orphanPendingReviewId}
                              fillHeight
                              onSelectLine={handleSelectLine}
                              onSelectThread={handleSelectThread}
                              onComposerBodyChange={handleComposerBodyChange}
                              onComposerDiscard={handleComposerDiscard}
                              onComposerDelete={handleComposerDelete}
                              onComposerSave={handleComposerSave}
                              onSyncFileComments={handleSyncFileComments}
                              onSyncAllComments={handleSyncAllComments}
                              onSubmitReview={handleSubmitReview}
                              onHeaderPointerDown={handleDiffHeaderPointerDown}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </Panel>

                  <PanelResizeHandle className="group relative mx-1 hidden w-2 items-stretch justify-center lg:flex">
                    <div className="h-full w-px bg-[var(--border)] transition-colors group-hover:bg-[var(--accent)]" />
                  </PanelResizeHandle>

                  <Panel
                    id="review-sidebar-panel"
                    order={2}
                    defaultSize={theaterMode ? 14 : 20}
                    minSize={12}
                    maxSize={28}
                  >
                    <div
                      data-testid="review-desktop-sidebar"
                      className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4"
                    >
                      <div className="review-surface shrink-0 rounded-[24px] px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--foreground-soft)]">
                            Follow-along transcript
                          </p>
                          <span
                            data-testid="review-current-time"
                            className="rounded-full border border-[var(--border)] bg-white/5 px-3 py-1 text-xs font-medium text-white"
                          >
                            {formatTimestamp(playback.currentVideoTimeMs)}
                          </span>
                        </div>
                        <LiveTranscript
                          scenes={props.reviewPage.scenes}
                          currentTimeMs={playback.currentVideoTimeMs}
                          activeSceneNumber={playback.activeScene?.sceneNumber ?? null}
                          compact
                        />
                      </div>
                      <div className="min-h-[240px] shrink-0">
                        <TranscriptTimeline
                          scenes={props.reviewPage.scenes}
                          activeSceneNumber={playback.activeScene?.sceneNumber ?? null}
                          headline={props.reviewPage.headline}
                          onSelectScene={handleTimelineSelectScene}
                        />
                      </div>
                    </div>
                  </Panel>
                </PanelGroup>
              </section>
            </div>
          </Panel>
        </PanelGroup>
        {isDiffDetached ? (
          <div className="pointer-events-none fixed inset-0 z-50">
            <div
              data-testid="floating-diff-window"
              className="pointer-events-auto fixed flex min-h-0 min-w-0 overflow-hidden rounded-[14px] shadow-[0_40px_120px_rgba(0,0,0,0.55)]"
              style={{
                left: detachedDiffRect.x,
                top: detachedDiffRect.y,
                width: detachedDiffRect.width,
                height: detachedDiffRect.height,
              }}
            >
              <DiffWorkspace
                diffSnapshot={props.reviewPage.diffSnapshot}
                sceneAnchors={props.reviewPage.sceneAnchors}
                activeSceneNumber={playback.activeScene?.sceneNumber ?? null}
                focusFilePath={selectedFilePath}
                snapshotStatus={props.reviewPage.snapshotStatus}
                fileThreads={allFileThreads}
                syncableFileThreadCount={activeFileDrafts.length}
                allDraftCount={allUnsyncedDrafts.length}
                canSyncDrafts={props.reviewPage.canSyncDrafts}
                saveBlockedReason={saveBlockedReason}
                composer={diffComposer}
                isSyncingFileComments={isSyncingFileComments}
                isSyncingAllComments={isSyncingAllComments}
                syncError={syncError}
                submitError={submitError}
                draftRestoreError={localDrafts.restoreError}
                draftBackupFailed={localDrafts.restoreBackupFailed}
                fillHeight
                detachedMode
                onSelectLine={handleSelectLine}
                onSelectThread={handleSelectThread}
                onComposerBodyChange={handleComposerBodyChange}
                onComposerDiscard={handleComposerDiscard}
                onComposerDelete={handleComposerDelete}
                onComposerSave={handleComposerSave}
                onSyncFileComments={handleSyncFileComments}
                onSyncAllComments={handleSyncAllComments}
                onHeaderPointerDown={handleDiffHeaderPointerDown}
                onRestoreEmbedded={handleRestoreDiff}
                onResizePointerDown={handleDetachedResizePointerDown}
              />
            </div>
          </div>
        ) : null}
        {props.reviewPage.reviewGraph ? (
          <GraphModal
            open={graphModalOpen}
            onClose={handleCloseGraphModal}
            reviewGraph={props.reviewPage.reviewGraph}
            videoUrl={props.reviewPage.videoUrl}
            initialTimeMs={pipHandoffRef.current?.mainTimeAtOpenMs ?? playback.currentVideoTimeMs}
            initiallyPlaying={pipHandoffRef.current?.wasPlayingBeforeOpen ?? false}
            sceneStartTimesMs={sceneStartTimesMs}
          />
        ) : null}
    </ReviewShell>
  );
}
