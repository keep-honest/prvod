import React, { useRef } from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import type { CodeBroll } from "@/domain/entities/VideoScript";
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

export interface CodeCardLayoutProps {
  items: CodeBroll[];
  activeIndex: number;
  relatedIndices: number[];
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

interface CardSlotState {
  prev: Slot;
  current: Slot;
  /** Frame at which the current slot was assigned (drives spring time). */
  transitionFrame: number;
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

/**
 * Positions all codeBroll cards in slots (active / related / parked) and
 * animates transitions via spring(). Re-renders are pure: spring math reads
 * frame and previous-slot snapshot from useRef, no React state writes per frame.
 */
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

export const CodeCardLayout: React.FC<CodeCardLayoutProps> = ({
  items,
  activeIndex,
  relatedIndices,
  startFrame: _startFrame,
  durationFrames: _durationFrames,
  activeHighlightLines,
  activeHighlightStartMs,
  activeHighlightEndMs,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Slot-per-card state keyed by index, persisted across renders so we know
  // when a slot actually changed and need to re-anchor the spring.
  const slotState = useRef<Map<number, CardSlotState>>(new Map());

  // Compute per-card slot decision inline. The previous useMemo had an
  // unstable `relatedIndices` dependency (fresh array reference from the
  // parent every render) so the memo never cached — it added overhead with
  // no benefit. `pickSlot` is O(1) per index over a small `items` array
  // (≤ MAX_VISIBLE_ARROWS + active), so a direct loop is the cheapest path.
  const slotByIndex = new Map<number, Slot>();
  for (let i = 0; i < items.length; i++) {
    slotByIndex.set(i, pickSlot(i, activeIndex, relatedIndices));
  }

  return (
    <>
      {items.map((codeBroll, index) => {
        // `slotByIndex` is populated for every index in `items`, so .get() is
        // guaranteed defined. Fall back to PARKED_SLOT defensively to satisfy
        // the no-non-null-assertion lint rule.
        const targetSlot = slotByIndex.get(index) ?? PARKED_SLOT;
        const prevState = slotState.current.get(index);
        // Detect slot change → re-anchor spring.
        const slotChanged =
          !prevState ||
          prevState.current.cx !== targetSlot.cx ||
          prevState.current.cy !== targetSlot.cy ||
          prevState.current.scale !== targetSlot.scale ||
          prevState.current.opacity !== targetSlot.opacity;
        if (slotChanged) {
          slotState.current.set(index, {
            prev: prevState ? prevState.current : targetSlot,
            current: targetSlot,
            transitionFrame: frame,
          });
        }
        const state = slotState.current.get(index) ?? {
          prev: targetSlot,
          current: targetSlot,
          transitionFrame: frame,
        };

        const springProgress = spring({
          frame: frame - state.transitionFrame,
          fps,
          config: { damping: 22, mass: 0.7, stiffness: 120 },
        });

        const cx = interpolate(springProgress, [0, 1], [state.prev.cx, state.current.cx]);
        const cy = interpolate(springProgress, [0, 1], [state.prev.cy, state.current.cy]);
        const scale = interpolate(springProgress, [0, 1], [state.prev.scale, state.current.scale]);
        const opacity = interpolate(springProgress, [0, 1], [state.prev.opacity, state.current.opacity]);

        const cardX = cx * width;
        const cardY = cy * height;

        const isActive = index === activeIndex;
        return (
          <div
            key={index}
            data-slot={isActive ? "active" : (relatedIndices.includes(index) ? "related" : "parked")}
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
