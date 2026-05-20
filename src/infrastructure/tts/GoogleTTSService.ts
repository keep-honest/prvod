import { v1beta1 } from "@google-cloud/text-to-speech";
import type { protos } from "@google-cloud/text-to-speech";
import { Input, BufferSource, ALL_FORMATS } from "mediabunny";
import { createLogger } from "@/lib/logger";
import type {
  ITTSService,
  TTSOptions,
  TTSResult,
  WordTiming,
} from "@/interfaces/ITTSService";
import { sanitizeSpokenNarrationText } from "@/lib/narrationText";
import { escapeXml } from "@/lib/xml";
import { parseTtsSpeedMultiplier, computeTtsSpeakingRate } from "@/infrastructure/llm/wordBudget";

const logger = createLogger("GoogleTTSService");

type GoogleTextToSpeechClient = InstanceType<typeof v1beta1.TextToSpeechClient>;
type SynthesizeSpeechRequest = protos.google.cloud.texttospeech.v1beta1.ISynthesizeSpeechRequest;
type SynthesizeSpeechResponse = protos.google.cloud.texttospeech.v1beta1.ISynthesizeSpeechResponse;

const VALID_VOICES = new Set([
  // Neural2
  "en-US-Neural2-A", "en-US-Neural2-C", "en-US-Neural2-D",
  "en-US-Neural2-E", "en-US-Neural2-F", "en-US-Neural2-G",
  "en-US-Neural2-H", "en-US-Neural2-I", "en-US-Neural2-J",
  // WaveNet
  "en-US-Wavenet-A", "en-US-Wavenet-B", "en-US-Wavenet-C",
  "en-US-Wavenet-D", "en-US-Wavenet-E", "en-US-Wavenet-F",
  "en-US-Wavenet-G", "en-US-Wavenet-H", "en-US-Wavenet-I",
  "en-US-Wavenet-J",
  // Studio
  "en-US-Studio-O", "en-US-Studio-Q",
  // Chirp HD
  "en-US-Chirp-HD-D", "en-US-Chirp-HD-F", "en-US-Chirp-HD-O",
  // Chirp3 HD (named voices — replacements for the retired Journey family)
  "en-US-Chirp3-HD-Achernar", "en-US-Chirp3-HD-Achird", "en-US-Chirp3-HD-Algenib",
  "en-US-Chirp3-HD-Algieba", "en-US-Chirp3-HD-Alnilam", "en-US-Chirp3-HD-Aoede",
  "en-US-Chirp3-HD-Autonoe", "en-US-Chirp3-HD-Callirrhoe", "en-US-Chirp3-HD-Charon",
  "en-US-Chirp3-HD-Despina", "en-US-Chirp3-HD-Enceladus", "en-US-Chirp3-HD-Erinome",
  "en-US-Chirp3-HD-Fenrir", "en-US-Chirp3-HD-Gacrux", "en-US-Chirp3-HD-Iapetus",
  "en-US-Chirp3-HD-Kore", "en-US-Chirp3-HD-Laomedeia", "en-US-Chirp3-HD-Leda",
  "en-US-Chirp3-HD-Orus", "en-US-Chirp3-HD-Puck", "en-US-Chirp3-HD-Pulcherrima",
  "en-US-Chirp3-HD-Rasalgethi", "en-US-Chirp3-HD-Sadachbia", "en-US-Chirp3-HD-Sadaltager",
  "en-US-Chirp3-HD-Schedar", "en-US-Chirp3-HD-Sulafat", "en-US-Chirp3-HD-Umbriel",
  "en-US-Chirp3-HD-Vindemiatrix", "en-US-Chirp3-HD-Zephyr", "en-US-Chirp3-HD-Zubenelgenubi",
]);

const DEFAULT_VOICE = "en-US-Chirp3-HD-Algenib";
const DEFAULT_TTS_TIMEOUT_MS = 45_000;
const DEFAULT_TTS_MAX_ATTEMPTS = 3;
const DEFAULT_TTS_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_TTS_RETRY_MAX_DELAY_MS = 10_000;

const TRANSIENT_TTS_CODES = new Set([
  "DEADLINE_EXCEEDED",
  "UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

const TRANSIENT_TTS_PATTERNS = [
  /deadline[_ ]exceeded/i,
  /total timeout/i,
  /timed? ?out/i,
  /timeout .*before any response/i,
  /resource[_ ]exhausted/i,
  /too many requests/i,
  /rate ?limit/i,
  /unavailable/i,
  /service unavailable/i,
  /\b408\b/,
  /\b429\b/,
  /\b5\d\d\b/,
];

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTtsRetryConfig(): {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
} {
  return {
    timeoutMs: readPositiveIntEnv("GOOGLE_TTS_TIMEOUT_MS", DEFAULT_TTS_TIMEOUT_MS),
    maxAttempts: readPositiveIntEnv("GOOGLE_TTS_MAX_ATTEMPTS", DEFAULT_TTS_MAX_ATTEMPTS),
    baseDelayMs: readPositiveIntEnv("GOOGLE_TTS_RETRY_BASE_DELAY_MS", DEFAULT_TTS_RETRY_BASE_DELAY_MS),
    maxDelayMs: readPositiveIntEnv("GOOGLE_TTS_RETRY_MAX_DELAY_MS", DEFAULT_TTS_RETRY_MAX_DELAY_MS),
  };
}

function computeRetryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, maxDelayMs);
  const half = capped / 2;
  return Math.round(half + Math.random() * half);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTtsError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;

  const candidate = err as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const numericStatus =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : typeof candidate.code === "number"
          ? candidate.code
          : null;
  if (numericStatus !== null) {
    // Google gax reports gRPC statuses as numbers: 4=DEADLINE_EXCEEDED,
    // 8=RESOURCE_EXHAUSTED, 14=UNAVAILABLE.
    if (numericStatus === 4 || numericStatus === 8 || numericStatus === 14) return true;
    if (numericStatus === 408 || numericStatus === 429) return true;
    if (numericStatus >= 500 && numericStatus <= 599) return true;
  }

  const code = typeof candidate.code === "string" ? candidate.code : null;
  if (code && TRANSIENT_TTS_CODES.has(code.toUpperCase())) return true;

  const message = typeof candidate.message === "string" ? candidate.message : "";
  return TRANSIENT_TTS_PATTERNS.some((pattern) => pattern.test(message));
}

function textToSSML(text: string): { ssml: string; words: string[] } {
  const words = text.split(/\s+/).filter(Boolean);
  const ssml = `<speak>${words.map((w) => escapeXml(w)).join(" ")}</speak>`;
  return { ssml, words };
}

function sceneSegmentsToSSML(
  sceneSegments: NonNullable<TTSOptions["sceneSegments"]>,
): { ssml: string; words: string[] } {
  const words: string[] = [];
  const ssmlParts: string[] = [];

  for (const segment of sceneSegments) {
    const segmentWords = segment.text.split(/\s+/).filter(Boolean);
    for (const word of segmentWords) {
      words.push(word);
      ssmlParts.push(escapeXml(word));
    }
    if ((segment.holdDurationMs ?? 0) > 0) {
      ssmlParts.push(`<break time="${Math.round(segment.holdDurationMs ?? 0)}ms"/>`);
    }
  }

  return {
    ssml: `<speak>${ssmlParts.join(" ")}</speak>`,
    words,
  };
}

/**
 * Compute word timings from measured audio duration for segmented scenes.
 * Distributes words evenly within each segment, adding hold gaps between segments.
 * The total timing span is scaled to match the measured audio duration.
 */
function computeSegmentTimingsFromAudio(
  sceneSegments: NonNullable<TTSOptions["sceneSegments"]>,
  audioDurationMs: number,
): WordTiming[] {
  // Compute total holds and total word count
  let totalHoldMs = 0;
  let totalWords = 0;
  for (const segment of sceneSegments) {
    totalWords += segment.text.split(/\s+/).filter(Boolean).length;
    totalHoldMs += Math.max(0, Math.round(segment.holdDurationMs ?? 0));
  }
  if (totalWords === 0) return [];

  // Speech time = audio duration minus hold gaps
  const speechMs = Math.max(0, audioDurationMs - totalHoldMs);
  if (speechMs === 0) {
    logger.warn("Segment hold durations consume entire audio — falling back to approximation", {
      audioDurationMs, totalHoldMs, totalWords,
    });
    return [];
  }
  const msPerWord = speechMs / totalWords;

  const wordTimings: WordTiming[] = [];
  let currentTimeMs = 0;

  for (const segment of sceneSegments) {
    const segmentWords = segment.text.split(/\s+/).filter(Boolean);
    for (const word of segmentWords) {
      wordTimings.push({
        word,
        startTimeMs: Math.round(currentTimeMs),
        endTimeMs: Math.round(currentTimeMs + msPerWord),
      });
      currentTimeMs += msPerWord;
    }
    currentTimeMs += Math.max(0, Math.round(segment.holdDurationMs ?? 0));
  }

  return wordTimings;
}

/** Fallback: approximates word-level timings at ~150 WPM (400ms/word). */
function approximateWordTimings(text: string): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  const msPerWord = 400;
  return words.map((word, i) => ({
    word,
    startTimeMs: i * msPerWord,
    endTimeMs: (i + 1) * msPerWord,
  }));
}

function approximateSceneSegmentTimings(
  sceneSegments: NonNullable<TTSOptions["sceneSegments"]>,
): WordTiming[] {
  const msPerWord = 400;
  const wordTimings: WordTiming[] = [];
  let currentTimeMs = 0;

  for (const segment of sceneSegments) {
    const words = segment.text.split(/\s+/).filter(Boolean);

    for (const word of words) {
      wordTimings.push({
        word,
        startTimeMs: currentTimeMs,
        endTimeMs: currentTimeMs + msPerWord,
      });
      currentTimeMs += msPerWord;
    }

    currentTimeMs += Math.max(0, Math.round(segment.holdDurationMs ?? 0));
  }

  return wordTimings;
}

export class GoogleTTSService implements ITTSService {
  private client: GoogleTextToSpeechClient | null = null;
  private defaultVoice: string;
  private speedMultiplier: number;

  constructor() {
    this.defaultVoice = DEFAULT_VOICE;
    const envVoice = process.env.GOOGLE_TTS_VOICE;
    if (envVoice) {
      if (VALID_VOICES.has(envVoice)) {
        this.defaultVoice = envVoice;
      } else {
        logger.warn("Invalid GOOGLE_TTS_VOICE, using default", { suggested: envVoice, default: DEFAULT_VOICE });
      }
    }

    this.speedMultiplier = parseTtsSpeedMultiplier();

    logger.info("GoogleTTSService initialized", {
      defaultVoice: this.defaultVoice,
      speedMultiplier: this.speedMultiplier,
      clientMode: "lazy",
    });
  }

  async synthesize(
    text: string,
    voiceName?: string,
    options?: TTSOptions,
  ): Promise<TTSResult> {
    const voice = this.resolveVoice(voiceName);
    const spokenText = sanitizeSpokenNarrationText(text);
    const sceneSegments = options?.sceneSegments?.map((segment) => ({
      text: sanitizeSpokenNarrationText(segment.text),
      holdDurationMs: Math.max(0, segment.holdDurationMs ?? 0),
    }));
    logger.info("Synthesizing speech", {
      textLength: spokenText.length,
      voice,
      normalizedInput: spokenText !== text,
      segmentedInput: Boolean(sceneSegments && sceneSegments.length > 0),
    });
    logger.debug("TTS input text preview", { preview: spokenText.slice(0, 120) });

    const { ssml, words } =
      sceneSegments && sceneSegments.length > 0
        ? sceneSegmentsToSSML(sceneSegments)
        : textToSSML(spokenText);

    const speakingRate = computeTtsSpeakingRate(words.length, options?.targetDurationSeconds, this.speedMultiplier);

    const client = this.getClient();
    const synthesizeRequest = {
      input: { ssml },
      voice: { languageCode: "en-US", name: voice },
      audioConfig: { audioEncoding: "OGG_OPUS" as const, speakingRate },
    };
    const response = await this.synthesizeSpeechWithRetry(
      client,
      synthesizeRequest,
      {
        voice,
        wordCount: words.length,
        textLength: spokenText.length,
        speakingRate,
      },
    );

    if (!response.audioContent) {
      logger.error("No audio content returned from Google TTS");
      throw new Error("Google TTS returned empty audio content");
    }

    const audioBuffer = Buffer.from(response.audioContent as Uint8Array);
    const audioDurationSeconds = await this.measureAudioDuration(audioBuffer);

    // Compute word timings from measured audio duration — calibrated to the
    // actual audio like Remotion's shared frame clock. Google TTS SSML
    // timepoints are unreliable for Chirp3-HD voices, so we don't use them.
    let wordTimings: WordTiming[];
    let timingSource: "measured-audio" | "approximation";
    if (audioDurationSeconds > 0 && words.length > 0) {
      const audioDurationMs = audioDurationSeconds * 1000;
      if (sceneSegments && sceneSegments.length > 0) {
        wordTimings = computeSegmentTimingsFromAudio(sceneSegments, audioDurationMs);
        if (wordTimings.length === 0 && words.length > 0) {
          // Hold durations consumed entire audio — fall back to approximation
          wordTimings = approximateSceneSegmentTimings(sceneSegments);
          timingSource = "approximation";
        } else {
          timingSource = "measured-audio";
        }
      } else {
        const msPerWord = audioDurationMs / words.length;
        wordTimings = words.map((word, i) => ({
          word,
          startTimeMs: Math.round(i * msPerWord),
          endTimeMs: Math.round((i + 1) * msPerWord),
        }));
        timingSource = "measured-audio";
      }
      if (timingSource === "measured-audio") {
        logger.info("Word timings calibrated to measured audio duration", {
          audioDurationMs: Math.round(audioDurationMs),
          wordCount: words.length,
          msPerWord: Math.round(audioDurationMs / words.length),
        });
      }
    } else {
      logger.warn("Audio duration unavailable — using 400ms/word approximation", {
        wordCount: words.length, voice,
      });
      wordTimings =
        sceneSegments && sceneSegments.length > 0
          ? approximateSceneSegmentTimings(sceneSegments)
          : approximateWordTimings(spokenText);
      timingSource = "approximation";
    }

    if (wordTimings.length > 0) {
      const firstTiming = wordTimings[0];
      const lastTiming = wordTimings[wordTimings.length - 1];
      const audioDurationMs = Math.round(audioDurationSeconds * 1000);
      logger.info("Caption-audio sync diagnostics", {
        firstWordStartMs: firstTiming.startTimeMs,
        firstWord: firstTiming.word,
        lastWordEndMs: lastTiming.endTimeMs,
        lastWord: lastTiming.word,
        audioDurationMs: audioDurationMs > 0 ? audioDurationMs : "unavailable",
        timingSpanMs: lastTiming.endTimeMs - firstTiming.startTimeMs,
        ...(audioDurationMs > 0
          ? { gapAtEndMs: audioDurationMs - lastTiming.endTimeMs }
          : {}),
      });
    }

    logger.info("Speech synthesis complete", {
      audioSizeBytes: audioBuffer.length,
      wordTimingsCount: wordTimings.length,
      timingSource,
      voice,
    });

    return { audioBuffer, wordTimings, audioDurationSeconds };
  }

  private async measureAudioDuration(audioBuffer: Buffer): Promise<number> {
    let duration: number;
    try {
      const input = new Input({
        source: new BufferSource(new Uint8Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength)),
        formats: ALL_FORMATS,
      });
      duration = await input.computeDuration();
    } catch (err) {
      logger.warn("Audio duration measurement failed, falling back to 0", {
        error: err instanceof Error ? err.message : String(err),
        bufferSize: audioBuffer.length,
      });
      return 0;
    }

    if (!duration || duration <= 0) {
      logger.warn("Audio duration probe returned non-positive value, falling back to 0", {
        duration, bufferSize: audioBuffer.length,
      });
      return 0;
    }

    logger.debug("Measured audio duration", { durationSeconds: duration });
    return duration;
  }

  private resolveVoice(suggested?: string): string {
    if (suggested && VALID_VOICES.has(suggested)) return suggested;
    if (suggested) {
      logger.warn("Invalid voice suggestion, using default", { suggested, default: this.defaultVoice ?? DEFAULT_VOICE });
    }
    return this.defaultVoice ?? DEFAULT_VOICE;
  }

  private async synthesizeSpeechWithRetry(
    client: GoogleTextToSpeechClient,
    synthesizeRequest: SynthesizeSpeechRequest,
    context: {
      voice: string;
      wordCount: number;
      textLength: number;
      speakingRate: number;
    },
  ): Promise<SynthesizeSpeechResponse> {
    const { timeoutMs, maxAttempts, baseDelayMs, maxDelayMs } = getTtsRetryConfig();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const [response] = await client.synthesizeSpeech(synthesizeRequest, { timeout: timeoutMs });
        return response;
      } catch (err) {
        lastError = err;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const retryable = isTransientTtsError(err);
        if (!retryable || attempt >= maxAttempts) {
          logger.error("Google TTS synthesizeSpeech failed", {
            voice: context.voice,
            textLength: context.textLength,
            wordCount: context.wordCount,
            speakingRate: context.speakingRate,
            attempt,
            maxAttempts,
            timeoutMs,
            retryable,
            error: errorMessage,
          });
          throw new Error(
            `Speech synthesis failed for voice "${context.voice}" ` +
              `(${context.wordCount} words, rate ${context.speakingRate}) ` +
              `after ${attempt} attempt${attempt === 1 ? "" : "s"} ` +
              `(timeout ${timeoutMs}ms): ${errorMessage}`,
            { cause: err },
          );
        }

        const delayMs = computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
        logger.warn("Google TTS transient failure — retrying with backoff", {
          voice: context.voice,
          textLength: context.textLength,
          wordCount: context.wordCount,
          speakingRate: context.speakingRate,
          attempt,
          maxAttempts,
          nextAttemptInMs: delayMs,
          timeoutMs,
          error: errorMessage.slice(0, 300),
        });
        await sleep(delayMs);
      }
    }

    throw new Error(
      `Speech synthesis failed for voice "${context.voice}" after ${maxAttempts} attempts`,
      { cause: lastError },
    );
  }

  private getClient(): GoogleTextToSpeechClient {
    if (this.client) return this.client;

    const apiKey = process.env.GOOGLE_CLOUD_TTS_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_CLOUD_TTS_KEY environment variable is not set. " +
          "Set it when external TTS is needed (for example non-speaking themes with USE_BUILTIN_TTS=false).",
      );
    }

    this.client ??= new v1beta1.TextToSpeechClient({ apiKey });
    logger.info("GoogleTTSService client initialized");
    return this.client;
  }
}
