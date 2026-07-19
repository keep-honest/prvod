/**
 * Pure card-slot & transition derivation for the word-synced code stage.
 *
 * No React, no Remotion — every export is a pure function of the resolved
 * binding timeline, so it's straightforward to unit-test and, critically,
 * every rendered frame stays a pure function of (frame, props): Remotion's
 * concurrent chunked rendering remounts components at chunk boundaries,
 * resetting any cross-frame refs, so slot assignments AND transition anchors
 * must both be derived from the timeline rather than remembered.
 *
 * Shares `findActiveBindingIndex` with the stage's active-binding lookup so
 * the two sticky-forward searches can never diverge.
 */
import type { ResolvedBinding } from "@/infrastructure/video/remotion/wordSyncedBindings";
import { findActiveBindingIndex } from "@/infrastructure/video/remotion/wordSyncedBindings";

/** Screen-space slot a card can occupy. */
export interface Slot {
  /** Normalized (0..1) center coordinates in the viewport. */
  cx: number;
  cy: number;
  scale: number;
  opacity: number;
}

/**
 * Slots are shared module constants — reference equality (`slotA !== slotB`)
 * is how a slot change is detected, so callers must never clone them.
 */
export const ACTIVE_SLOT: Slot = { cx: 0.5, cy: 0.5, scale: 1.0, opacity: 1.0 };
// Related-slots ring positions (upper-right, lower-right, left). Caller may
// supply up to MAX_VISIBLE_ARROWS related indices; surplus collapse to
// PARKED_SLOT via pickSlot's bounds check.
export const RELATED_SLOTS: Slot[] = [
  { cx: 0.82, cy: 0.28, scale: 0.55, opacity: 0.85 },
  { cx: 0.82, cy: 0.72, scale: 0.55, opacity: 0.85 },
  { cx: 0.18, cy: 0.5, scale: 0.55, opacity: 0.85 },
];
export const PARKED_SLOT: Slot = { cx: 0.5, cy: 1.15, scale: 0.4, opacity: 0 };

/** Max related cards shown in ring slots (mirrors the arrow cap in WordSyncedCodeStage). */
export const MAX_VISIBLE_ARROWS = 3;

export interface SegmentState {
  activeIndex: number;
  relatedIndices: number[];
}

/**
 * The (activeIndex, relatedIndices) pair is piecewise-constant over time:
 * the sticky-forward binding search changes only at each binding's `startMs`.
 * Segment -1 is the pre-first-binding default (first snippet centered, no
 * related cards), segment j covers [bindings[j].startMs, next).
 */
function segmentState(bindings: ResolvedBinding[], segIdx: number): SegmentState {
  if (segIdx < 0) return { activeIndex: 0, relatedIndices: [] };
  const b = bindings[segIdx];
  return {
    activeIndex: b.codeBrollIndex,
    relatedIndices: (b.relatesToCodeBrollIndices ?? []).slice(0, MAX_VISIBLE_ARROWS),
  };
}

/** Segment state at `currentTimeMs` — the pre-first-binding default before the first binding. */
export function segmentStateAt(
  bindings: ResolvedBinding[],
  currentTimeMs: number,
): SegmentState {
  return segmentState(bindings, findActiveBindingIndex(bindings, currentTimeMs));
}

/** First frame (scene-local) at which a boundary at `ms` is observed. */
function boundaryFrame(ms: number, fps: number): number {
  return Math.ceil((ms / 1000) * fps);
}

export function pickSlot(
  index: number,
  activeIndex: number,
  relatedIndices: number[],
): Slot {
  if (index === activeIndex) return ACTIVE_SLOT;
  const relatedPos = relatedIndices.indexOf(index);
  if (relatedPos >= 0 && relatedPos < RELATED_SLOTS.length) return RELATED_SLOTS[relatedPos];
  return PARKED_SLOT;
}

export interface CardTransition {
  /** Slot the card occupies in the current segment. */
  targetSlot: Slot;
  /** Slot the card is animating away from; equals targetSlot when no transition. */
  prevSlot: Slot;
  /**
   * Scene-local frame at which the prev→target spring anchors (ceil of the
   * boundary's ms). 0 when the card's slot has not changed since t=0.
   */
  transitionFrameOffset: number;
}

/**
 * Derive one card's current slot AND its most recent slot-change boundary
 * from the resolved binding timeline.
 *
 * Walks back through binding-boundary segments to find the most recent one
 * where this card's slot changed. Loop invariant: this card's slot in segment
 * j equals targetSlot (trivially true at j = segIdx; each continue implies
 * segment j-1 also matches). Slots are shared module constants, so reference
 * equality identifies a change. If the slot never changed since t=0,
 * prevSlot === targetSlot and any spring anchored at offset 0 is a no-op.
 */
export function deriveCardTransition(
  bindings: ResolvedBinding[],
  cardIndex: number,
  currentTimeMs: number,
  fps: number,
): CardTransition {
  const segIdx = findActiveBindingIndex(bindings, currentTimeMs);
  const seg = segmentState(bindings, segIdx);
  const targetSlot = pickSlot(cardIndex, seg.activeIndex, seg.relatedIndices);

  let prevSlot = targetSlot;
  let transitionFrameOffset = 0;
  for (let j = segIdx; j >= 0; j--) {
    const before = segmentState(bindings, j - 1);
    const slotBefore = pickSlot(cardIndex, before.activeIndex, before.relatedIndices);
    if (slotBefore !== targetSlot) {
      prevSlot = slotBefore;
      transitionFrameOffset = boundaryFrame(bindings[j].startMs, fps);
      break;
    }
  }
  return { targetSlot, prevSlot, transitionFrameOffset };
}
