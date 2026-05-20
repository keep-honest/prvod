"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ReviewPageModel, ReviewScene } from "@/domain/entities/ReviewPage";

function clampTimeMs(value: number, durationSeconds: number): number {
  const maxMs = Math.max(0, durationSeconds * 1000);
  return Math.max(0, Math.min(value, maxMs));
}

function findSceneForTime(scenes: ReviewScene[], timeMs: number): ReviewScene | null {
  return scenes.find((scene) => timeMs >= scene.startTimeMs && timeMs < scene.endTimeMs) ?? null;
}

export function useReviewPlayback(reviewPage: ReviewPageModel) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const activeScene = useMemo(
    () => findSceneForTime(reviewPage.scenes, currentTimeMs),
    [reviewPage.scenes, currentTimeMs],
  );

  const seekTo = useCallback((targetMs: number) => {
    const clamped = clampTimeMs(targetMs, reviewPage.durationSeconds);
    setCurrentTimeMs(clamped);
    if (videoRef.current) {
      videoRef.current.currentTime = clamped / 1000;
    }
  }, [reviewPage.durationSeconds]);

  const handleTimeUpdate = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const target = event.currentTarget;
    setCurrentTimeMs(Math.round(target.currentTime * 1000));
  }, []);

  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => setIsPlaying(false), []);
  const handleEnded = useCallback(() => setIsPlaying(false), []);

  return {
    videoRef,
    currentTimeMs,
    activeScene,
    isPlaying,
    seekTo,
    handleTimeUpdate,
    handlePlay,
    handlePause,
    handleEnded,
  };
}
