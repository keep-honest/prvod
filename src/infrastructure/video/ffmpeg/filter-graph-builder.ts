/**
 * Constructs the ffmpeg `-filter_complex` graph for the FFmpegCompositor.
 *
 * This is the most complex module in the ffmpeg pipeline. It produces a single
 * filter graph string that ffmpeg evaluates in one pass, handling:
 *
 * **Video chain:** scale each clip to 1920x1080 (letterbox/pillarbox) -> concat clips
 * within each scene -> concat all scenes -> burn ASS captions -> composite code overlay PNGs.
 *
 * **Audio chain (5 branches, one per scene):**
 *  1. `audioIncluded=true` — model-native narration baked into clips; concat clip audio directly.
 *  2. External TTS + productionAudio — mix attenuated clip SFX under narration via amix.
 *  3. External TTS only — pad narration to scene duration.
 *  4. No narration but clips have productionAudio — play clip SFX at background volume.
 *  5. No audio at all — generate silence with `anullsrc`.
 *
 * The filter graph references ffmpeg inputs by index. Inputs are ordered:
 * [all clip files] [per-scene audio files] [code overlay PNGs].
 *
 * @module filter-graph-builder
 */
import type { ClipAsset, SceneTimelineEntry } from "@/interfaces/IClipAsset";
import type { VideoScript } from "@/domain/entities/VideoScript";
import { createLogger } from "@/lib/logger";

const logger = createLogger("filter-graph-builder");

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const BG_COLOR = "0x0d1117";
/**
 * Clip audio volume when mixed with external narration (~-18.4 dB).
 * Matches the Remotion compositor's BACKGROUND_CLIP_AUDIO_VOLUME.
 * Industry standard: 18-20 dB separation for narration intelligibility
 * (W3C WCAG G56, BBC mixing guidelines, EBU R 128).
 */
const BG_AUDIO_VOLUME = 0.12;

/** A pre-rendered code overlay PNG associated with a specific scene. */
export interface CodeOverlayEntry {
  sceneNumber: number;
  pngPath: string;
}

/**
 * A pre-rendered full-frame overlay (e.g., the constellation graph) that
 * fades in on top of a specific scene. Unlike code overlays it covers the
 * entire canvas and never fades out.
 */
export interface FullFrameOverlayEntry {
  sceneNumber: number;
  pngPath: string;
  /** Fade-in duration in seconds. */
  fadeInSec?: number;
}

/** All inputs needed to construct the ffmpeg filter graph. */
export interface FilterGraphInput {
  script: VideoScript;
  clips: ClipAsset[];
  sceneTimelineFrames: SceneTimelineEntry[];
  audioIncluded: boolean;
  captionAssPath: string | null;
  codeOverlays: CodeOverlayEntry[];
  /**
   * Optional full-frame overlay rendered after captions — used by the
   * FFmpeg constellation graph (Phase 2). Renders across the whole canvas
   * during the target scene with a fade-in.
   */
  fullFrameOverlay?: FullFrameOverlayEntry;
  /** Map of sceneNumber → local audio file path (for external TTS). */
  localAudioPaths: Map<number, string>;
  /** Map of sceneNumber+clipIndex → local clip file path. */
  localClipPaths: Map<string, string>;
  /**
   * Set of clipKey(sceneNumber, clipIndex) for clips whose MP4 contains an
   * audio track (probed via ffprobe). When audioIncluded=false, only clips
   * in this set are safe to reference as `[idx:a]` in the filter graph.
   * Clips outside the set are video-only and referencing their audio stream
   * crashes ffmpeg with "matches no streams".
   */
  clipsWithAudio?: Set<string>;
  /**
   * Map of clipKey → probed duration in seconds (from ffprobe).
   * Used to size silence fillers for clips without audio so they match
   * the actual MP4 duration, not the AI-reported approximate duration.
   */
  probedClipDurations?: Map<string, number>;
}

/** The outputs of filter graph construction, ready to pass to ffmpeg. */
export interface FilterGraphResult {
  /** Ordered `-i` arguments for ffmpeg (clips, audio files, overlay PNGs). */
  inputArgs: string[];
  /** The complete `filter_complex` string with semicolon-separated filter chains. */
  filterComplex: string;
  /** Label to use with `-map` for the final video stream (e.g., `"captioned"` or `"full_v"`). */
  outputVideoLabel: string;
  /** Label to use with `-map` for the final audio stream. */
  outputAudioLabel: string;
}

/**
 * Generates a stable key for clip lookups across localClipPaths and clipsWithAudio maps.
 * Format: `"sceneNumber:clipIndex"` (e.g., `"3:0"`).
 */
export function clipKey(sceneNumber: number, clipIndex: number): string {
  return `${sceneNumber}:${clipIndex}`;
}

/**
 * Builds the ffmpeg `-filter_complex` string and ordered `-i` input arguments.
 *
 * The graph is constructed in 5 phases:
 *  1. **Inputs** — register clip files, per-scene audio, and looped PNG overlays as `-i` args
 *  2. **Per-scene chains** — scale/pad each clip to 1920x1080, concat within scene, mix audio
 *  3. **Global concat** — join all scene video and audio streams sequentially
 *  4. **Caption burn-in** — apply ASS subtitles via the `ass` filter (if word timings exist)
 *  5. **Code overlays** — composite PNGs with `setpts` time-shift and `fade` alpha transitions
 *
 * @param input - All assets, paths, and configuration needed for graph construction
 * @returns Filter graph string plus the final output labels for video and audio
 * @throws If a clip's local path is missing from `localClipPaths`
 */
export function buildFilterGraph(input: FilterGraphInput): FilterGraphResult {
  const { script, clips, sceneTimelineFrames, audioIncluded, captionAssPath, codeOverlays, fullFrameOverlay, localAudioPaths, localClipPaths, clipsWithAudio, probedClipDurations } = input;

  const inputArgs: string[] = [];
  const filters: string[] = [];
  let inputIdx = 0;

  // Group clips by scene
  const clipsByScene = new Map<number, ClipAsset[]>();
  for (const clip of clips) {
    const existing = clipsByScene.get(clip.sceneNumber) ?? [];
    existing.push(clip);
    clipsByScene.set(clip.sceneNumber, existing);
  }

  // Build timeline entries keyed by scene number for lookup
  const timelineByScene = new Map<number, SceneTimelineEntry>();
  for (const entry of sceneTimelineFrames) {
    timelineByScene.set(entry.sceneNumber, entry);
  }

  // Track per-scene video and audio concat labels
  const sceneConcatVideoLabels: string[] = [];
  const sceneConcatAudioLabels: string[] = [];

  // Compute scene start offsets (seconds) for code overlay timing
  const sceneStartSec = new Map<number, number>();
  const sceneDurationSec = new Map<number, number>();
  let offsetSec = 0;
  for (const scene of script.scenes) {
    const timeline = timelineByScene.get(scene.sceneNumber);
    const durSec = timeline
      ? (timeline.durationSeconds ?? timeline.durationFrames / FPS)
      : scene.durationSeconds;
    sceneStartSec.set(scene.sceneNumber, offsetSec);
    sceneDurationSec.set(scene.sceneNumber, durSec);
    offsetSec += durSec;
  }

  // Track external audio input indices for amix
  const audioInputMap = new Map<number, number>(); // sceneNumber → input index of audio file

  // Phase 1: Add all clip inputs and per-scene audio inputs
  for (const scene of script.scenes) {
    const sceneClips = clipsByScene.get(scene.sceneNumber) ?? [];
    // Sort by clipIndex to ensure consistent ordering
    sceneClips.sort((a, b) => a.clipIndex - b.clipIndex);

    for (const clip of sceneClips) {
      const path = localClipPaths.get(clipKey(clip.sceneNumber, clip.clipIndex));
      if (!path) {
        throw new Error(`Missing local path for clip s${clip.sceneNumber}-c${clip.clipIndex}`);
      }
      inputArgs.push("-i", path);
      inputIdx++;
    }
  }

  // Add external audio inputs after all clips
  for (const scene of script.scenes) {
    const audioPath = localAudioPaths.get(scene.sceneNumber);
    if (audioPath) {
      inputArgs.push("-i", audioPath);
      audioInputMap.set(scene.sceneNumber, inputIdx);
      inputIdx++;
    }
  }

  // Add code overlay PNG inputs after audio.
  // PNGs are single-frame images. `-loop 1` tells ffmpeg to repeat the frame
  // indefinitely, and `-t` caps the synthetic stream duration to the scene length.
  // Without this, ffmpeg would emit a single-frame stream that can't be faded.
  // Invariant: every overlay's sceneNumber must exist in `sceneDurationSec`
  // (built from `script.scenes`). A mismatch means the caller passed an
  // overlay for a scene that isn't in the script — a logic bug we want to
  // catch loudly rather than silently rendering a 10-second synthetic stream.
  // Phase 4 (full-frame overlay) already throws on the same class of
  // mismatch; Phase 1 previously had a silent `?? 10` fallback that hid it.
  const overlayInputMap = new Map<number, number>(); // sceneNumber → input index
  for (const overlay of codeOverlays) {
    const overlayDurSec = sceneDurationSec.get(overlay.sceneNumber);
    if (overlayDurSec === undefined) {
      logger.error(
        "Code overlay references unknown scene — invariant violation",
        {
          sceneNumber: overlay.sceneNumber,
          knownScenes: [...sceneDurationSec.keys()],
        },
      );
      throw new Error(
        `Code overlay scene ${overlay.sceneNumber} missing from timeline map`,
      );
    }
    inputArgs.push("-loop", "1", "-t", overlayDurSec.toFixed(3), "-i", overlay.pngPath);
    overlayInputMap.set(overlay.sceneNumber, inputIdx);
    inputIdx++;
  }

  // Full-frame overlay (e.g., constellation graph summary) — registered after
  // code overlays so its input index is stable regardless of code overlay count.
  let fullFrameOverlayInputIdx: number | null = null;
  if (fullFrameOverlay) {
    const fullFrameDurSec = sceneDurationSec.get(fullFrameOverlay.sceneNumber);
    if (fullFrameDurSec === undefined) {
      logger.error(
        "Full-frame overlay references unknown scene — invariant violation",
        {
          sceneNumber: fullFrameOverlay.sceneNumber,
          knownScenes: [...sceneDurationSec.keys()],
        },
      );
      throw new Error(
        `Full-frame overlay scene ${fullFrameOverlay.sceneNumber} missing from timeline map`,
      );
    }
    inputArgs.push(
      "-loop", "1",
      "-t", fullFrameDurSec.toFixed(3),
      "-i", fullFrameOverlay.pngPath,
    );
    fullFrameOverlayInputIdx = inputIdx;
    inputIdx++;
  }

  // Phase 2: Build per-scene video and audio filter chains
  let clipInputIdx = 0;

  for (const scene of script.scenes) {
    const sceneClips = clipsByScene.get(scene.sceneNumber) ?? [];
    sceneClips.sort((a, b) => a.clipIndex - b.clipIndex);
    const sn = scene.sceneNumber;
    const durSec = sceneDurationSec.get(sn) ?? scene.durationSeconds;

    if (sceneClips.length === 0) {
      // No clips — generate a solid color frame + silence
      filters.push(
        `color=c=${BG_COLOR}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${durSec.toFixed(3)},format=yuv420p[scene${sn}_v]`,
      );
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${durSec.toFixed(3)}[scene${sn}_a]`,
      );
      sceneConcatVideoLabels.push(`[scene${sn}_v]`);
      sceneConcatAudioLabels.push(`[scene${sn}_a]`);
      continue;
    }

    // Scale each clip and track per-clip audio availability.
    const scaledLabels: string[] = [];
    const clipAudioLabels: string[] = [];   // only clips with actual audio
    const sceneClipStartIdx = clipInputIdx; // for building aligned audio later
    for (const clip of sceneClips) {
      const idx = clipInputIdx;
      clipInputIdx++;
      const label = `s${sn}c${clip.clipIndex}_v`;
      filters.push(
        `[${idx}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BG_COLOR},` +
        `setsar=1,fps=${FPS},format=yuv420p[${label}]`,
      );
      scaledLabels.push(`[${label}]`);
      // Only reference clip audio when the MP4 actually contains an audio
      // track (confirmed via ffprobe). Referencing a non-existent stream
      // crashes ffmpeg with "matches no streams".
      const hasAudio = audioIncluded || clipsWithAudio?.has(clipKey(sn, clip.clipIndex));
      if (hasAudio) {
        clipAudioLabels.push(`[${idx}:a]`);
      }
    }

    // Concat clips within scene (video)
    let sceneVideoLabel: string;
    if (scaledLabels.length > 1) {
      sceneVideoLabel = `scene${sn}_v`;
      filters.push(
        `${scaledLabels.join("")}concat=n=${scaledLabels.length}:v=1:a=0[${sceneVideoLabel}]`,
      );
    } else {
      sceneVideoLabel = `s${sn}c${sceneClips[0].clipIndex}_v`;
    }

    // Audio handling
    let sceneAudioLabel: string;
    if (audioIncluded) {
      // audioIncluded=true means the video model provides narration baked into the video
      // (speaking themes: talk_show, sports_studio, standup_show with Veo3 native voices).
      // ThemeCapabilityService enforces that only models with audio support are used,
      // so clip audio streams are guaranteed to exist here.
      if (clipAudioLabels.length > 1) {
        sceneAudioLabel = `scene${sn}_a`;
        filters.push(
          `${clipAudioLabels.join("")}concat=n=${clipAudioLabels.length}:v=0:a=1[${sceneAudioLabel}]`,
        );
      } else {
        sceneAudioLabel = `${clipInputIdx - sceneClips.length}:a`;
      }
    } else if (audioInputMap.has(sn)) {
      // External TTS: narration is the primary audio source.
      // Pad narration to match the scene's video duration to prevent
      // cumulative audio-video desync when scenes are concat'd.
      const narrationIdx = audioInputMap.get(sn) ?? 0;
      const hasClipAudio = clipAudioLabels.length > 0;
      const hasProductionAudio = hasClipAudio && !!scene.productionAudio?.trim();

      if (hasProductionAudio) {
        // Scene has SFX/ambience audio in the clips — mix at reduced volume
        // under narration, matching Remotion's BACKGROUND_CLIP_AUDIO_VOLUME.
        const clipAudioRef = concatAlignedClipAudio(sceneClips, sceneClipStartIdx, sn, clipsWithAudio, probedClipDurations, filters);

        const attLabel = `scene${sn}_att_a`;
        filters.push(`[${clipAudioRef}]volume=${BG_AUDIO_VOLUME}[${attLabel}]`);

        const narLabel = `scene${sn}_nar`;
        filters.push(
          `[${narrationIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo[${narLabel}]`,
        );

        const mixLabel = `scene${sn}_mix`;
        filters.push(
          `[${narLabel}][${attLabel}]amix=inputs=2:duration=longest:dropout_transition=0[${mixLabel}]`,
        );

        // Pad and trim the mix to match scene video duration
        sceneAudioLabel = `scene${sn}_a`;
        filters.push(
          `[${mixLabel}]apad=whole_dur=${durSec.toFixed(3)},atrim=0:${durSec.toFixed(3)}[${sceneAudioLabel}]`,
        );
      } else {
        // Narration only (clips are video-only or have no productionAudio)
        sceneAudioLabel = `scene${sn}_a`;
        filters.push(
          `[${narrationIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
          `apad=whole_dur=${durSec.toFixed(3)},atrim=0:${durSec.toFixed(3)}[${sceneAudioLabel}]`,
        );
      }
    } else if (clipAudioLabels.length > 0 && scene.productionAudio?.trim()) {
      // No narration for this scene, but clips have SFX/ambience audio.
      // Play clip audio at the background volume level with aligned timing.
      const clipAudioRef = concatAlignedClipAudio(sceneClips, sceneClipStartIdx, sn, clipsWithAudio, probedClipDurations, filters);

      sceneAudioLabel = `scene${sn}_prod_a`;
      filters.push(
        `[${clipAudioRef}]volume=${BG_AUDIO_VOLUME},` +
        `apad=whole_dur=${durSec.toFixed(3)},atrim=0:${durSec.toFixed(3)}[${sceneAudioLabel}]`,
      );
    } else {
      // No narration and no clip audio — generate silence
      sceneAudioLabel = `scene${sn}_silence`;
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${durSec.toFixed(3)}[${sceneAudioLabel}]`,
      );
    }

    sceneConcatVideoLabels.push(`[${sceneVideoLabel}]`);
    sceneConcatAudioLabels.push(`[${sceneAudioLabel}]`);
  }

  // Phase 3: Concat all scenes
  const nScenes = script.scenes.length;
  let finalVideoLabel: string;
  let finalAudioLabel: string;

  if (nScenes > 1) {
    filters.push(
      `${sceneConcatVideoLabels.join("")}concat=n=${nScenes}:v=1:a=0[full_v]`,
    );
    filters.push(
      `${sceneConcatAudioLabels.join("")}concat=n=${nScenes}:v=0:a=1[full_a]`,
    );
    finalVideoLabel = "full_v";
    finalAudioLabel = "full_a";
  } else {
    // Single scene — strip the brackets from the label
    finalVideoLabel = stripBrackets(sceneConcatVideoLabels[0]);
    finalAudioLabel = stripBrackets(sceneConcatAudioLabels[0]);
  }

  // Phase 4: Full-frame overlay (constellation graph summary).
  //
  // The overlay runs BEFORE the caption burn-in so that ASS subtitles are
  // rendered on top of the semi-opaque graph background during the final
  // scene. Putting the graph above the captions would darken/obscure the
  // subtitles — a mismatch with the Remotion path, where CaptionOverlay is
  // composited on top of ConstellationGraph.
  if (fullFrameOverlay && fullFrameOverlayInputIdx !== null) {
    const startSec = sceneStartSec.get(fullFrameOverlay.sceneNumber);
    const durSec = sceneDurationSec.get(fullFrameOverlay.sceneNumber);
    if (startSec === undefined || durSec === undefined) {
      // Invariant violation: the scene number came from the same script used
      // to build this timeline map. Reaching this branch means script.scenes
      // mutated or the map was built incorrectly — a logic bug, not a
      // recoverable fallback.
      logger.error(
        "Full-frame overlay references unknown scene — script/timeline mismatch",
        {
          sceneNumber: fullFrameOverlay.sceneNumber,
          knownScenes: [...sceneStartSec.keys()],
          knownDurationScenes: [...sceneDurationSec.keys()],
        },
      );
      throw new Error(
        `Full-frame overlay scene ${fullFrameOverlay.sceneNumber} missing from timeline map`,
      );
    }
    const endSec = startSec + durSec;
    const fadeInDur = fullFrameOverlay.fadeInSec ?? 0.6;
    const fadedLabel = `full_overlay_s${fullFrameOverlay.sceneNumber}`;
    filters.push(
      `[${fullFrameOverlayInputIdx}:v]setpts=PTS+${startSec.toFixed(3)}/TB,` +
      `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=disable,format=rgba,` +
      `fade=t=in:st=${startSec.toFixed(3)}:d=${fadeInDur}:alpha=1[${fadedLabel}]`,
    );

    const outLabel = `graph_s${fullFrameOverlay.sceneNumber}`;
    filters.push(
      `[${finalVideoLabel}][${fadedLabel}]overlay=0:0:` +
      `enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'[${outLabel}]`,
    );
    finalVideoLabel = outLabel;
  }

  // Phase 5: Burn ASS captions (drawn on top of the constellation graph so
  // subtitles remain visible over the semi-opaque panel during the final scene).
  if (captionAssPath) {
    const escaped = escapeFilterPath(captionAssPath);
    const captionedLabel = "captioned";
    filters.push(`[${finalVideoLabel}]ass='${escaped}'[${captionedLabel}]`);
    finalVideoLabel = captionedLabel;
  }

  // Phase 6: Code overlays
  for (const overlay of codeOverlays) {
    // Skip the right-side code card for the scene that owns the full-frame
    // constellation graph. Otherwise the card sits on top of the graph and
    // the FFmpeg output never reaches the "graph-only end state" that the
    // Remotion ConstellationScene produces. Matches the Remotion behavior
    // where the code frame shrinks into a node instead of staying visible.
    if (
      fullFrameOverlay !== undefined &&
      overlay.sceneNumber === fullFrameOverlay.sceneNumber
    ) {
      logger.debug("Skipping code overlay on full-frame graph scene", {
        sceneNumber: overlay.sceneNumber,
      });
      continue;
    }

    const overlayIdx = overlayInputMap.get(overlay.sceneNumber);
    if (overlayIdx === undefined) continue;

    const startSec = sceneStartSec.get(overlay.sceneNumber);
    const durSec = sceneDurationSec.get(overlay.sceneNumber);
    if (startSec === undefined || durSec === undefined) {
      logger.warn("Code overlay references unknown scene, skipping", {
        sceneNumber: overlay.sceneNumber,
        knownScenes: [...sceneStartSec.keys()],
      });
      continue;
    }
    const endSec = startSec + durSec;
    const fadeInDur = 0.5;
    const fadeOutDur = 0.5;
    // Fade times are absolute (main-timeline PTS) because setpts shifts
    // the overlay stream to match the scene's position in the final video.
    const fadeOutStart = Math.max(startSec, endSec - fadeOutDur);

    const fadedLabel = `overlay_s${overlay.sceneNumber}`;
    // setpts shifts the overlay PTS so frame 0 aligns with the scene start.
    // Without this, the looped-PNG stream starts at PTS=0 and has already
    // played through its fade (and possibly reached EOF) by the time
    // the enable window opens for scenes after scene 1.
    // format=rgba preserves the alpha channel through the fade chain.
    // alpha=1 fades transparency (invisible→visible) instead of the
    // default RGB fade (black→visible) which produces a solid black box.
    filters.push(
      `[${overlayIdx}:v]setpts=PTS+${startSec.toFixed(3)}/TB,format=rgba,` +
      `fade=t=in:st=${startSec.toFixed(3)}:d=${fadeInDur}:alpha=1,` +
      `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDur}:alpha=1[${fadedLabel}]`,
    );

    const outLabel = `code_s${overlay.sceneNumber}`;
    // Position: vertically centered, right-aligned with 60px padding.
    // Matches Remotion CodeBrollOverlay: justifyContent:"center", alignItems:"flex-end", padding:"40px 60px"
    filters.push(
      `[${finalVideoLabel}][${fadedLabel}]overlay=W-w-60:(H-h)/2:` +
      `enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'[${outLabel}]`,
    );
    finalVideoLabel = outLabel;
  }

  const filterComplex = filters.join(";\n");

  logger.debug("Filter graph built", {
    inputCount: inputIdx,
    filterCount: filters.length,
    scenes: nScenes,
    overlays: codeOverlays.length,
    fullFrameOverlay: fullFrameOverlay ? fullFrameOverlay.sceneNumber : null,
    hasCaptions: !!captionAssPath,
  });

  return {
    inputArgs,
    filterComplex,
    outputVideoLabel: finalVideoLabel,
    outputAudioLabel: finalAudioLabel,
  };
}

/**
 * Builds one audio label per clip in scene order. Clips with an audio track
 * reference `[idx:a]`; clips without get an `anullsrc` silence filler matching
 * the clip's video duration. This keeps the audio concat aligned with the
 * video concat so SFX/ambience from later clips don't shift earlier.
 */
function buildAlignedClipAudioLabels(
  sceneClips: ClipAsset[],
  sceneClipStartIdx: number,
  sn: number,
  clipsWithAudio: Set<string> | undefined,
  probedClipDurations: Map<string, number> | undefined,
  filters: string[],
): string[] {
  return sceneClips.map((clip, i) => {
    const idx = sceneClipStartIdx + i;
    const key = clipKey(sn, clip.clipIndex);
    if (clipsWithAudio?.has(key)) {
      return `[${idx}:a]`;
    }
    // Use probed duration (actual MP4 length) for silence fillers so the
    // audio concat stays aligned with the video concat. Fall back to the
    // AI-reported duration if the clip wasn't probed.
    const durSec = probedClipDurations?.get(key) ?? clip.durationSeconds;
    const silLabel = `s${sn}c${clip.clipIndex}_sil`;
    filters.push(
      `anullsrc=r=48000:cl=stereo,atrim=duration=${durSec.toFixed(3)}[${silLabel}]`,
    );
    return `[${silLabel}]`;
  });
}

/**
 * Builds aligned clip audio labels and, if more than one, concatenates them
 * into a single labelled stream. Returns the bare label (without brackets)
 * ready for use in subsequent filter references like `[${ref}]volume=...`.
 */
function concatAlignedClipAudio(
  sceneClips: ClipAsset[],
  sceneClipStartIdx: number,
  sn: number,
  clipsWithAudio: Set<string> | undefined,
  probedClipDurations: Map<string, number> | undefined,
  filters: string[],
): string {
  const aligned = buildAlignedClipAudioLabels(sceneClips, sceneClipStartIdx, sn, clipsWithAudio, probedClipDurations, filters);
  if (aligned.length > 1) {
    const rawLabel = `scene${sn}_raw_a`;
    filters.push(
      `${aligned.join("")}concat=n=${aligned.length}:v=0:a=1[${rawLabel}]`,
    );
    return rawLabel;
  }
  return stripBrackets(aligned[0]);
}

/** Strips surrounding `[` and `]` from a filter graph label. */
function stripBrackets(label: string): string {
  return label.slice(1, -1);
}

/** Escapes a file path for use inside an ffmpeg filter graph string. */
function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}
