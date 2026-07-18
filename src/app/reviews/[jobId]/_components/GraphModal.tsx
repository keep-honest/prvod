"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import type { ReviewGraphData, ReviewGraphNode } from "@/domain/entities/ReviewGraph";
import {
  ConstellationGraphView,
} from "./ConstellationGraphView";

export interface GraphModalProps {
  open: boolean;
  /**
   * Called when the user explicitly closes the modal (Escape, close X,
   * overlay click). Receives the final PiP video `currentTime` in
   * milliseconds so the parent can hand off to the main-page video.
   */
  onClose: (finalPipTimeMs: number) => void;
  reviewGraph: ReviewGraphData;
  /** URL of the video file — must match the main-page `<video>` src. */
  videoUrl: string;
  /**
   * Video time (ms) captured from the main-page video at the instant
   * the modal opened. The PiP seeks to this on `loadedmetadata`.
   */
  initialTimeMs: number;
  /** Whether the main-page video was playing when the modal opened. */
  initiallyPlaying: boolean;
  /**
   * Per-scene startTime lookup (ms). Used to resolve node clicks inside
   * the graph to PiP seek targets without dragging the full
   * `ReviewScene[]` into the modal.
   */
  sceneStartTimesMs: ReadonlyMap<number, number>;
}

export type ModalView = "graph_pip" | "video_expanded";

/**
 * Pure reducer for the modal's two-state view machine. Extracted as
 * a helper so tests can exercise every transition without a DOM.
 *
 * Transitions:
 *   - `open` (modal is opened) → always reset to `graph_pip`
 *   - `expand` (user clicks Expand in the PiP) → `video_expanded`
 *   - `collapse` (user clicks "Back to map" or Collapse) → `graph_pip`
 */
export function _nextModalView(
  current: ModalView,
  action: "open" | "expand" | "collapse",
): ModalView {
  switch (action) {
    case "open":
      return "graph_pip";
    case "expand":
      return "video_expanded";
    case "collapse":
      return "graph_pip";
  }
}

/** Minimal interface the PiP video helpers need — lets tests pass plain stubs. */
interface PipVideoLike {
  currentTime: number;
  readyState?: number;
  play: () => Promise<void>;
  pause?: () => void;
}

/**
 * Pure helper: seed the PiP video's currentTime on `loadedmetadata`.
 *
 * Extracted so unit tests can exercise the full decision matrix
 * (already-seeded, invalid input, throwing setter, autoplay rejection)
 * without faking browser media events. The component calls this from
 * `handlePipLoadedMetadata`.
 *
 * Important: `seededRef.current = true` is ONLY set on a successful
 * seek. Leaving the flag false after a failed seek lets a later retry
 * succeed and prevents the rest of the modal from believing the PiP
 * took control when it didn't.
 */
export function _seedPipVideo(args: {
  video: PipVideoLike | null;
  alreadySeeded: boolean;
  initialTimeMs: number;
  initiallyPlaying: boolean;
  onSeeded: () => void;
  logger?: Pick<Console, "error" | "warn">;
}): "seeded" | "skipped_null_video" | "skipped_already_seeded" | "skipped_invalid_time" | "failed" {
  const logger = args.logger ?? console;
  if (!args.video) return "skipped_null_video";
  if (args.alreadySeeded) return "skipped_already_seeded";
  if (!Number.isFinite(args.initialTimeMs) || args.initialTimeMs < 0) {
    logger.error(
      "[GraphModal] Ignoring invalid initialTimeMs on PiP seed",
      { initialTimeMs: args.initialTimeMs },
    );
    return "skipped_invalid_time";
  }
  try {
    args.video.currentTime = Math.max(0, args.initialTimeMs / 1000);
  } catch (err) {
    logger.error("[GraphModal] Failed to seed PiP currentTime", {
      initialTimeMs: args.initialTimeMs,
      readyState: args.video.readyState,
      err,
    });
    return "failed";
  }
  args.onSeeded();
  if (args.initiallyPlaying) {
    void args.video.play().catch((err: unknown) => {
      const isAutoplayBlocked =
        err instanceof DOMException && err.name === "NotAllowedError";
      if (!isAutoplayBlocked) {
        logger.error("[GraphModal] PiP video.play() failed:", err);
      }
    });
  }
  return "seeded";
}

/**
 * Pure helper: seek the PiP video to a specific scene's start time
 * when a graph node is clicked.
 *
 * Marks the PiP as seeded (even if metadata hasn't loaded yet) so the
 * `loadedmetadata` handler doesn't later overwrite the user's explicit
 * node-click seek with the initial handoff time. If the scene number
 * has no matching entry in `sceneStartTimesMs` the click is treated
 * as a data-integrity violation and logged at error level.
 */
export function _seekPipForNodeClick(args: {
  video: PipVideoLike | null;
  sceneNumber: number;
  sceneStartTimesMs: ReadonlyMap<number, number>;
  onSeeded: () => void;
  logger?: Pick<Console, "error" | "warn">;
}): "seeked" | "skipped_unknown_scene" | "skipped_null_video" | "failed" {
  const logger = args.logger ?? console;
  const startTimeMs = args.sceneStartTimesMs.get(args.sceneNumber);
  if (startTimeMs === undefined) {
    logger.error(
      "[GraphModal] Graph node references unknown scene — layout/scenes mismatch",
      {
        sceneNumber: args.sceneNumber,
        knownScenes: Array.from(args.sceneStartTimesMs.keys()),
      },
    );
    return "skipped_unknown_scene";
  }
  if (!args.video) return "skipped_null_video";
  try {
    args.video.currentTime = Math.max(0, startTimeMs / 1000);
  } catch (err) {
    logger.error("[GraphModal] Failed to seek PiP on node click", {
      sceneNumber: args.sceneNumber,
      startTimeMs,
      err,
    });
    return "failed";
  }
  // Mark as seeded so the later `loadedmetadata` handoff (if still
  // pending) doesn't overwrite the user's explicit node selection.
  args.onSeeded();
  return "seeked";
}

/**
 * Pure helper: compute the final PiP time to hand back to the parent
 * when the modal closes.
 *
 * If the PiP never seeded (user closed before metadata loaded) we
 * must NOT read `video.currentTime` — it's 0 in that state, which
 * would rewind the main video back to the start. Fall back to the
 * original `initialTimeMs` so the main video resumes exactly where
 * it was before the modal opened.
 */
export function _computeFinalPipTimeMs(args: {
  video: PipVideoLike | null;
  seeded: boolean;
  initialTimeMs: number;
  logger?: Pick<Console, "error" | "warn">;
}): number {
  if (args.video && args.seeded) {
    return Math.round(args.video.currentTime * 1000);
  }
  if (!args.seeded) {
    const logger = args.logger ?? console;
    logger.warn(
      "[GraphModal] Closed before PiP seeded — handing back initialTimeMs",
      { initialTimeMs: args.initialTimeMs, hasVideo: Boolean(args.video) },
    );
  }
  return args.initialTimeMs;
}

/**
 * Pure helper: resolve a playback timestamp to a scene number using
 * the scene start-time lookup.
 *
 * Returns the largest sceneNumber whose `startTimeMs <= currentTimeMs`.
 * Ties are broken by the numerically larger sceneNumber (later scene
 * wins) so zero-duration scenes don't mask subsequent ones.
 *
 * Extracted as a helper so the modal's "live scene" header chip can
 * derive the active scene from the PiP's `timeupdate` events instead
 * of waiting for an explicit node click — and so unit tests can
 * exercise every branch of the resolution without a DOM.
 */
export function _sceneNumberForTimeMs(
  sceneStartTimesMs: ReadonlyMap<number, number>,
  currentTimeMs: number,
): number | null {
  if (!Number.isFinite(currentTimeMs) || currentTimeMs < 0) return null;
  let best: number | null = null;
  let bestStart = -Infinity;
  for (const [sceneNumber, startTimeMs] of sceneStartTimesMs) {
    if (startTimeMs > currentTimeMs) continue;
    if (
      startTimeMs > bestStart
      || (startTimeMs === bestStart && (best === null || sceneNumber > best))
    ) {
      best = sceneNumber;
      bestStart = startTimeMs;
    }
  }
  return best;
}

export function _nextSelectedNodeId(args: {
  selectedNodeId: string | null;
  nextSceneNumber: number | null;
  reviewGraph: ReviewGraphData;
}): string | null {
  if (!args.selectedNodeId || args.nextSceneNumber === null) return null;
  const selectedNode = args.reviewGraph.nodes.find((node) => node.id === args.selectedNodeId);
  return selectedNode?.sceneNumbers.includes(args.nextSceneNumber)
    ? selectedNode.id
    : null;
}

/**
 * Full-viewport constellation graph modal with an in-modal
 * picture-in-picture video.
 *
 * The modal owns a second `<video>` element (the PiP). When the modal
 * opens, the main-page video pauses and this PiP takes over at the
 * same timestamp — single decoder at a time. When the modal closes,
 * the PiP reports its final `currentTime` to the parent via `onClose`
 * so the main video can resume from exactly where the PiP left off.
 *
 * Two visual states:
 *   - `graph_pip` (default on open) — full-modal graph + small PiP
 *     overlay in the bottom-right corner.
 *   - `video_expanded` — graph unmounts (simulation stops), video
 *     fills the modal, "Back to map" button appears in the header.
 *
 * The `<video>` element is rendered in BOTH states via a single DOM
 * node (CSS toggles size/position) so toggling the view does NOT
 * remount the video and reset playback.
 *
 * Node clicks inside the graph seek the PiP but do NOT close the
 * modal — the user stays in exploration flow. The modal only closes
 * via Escape, the header close button, or an overlay click.
 */
export function GraphModal({
  open,
  onClose,
  reviewGraph,
  videoUrl,
  initialTimeMs,
  initiallyPlaying,
  sceneStartTimesMs,
}: GraphModalProps) {
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const [view, setView] = useState<ModalView>("graph_pip");
  // Active-scene state — seeded from `initialTimeMs` on open so the
  // header chip shows the user's current scene immediately (not
  // "Pre-roll"), then maintained by both node clicks AND the PiP's
  // `timeupdate` events so it tracks playback as the video plays.
  const [activeSceneNumber, setActiveSceneNumber] = useState<number | null>(() =>
    _sceneNumberForTimeMs(sceneStartTimesMs, initialTimeMs),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Whether the PiP has been seeded (either by loadedmetadata handoff
  // or by an explicit node-click seek). Prevents the loadedmetadata
  // handler from overwriting the user's explicit selection and
  // prevents close-before-seed from rewinding the main video.
  const seededRef = useRef(false);

  // Reset transient state each time the modal opens.
  useEffect(() => {
    if (open) {
      setView("graph_pip");
      setActiveSceneNumber(_sceneNumberForTimeMs(sceneStartTimesMs, initialTimeMs));
      setSelectedNodeId(null);
      seededRef.current = false;
    }
    // We intentionally only re-run when `open` flips, not when
    // `initialTimeMs` or `sceneStartTimesMs` change mid-session —
    // the parent captures `initialTimeMs` at the moment the modal
    // opens and we want to respect that snapshot.
  }, [open]);

  const markSeeded = useCallback(() => {
    seededRef.current = true;
  }, []);

  const handlePipLoadedMetadata = useCallback(() => {
    _seedPipVideo({
      video: pipVideoRef.current,
      alreadySeeded: seededRef.current,
      initialTimeMs,
      initiallyPlaying,
      onSeeded: markSeeded,
    });
  }, [initialTimeMs, initiallyPlaying, markSeeded]);

  const handlePipError = useCallback(() => {
    const video = pipVideoRef.current;
    console.error("[GraphModal] PiP <video> fired error event", {
      videoUrl,
      readyState: video?.readyState,
      errorCode: video?.error?.code,
      errorMessage: video?.error?.message,
    });
  }, [videoUrl]);

  const handlePipTimeUpdate = useCallback(() => {
    const video = pipVideoRef.current;
    if (!video) return;
    const next = _sceneNumberForTimeMs(sceneStartTimesMs, video.currentTime * 1000);
    if (next === null) return;
    setActiveSceneNumber((prev) => (prev === next ? prev : next));
    setSelectedNodeId((prev) => _nextSelectedNodeId({
      selectedNodeId: prev,
      nextSceneNumber: next,
      reviewGraph,
    }));
  }, [reviewGraph, sceneStartTimesMs]);

  const handleNodeSelect = useCallback(
    (node: ReviewGraphNode) => {
      const outcome = _seekPipForNodeClick({
        video: pipVideoRef.current,
        sceneNumber: node.primarySceneNumber,
        sceneStartTimesMs,
        onSeeded: markSeeded,
      });
      if (outcome === "seeked" || outcome === "skipped_null_video") {
        setSelectedNodeId(node.id);
        setActiveSceneNumber(node.primarySceneNumber);
      }
    },
    [sceneStartTimesMs, markSeeded],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return; // Radix only calls with false for close intents
      const video = pipVideoRef.current;
      const finalTimeMs = _computeFinalPipTimeMs({
        video,
        seeded: seededRef.current,
        initialTimeMs,
      });
      if (video) {
        try {
          video.pause();
        } catch (err) {
          console.error("[GraphModal] Failed to pause PiP on close", err);
        }
      }
      onClose(finalTimeMs);
    },
    [initialTimeMs, onClose],
  );

  // Stop the PiP video when the modal closes (defensive — Radix
  // unmounts the portal, which would stop playback anyway, but this
  // makes the intent explicit).
  useEffect(() => {
    if (!open && pipVideoRef.current) {
      pipVideoRef.current.pause();
    }
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="graph-modal-overlay"
          className="fixed inset-0 z-40 bg-black/82 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <Dialog.Content
          data-testid="graph-modal-content"
          aria-describedby="graph-modal-description"
          className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[#0b0f1a] shadow-[0_28px_72px_rgba(0,0,0,0.52)] md:inset-8 lg:inset-12"
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-4">
            <div className="flex min-w-0 items-center gap-3">
              {view === "video_expanded" ? (
                <button
                  type="button"
                  data-testid="graph-modal-back-to-map"
                  aria-label="Back to map"
                  onClick={() => setView("graph_pip")}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-black/20 px-4 py-2 text-sm text-[var(--foreground)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                >
                  <ArrowLeft size={16} />
                  Back to map
                </button>
              ) : null}
              <div className="min-w-0">
                <Dialog.Title className="text-lg font-semibold text-white">
                  {view === "video_expanded" ? "Video" : "Constellation map"}
                </Dialog.Title>
                <Dialog.Description
                  id="graph-modal-description"
                  className="mt-1 text-xs text-[var(--foreground-muted)]"
                >
                  {view === "video_expanded"
                    ? 'Click "Back to map" to return to the node graph.'
                    : "Drag the background to pan, scroll to zoom, and click a node to focus it and seek the video."}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              type="button"
              data-testid="graph-modal-close"
              aria-label="Close constellation map"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-strong)] bg-black/20 text-[var(--foreground)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
            >
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="relative min-h-0 flex-1">
            {/* Graph subtree — mounted only in graph_pip state so the
                simulation stops (via useEffect cleanup) when the user
                expands the video. */}
            {view === "graph_pip" ? (
              <div className="absolute inset-0 p-4" data-testid="graph-modal-graph-pane">
                <ConstellationGraphView
                  reviewGraph={reviewGraph}
                  currentSceneNumber={activeSceneNumber}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={handleNodeSelect}
                />
              </div>
            ) : null}

            {/* PiP video — ALWAYS mounted so toggling view state does
                not reset playback. CSS classes control position/size.

                Design direction: "mission control monitor" — a
                prominent live feed framed with an accent-cyan border
                + outer glow so the eye tracks to it on modal open.
                Entrance animation slides up from below. On hover an
                expand overlay fades in and the whole PiP becomes a
                click target. */}
            <div
              data-testid="graph-modal-pip-container"
              data-view={view}
              className={
                view === "video_expanded"
                  ? "absolute inset-0 flex items-center justify-center bg-black"
                  : "group pointer-events-auto absolute bottom-6 right-6 w-[440px] animate-[pip-rise_420ms_cubic-bezier(0.22,1,0.36,1)_both] overflow-hidden rounded-2xl border border-[color:var(--accent-secondary)]/35 bg-black shadow-[0_18px_42px_rgba(0,0,0,0.45)]"
              }
            >
              {/* Live-feed header chip — only in graph_pip state. */}
              {view === "graph_pip" ? (
                <div
                  data-testid="graph-modal-pip-header"
                  className="flex items-center justify-between border-b border-[color:var(--accent-secondary)]/25 bg-gradient-to-b from-black/80 to-black/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent-secondary)]"
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--accent-secondary)]"
                    />
                    Live playback
                  </span>
                  <span className="text-[color:var(--foreground-muted)]">
                    {activeSceneNumber !== null ? `Scene ${activeSceneNumber}` : "Cueing"}
                  </span>
                </div>
              ) : null}
              <video
                ref={pipVideoRef}
                data-testid="graph-modal-pip-video"
                src={videoUrl}
                playsInline
                preload="auto"
                controls={view === "video_expanded"}
                className={
                  view === "video_expanded"
                    ? "max-h-full max-w-full"
                    : "aspect-video w-full cursor-pointer"
                }
                onLoadedMetadata={handlePipLoadedMetadata}
                onTimeUpdate={handlePipTimeUpdate}
                onError={handlePipError}
                onClick={
                  view === "graph_pip"
                    ? () => setView("video_expanded")
                    : undefined
                }
              />
              {view === "graph_pip" ? (
                <>
                  {/* Hover overlay — whole-PiP affordance that the
                      video area is clickable to expand. */}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 top-[34px] flex items-end justify-end bg-gradient-to-t from-black/60 via-black/10 to-transparent px-3 pb-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  >
                    <span className="flex items-center gap-1.5 rounded-full border border-[color:var(--accent-secondary)]/60 bg-black/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent-secondary)]">
                      <Maximize2 size={11} /> Click to expand
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid="graph-modal-pip-expand"
                    aria-label="Expand video"
                    onClick={() => setView("video_expanded")}
                    className="absolute right-3 top-[46px] inline-flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--accent-secondary)]/60 bg-black/80 text-[color:var(--accent-secondary)] transition-colors hover:border-[color:var(--accent-secondary)] hover:bg-[color:var(--accent-secondary)]/15"
                  >
                    <Maximize2 size={15} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="graph-modal-pip-collapse"
                  aria-label="Collapse video"
                  onClick={() => setView("graph_pip")}
                  className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--accent-secondary)]/60 bg-black/80 text-[color:var(--accent-secondary)] transition-colors hover:border-[color:var(--accent-secondary)] hover:bg-[color:var(--accent-secondary)]/15"
                >
                  <Minimize2 size={16} />
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      {/* PiP entrance animation keyframes — scoped via a global
          <style> so the modal is self-contained and doesn't force a
          Tailwind config change. */}
      <style>{`
        @keyframes pip-rise {
          0% {
            transform: translateY(32px) scale(0.96);
            opacity: 0;
            filter: blur(4px);
          }
          100% {
            transform: translateY(0) scale(1);
            opacity: 1;
            filter: blur(0);
          }
        }
      `}</style>
    </Dialog.Root>
  );
}
