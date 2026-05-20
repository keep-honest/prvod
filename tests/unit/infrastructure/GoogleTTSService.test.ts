import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleTTSService } from "@/infrastructure/tts/GoogleTTSService";
import { computeTtsSpeakingRate } from "@/infrastructure/llm/wordBudget";

const mockComputeDuration = vi.fn().mockResolvedValue(2.5);
vi.mock("mediabunny", () => ({
  Input: vi.fn().mockImplementation(() => ({
    computeDuration: mockComputeDuration,
  })),
  BufferSource: vi.fn(),
  ALL_FORMATS: [],
}));

const ORIGINAL_KEY = process.env.GOOGLE_CLOUD_TTS_KEY;
const ORIGINAL_VOICE = process.env.GOOGLE_TTS_VOICE;
const ORIGINAL_SPEED = process.env.TTS_SPEED_MULTIPLIER;
const ORIGINAL_TTS_TIMEOUT = process.env.GOOGLE_TTS_TIMEOUT_MS;
const ORIGINAL_TTS_MAX_ATTEMPTS = process.env.GOOGLE_TTS_MAX_ATTEMPTS;
const ORIGINAL_TTS_RETRY_BASE = process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS;
const ORIGINAL_TTS_RETRY_MAX = process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.GOOGLE_CLOUD_TTS_KEY;
  } else {
    process.env.GOOGLE_CLOUD_TTS_KEY = ORIGINAL_KEY;
  }

  if (ORIGINAL_VOICE === undefined) {
    delete process.env.GOOGLE_TTS_VOICE;
  } else {
    process.env.GOOGLE_TTS_VOICE = ORIGINAL_VOICE;
  }

  if (ORIGINAL_SPEED === undefined) {
    delete process.env.TTS_SPEED_MULTIPLIER;
  } else {
    process.env.TTS_SPEED_MULTIPLIER = ORIGINAL_SPEED;
  }

  if (ORIGINAL_TTS_TIMEOUT === undefined) {
    delete process.env.GOOGLE_TTS_TIMEOUT_MS;
  } else {
    process.env.GOOGLE_TTS_TIMEOUT_MS = ORIGINAL_TTS_TIMEOUT;
  }

  if (ORIGINAL_TTS_MAX_ATTEMPTS === undefined) {
    delete process.env.GOOGLE_TTS_MAX_ATTEMPTS;
  } else {
    process.env.GOOGLE_TTS_MAX_ATTEMPTS = ORIGINAL_TTS_MAX_ATTEMPTS;
  }

  if (ORIGINAL_TTS_RETRY_BASE === undefined) {
    delete process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS;
  } else {
    process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS = ORIGINAL_TTS_RETRY_BASE;
  }

  if (ORIGINAL_TTS_RETRY_MAX === undefined) {
    delete process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS;
  } else {
    process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS = ORIGINAL_TTS_RETRY_MAX;
  }
});

describe("GoogleTTSService", () => {
  it("does not require GOOGLE_CLOUD_TTS_KEY at construction time", () => {
    delete process.env.GOOGLE_CLOUD_TTS_KEY;
    expect(() => new GoogleTTSService()).not.toThrow();
  });

  it("requires GOOGLE_CLOUD_TTS_KEY when synthesize is called", async () => {
    delete process.env.GOOGLE_CLOUD_TTS_KEY;
    const service = new GoogleTTSService();

    await expect(service.synthesize("hello world")).rejects.toThrow(
      "GOOGLE_CLOUD_TTS_KEY environment variable is not set",
    );
  });

  it("defaults to en-US-Chirp3-HD-Algenib when GOOGLE_TTS_VOICE is not set", () => {
    delete process.env.GOOGLE_TTS_VOICE;
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((service as any).defaultVoice).toBe("en-US-Chirp3-HD-Algenib");
  });

  it("uses GOOGLE_TTS_VOICE env var when it is a valid voice", () => {
    process.env.GOOGLE_TTS_VOICE = "en-US-Neural2-D";
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((service as any).defaultVoice).toBe("en-US-Neural2-D");
  });

  it("falls back to the default when GOOGLE_TTS_VOICE is invalid", () => {
    process.env.GOOGLE_TTS_VOICE = "en-US-InvalidVoice-X";
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((service as any).defaultVoice).toBe("en-US-Chirp3-HD-Algenib");
  });

  it("resolveVoice returns the per-call voice when it is a valid Chirp3-HD voice", () => {
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved = (service as any).resolveVoice("en-US-Neural2-A");
    expect(resolved).toBe("en-US-Neural2-A");
  });

  it("resolveVoice falls back to defaultVoice when per-call voice is invalid", () => {
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved = (service as any).resolveVoice("en-US-Journey-D");
    expect(resolved).toBe("en-US-Chirp3-HD-Algenib");
  });

  it("resolveVoice returns defaultVoice when no per-call voice is provided", () => {
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved = (service as any).resolveVoice(undefined);
    expect(resolved).toBe("en-US-Chirp3-HD-Algenib");
  });

  describe("computeSpeakingRate (shared via computeTtsSpeakingRate)", () => {
    it("returns 1.0 when no targetDurationSeconds is provided", () => {
      expect(computeTtsSpeakingRate(10, undefined, 1.0)).toBe(1.0);
    });

    it("caps at 1.0 when narration is longer than target (never speeds up past natural)", () => {
      // 10 words x 0.4s = 4s natural, target = 2s -> rawRate = 2.0 -> capped to 1.0
      expect(computeTtsSpeakingRate(10, 2, 1.0)).toBe(1.0);
    });

    it("slows down when narration is shorter than target duration", () => {
      // 5 words x 0.4s = 2s natural, target = 4s -> raw = 0.5
      expect(computeTtsSpeakingRate(5, 4, 1.0)).toBe(0.5);
    });

    it("caps at 1.0 even for extreme word/target mismatch", () => {
      // 100 words x 0.4s = 40s natural, target = 1s -> rawRate = 40 -> capped to 1.0
      expect(computeTtsSpeakingRate(100, 1, 1.0)).toBe(1.0);
    });

    it("clamps to 0.25 min", () => {
      // 1 word x 0.4s = 0.4s natural, target = 100s -> rate = 0.004 -> clamped to 0.25
      expect(computeTtsSpeakingRate(1, 100, 1.0)).toBe(0.25);
    });

    it("returns 1.0 when wordCount is 0", () => {
      expect(computeTtsSpeakingRate(0, 5, 1.0)).toBe(1.0);
    });

    it("applies speedMultiplier=1.5 as absolute pace (50% faster than natural)", () => {
      // 10 words x 0.4s = 4s natural, target = 2s -> rawRate = 2.0 -> capped to 1.0 x 1.5 = 1.5
      expect(computeTtsSpeakingRate(10, 2, 1.5)).toBe(1.5);
    });

    it("applies speedMultiplier=0.5 as absolute pace (50% slower than natural)", () => {
      // 10 words x 0.4s = 4s natural, target = 2s -> rawRate = 2.0 -> capped to 1.0 x 0.5 = 0.5
      expect(computeTtsSpeakingRate(10, 2, 0.5)).toBe(0.5);
    });

    it("multiplier stacks with pacing slowdown for short narration", () => {
      // 5 words x 0.4s = 2s natural, target = 4s -> rawRate = 0.5 (pacing)
      // capped to 0.5 (< 1.0), then x 0.9 = 0.45
      expect(computeTtsSpeakingRate(5, 4, 0.9)).toBe(0.45);
    });

    it("ignores invalid speedMultiplier and defaults via parseTtsSpeedMultiplier", () => {
      process.env.TTS_SPEED_MULTIPLIER = "-2";
      // When speedMultiplier is omitted, parseTtsSpeedMultiplier reads env (invalid -> 1.0)
      // rawRate = 2.0 -> capped to 1.0 x 1.0 (default) = 1.0
      expect(computeTtsSpeakingRate(10, 2)).toBe(1.0);
    });
  });

  it("wraps synthesizeSpeech errors with context and preserves cause", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    process.env.GOOGLE_TTS_MAX_ATTEMPTS = "1";
    const service = new GoogleTTSService();
    const sdkError = new Error("DEADLINE_EXCEEDED: 503");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => { throw sdkError; },
    });

    let caught: Error | undefined;
    try {
      await service.synthesize("hello world test", "en-US-Neural2-D", {
        targetDurationSeconds: 5,
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    if (!caught) throw new Error("Expected synthesize to throw");
    expect(caught.message).toMatch(/Speech synthesis failed/);
    expect(caught.message).toMatch(/en-US-Neural2-D/);
    expect(caught.message).toMatch(/DEADLINE_EXCEEDED/);
    expect(caught.message).toMatch(/after 1 attempt/);
    expect(caught.cause).toBe(sdkError);
  });

  it("retries transient synthesizeSpeech failures and succeeds", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    process.env.GOOGLE_TTS_TIMEOUT_MS = "1234";
    process.env.GOOGLE_TTS_MAX_ATTEMPTS = "3";
    process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS = "1";
    process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS = "1";
    mockComputeDuration.mockResolvedValueOnce(2.0);
    const service = new GoogleTTSService();
    const synthesizeSpeech = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("DEADLINE_EXCEEDED"), { code: "DEADLINE_EXCEEDED" }))
      .mockResolvedValueOnce([{ audioContent: Uint8Array.from([1, 2, 3]) }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({ synthesizeSpeech });

    const result = await service.synthesize("hello world", "en-US-Neural2-D");

    expect(result.audioBuffer).toEqual(Buffer.from([1, 2, 3]));
    expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(synthesizeSpeech).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      { timeout: 1234 },
    );
    expect(synthesizeSpeech).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      { timeout: 1234 },
    );
  });

  it("retries numeric Google gRPC transient codes", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    process.env.GOOGLE_TTS_MAX_ATTEMPTS = "2";
    process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS = "1";
    process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS = "1";
    mockComputeDuration.mockResolvedValueOnce(2.0);
    const service = new GoogleTTSService();
    const synthesizeSpeech = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("request deadline exceeded"), { code: 4 }))
      .mockResolvedValueOnce([{ audioContent: Uint8Array.from([1, 2, 3]) }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({ synthesizeSpeech });

    await expect(service.synthesize("hello world")).resolves.toMatchObject({
      audioBuffer: Buffer.from([1, 2, 3]),
    });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
  });

  it("stops after max attempts for transient synthesizeSpeech failures", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    process.env.GOOGLE_TTS_TIMEOUT_MS = "2000";
    process.env.GOOGLE_TTS_MAX_ATTEMPTS = "2";
    process.env.GOOGLE_TTS_RETRY_BASE_DELAY_MS = "1";
    process.env.GOOGLE_TTS_RETRY_MAX_DELAY_MS = "1";
    const service = new GoogleTTSService();
    const sdkError = Object.assign(
      new Error("Total timeout of API google.cloud.texttospeech.v1beta1.TextToSpeech exceeded 2000 milliseconds before any response was received."),
      { code: "DEADLINE_EXCEEDED" },
    );
    const synthesizeSpeech = vi.fn().mockRejectedValue(sdkError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({ synthesizeSpeech });

    await expect(service.synthesize("hello world", "en-US-Neural2-D")).rejects.toThrow(
      /after 2 attempts \(timeout 2000ms\)/,
    );
    expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient synthesizeSpeech failures", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    process.env.GOOGLE_TTS_MAX_ATTEMPTS = "3";
    const service = new GoogleTTSService();
    const synthesizeSpeech = vi.fn().mockRejectedValue(
      Object.assign(new Error("INVALID_ARGUMENT: unsupported SSML"), { code: "INVALID_ARGUMENT" }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({ synthesizeSpeech });

    await expect(service.synthesize("hello world")).rejects.toThrow(/INVALID_ARGUMENT/);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
  });

  it("throws when Google TTS returns empty audio content", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    process.env.GOOGLE_TTS_MAX_ATTEMPTS = "3";
    const service = new GoogleTTSService();
    const synthesizeSpeech = vi.fn().mockResolvedValue([{ audioContent: null }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({ synthesizeSpeech });

    await expect(service.synthesize("hello world")).rejects.toThrow(
      "Google TTS returned empty audio content",
    );
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
  });

  it("calibrates word timings to measured audio duration", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    mockComputeDuration.mockResolvedValueOnce(3.0); // 3 seconds of audio
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [
        { audioContent: Uint8Array.from([1, 2, 3]) },
      ],
    });

    const result = await service.synthesize("hello beautiful world");

    // 3 words across 3000ms = 1000ms per word
    expect(result.wordTimings).toEqual([
      { word: "hello", startTimeMs: 0, endTimeMs: 1000 },
      { word: "beautiful", startTimeMs: 1000, endTimeMs: 2000 },
      { word: "world", startTimeMs: 2000, endTimeMs: 3000 },
    ]);
  });

  it("calibrates scene segment timings to measured audio with hold gaps", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    // 5 words + 2s hold = audio should be ~4s speech + 2s hold = 6s
    mockComputeDuration.mockResolvedValueOnce(6.0);
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [
        { audioContent: Uint8Array.from([1, 2, 3]) },
      ],
    });

    const result = await service.synthesize("Guard holds. Second scene starts.", undefined, {
      sceneSegments: [
        { text: "Guard holds.", holdDurationMs: 2000 },
        { text: "Second scene starts." },
      ],
    });

    expect(result.wordTimings.map((timing) => timing.word)).toEqual([
      "Guard",
      "holds.",
      "Second",
      "scene",
      "starts.",
    ]);
    // 5 words, 6000ms audio - 2000ms hold = 4000ms speech = 800ms/word
    // Segment 1: "Guard" 0-800, "holds." 800-1600
    // Hold: 1600-3600
    // Segment 2: "Second" 3600-4400, "scene" 4400-5200, "starts." 5200-6000
    expect(result.wordTimings[0].startTimeMs).toBe(0);
    expect(result.wordTimings[0].endTimeMs).toBe(800);
    expect(result.wordTimings[2].startTimeMs).toBe(3600);
    expect(result.wordTimings[4].endTimeMs).toBe(6000);
  });

  it("falls back to 400ms/word when audio duration measurement fails", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    mockComputeDuration.mockRejectedValueOnce(new Error("parse error"));
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [
        { audioContent: Uint8Array.from([1, 2, 3]) },
      ],
    });

    const result = await service.synthesize("hello world");

    // Falls back to 400ms/word approximation
    expect(result.wordTimings).toEqual([
      { word: "hello", startTimeMs: 0, endTimeMs: 400 },
      { word: "world", startTimeMs: 400, endTimeMs: 800 },
    ]);
  });

  it("returns audioDurationSeconds measured via mediabunny", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    mockComputeDuration.mockResolvedValueOnce(3.75);
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [
        {
          audioContent: Uint8Array.from([1, 2, 3]),
          // No timepoints — word timings computed from measured audio duration
        },
      ],
    });

    const result = await service.synthesize("hello");
    expect(result.audioDurationSeconds).toBe(3.75);
  });

  it("returns 0 audioDurationSeconds when duration measurement fails", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    mockComputeDuration.mockRejectedValueOnce(new Error("parse error"));
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [
        {
          audioContent: Uint8Array.from([1, 2, 3]),
          // No timepoints — word timings computed from measured audio duration
        },
      ],
    });

    const result = await service.synthesize("hello");
    expect(result.audioDurationSeconds).toBe(0);
  });

  it("returns 0 audioDurationSeconds when TypeError occurs in duration measurement", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    mockComputeDuration.mockRejectedValueOnce(new TypeError("invalid buffer"));
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [
        {
          audioContent: Uint8Array.from([1, 2, 3]),
          // No timepoints — word timings computed from measured audio duration
        },
      ],
    });

    const result = await service.synthesize("hello");
    expect(result.audioDurationSeconds).toBe(0);
  });

  it("falls back to 400ms/word when hold durations consume entire audio", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    // 2s audio, 3s hold → speechMs = max(0, 2000 - 3000) = 0 → return [] → fallback
    mockComputeDuration.mockResolvedValueOnce(2.0);
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [{ audioContent: Uint8Array.from([1, 2, 3]) }],
    });

    const result = await service.synthesize("hello world", undefined, {
      sceneSegments: [{ text: "hello world", holdDurationMs: 3000 }],
    });

    // computeSegmentTimingsFromAudio returns [] (speechMs === 0) → approximateSceneSegmentTimings used
    expect(result.wordTimings).toEqual([
      { word: "hello", startTimeMs: 0, endTimeMs: 400 },
      { word: "world", startTimeMs: 400, endTimeMs: 800 },
    ]);
  });

  it("returns 0 audioDurationSeconds when duration probe returns 0", async () => {
    process.env.GOOGLE_CLOUD_TTS_KEY = "test-key";
    mockComputeDuration.mockResolvedValueOnce(0);
    const service = new GoogleTTSService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).getClient = () => ({
      synthesizeSpeech: async () => [
        {
          audioContent: Uint8Array.from([1, 2, 3]),
          // No timepoints — word timings computed from measured audio duration
        },
      ],
    });

    const result = await service.synthesize("hello");
    expect(result.audioDurationSeconds).toBe(0);
  });
});
