"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ReviewScene } from "@/domain/entities/ReviewPage";

interface TimedSentence {
  text: string;
  startMs: number;
  endMs: number;
}

function splitSentences(narration: string): string[] {
  return narration
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function buildTimedSentences(scene: ReviewScene): TimedSentence[] {
  const sentences = splitSentences(scene.narration);
  if (sentences.length === 0) return [];

  const wordCounts = sentences.map(countWords);
  const totalWords = wordCounts.reduce((sum, w) => sum + w, 0);
  if (totalWords === 0) {
    // Edge case: all punctuation, no words — distribute evenly
    const sliceDuration = (scene.endTimeMs - scene.startTimeMs) / sentences.length;
    return sentences.map((text, i) => ({
      text,
      startMs: scene.startTimeMs + i * sliceDuration,
      endMs: scene.startTimeMs + (i + 1) * sliceDuration,
    }));
  }

  const sceneDurationMs = scene.endTimeMs - scene.startTimeMs;
  let cursor = scene.startTimeMs;
  return sentences.map((text, i) => {
    const fraction = (wordCounts[i] ?? 0) / totalWords;
    const durationMs = fraction * sceneDurationMs;
    const startMs = cursor;
    const endMs = cursor + durationMs;
    cursor = endMs;
    return { text, startMs, endMs };
  });
}

export function LiveTranscript(props: {
  scenes: ReviewScene[];
  currentTimeMs: number;
  activeSceneNumber: number | null;
  compact?: boolean;
}) {
  const activeRef = useRef<HTMLSpanElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const activeScene = useMemo(
    () => props.scenes.find((s) => s.sceneNumber === props.activeSceneNumber) ?? null,
    [props.scenes, props.activeSceneNumber],
  );

  const timedSentences = useMemo(
    () => (activeScene ? buildTimedSentences(activeScene) : []),
    [activeScene],
  );

  const activeIndex = useMemo(() => {
    const t = props.currentTimeMs;
    const idx = timedSentences.findIndex((s) => t >= s.startMs && t < s.endMs);
    // If past the last sentence, highlight the last one
    const lastSentence = timedSentences[timedSentences.length - 1];
    if (idx === -1 && lastSentence && t >= lastSentence.endMs) {
      return timedSentences.length - 1;
    }
    return idx;
  }, [timedSentences, props.currentTimeMs]);

  useEffect(() => {
    const el = activeRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    container.scrollTo({
      top: el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2,
      behavior: "smooth",
    });
  }, [activeIndex]);

  if (!activeScene || timedSentences.length === 0) {
    return null;
  }

  const containerClassName = props.compact
    ? "max-h-[128px] overflow-y-auto rounded-2xl border border-[var(--border)] bg-black/20 px-4 py-3"
    : "mt-3 max-h-[160px] overflow-y-auto rounded-2xl border border-[var(--border)] bg-black/20 px-4 py-3";
  const textClassName = props.compact
    ? "text-sm leading-7 text-[var(--foreground-muted)]"
    : "text-base leading-8 text-[var(--foreground-muted)]";

  return (
    <div
      ref={containerRef}
      data-testid="review-live-transcript"
      className={containerClassName}
    >
      <p className={textClassName}>
        {timedSentences.map((sentence, i) => (
          <span
            key={`${activeScene.sceneNumber}-${i}`}
            ref={i === activeIndex ? activeRef : undefined}
            className={`cine-transition inline ${
              i === activeIndex
                ? "rounded bg-[var(--accent-soft)] px-1 -mx-0.5 text-white"
                : i < activeIndex
                  ? "text-[var(--foreground-muted)]"
                  : "text-[var(--foreground-soft)] opacity-50"
            }`}
          >
            {sentence.text}{" "}
          </span>
        ))}
      </p>
    </div>
  );
}
