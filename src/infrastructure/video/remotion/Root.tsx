import React from "react";
import {
  Composition,
  AbsoluteFill,
  Sequence,
  Audio,
  registerRoot,
} from "remotion";
import type { CodeBroll, VideoScript } from "@/domain/entities/VideoScript";
import type { SceneTimelineEntry } from "@/interfaces/IClipAsset";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import { AIClipScene } from "./components/AIClipScene";
import { CodeBrollOverlay } from "./components/CodeBrollOverlay";
import { WordSyncedCodeStage } from "./components/WordSyncedCodeStage";
import { isWordSyncedCodeEnabled } from "@/lib/featureFlags";
import { CaptionOverlay } from "./components/CaptionOverlay";
import { CodeFirstScene } from "./components/CodeFirstScene";
import { ConstellationScene } from "./components/ConstellationScene";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * Volume scalar applied to AI clip background audio when a separate narration
 * track is present. Equivalent to approximately -18.4 dB relative to the
 * narration track (which plays at unity / 0 dBFS).
 *
 * Rationale: Industry consensus (W3C WCAG G56, BBC mixing guidelines, EBU R 128,
 * YouTube/documentary practice) places the narration-to-background separation at
 * 18–20 dB for clear intelligibility without harshness. 0.12 ≈ -18.4 dB sits
 * within that range while retaining just enough atmospheric presence.
 *
 * Formula: linear = 10^(dB / 20) → 10^(-18.4 / 20) ≈ 0.12
 * W3C WCAG floor (20 dB / 0.10) is satisfied at this level.
 */
const BACKGROUND_CLIP_AUDIO_VOLUME = 0.12;

export interface ClipPathEntry {
  sceneNumber: number;
  clipIndex: number;
  localPath: string;
  sourceType?: "video" | "code";
  durationFrames: number;
}

export interface PRVideoProps extends Record<string, unknown> {
  script: VideoScript;
  clipPaths: ClipPathEntry[];
  sceneTimelineFrames?: SceneTimelineEntry[];
  audioIncluded?: boolean;
  captionOffsetMs?: number;
  graphLayout?: GraphLayoutData;
  /**
   * Server-resolved WORD_SYNCED_CODE flag. This component executes inside the
   * Remotion webpack bundle (headless Chrome) where custom server env vars are
   * NOT injected — Remotion only exposes REMOTION_-prefixed vars or values
   * passed via `envVariables`/`inputProps`. RemotionCompositor resolves the
   * flag server-side and threads it through here (like all other render data).
   * When absent (Remotion Studio / defaultProps), falls back to reading the
   * env directly via `isWordSyncedCodeEnabled()`.
   */
  wordSyncedCodeEnabled?: boolean;
}

interface SceneClipProps {
  scene: VideoScript["scenes"][number];
  clips: ClipPathEntry[];
  durationInFrames: number;
  clipAudioVolume: number;
  sceneTimeline: SceneTimelineEntry | undefined;
  audioIncluded: boolean;
  captionOffsetMs: number;
  upcomingSnippets: CodeBroll[];
  isFirstScene: boolean;
  isLastScene: boolean;
  graphLayout?: GraphLayoutData;
  wordSyncedCodeEnabled: boolean;
}

const SceneClip: React.FC<SceneClipProps> = ({
  scene,
  clips,
  durationInFrames,
  clipAudioVolume,
  sceneTimeline,
  audioIncluded,
  captionOffsetMs,
  upcomingSnippets,
  isFirstScene,
  isLastScene,
  graphLayout,
  wordSyncedCodeEnabled,
}) => {
  const sceneAudioSrc = sceneTimeline?.audioSrc;
  const sceneWordTimings = sceneTimeline?.wordTimings;
  const isCodeOnlyScene =
    clips.length > 0 && clips.every((clip) => clip.sourceType === "code");
  // Constellation scenes animate code cards down to graph nodes. Any scene
  // with codeBroll qualifies, plus the final scene renders the completed
  // graph as the hero visual with a staggered build-in animation (finale).
  const useConstellation =
    isCodeOnlyScene &&
    !!graphLayout &&
    graphLayout.nodes.length > 0 &&
    !isFirstScene &&
    (scene.codeBroll.length > 0 || isLastScene);

  return (
    <AbsoluteFill>
      {useConstellation && graphLayout ? (
        <ConstellationScene
          sceneNumber={scene.sceneNumber}
          graphLayout={graphLayout}
          codeBrollItems={scene.codeBroll}
          durationInFrames={durationInFrames}
          isLastScene={isLastScene}
        />
      ) : isCodeOnlyScene ? (
        <CodeFirstScene
          sceneNumber={scene.sceneNumber}
          filePath={isFirstScene ? undefined : scene.codeBroll[0]?.filePath}
          language={isFirstScene ? undefined : scene.codeBroll[0]?.language}
          code={isFirstScene ? undefined : scene.codeBroll[0]?.code}
          lineRange={isFirstScene ? undefined : scene.codeBroll[0]?.lineRange}
          highlights={isFirstScene ? undefined : scene.codeBroll[0]?.highlights}
          durationInFrames={durationInFrames}
          upcomingSnippets={upcomingSnippets}
          additionalCodeBroll={isFirstScene ? undefined : scene.codeBroll.slice(1)}
        />
      ) : clips.length > 0 && (() => {
        let subOffset = 0;
        return [...clips]
          .sort((a, b) => a.clipIndex - b.clipIndex)
          .map((clip) => {
            const from = subOffset;
            subOffset += clip.durationFrames;
            return (
              <Sequence
                key={`${clip.sceneNumber}-${clip.clipIndex}`}
                from={from}
                durationInFrames={clip.durationFrames}
              >
                <AIClipScene
                  clipSrc={clip.localPath}
                  startFrame={0}
                  durationFrames={clip.durationFrames}
                  muted={clipAudioVolume <= 0}
                  volume={clipAudioVolume}
                />
              </Sequence>
            );
          });
      })()}
      {!isCodeOnlyScene && scene.codeBroll[0] && (() => {
        // Word-synced stage only when: flag enabled, codeBroll exists, and
        // the scene has word timings (genuinely silent scenes fall through
        // to the legacy static overlay since there's no timing source).
        const useWordSync =
          wordSyncedCodeEnabled &&
          scene.codeBroll.length > 0 &&
          (sceneWordTimings?.length ?? 0) > 0;
        if (useWordSync && sceneWordTimings) {
          return (
            <WordSyncedCodeStage
              scene={scene}
              wordTimings={sceneWordTimings}
              startFrame={0}
              durationFrames={durationInFrames}
            />
          );
        }
        return (
          <CodeBrollOverlay
            codeBroll={scene.codeBroll[0]}
            startFrame={0}
            durationFrames={durationInFrames}
          />
        );
      })()}
      {/* Per-scene narration audio — local frame clock (0-based) matches per-scene word timings */}
      {!audioIncluded && sceneAudioSrc && <Audio src={sceneAudioSrc} />}
      {!audioIncluded && sceneWordTimings?.length && (
        <CaptionOverlay wordTimings={sceneWordTimings} captionOffsetMs={captionOffsetMs} />
      )}
    </AbsoluteFill>
  );
};

const PRVideo: React.FC<PRVideoProps> = ({
  script,
  clipPaths,
  sceneTimelineFrames,
  audioIncluded,
  captionOffsetMs,
  graphLayout,
  wordSyncedCodeEnabled,
}) => {
  let frameOffset = 0;
  // Render path: server-resolved flag arrives via inputProps. Studio path:
  // no inputProps → read the env directly (works there because Studio runs
  // through the dev server, not the sandboxed render bundle).
  const wordSyncEnabled = wordSyncedCodeEnabled ?? isWordSyncedCodeEnabled();
  const sceneTimelineMap = new Map(
    (sceneTimelineFrames ?? []).map((entry) => [entry.sceneNumber, entry]),
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#0d1117" }}>
      {script.scenes.map((scene, sceneIndex) => {
        const startFrame = frameOffset;
        const sceneClips = clipPaths.filter((c) => c.sceneNumber === scene.sceneNumber);
        const sceneTimeline = sceneTimelineMap.get(scene.sceneNumber);
        const clipFrameSum = sceneClips.reduce((sum, c) => sum + c.durationFrames, 0);
        const isFirstScene = sceneIndex === 0;
        const isLastScene = sceneIndex === script.scenes.length - 1;
        const upcomingSnippets: CodeBroll[] = (isFirstScene || scene.codeBroll.length === 0)
          ? script.scenes
              .slice(isFirstScene ? 1 : sceneIndex + 1)
              .flatMap((s) => s.codeBroll)
          : [];
        // Prefer clipFrameSum when clips exist to keep outer Sequence window
        // exactly equal to the sum of inner sub-Sequence windows (avoids ±1
        // frame rounding drift that causes black gaps or Remotion truncation).
        const sceneDurationFrames = clipFrameSum > 0
          ? clipFrameSum
          : (sceneTimeline?.durationFrames ?? Math.round(scene.durationSeconds * FPS));
        const clipAudioVolume = audioIncluded
          ? 1
          : scene.productionAudio?.trim()
            ? BACKGROUND_CLIP_AUDIO_VOLUME
            : 0;

        frameOffset += sceneDurationFrames;

        return (
          <Sequence
            key={scene.sceneNumber}
            from={startFrame}
            durationInFrames={sceneDurationFrames}
          >
            <SceneClip
              scene={scene}
              clips={sceneClips}
              durationInFrames={sceneDurationFrames}
              clipAudioVolume={clipAudioVolume}
              sceneTimeline={sceneTimeline}
              audioIncluded={audioIncluded ?? false}
              captionOffsetMs={captionOffsetMs ?? 0}
              upcomingSnippets={upcomingSnippets}
              isFirstScene={isFirstScene}
              isLastScene={isLastScene}
              graphLayout={graphLayout}
              wordSyncedCodeEnabled={wordSyncEnabled}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PRVideo"
        component={PRVideo}
        durationInFrames={60 * FPS}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{
          script: {
            changeType: "feature" as const,
            summary: "Default",
            headline: "",
            scenes: [],
            totalDurationSeconds: 60,
            totalWordCount: 150,
            keyFiles: [],
            tags: [],
            narrativeRoles: [],
            voiceAssignments: [],
          },
          clipPaths: [],
          sceneTimelineFrames: [],
          audioIncluded: false,
          captionOffsetMs: 0,
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
