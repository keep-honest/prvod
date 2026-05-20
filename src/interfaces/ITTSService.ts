export interface WordTiming {
  word: string;
  startTimeMs: number;
  endTimeMs: number;
}

export interface TTSResult {
  audioBuffer: Buffer;
  wordTimings: WordTiming[];
  audioDurationSeconds: number;
}

export interface TTSSceneSegment {
  text: string;
  holdDurationMs?: number;
}

export interface TTSOptions {
  sceneSegments?: TTSSceneSegment[];
  targetDurationSeconds?: number;
}

export interface ITTSService {
  synthesize(text: string, voiceName?: string, options?: TTSOptions): Promise<TTSResult>;
}
