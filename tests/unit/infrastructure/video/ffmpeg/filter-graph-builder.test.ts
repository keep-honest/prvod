import { describe, expect, it } from "vitest";
import {
  buildFilterGraph,
  clipKey,
} from "@/infrastructure/video/ffmpeg/filter-graph-builder";
import type { FilterGraphInput } from "@/infrastructure/video/ffmpeg/filter-graph-builder";
import type { ClipAsset, SceneTimelineEntry } from "@/interfaces/IClipAsset";
import type { VideoScript } from "@/domain/entities/VideoScript";

// ── Base mock script ─────────────────────────────────────────────────

function makeScript(scenes: VideoScript["scenes"]): VideoScript {
  return {
    changeType: "feature",
    summary: "test",
    headline: "",
    scenes,
    totalDurationSeconds: scenes.reduce((s, sc) => s + sc.durationSeconds, 0),
    totalWordCount: 2,
    keyFiles: [],
    tags: [],
    narrativeRoles: [],
    voiceAssignments: [],
  } as VideoScript;
}

function makeScene(
  sceneNumber: number,
  durationSeconds: number,
): VideoScript["scenes"][number] {
  return {
    sceneNumber,
    sceneType: sceneNumber === 1 ? "overview" : "hook",
    durationSeconds,
    narration: "test narration",
    codeBroll: [],
  };
}

function makeClip(
  sceneNumber: number,
  clipIndex: number,
  durationSeconds = 5,
): ClipAsset {
  return {
    sceneNumber,
    clipIndex,
    clipUrl: `https://example.com/s${sceneNumber}-c${clipIndex}.mp4`,
    durationSeconds,
  };
}

function makeTimeline(
  sceneNumber: number,
  durationFrames: number,
  durationSeconds?: number,
): SceneTimelineEntry {
  return {
    sceneNumber,
    durationFrames,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

function buildLocalClipPaths(clips: ClipAsset[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const clip of clips) {
    map.set(
      clipKey(clip.sceneNumber, clip.clipIndex),
      `/tmp/s${clip.sceneNumber}-c${clip.clipIndex}.mp4`,
    );
  }
  return map;
}

function baseInput(overrides: Partial<FilterGraphInput> = {}): FilterGraphInput {
  const clips = [makeClip(1, 0)];
  const script = makeScript([makeScene(1, 5)]);
  return {
    script,
    clips,
    sceneTimelineFrames: [makeTimeline(1, 150)],
    audioIncluded: false,
    captionAssPath: null,
    codeOverlays: [],
    localAudioPaths: new Map(),
    localClipPaths: buildLocalClipPaths(clips),
    ...overrides,
  };
}

// ── clipKey ──────────────────────────────────────────────────────────

describe("clipKey", () => {
  it("returns sceneNumber:clipIndex", () => {
    expect(clipKey(1, 0)).toBe("1:0");
    expect(clipKey(3, 2)).toBe("3:2");
  });
});

// ── buildFilterGraph ─────────────────────────────────────────────────

describe("buildFilterGraph", () => {
  describe("single scene, single clip", () => {
    it("produces scale+pad filter and maps clip to output", () => {
      const { inputArgs, filterComplex, outputVideoLabel } = buildFilterGraph(baseInput());

      expect(inputArgs).toContain("/tmp/s1-c0.mp4");
      expect(filterComplex).toContain("scale=1920:1080");
      expect(filterComplex).toContain("pad=1920:1080");
      expect(filterComplex).toContain("format=yuv420p");
      // Single scene — label is the clip label directly (no scene concat)
      expect(outputVideoLabel).toBe("s1c0_v");
    });

    it("includes fps and setsar filters", () => {
      const { filterComplex } = buildFilterGraph(baseInput());
      expect(filterComplex).toContain("setsar=1");
      expect(filterComplex).toContain("fps=30");
    });
  });

  describe("multi-clip scene", () => {
    it("concats clips within the scene", () => {
      const clips = [makeClip(1, 0), makeClip(1, 1)];
      const script = makeScript([makeScene(1, 5)]);
      const { filterComplex, outputVideoLabel } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        localClipPaths: buildLocalClipPaths(clips),
      });

      expect(filterComplex).toContain("concat=n=2:v=1:a=0");
      expect(outputVideoLabel).toBe("scene1_v");
    });
  });

  describe("audio handling", () => {
    it("uses clip audio directly when audioIncluded=true", () => {
      const { filterComplex } = buildFilterGraph(baseInput({ audioIncluded: true }));

      // When audioIncluded and single clip, audio label is just `<idx>:a` — no volume filter
      expect(filterComplex).not.toContain("volume=");
      expect(filterComplex).not.toContain("amix");
    });

    it("uses narration with apad+atrim to match scene video duration", () => {
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const { filterComplex } = buildFilterGraph(
        baseInput({ audioIncluded: false, localAudioPaths }),
      );

      // Narration must be padded/trimmed to match the scene's video duration
      // (150 frames / 30 fps = 5.000s) to prevent cumulative audio-video desync
      expect(filterComplex).toContain("aformat=sample_rates=48000:channel_layouts=stereo");
      expect(filterComplex).toContain("apad=whole_dur=5.000");
      expect(filterComplex).toContain("atrim=0:5.000");
      expect(filterComplex).not.toContain("amix");
      expect(filterComplex).not.toContain("volume=");
    });

    it("uses durationSeconds for narration apad/atrim when present", () => {
      // durationFrames=184 → 184/30 = 6.133s (frame-quantized)
      // durationSeconds=6.12 → precise probed value
      // Narration pad/trim must use 6.120s, not 6.133s.
      const clips = [makeClip(1, 0)];
      const script = makeScript([makeScene(1, 7)]);
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const { filterComplex } = buildFilterGraph({
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 184, 6.12)],
        audioIncluded: false,
        captionAssPath: null,
        codeOverlays: [],
        localAudioPaths,
        localClipPaths: buildLocalClipPaths(clips),
      });

      expect(filterComplex).toContain("apad=whole_dur=6.120");
      expect(filterComplex).toContain("atrim=0:6.120");
    });

    it("ignores productionAudio when clips have no audio (no clipsWithAudio entry)", () => {
      const scene = { ...makeScene(1, 5), productionAudio: "ambient crowd cheering" };
      const script = makeScript([scene]);
      const clips = [makeClip(1, 0)];
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        audioIncluded: false,
        localAudioPaths,
        localClipPaths: buildLocalClipPaths(clips),
        clipsWithAudio: new Set(), // no clips have audio
      });

      // Clips are video-only — use narration only with padding
      expect(filterComplex).toContain("aformat=sample_rates=48000:channel_layouts=stereo");
      expect(filterComplex).toContain("apad=whole_dur=");
      expect(filterComplex).not.toContain("volume=0.12");
      expect(filterComplex).not.toContain("amix");
    });

    it("mixes clip audio at 0.12 under narration when clips have audio and productionAudio set", () => {
      const scene = { ...makeScene(1, 5), productionAudio: "ambient crowd cheering" };
      const script = makeScript([scene]);
      const clips = [makeClip(1, 0)];
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        audioIncluded: false,
        localAudioPaths,
        localClipPaths: buildLocalClipPaths(clips),
        clipsWithAudio: new Set(["1:0"]), // clip has audio track
      });

      // Clip audio mixed at reduced volume under narration
      expect(filterComplex).toContain("volume=0.12");
      expect(filterComplex).toContain("amix=inputs=2");
      // Must still pad/trim to match scene video duration
      expect(filterComplex).toContain("apad=whole_dur=");
      expect(filterComplex).toContain("atrim=0:");
    });

    it("plays clip audio at BG volume when clips have audio, productionAudio set, but no narration", () => {
      const scene = { ...makeScene(1, 5), productionAudio: "crowd cheering" };
      const script = makeScript([scene]);
      const clips = [makeClip(1, 0)];
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        audioIncluded: false,
        localAudioPaths: new Map(), // no narration
        localClipPaths: buildLocalClipPaths(clips),
        clipsWithAudio: new Set(["1:0"]),
      });

      // Clip audio at reduced volume, no amix (no narration to mix with)
      expect(filterComplex).toContain("volume=0.12");
      expect(filterComplex).not.toContain("amix");
      // Padded to scene duration
      expect(filterComplex).toContain("apad=whole_dur=");
    });

    it("inserts silence fillers for sub-clips without audio to keep timeline aligned", () => {
      const scene = { ...makeScene(1, 10), productionAudio: "ambient SFX" };
      const script = makeScript([scene]);
      // clip 0 = no audio (6s nominal), clip 1 = has audio (4s nominal)
      const clips = [makeClip(1, 0, 6), makeClip(1, 1, 4)];
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 300)],
        audioIncluded: false,
        localAudioPaths,
        localClipPaths: buildLocalClipPaths(clips),
        clipsWithAudio: new Set(["1:1"]), // only clip 1 has audio
      });

      // Clip 0 should get a silence filler matching its 6s video duration
      expect(filterComplex).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=6.000[s1c0_sil]");
      // Both labels (filler + real) are concat'd to keep audio aligned with video
      expect(filterComplex).toContain("[s1c0_sil][1:a]concat=n=2:v=0:a=1");
      // SFX is still mixed at reduced volume
      expect(filterComplex).toContain("volume=0.12");
      expect(filterComplex).toContain("amix=inputs=2");
    });

    it("uses probed clip duration for silence fillers instead of nominal duration", () => {
      const scene = { ...makeScene(1, 10), productionAudio: "ambient SFX" };
      const script = makeScript([scene]);
      // clip 0 = no audio (6s nominal, 6.12s probed), clip 1 = has audio
      const clips = [makeClip(1, 0, 6), makeClip(1, 1, 4)];
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const probedClipDurations = new Map([["1:0", 6.12], ["1:1", 4.08]]);
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 300)],
        audioIncluded: false,
        localAudioPaths,
        localClipPaths: buildLocalClipPaths(clips),
        clipsWithAudio: new Set(["1:1"]),
        probedClipDurations,
      });

      // Silence filler should use probed 6.12s, not nominal 6s
      expect(filterComplex).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=6.120[s1c0_sil]");
      // NOT the nominal duration
      expect(filterComplex).not.toContain("atrim=duration=6.000[s1c0_sil]");
    });

    it("generates silence when no narration and clips have no audio even with productionAudio hint", () => {
      const scene = { ...makeScene(1, 5), productionAudio: "crowd cheering, stadium ambience" };
      const script = makeScript([scene]);
      const clips = [makeClip(1, 0)];
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        audioIncluded: false,
        localAudioPaths: new Map(),
        localClipPaths: buildLocalClipPaths(clips),
        clipsWithAudio: new Set(), // no audio in clips
      });

      // No narration and no clip audio — silence
      expect(filterComplex).toContain("anullsrc=r=48000:cl=stereo");
      expect(filterComplex).not.toContain("volume=0.12");
    });

    it("does not reference clip audio when clipsWithAudio is undefined and audioIncluded=false", () => {
      const scene = { ...makeScene(1, 5), productionAudio: "crowd cheering" };
      const script = makeScript([scene]);
      const clips = [makeClip(1, 0)];
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        audioIncluded: false,
        localAudioPaths,
        localClipPaths: buildLocalClipPaths(clips),
        clipsWithAudio: undefined, // probing not performed
      });

      // Safe default: no clip audio referenced, narration only with padding
      expect(filterComplex).toContain("aformat=sample_rates=48000:channel_layouts=stereo");
      expect(filterComplex).toContain("apad=whole_dur=");
      expect(filterComplex).not.toContain("volume=0.12");
      expect(filterComplex).not.toContain("[0:a]");
    });

    it("generates anullsrc silence when no audio and no TTS", () => {
      const { filterComplex } = buildFilterGraph(
        baseInput({ audioIncluded: false, localAudioPaths: new Map() }),
      );

      expect(filterComplex).toContain("anullsrc=r=48000:cl=stereo");
    });
  });

  describe("multi-scene", () => {
    it("concats all scenes into full_v and full_a labels", () => {
      const clips = [makeClip(1, 0), makeClip(2, 0)];
      const script = makeScript([makeScene(1, 5), makeScene(2, 5)]);
      const timeline = [makeTimeline(1, 150), makeTimeline(2, 150)];
      const { filterComplex, outputVideoLabel, outputAudioLabel } = buildFilterGraph({
        script,
        clips,
        sceneTimelineFrames: timeline,
        audioIncluded: false,
        captionAssPath: null,
        codeOverlays: [],
        localAudioPaths: new Map(),
        localClipPaths: buildLocalClipPaths(clips),
      });

      expect(filterComplex).toContain("concat=n=2:v=1:a=0[full_v]");
      expect(filterComplex).toContain("concat=n=2:v=0:a=1[full_a]");
      expect(outputVideoLabel).toBe("full_v");
      expect(outputAudioLabel).toBe("full_a");
    });
  });

  describe("code overlay", () => {
    it("adds looped PNG input with -loop 1 -t <duration>", () => {
      const codeOverlays = [{ sceneNumber: 1, pngPath: "/tmp/overlay-s1.png" }];
      const { inputArgs } = buildFilterGraph(baseInput({ codeOverlays }));

      // PNG input must be looped so ffmpeg can apply time-based fades
      const loopIdx = inputArgs.indexOf("-loop");
      expect(loopIdx).toBeGreaterThan(-1);
      expect(inputArgs[loopIdx + 1]).toBe("1");
      expect(inputArgs[loopIdx + 2]).toBe("-t");
      // Duration comes from scene timeline (150 frames / 30 fps = 5s)
      expect(inputArgs[loopIdx + 3]).toBe("5.000");
      expect(inputArgs[loopIdx + 4]).toBe("-i");
      expect(inputArgs[loopIdx + 5]).toBe("/tmp/overlay-s1.png");
    });

    it("adds setpts to align overlay PTS with scene start, RGBA fade with alpha=1", () => {
      const codeOverlays = [{ sceneNumber: 1, pngPath: "/tmp/overlay-s1.png" }];
      const { filterComplex, outputVideoLabel } = buildFilterGraph(
        baseInput({ codeOverlays }),
      );

      expect(filterComplex).toContain("between(t,");
      // setpts shifts the overlay stream PTS to match the scene position
      expect(filterComplex).toContain("setpts=PTS+0.000/TB");
      // Must preserve RGBA through the fade chain to avoid black box
      expect(filterComplex).toContain("format=rgba");
      // alpha=1 fades transparency instead of RGB (black→visible)
      expect(filterComplex).toContain("fade=t=in:st=0.000:d=0.5:alpha=1");
      expect(filterComplex).toContain("fade=t=out");
      expect(filterComplex).toContain(":alpha=1");
      expect(filterComplex).toContain("overlay=");
      expect(outputVideoLabel).toBe("code_s1");
    });

    it("shifts overlay PTS for scenes after scene 1", () => {
      const clips = [makeClip(1, 0), makeClip(2, 0)];
      const script = makeScript([makeScene(1, 4), makeScene(2, 6)]);
      const timeline = [makeTimeline(1, 120), makeTimeline(2, 180)];
      // Overlay on scene 2 only
      const codeOverlays = [{ sceneNumber: 2, pngPath: "/tmp/overlay-s2.png" }];
      const { filterComplex } = buildFilterGraph({
        script,
        clips,
        sceneTimelineFrames: timeline,
        audioIncluded: false,
        captionAssPath: null,
        codeOverlays,
        localAudioPaths: new Map(),
        localClipPaths: buildLocalClipPaths(clips),
      });

      // Scene 1 is 120 frames / 30 fps = 4s, so scene 2 starts at t=4.000
      expect(filterComplex).toContain("setpts=PTS+4.000/TB");
      // Fade-in starts at the scene start time (absolute)
      expect(filterComplex).toContain("fade=t=in:st=4.000:d=0.5:alpha=1");
      // Enable window matches the scene boundary
      expect(filterComplex).toContain("enable='between(t,4.000,10.000)'");
    });

    it("uses durationSeconds for precise overlay and audio timing when present", () => {
      // durationFrames=184 → 184/30 = 6.1333s (frame-quantized)
      // durationSeconds=6.12 → exact probed value
      // Scene 2 overlay must use 6.12s (precise), not 6.133s (frame-quantized).
      const clips = [makeClip(1, 0), makeClip(2, 0)];
      const script = makeScript([makeScene(1, 7), makeScene(2, 6)]);
      const timeline = [
        makeTimeline(1, 184, 6.12),  // precise probed: 6.12s
        makeTimeline(2, 180, 5.98),  // precise probed: 5.98s
      ];
      const codeOverlays = [{ sceneNumber: 2, pngPath: "/tmp/overlay-s2.png" }];
      const { filterComplex, inputArgs } = buildFilterGraph({
        script,
        clips,
        sceneTimelineFrames: timeline,
        audioIncluded: false,
        captionAssPath: null,
        codeOverlays,
        localAudioPaths: new Map(),
        localClipPaths: buildLocalClipPaths(clips),
      });

      // Scene 2 starts at 6.12s (from durationSeconds), not 6.133s (from 184/30)
      expect(filterComplex).toContain("setpts=PTS+6.120/TB");
      expect(filterComplex).toContain("fade=t=in:st=6.120:d=0.5:alpha=1");
      // Scene 2 end = 6.12 + 5.98 = 12.10s
      expect(filterComplex).toContain("enable='between(t,6.120,12.100)'");
      // PNG loop duration uses scene 2's precise duration
      const tIdx = inputArgs.indexOf("-t");
      expect(inputArgs[tIdx + 1]).toBe("5.980");
    });

    it("positions overlay vertically centered and right-aligned with 60px padding", () => {
      const codeOverlays = [{ sceneNumber: 1, pngPath: "/tmp/overlay-s1.png" }];
      const { filterComplex } = buildFilterGraph(baseInput({ codeOverlays }));

      // Matches Remotion CodeBrollOverlay: justifyContent:"center", alignItems:"flex-end"
      expect(filterComplex).toContain("overlay=W-w-60:(H-h)/2");
    });
  });

  describe("caption ASS path", () => {
    it("adds ass= filter when captionAssPath is provided", () => {
      const { filterComplex, outputVideoLabel } = buildFilterGraph(
        baseInput({ captionAssPath: "/tmp/captions.ass" }),
      );

      expect(filterComplex).toContain("ass=");
      expect(filterComplex).toContain("captions.ass");
      expect(outputVideoLabel).toBe("captioned");
    });

    it("escapes colons, backslashes, and single quotes in the ASS path", () => {
      const weirdPath = "/tmp/user's:project\\dir/captions.ass";
      const { filterComplex } = buildFilterGraph(
        baseInput({ captionAssPath: weirdPath }),
      );

      // Colons, backslashes, and single quotes must be escaped for ffmpeg filter syntax
      expect(filterComplex).toContain("\\:");
      expect(filterComplex).toContain("\\\\");
      expect(filterComplex).toContain("\\'");
      expect(filterComplex).not.toContain("user's:");
    });

    it("does not add ass= filter when captionAssPath is null", () => {
      const { filterComplex } = buildFilterGraph(baseInput({ captionAssPath: null }));
      expect(filterComplex).not.toContain("ass=");
    });
  });

  describe("input ordering", () => {
    it("adds all clip inputs before audio inputs", () => {
      const clips = [makeClip(1, 0)];
      const localAudioPaths = new Map([[1, "/tmp/narration-1.mp3"]]);
      const { inputArgs } = buildFilterGraph(
        baseInput({ clips, localAudioPaths, localClipPaths: buildLocalClipPaths(clips) }),
      );

      const clipIdx = inputArgs.indexOf("/tmp/s1-c0.mp4");
      const audioIdx = inputArgs.indexOf("/tmp/narration-1.mp3");
      expect(clipIdx).toBeLessThan(audioIdx);
    });

    it("throws when a clip path is missing from localClipPaths", () => {
      expect(() =>
        buildFilterGraph(baseInput({ localClipPaths: new Map() })),
      ).toThrow(/Missing local path/);
    });
  });

  describe("zero-clip scene", () => {
    it("generates color source and silence for a scene with no clips", () => {
      const clips = [makeClip(2, 0)];
      const script = makeScript([makeScene(1, 3), makeScene(2, 5)]);
      const timeline = [makeTimeline(1, 90), makeTimeline(2, 150)];
      // Scene 1 has no clips — only scene 2 has a clip
      const { filterComplex } = buildFilterGraph({
        script,
        clips,
        sceneTimelineFrames: timeline,
        audioIncluded: false,
        captionAssPath: null,
        codeOverlays: [],
        localAudioPaths: new Map(),
        localClipPaths: buildLocalClipPaths(clips),
      });

      // Scene 1 should use a solid color source + silence
      expect(filterComplex).toContain("color=c=0x0d1117:s=1920x1080:r=30:d=3");
      expect(filterComplex).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=3");
      // Scene 2 should still have a normal clip scale
      expect(filterComplex).toContain("scale=1920:1080");
    });
  });

  describe("audioIncluded with multi-clip scene", () => {
    it("concats clip audio streams when audioIncluded=true and multiple clips in a scene", () => {
      const clips = [makeClip(1, 0), makeClip(1, 1)];
      const script = makeScript([makeScene(1, 10)]);
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        audioIncluded: true,
        localClipPaths: buildLocalClipPaths(clips),
      });

      // Multi-clip audio concat with audioIncluded=true
      expect(filterComplex).toContain("concat=n=2:v=0:a=1");
    });
  });

  // ── full-frame overlay (constellation graph summary) ───────────────
  describe("full-frame overlay (constellation graph)", () => {
    it("registers a looped PNG input for the overlay", () => {
      const clips = [makeClip(1, 0), makeClip(2, 0)];
      const script = makeScript([makeScene(1, 4), makeScene(2, 6)]);
      const { inputArgs } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 120), makeTimeline(2, 180)],
        localClipPaths: buildLocalClipPaths(clips),
        fullFrameOverlay: {
          sceneNumber: 2,
          pngPath: "/tmp/constellation.png",
          fadeInSec: 0.6,
        },
      });
      // The overlay should be registered as a looped PNG input, with a
      // duration equal to the target scene's length. Arg order is
      // `-loop 1 -t <dur> -i <path>`, so path is at index; walk back.
      const overlayPathIdx = inputArgs.indexOf("/tmp/constellation.png");
      expect(overlayPathIdx).toBeGreaterThan(-1);
      expect(inputArgs[overlayPathIdx - 1]).toBe("-i");
      expect(inputArgs[overlayPathIdx - 2]).toBe("6.000");
      expect(inputArgs[overlayPathIdx - 3]).toBe("-t");
      expect(inputArgs[overlayPathIdx - 4]).toBe("1");
      expect(inputArgs[overlayPathIdx - 5]).toBe("-loop");
    });

    it("emits a fade-in filter chain scaled to 1920x1080 RGBA with correct time window", () => {
      const clips = [makeClip(1, 0), makeClip(2, 0)];
      const script = makeScript([makeScene(1, 4), makeScene(2, 6)]);
      const { filterComplex, outputVideoLabel } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 120), makeTimeline(2, 180)],
        localClipPaths: buildLocalClipPaths(clips),
        fullFrameOverlay: {
          sceneNumber: 2,
          pngPath: "/tmp/constellation.png",
          fadeInSec: 0.6,
        },
      });
      // Scene 2 starts at t=4.000, ends at t=10.000
      expect(filterComplex).toContain("setpts=PTS+4.000/TB");
      expect(filterComplex).toContain("scale=1920:1080:force_original_aspect_ratio=disable");
      expect(filterComplex).toContain("format=rgba");
      expect(filterComplex).toContain("fade=t=in:st=4.000:d=0.6:alpha=1");
      // Full-frame placement at top-left with a scene-scoped enable window
      expect(filterComplex).toContain("overlay=0:0:enable='between(t,4.000,10.000)'");
      expect(outputVideoLabel).toBe("graph_s2");
    });

    it("composes code overlays on non-graph scenes and lets the graph own its scene", () => {
      // Scene 1 gets its code card (normal behavior).
      // Scene 2 owns the constellation graph AND has a codeBroll, but the
      // code card is suppressed so the graph is the sole visual for scene 2.
      const clips = [makeClip(1, 0), makeClip(2, 0), makeClip(3, 0)];
      const script = makeScript([makeScene(1, 4), makeScene(2, 6), makeScene(3, 5)]);
      const { filterComplex } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 120), makeTimeline(2, 180), makeTimeline(3, 150)],
        localClipPaths: buildLocalClipPaths(clips),
        codeOverlays: [
          { sceneNumber: 1, pngPath: "/tmp/code-s1.png" },
          { sceneNumber: 2, pngPath: "/tmp/code-s2.png" },
        ],
        fullFrameOverlay: {
          sceneNumber: 2,
          pngPath: "/tmp/constellation.png",
          fadeInSec: 0.6,
        },
      });
      // Scene 1's code overlay is present
      expect(filterComplex).toContain("[code_s1]");
      // Scene 2's code overlay is suppressed in favor of the graph
      expect(filterComplex).not.toContain("[code_s2]");
      // The constellation graph for scene 2 is present
      expect(filterComplex).toContain("full_overlay_s2");
      // Ordering sanity check: the graph overlay filter must appear before
      // scene 1's code overlay filter (graph is composed first in Phase 4,
      // code overlays are composed in Phase 6).
      const graphIdx = filterComplex.indexOf("full_overlay_s2");
      const codeS1Idx = filterComplex.indexOf("[code_s1]");
      expect(graphIdx).toBeGreaterThan(-1);
      expect(codeS1Idx).toBeGreaterThan(-1);
      expect(graphIdx).toBeLessThan(codeS1Idx);
    });

    it("burns captions ON TOP of the constellation graph so subtitles remain readable", () => {
      const clips = [makeClip(1, 0), makeClip(2, 0)];
      const script = makeScript([makeScene(1, 4), makeScene(2, 6)]);
      const { filterComplex, outputVideoLabel } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 120), makeTimeline(2, 180)],
        localClipPaths: buildLocalClipPaths(clips),
        captionAssPath: "/tmp/captions.ass",
        fullFrameOverlay: {
          sceneNumber: 2,
          pngPath: "/tmp/constellation.png",
          fadeInSec: 0.6,
        },
      });
      // Both the graph overlay and the caption burn-in should be present.
      expect(filterComplex).toContain("full_overlay_s2");
      expect(filterComplex).toContain("ass='/tmp/captions.ass'");
      // Captions burn AFTER the graph overlay so they render on top of it.
      // The final label must therefore be the captioned output, not the graph.
      expect(outputVideoLabel).toBe("captioned");
      const graphIdx = filterComplex.indexOf("full_overlay_s2");
      const captionIdx = filterComplex.indexOf("ass='/tmp/captions.ass'");
      expect(graphIdx).toBeLessThan(captionIdx);
    });

    it("throws when the target scene is missing from the timeline map", () => {
      const clips = [makeClip(1, 0)];
      const script = makeScript([makeScene(1, 5)]);
      expect(() =>
        buildFilterGraph({
          ...baseInput(),
          script,
          clips,
          sceneTimelineFrames: [makeTimeline(1, 150)],
          localClipPaths: buildLocalClipPaths(clips),
          fullFrameOverlay: {
            sceneNumber: 99, // not in script
            pngPath: "/tmp/constellation.png",
          },
        }),
      ).toThrow(/missing from timeline map/);
    });

    it("throws when a code overlay references a scene that's not in the timeline map", () => {
      // Phase 1 used to silently default unknown-scene overlays to a 10-second
      // PNG, hiding upstream invariant violations. It now throws to match
      // Phase 4's semantics for the full-frame overlay.
      const clips = [makeClip(1, 0)];
      const script = makeScript([makeScene(1, 5)]);
      expect(() =>
        buildFilterGraph({
          ...baseInput(),
          script,
          clips,
          sceneTimelineFrames: [makeTimeline(1, 150)],
          localClipPaths: buildLocalClipPaths(clips),
          codeOverlays: [
            { sceneNumber: 99, pngPath: "/tmp/orphan.png" }, // not in script
          ],
        }),
      ).toThrow(/Code overlay scene 99 missing from timeline map/);
    });

    it("is a no-op when fullFrameOverlay is omitted", () => {
      const { filterComplex, outputVideoLabel } = buildFilterGraph(baseInput());
      expect(filterComplex).not.toContain("full_overlay_");
      expect(outputVideoLabel).not.toMatch(/^graph_/);
    });

    it("skips per-scene code overlay on the scene owning the full-frame graph overlay", () => {
      // When the last scene has BOTH a code overlay AND a full-frame graph
      // overlay, the code card would otherwise composite on top of the graph
      // during the entire final scene — the MP4 would never reach the
      // graph-only end state. This test locks in the skip behavior.
      const clips = [makeClip(1, 0), makeClip(2, 0)];
      const script = makeScript([makeScene(1, 4), makeScene(2, 6)]);
      const { filterComplex, outputVideoLabel } = buildFilterGraph({
        ...baseInput(),
        script,
        clips,
        sceneTimelineFrames: [makeTimeline(1, 120), makeTimeline(2, 180)],
        localClipPaths: buildLocalClipPaths(clips),
        codeOverlays: [
          { sceneNumber: 1, pngPath: "/tmp/code-s1.png" },
          { sceneNumber: 2, pngPath: "/tmp/code-s2.png" },
        ],
        fullFrameOverlay: {
          sceneNumber: 2,
          pngPath: "/tmp/constellation.png",
          fadeInSec: 0.6,
        },
      });
      // Graph must still appear on scene 2
      expect(filterComplex).toContain("full_overlay_s2");
      // Scene 1's code overlay is unaffected (labels are emitted with brackets)
      expect(filterComplex).toContain("[overlay_s1]");
      expect(filterComplex).toContain("[code_s1]");
      // Scene 2's code overlay is SKIPPED so the graph owns the final scene.
      // Match the bracketed label form so "[overlay_s2]" doesn't collide
      // with "[full_overlay_s2]" via substring.
      expect(filterComplex).not.toContain("[overlay_s2]");
      expect(filterComplex).not.toContain("[code_s2]");
      // Final label is the last applied overlay (code_s1), NOT code_s2
      expect(outputVideoLabel).toBe("code_s1");
    });
  });
});
