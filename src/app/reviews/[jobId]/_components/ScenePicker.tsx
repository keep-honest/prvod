"use client";

import type { ReviewScene } from "@/domain/entities/ReviewPage";
import { formatTimestamp } from "./reviewFormatters";

export function ScenePicker(props: {
  filePath: string;
  scenes: ReviewScene[];
  onSelectScene: (sceneNumber: number) => void;
}) {
  if (props.scenes.length <= 1) {
    return null;
  }

  return (
    <div className="review-surface cine-transition rounded-2xl p-3">
      <div className="mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--foreground-soft)]">
          Replay scenes
        </p>
        <p className="mt-1 text-sm text-[var(--foreground)]">{props.filePath}</p>
      </div>

      <div className="space-y-2">
        {props.scenes.map((scene) => (
          <button
            key={scene.sceneNumber}
            type="button"
            data-testid="review-scene-option"
            data-scene-number={scene.sceneNumber}
            onClick={() => props.onSelectScene(scene.sceneNumber)}
            className="cine-transition flex w-full items-start justify-between gap-3 rounded-xl border border-[var(--border)] bg-black/20 px-3 py-2 text-left hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
          >
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-secondary)]">
                Scene {scene.sceneNumber}
              </div>
              <div className="mt-1 text-sm text-[var(--foreground-muted)]">{scene.narration}</div>
            </div>
            <span className="shrink-0 text-xs text-[var(--foreground-soft)]">
              {formatTimestamp(scene.startTimeMs)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
