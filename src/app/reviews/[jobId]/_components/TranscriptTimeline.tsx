"use client";

import type { ReviewScene } from "@/domain/entities/ReviewPage";
import { formatTimestamp } from "./reviewFormatters";
import { VirtualizedScrollList } from "./VirtualizedScrollList";

const VIRTUALIZE_SCENES_THRESHOLD = 10;
const CARD_GAP = 12;

export function TranscriptTimeline(props: {
  scenes: ReviewScene[];
  activeSceneNumber: number | null;
  headline: string;
  onSelectScene?: (sceneNumber: number) => void;
}) {
  const renderSceneCard = (scene: ReviewScene) => {
    const active = props.activeSceneNumber === scene.sceneNumber;
    const clickable = !!props.onSelectScene;
    return (
      <div
        key={scene.sceneNumber}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        data-scene-number={scene.sceneNumber}
        onClick={clickable ? () => props.onSelectScene?.(scene.sceneNumber) : undefined}
        onKeyDown={clickable ? (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onSelectScene?.(scene.sceneNumber);
          }
        } : undefined}
        className={`cine-transition min-w-0 rounded-2xl border px-4 py-3 ${
          active
            ? "border-[var(--accent)] bg-[var(--accent-soft)]"
            : "border-[var(--border)] bg-black/15"
        } ${clickable ? "cursor-pointer hover:border-[var(--border-strong)] hover:bg-white/5" : ""}`}
      >
        <div className="flex min-w-0 items-center gap-3 overflow-hidden">
          <span className="rounded-md bg-black/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--warning)]">
            {formatTimestamp(scene.startTimeMs)}
          </span>
          <span className="text-xs uppercase tracking-[0.18em] text-[var(--foreground-soft)]">
            {scene.sceneType.replaceAll("_", " ")}
          </span>
          {scene.filePaths[0] ? (
            <span className="truncate text-xs text-[var(--accent-secondary)]">{scene.filePaths[0]}</span>
          ) : null}
        </div>
        <p className="mt-3 break-words text-sm leading-6 text-[var(--foreground-muted)]">
          {scene.narration}
        </p>
      </div>
    );
  };

  return (
    <div className="review-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[28px]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--foreground-soft)]">
              Transcript, timeline & diff focus
            </p>
            <h3 className="mt-2 text-lg font-semibold text-[var(--foreground)]">{props.headline}</h3>
          </div>
          <span className="rounded-full border border-[var(--border)] bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--foreground-soft)]">
            {props.scenes.length} beats
          </span>
        </div>
      </div>

      <VirtualizedScrollList
        items={props.scenes}
        threshold={VIRTUALIZE_SCENES_THRESHOLD}
        estimateSize={140}
        overscan={4}
        gap={CARD_GAP}
        measureElements
        getKey={(s) => s.sceneNumber}
        renderItem={renderSceneCard}
        rootClassName="min-h-0 min-w-0 flex-1 overflow-hidden"
        paddingClass="px-4 py-4"
        spacingClass="space-y-3"
      />
    </div>
  );
}
