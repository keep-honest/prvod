import { describe, expect, it } from "vitest";
import {
  ACTIVE_SLOT,
  RELATED_SLOTS,
  PARKED_SLOT,
  MAX_VISIBLE_ARROWS,
  pickSlot,
  segmentStateAt,
  deriveCardTransition,
} from "@/infrastructure/video/remotion/cardTransitions";
import {
  findActiveBinding,
  findActiveBindingIndex,
  type ResolvedBinding,
} from "@/infrastructure/video/remotion/wordSyncedBindings";

const FPS = 30;

function binding(overrides: Partial<ResolvedBinding>): ResolvedBinding {
  return {
    wordStartIndex: 0,
    wordEndIndex: 0,
    codeBrollIndex: 0,
    highlightLines: [],
    relatesToCodeBrollIndices: [],
    startMs: 0,
    endMs: 0,
    ...overrides,
  };
}

/** Active card 0 from t=0, then active card 1 (with 0 as related) from t=2000. */
function twoSegmentTimeline(): ResolvedBinding[] {
  return [
    binding({ codeBrollIndex: 0, startMs: 0, endMs: 1000, relatesToCodeBrollIndices: [1] }),
    binding({
      wordStartIndex: 4,
      wordEndIndex: 5,
      codeBrollIndex: 1,
      startMs: 2000,
      endMs: 3000,
      relatesToCodeBrollIndices: [0],
    }),
  ];
}

// ── segmentStateAt ──────────────────────────────────────────────────────

describe("segmentStateAt", () => {
  it("returns the pre-first-binding default (card 0 active, no related) before the first binding", () => {
    const bindings = [binding({ codeBrollIndex: 2, startMs: 1000, endMs: 2000 })];
    expect(segmentStateAt(bindings, 500)).toEqual({ activeIndex: 0, relatedIndices: [] });
    expect(segmentStateAt([], 500)).toEqual({ activeIndex: 0, relatedIndices: [] });
  });

  it("returns the binding's card + related indices once its segment starts", () => {
    const bindings = twoSegmentTimeline();
    expect(segmentStateAt(bindings, 0)).toEqual({ activeIndex: 0, relatedIndices: [1] });
    // Sticky-forward: still segment 0 in the gap after endMs.
    expect(segmentStateAt(bindings, 1500)).toEqual({ activeIndex: 0, relatedIndices: [1] });
    expect(segmentStateAt(bindings, 2000)).toEqual({ activeIndex: 1, relatedIndices: [0] });
  });

  it("caps relatedIndices at MAX_VISIBLE_ARROWS", () => {
    const bindings = [
      binding({ codeBrollIndex: 0, relatesToCodeBrollIndices: [1, 2, 3, 4, 5] }),
    ];
    const seg = segmentStateAt(bindings, 100);
    expect(seg.relatedIndices).toHaveLength(MAX_VISIBLE_ARROWS);
    expect(seg.relatedIndices).toEqual([1, 2, 3]);
  });
});

// ── pickSlot ────────────────────────────────────────────────────────────

describe("pickSlot", () => {
  it("assigns the active index to ACTIVE_SLOT (even if it also appears in relatedIndices)", () => {
    expect(pickSlot(0, 0, [])).toBe(ACTIVE_SLOT);
    expect(pickSlot(1, 1, [1])).toBe(ACTIVE_SLOT);
  });

  it("assigns related indices to ring slots by position", () => {
    expect(pickSlot(4, 0, [4, 5, 6])).toBe(RELATED_SLOTS[0]);
    expect(pickSlot(5, 0, [4, 5, 6])).toBe(RELATED_SLOTS[1]);
    expect(pickSlot(6, 0, [4, 5, 6])).toBe(RELATED_SLOTS[2]);
  });

  it("parks unreferenced indices", () => {
    expect(pickSlot(9, 0, [1, 2])).toBe(PARKED_SLOT);
  });

  it("parks related overflow beyond the ring capacity (guards MAX_VISIBLE_ARROWS vs RELATED_SLOTS divergence)", () => {
    // If MAX_VISIBLE_ARROWS ever exceeded the ring size, surplus related
    // indices must degrade to PARKED_SLOT instead of crashing/undefined.
    const overflow = [4, 5, 6, 7];
    expect(pickSlot(7, 0, overflow)).toBe(PARKED_SLOT);
    // And the cap itself must never outgrow the ring.
    expect(MAX_VISIBLE_ARROWS).toBeLessThanOrEqual(RELATED_SLOTS.length);
  });
});

// ── deriveCardTransition ────────────────────────────────────────────────

describe("deriveCardTransition", () => {
  it("pre-first-binding default: card 0 active, no transition (segment -1)", () => {
    const bindings = [binding({ codeBrollIndex: 1, startMs: 1000, endMs: 2000 })];

    const card0 = deriveCardTransition(bindings, 0, 500, FPS);
    expect(card0.targetSlot).toBe(ACTIVE_SLOT);
    expect(card0.prevSlot).toBe(ACTIVE_SLOT);
    expect(card0.transitionFrameOffset).toBe(0);

    const card1 = deriveCardTransition(bindings, 1, 500, FPS);
    expect(card1.targetSlot).toBe(PARKED_SLOT);
    expect(card1.prevSlot).toBe(PARKED_SLOT);
    expect(card1.transitionFrameOffset).toBe(0);
  });

  it("derives prev/target slots and the ceil-anchored frame for an active swap at a single boundary", () => {
    const bindings = twoSegmentTimeline();
    const t = 2500; // inside segment 1 (started at 2000ms)
    const expectedAnchor = Math.ceil((2000 / 1000) * FPS); // = 60

    // Card 1: related (ring slot 0) → active.
    const card1 = deriveCardTransition(bindings, 1, t, FPS);
    expect(card1.targetSlot).toBe(ACTIVE_SLOT);
    expect(card1.prevSlot).toBe(RELATED_SLOTS[0]);
    expect(card1.transitionFrameOffset).toBe(expectedAnchor);

    // Card 0: active → related (ring slot 0), anchored at the SAME boundary.
    const card0 = deriveCardTransition(bindings, 0, t, FPS);
    expect(card0.targetSlot).toBe(RELATED_SLOTS[0]);
    expect(card0.prevSlot).toBe(ACTIVE_SLOT);
    expect(card0.transitionFrameOffset).toBe(expectedAnchor);
  });

  it("ceil-anchors boundaries that fall between frames", () => {
    const bindings = [
      binding({ codeBrollIndex: 0, startMs: 0, endMs: 1000 }),
      binding({ wordStartIndex: 3, codeBrollIndex: 1, startMs: 2050, endMs: 3000 }),
    ];
    const card1 = deriveCardTransition(bindings, 1, 2500, FPS);
    // 2050ms at 30fps = frame 61.5 → first frame observing the boundary is 62.
    expect(card1.transitionFrameOffset).toBe(62);
  });

  it("is a no-op for a card whose slot never changes across boundaries", () => {
    const bindings = twoSegmentTimeline();
    // Card 2 is never active nor related — parked in every segment,
    // including segment -1. The walk-back must find no change.
    const card2 = deriveCardTransition(bindings, 2, 2500, FPS);
    expect(card2.targetSlot).toBe(PARKED_SLOT);
    expect(card2.prevSlot).toBe(PARKED_SLOT);
    expect(card2.transitionFrameOffset).toBe(0);
  });

  it("walks back past the first binding into segment -1 when the slot was already correct at t=0", () => {
    // Segment -1 default already has card 0 active; binding 0 keeps it
    // active. No transition should be synthesized at binding 0's start.
    const bindings = [binding({ codeBrollIndex: 0, startMs: 400, endMs: 1000 })];
    const card0 = deriveCardTransition(bindings, 0, 700, FPS);
    expect(card0.prevSlot).toBe(ACTIVE_SLOT);
    expect(card0.transitionFrameOffset).toBe(0);
  });

  it("anchors at the most recent boundary where the card's slot changed, not the current segment start", () => {
    // Card 0 goes active → parked at 2000ms and STAYS parked through the
    // 4000ms boundary — the spring must stay anchored at 2000ms.
    const bindings = [
      binding({ codeBrollIndex: 0, startMs: 0, endMs: 1000 }),
      binding({ wordStartIndex: 3, codeBrollIndex: 1, startMs: 2000, endMs: 3000 }),
      binding({ wordStartIndex: 6, codeBrollIndex: 2, startMs: 4000, endMs: 5000 }),
    ];
    const card0 = deriveCardTransition(bindings, 0, 4500, FPS);
    expect(card0.targetSlot).toBe(PARKED_SLOT);
    expect(card0.prevSlot).toBe(ACTIVE_SLOT);
    expect(card0.transitionFrameOffset).toBe(Math.ceil((2000 / 1000) * FPS));
  });
});

// ── shared search consistency ───────────────────────────────────────────

describe("findActiveBindingIndex ↔ findActiveBinding consistency", () => {
  it("returns the same binding for identical timelines at every probe time", () => {
    const timeline = [
      binding({ codeBrollIndex: 0, startMs: 0, endMs: 900 }),
      binding({ wordStartIndex: 2, codeBrollIndex: 1, startMs: 1500, endMs: 2400 }),
      binding({ wordStartIndex: 5, codeBrollIndex: 2, startMs: 3000, endMs: 4000 }),
    ];
    const probes = [-100, 0, 450, 900, 1200, 1500, 2999, 3000, 3001, 99999];
    for (const t of probes) {
      const idx = findActiveBindingIndex(timeline, t);
      const viaIndex = idx === -1 ? null : timeline[idx];
      expect(viaIndex).toBe(findActiveBinding(timeline, t));
    }
  });

  it("both report 'no binding yet' before the first startMs and on empty lists", () => {
    const timeline = [binding({ codeBrollIndex: 0, startMs: 500, endMs: 900 })];
    expect(findActiveBindingIndex(timeline, 499)).toBe(-1);
    expect(findActiveBinding(timeline, 499)).toBeNull();
    expect(findActiveBindingIndex([], 100)).toBe(-1);
    expect(findActiveBinding([], 100)).toBeNull();
  });
});
