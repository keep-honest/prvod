import type {
  IVideoCompositor,
  CompositionInput,
  CompositionResult,
} from "@/interfaces/IVideoCompositor";

export class MockVideoCompositor implements IVideoCompositor {
  async compose(_input: CompositionInput): Promise<CompositionResult> {
    return {
      videoBuffer: Buffer.from("MOCK_VIDEO_DATA"),
    };
  }
}
