"use client";

import type { ReviewPageModel } from "@/domain/entities/ReviewPage";
import { ReviewHeader } from "./_components/ReviewHeader";
import { ReviewShell } from "./_components/ReviewShell";
import { ScenePicker } from "./_components/ScenePicker";
import { useReviewPlayback } from "./useReviewPlayback";

export function ReviewPageClient(props: { reviewPage: ReviewPageModel }) {
  const { reviewPage } = props;
  const {
    videoRef,
    activeScene,
    seekTo,
    handleTimeUpdate,
    handlePlay,
    handlePause,
    handleEnded,
  } = useReviewPlayback(reviewPage);

  return (
    <ReviewShell
      header={
        <ReviewHeader
          repoFullName={reviewPage.repoFullName}
          prNumber={reviewPage.prNumber}
          durationMode={reviewPage.durationMode}
          headline={reviewPage.headline}
        />
      }
    >
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="rounded-2xl border border-white/10 bg-black/40 p-3">
          <video
            ref={videoRef}
            src={reviewPage.videoUrl}
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full rounded-xl bg-black"
            onTimeUpdate={handleTimeUpdate}
            onPlay={handlePlay}
            onPause={handlePause}
            onEnded={handleEnded}
          />
          {activeScene ? (
            <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/50">
                Scene {activeScene.sceneNumber}
              </p>
              <p className="mt-1 text-sm leading-6 text-white/80">{activeScene.narration}</p>
            </div>
          ) : null}
        </div>

        <ScenePicker
          filePath={reviewPage.repoFullName}
          scenes={reviewPage.scenes}
          onSelectScene={(sceneNumber) => {
            const scene = reviewPage.scenes.find((s) => s.sceneNumber === sceneNumber);
            if (scene) seekTo(scene.startTimeMs);
          }}
        />
      </div>
    </ReviewShell>
  );
}
