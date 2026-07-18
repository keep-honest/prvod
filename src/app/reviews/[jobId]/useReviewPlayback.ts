"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ReviewPageModel,
  ReviewPlaybackMode,
  ReviewScene,
} from "@/domain/entities/ReviewPage";

function clampTimeMs(value: number, durationSeconds: number): number {
  const maxMs = Math.max(0, durationSeconds * 1000);
  return Math.max(0, Math.min(value, maxMs));
}

function findSceneForTime(scenes: ReviewScene[], timeMs: number): ReviewScene | null {
  return scenes.find((scene) => timeMs >= scene.startTimeMs && timeMs < scene.endTimeMs) ?? null;
}

declare global {
  interface Window {
    __PRVOD_REVIEW_TEST__?: {
      forceAutoplayBlocked: () => void;
      forceReplayUnlocked: (timeMs: number) => void;
    };
  }
}

export function useReviewPlayback(reviewPage: ReviewPageModel) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekMsRef = useRef<number | null>(0);
  const initialPlaybackAttemptedRef = useRef(false);

  const [mode, setMode] = useState<ReviewPlaybackMode>("full_review");
  const [mainCurrentTimeMs, setMainCurrentTimeMs] = useState(0);
  const [currentVideoTimeMs, setCurrentVideoTimeMs] = useState(0);
  const [focusedSceneNumber, setFocusedSceneNumber] = useState<number | null>(null);
  const [returnTimeMs, setReturnTimeMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [autoplayPermitted, setAutoplayPermitted] = useState(
    reviewPage.autoplayMode === "auto_if_permitted",
  );
  const sceneMap = useMemo(
    () => new Map(reviewPage.scenes.map((scene) => [scene.sceneNumber, scene] as const)),
    [reviewPage.scenes],
  );

  const activeScene = useMemo(() => {
    if (mode === "file_focus" && focusedSceneNumber !== null) {
      return sceneMap.get(focusedSceneNumber) ?? null;
    }
    return findSceneForTime(reviewPage.scenes, currentVideoTimeMs);
  }, [currentVideoTimeMs, focusedSceneNumber, mode, reviewPage.scenes, sceneMap]);

  const focusedScene = focusedSceneNumber !== null
    ? sceneMap.get(focusedSceneNumber) ?? null
    : null;
  const activeAnchorIds = activeScene?.anchorIds ?? [];

  // Locked only while the video is actively playing in full_review mode.
  // Users can explore the graph and file rail when paused or before first play.
  const railLocked = mode === "full_review" && isPlaying;

  const seekTo = (timeMs: number) => {
    const clampedMs = clampTimeMs(timeMs, reviewPage.durationSeconds);
    const video = videoRef.current;
    if (!video || Number.isNaN(video.duration)) {
      pendingSeekMsRef.current = clampedMs;
      return;
    }
    video.currentTime = clampedMs / 1000;
    pendingSeekMsRef.current = null;
    setCurrentVideoTimeMs(clampedMs);
  };

  const pauseVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setIsPlaying(false);
  };

  const playVideo = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
      setIsPlaying(true);
      setAutoplayPermitted(true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        console.error("[useReviewPlayback] video.play() failed:", err);
      }
      setAutoplayPermitted(false);
      setIsPlaying(false);
    }
  };

  const forceAutoplayBlocked = () => {
    setAutoplayPermitted(false);
    setIsPlaying(false);
  };

  const forceReplayUnlocked = (timeMs: number) => {
    const clampedMs = clampTimeMs(timeMs, reviewPage.durationSeconds);
    setMode("full_review");
    setFocusedSceneNumber(null);
    setReturnTimeMs(clampedMs);
    setMainCurrentTimeMs(clampedMs);
    setCurrentVideoTimeMs(clampedMs);
    seekTo(clampedMs);
    pauseVideo();
  };

  const selectScene = (sceneNumber: number) => {
    const scene = sceneMap.get(sceneNumber);
    if (!scene) return;

    const currentMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
    const savedReturnTime = mode === "full_review"
      ? currentMs
      : (returnTimeMs ?? mainCurrentTimeMs);

    setReturnTimeMs(savedReturnTime);
    setFocusedSceneNumber(sceneNumber);
    setMode("file_focus");
    setIsPlaying(false);
    seekTo(scene.startTimeMs);
    pauseVideo();
  };

  const backToReview = () => {
    const targetTimeMs = returnTimeMs ?? mainCurrentTimeMs;
    setMode("full_review");
    setFocusedSceneNumber(null);
    setCurrentVideoTimeMs(targetTimeMs);
    seekTo(targetTimeMs);
    pauseVideo();
  };

  const jumpToScene = (sceneNumber: number) => {
    const scene = sceneMap.get(sceneNumber);
    if (!scene) return;
    if (mode === "file_focus") {
      setMode("full_review");
      setFocusedSceneNumber(null);
    }
    seekTo(scene.startTimeMs);
    setCurrentVideoTimeMs(scene.startTimeMs);
    setMainCurrentTimeMs(scene.startTimeMs);
    pauseVideo();
  };

  const handleLoadedMetadata = () => {
    if (pendingSeekMsRef.current !== null) {
      seekTo(pendingSeekMsRef.current);
    }

    if (initialPlaybackAttemptedRef.current) {
      return;
    }

    initialPlaybackAttemptedRef.current = true;
    if (reviewPage.autoplayMode === "auto_if_permitted") {
      void playVideo();
      window.setTimeout(() => {
        const video = videoRef.current;
        if (!video || !video.paused) {
          return;
        }
        setAutoplayPermitted(false);
        setIsPlaying(false);
      }, 150);
      return;
    }

    setAutoplayPermitted(false);
    pauseVideo();
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    const timeMs = Math.round(video.currentTime * 1000);
    setCurrentVideoTimeMs(timeMs);

    if (mode === "full_review") {
      setMainCurrentTimeMs(timeMs);
      return;
    }

    if (focusedScene && timeMs >= focusedScene.endTimeMs) {
      seekTo(focusedScene.endTimeMs);
      pauseVideo();
    }
  };

  const handlePlay = () => {
    setIsPlaying(true);
  };

  const handlePause = () => {
    setIsPlaying(false);
  };

  const handleEnded = () => {
    setIsPlaying(false);
    if (mode === "full_review") {
      const endMs = reviewPage.durationSeconds * 1000;
      setMainCurrentTimeMs(endMs);
      setCurrentVideoTimeMs(endMs);
      return;
    }

    if (focusedScene) {
      seekTo(focusedScene.endTimeMs);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.__PRVOD_REVIEW_TEST__ = {
      forceAutoplayBlocked,
      forceReplayUnlocked,
    };
    return () => {
      delete window.__PRVOD_REVIEW_TEST__;
    };
  }, [reviewPage.durationSeconds]);

  return {
    videoRef,
    mode,
    activeScene,
    activeAnchorIds,
    focusedSceneNumber,
    currentVideoTimeMs,
    isPlaying,
    autoplayPermitted,
    railLocked,
    selectScene,
    backToReview,
    jumpToScene,
    playVideo,
    pauseVideo,
    forceAutoplayBlocked,
    forceReplayUnlocked,
    handleLoadedMetadata,
    handleTimeUpdate,
    handlePlay,
    handlePause,
    handleEnded,
  };
}
