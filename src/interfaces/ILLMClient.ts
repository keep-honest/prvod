/** Provider-agnostic LLM text completion client. */
export interface ILLMClient {
  complete(system: string, userPrompt: string): Promise<string>;
}
