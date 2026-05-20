import React from "react";
import { AbsoluteFill, OffthreadVideo } from "remotion";

interface AIClipSceneProps {
  clipSrc: string;
  startFrame: number;
  durationFrames: number;
  muted?: boolean;
  volume?: number;
}

/**
 * Plays an AI-generated video clip as the full-frame background.
 *
 * Plays the generated clip once. Scene sequencing in Root.tsx is responsible
 * for cutting away when the clip ends.
 */
export const AIClipScene: React.FC<AIClipSceneProps> = ({
  clipSrc,
  startFrame,
  durationFrames,
  muted,
  volume,
}) => {
  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={clipSrc}
        trimBefore={startFrame}
        trimAfter={startFrame + durationFrames}
        muted={muted ?? false}
        volume={muted ? 0 : volume}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};
