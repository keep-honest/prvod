import type {
  ITTSService,
  TTSOptions,
  TTSResult,
  WordTiming,
} from "@/interfaces/ITTSService";
import { sanitizeSpokenNarrationText } from "@/lib/narrationText";
import { computeTtsSpeakingRate } from "@/infrastructure/llm/wordBudget";

export class MockTTSService implements ITTSService {
  lastVoiceName?: string;

  async synthesize(
    text: string,
    voiceName?: string,
    options?: TTSOptions,
  ): Promise<TTSResult> {
    this.lastVoiceName = voiceName;

    const sceneSegments = options?.sceneSegments;
    const allWords = sceneSegments && sceneSegments.length > 0
      ? sceneSegments.flatMap((s) => sanitizeSpokenNarrationText(s.text).split(/\s+/).filter(Boolean))
      : sanitizeSpokenNarrationText(text).split(/\s+/).filter(Boolean);
    const wordCount = allWords.length;

    const rate = computeTtsSpeakingRate(wordCount, options?.targetDurationSeconds);
    const msPerWord = Math.round(400 / rate);

    let currentTimeMs = 0;
    let wordTimings: WordTiming[];

    if (sceneSegments && sceneSegments.length > 0) {
      wordTimings = [];
      for (const segment of sceneSegments) {
        const words = sanitizeSpokenNarrationText(segment.text).split(/\s+/).filter(Boolean);
        for (const word of words) {
          wordTimings.push({
            word,
            startTimeMs: currentTimeMs,
            endTimeMs: currentTimeMs + msPerWord,
          });
          currentTimeMs += msPerWord;
        }

        currentTimeMs += Math.max(0, segment.holdDurationMs ?? 0);
      }
    } else {
      wordTimings = allWords.map((word, i) => ({
        word,
        startTimeMs: i * msPerWord,
        endTimeMs: (i + 1) * msPerWord,
      }));
    }

    const audioBuffer = Buffer.from("MOCK_AUDIO_DATA");
    const lastTiming = wordTimings[wordTimings.length - 1];
    const audioDurationSeconds = lastTiming ? lastTiming.endTimeMs / 1000 : 0;

    return { audioBuffer, wordTimings, audioDurationSeconds };
  }
}
