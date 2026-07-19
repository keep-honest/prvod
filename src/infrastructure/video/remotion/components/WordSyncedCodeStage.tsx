import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Scene } from "@/domain/entities/VideoScript";
import type { WordTiming } from "@/interfaces/ITTSService";
import {
  resolveBindings,
  findActiveBinding,
} from "@/infrastructure/video/remotion/wordSyncedBindings";
import { CodeCardLayout } from "@/infrastructure/video/remotion/components/CodeCardLayout";
import {
  ACTIVE_SLOT,
  RELATED_SLOTS,
  MAX_VISIBLE_ARROWS,
} from "@/infrastructure/video/remotion/cardTransitions";
import { ConnectionArrow } from "@/infrastructure/video/remotion/components/ConnectionArrow";

interface WordSyncedCodeStageProps {
  scene: Scene;
  wordTimings: WordTiming[];
  /** Scene's frame offset within the parent composition. */
  startFrame: number;
  durationFrames: number;
}

/**
 * Top-level word-synced code stage. Per frame, derives the active binding
 * from `wordTimings`, picks the active codeBroll + related indices, and
 * delegates layout to CodeCardLayout. Renders one ConnectionArrow per
 * related index (capped at MAX_VISIBLE_ARROWS).
 *
 * No React state per frame — useMemo pre-resolves bindings once per
 * (scene, wordTimings) tuple. Binding lookup is binary search.
 */
export const WordSyncedCodeStage: React.FC<WordSyncedCodeStageProps> = ({
  scene,
  wordTimings,
  startFrame,
  durationFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const resolved = useMemo(() => resolveBindings({ scene, wordTimings }), [scene, wordTimings]);

  const currentTimeMs = ((frame - startFrame) / fps) * 1000;
  const active = findActiveBinding(resolved, currentTimeMs);

  // Default: first snippet centered (matches legacy static-overlay behavior).
  // CodeCardLayout derives the same (activeIndex, relatedIndices) internally
  // from the resolved timeline; these are only for arrows and highlights.
  const relatedIndices = (active?.relatesToCodeBrollIndices ?? []).slice(0, MAX_VISIBLE_ARROWS);

  // Arrows from the active card center to each related card center. Slot
  // coordinates come from the shared cardTransitions constants — the same
  // ones CodeCardLayout positions cards with — so endpoints always match.
  const arrows = relatedIndices.flatMap((relatedIdx, slotPos) => {
    const toSlot = RELATED_SLOTS[slotPos];
    if (!toSlot) return []; // relatedIndices is capped at MAX_VISIBLE_ARROWS, but guard anyway
    return [
      {
        relatedIdx,
        from: { x: ACTIVE_SLOT.cx * width, y: ACTIVE_SLOT.cy * height },
        to: { x: toSlot.cx * width, y: toSlot.cy * height },
      },
    ];
  });

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <CodeCardLayout
        items={scene.codeBroll}
        bindings={resolved}
        startFrame={startFrame}
        durationFrames={durationFrames}
        activeHighlightLines={active?.highlightLines ?? []}
        activeHighlightStartMs={active?.startMs ?? 0}
        activeHighlightEndMs={active?.endMs ?? 0}
      />
      {arrows.map((a) => (
        <ConnectionArrow
          key={a.relatedIdx}
          from={a.from}
          to={a.to}
          startMs={active?.startMs ?? 0}
          endMs={active?.endMs ?? 0}
        />
      ))}
    </AbsoluteFill>
  );
};
