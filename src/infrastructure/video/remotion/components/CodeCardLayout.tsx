import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import type { CodeBroll } from "@/domain/entities/VideoScript";
import type { ResolvedBinding } from "@/infrastructure/video/remotion/wordSyncedBindings";
import {
  getSnippetLineChangeKind,
  getSnippetLineNumbers,
  normalizeSnippetHighlights,
} from "@/infrastructure/video/codeLineMapping";
import { HighlightBand } from "@/infrastructure/video/remotion/components/HighlightBand";

/** Screen-space slot a card can occupy. */
export interface Slot {
  /** Normalized (0..1) center coordinates in the viewport. */
  cx: number;
  cy: number;
  scale: number;
  opacity: number;
}

const ACTIVE_SLOT: Slot = { cx: 0.5, cy: 0.5, scale: 1.0, opacity: 1.0 };
// Two related-slots ring positions (upper-right, lower-right). Caller may
// supply up to 3 related indices; surplus collapse to PARKED_SLOT.
const RELATED_SLOTS: Slot[] = [
  { cx: 0.82, cy: 0.28, scale: 0.55, opacity: 0.85 },
  { cx: 0.82, cy: 0.72, scale: 0.55, opacity: 0.85 },
  { cx: 0.18, cy: 0.5, scale: 0.55, opacity: 0.85 },
];
const PARKED_SLOT: Slot = { cx: 0.5, cy: 1.15, scale: 0.4, opacity: 0 };

/** Max related cards shown in ring slots (mirrors the arrow cap in WordSyncedCodeStage). */
export const MAX_VISIBLE_ARROWS = 3;

export interface CodeCardLayoutProps {
  items: CodeBroll[];
  /**
   * Full resolved binding timeline for the scene, sorted by startMs.
   * Slot assignments AND transition anchors are derived from it per frame,
   * keeping every frame a pure function of (frame, props) — required for
   * Remotion's concurrent chunked rendering, where cross-frame refs reset
   * at chunk boundaries.
   */
  bindings: ResolvedBinding[];
  /** Anchor frame in the scene timeline. Used for spring transitions. */
  startFrame: number;
  durationFrames: number;
  /** Highlight bands for the ACTIVE card only. Translated to per-line bands inside. */
  activeHighlightLines: number[];
  activeHighlightStartMs: number;
  activeHighlightEndMs: number;
}

const CARD_LINE_HEIGHT_PX = 22; // matches fontSize 14 + lineHeight 1.6
const CARD_TOP_PADDING_PX = 56; // file-path header (~20) + padding (~24) + margin (~12)

interface SegmentState {
  activeIndex: number;
  relatedIndices: number[];
}

/**
 * The (activeIndex, relatedIndices) pair is piecewise-constant over time:
 * `findActiveBinding` is sticky-forward, so it changes only at each binding's
 * `startMs`. Segment -1 is the pre-first-binding default (first snippet
 * centered, no related cards), segment j covers [bindings[j].startMs, next).
 */
function segmentState(bindings: ResolvedBinding[], segIdx: number): SegmentState {
  if (segIdx < 0) return { activeIndex: 0, relatedIndices: [] };
  const b = bindings[segIdx];
  return {
    activeIndex: b.codeBrollIndex,
    relatedIndices: (b.relatesToCodeBrollIndices ?? []).slice(0, MAX_VISIBLE_ARROWS),
  };
}

/** Rightmost segment whose startMs <= currentTimeMs; -1 before the first binding. */
function segmentIndexAt(bindings: ResolvedBinding[], currentTimeMs: number): number {
  let lo = 0;
  let hi = bindings.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (bindings[mid].startMs <= currentTimeMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** First frame (scene-local) at which a boundary at `ms` is observed. */
function boundaryFrame(ms: number, fps: number): number {
  return Math.ceil((ms / 1000) * fps);
}

function pickSlot(
  index: number,
  activeIndex: number,
  relatedIndices: number[],
): Slot {
  if (index === activeIndex) return ACTIVE_SLOT;
  const relatedPos = relatedIndices.indexOf(index);
  if (relatedPos >= 0 && relatedPos < RELATED_SLOTS.length) return RELATED_SLOTS[relatedPos];
  return PARKED_SLOT;
}

const CARD_WIDTH = 720; // intrinsic card width before scaling

function InlineCodeCard({
  codeBroll,
  isActive,
  highlightLines,
  highlightStartMs,
  highlightEndMs,
}: {
  codeBroll: CodeBroll;
  isActive: boolean;
  highlightLines: number[];
  highlightStartMs: number;
  highlightEndMs: number;
}): React.JSX.Element {
  const lines = codeBroll.code.split("\n");
  const lineNumbers = getSnippetLineNumbers(lines.length, codeBroll.lineRange);
  const staticHighlights = new Set(
    normalizeSnippetHighlights({
      highlights: codeBroll.highlights,
      lineRange: codeBroll.lineRange,
      lineCount: lines.length,
    }),
  );
  return (
    <div
      style={{
        position: "relative",
        background: "rgba(13, 17, 23, 0.92)",
        borderRadius: 12,
        padding: "20px 24px",
        border: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        fontFamily: "'Source Code Pro', 'Fira Code', monospace",
        fontSize: 14,
        lineHeight: 1.6,
        color: "#e6edf3",
      }}
    >
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 8, fontFamily: "Inter, sans-serif" }}>
        {codeBroll.filePath} ({codeBroll.language})
      </div>
      {/* Active-card per-word highlight band overlays the lines layer. */}
      {isActive && highlightLines.length > 0 && (
        <HighlightBand
          lineNumbers={highlightLines}
          cardLineRange={codeBroll.lineRange}
          cardLineCount={lines.length}
          startMs={highlightStartMs}
          endMs={highlightEndMs}
          lineHeightPx={CARD_LINE_HEIGHT_PX}
          topPaddingPx={CARD_TOP_PADDING_PX}
          widthPx={CARD_WIDTH - 48}
        />
      )}
      {lines.map((line, i) => {
        const lineNum = lineNumbers[i] ?? i + 1;
        const isHighlighted = staticHighlights.has(lineNum);
        const isRemoved = getSnippetLineChangeKind(line) === "removed";
        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: isRemoved
                ? "rgba(248, 81, 73, 0.16)"
                : isHighlighted
                  ? "rgba(56, 139, 253, 0.15)"
                  : "transparent",
              borderLeft: isRemoved
                ? "3px solid #f85149"
                : isHighlighted
                  ? "3px solid #388bfd"
                  : "3px solid transparent",
              padding: "1px 8px",
            }}
          >
            <span style={{ color: "#484f58", minWidth: 36, textAlign: "right", marginRight: 16, userSelect: "none" }}>
              {lineNum}
            </span>
            <span style={{ whiteSpace: "pre" }}>{line}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Positions all codeBroll cards in slots (active / related / parked) and
 * animates transitions via spring(). Every frame is a pure function of
 * (frame, props): the current slot AND the last slot-change boundary are
 * both derived from the resolved binding timeline, so parallel chunked
 * rendering produces identical frames regardless of chunk boundaries or
 * machine core count. Springs are anchored at binding-boundary frames.
 */
export const CodeCardLayout: React.FC<CodeCardLayoutProps> = ({
  items,
  bindings,
  startFrame,
  durationFrames: _durationFrames,
  activeHighlightLines,
  activeHighlightStartMs,
  activeHighlightEndMs,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const currentTimeMs = ((frame - startFrame) / fps) * 1000;
  const segIdx = segmentIndexAt(bindings, currentTimeMs);
  const seg = segmentState(bindings, segIdx);

  return (
    <>
      {items.map((codeBroll, index) => {
        const targetSlot = pickSlot(index, seg.activeIndex, seg.relatedIndices);

        // Walk back through binding-boundary segments to find the most recent
        // one where this card's slot changed. Loop invariant: this card's slot
        // in segment j equals targetSlot (trivially true at j = segIdx; each
        // continue implies segment j-1 also matches). Slots are shared module
        // constants, so reference equality identifies a change. If the slot
        // never changed since t=0, prev === target and the spring is a no-op.
        let prevSlot = targetSlot;
        let transitionFrame = startFrame;
        for (let j = segIdx; j >= 0; j--) {
          const before = segmentState(bindings, j - 1);
          const slotBefore = pickSlot(index, before.activeIndex, before.relatedIndices);
          if (slotBefore !== targetSlot) {
            prevSlot = slotBefore;
            transitionFrame = startFrame + boundaryFrame(bindings[j].startMs, fps);
            break;
          }
        }

        const springProgress = spring({
          frame: Math.max(0, frame - transitionFrame),
          fps,
          config: { damping: 22, mass: 0.7, stiffness: 120 },
        });

        const cx = interpolate(springProgress, [0, 1], [prevSlot.cx, targetSlot.cx]);
        const cy = interpolate(springProgress, [0, 1], [prevSlot.cy, targetSlot.cy]);
        const scale = interpolate(springProgress, [0, 1], [prevSlot.scale, targetSlot.scale]);
        const opacity = interpolate(springProgress, [0, 1], [prevSlot.opacity, targetSlot.opacity]);

        const cardX = cx * width;
        const cardY = cy * height;

        const isActive = index === seg.activeIndex;
        return (
          <div
            key={index}
            data-slot={isActive ? "active" : (seg.relatedIndices.includes(index) ? "related" : "parked")}
            data-codebroll-index={index}
            style={{
              position: "absolute",
              left: cardX,
              top: cardY,
              width: CARD_WIDTH,
              transform: `translate(-50%, -50%) scale(${scale})`,
              transformOrigin: "center",
              opacity,
              pointerEvents: "none",
            }}
          >
            <InlineCodeCard
              codeBroll={codeBroll}
              isActive={isActive}
              highlightLines={isActive ? activeHighlightLines : []}
              highlightStartMs={activeHighlightStartMs}
              highlightEndMs={activeHighlightEndMs}
            />
          </div>
        );
      })}
    </>
  );
};
