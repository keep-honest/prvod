import { createLogger } from "@/lib/logger";
import type { IDiffAnalyzer } from "@/interfaces/IDiffAnalyzer";
import type { IScriptWriter } from "@/interfaces/IScriptWriter";
import type { ITTSService } from "@/interfaces/ITTSService";
import type { ILLMClient } from "@/interfaces/ILLMClient";
import type { IVideoCompositor } from "@/interfaces/IVideoCompositor";
import type { IStorageService } from "@/interfaces/IStorageService";
import type { IJobRepository } from "@/interfaces/IJobRepository";
import type { IPipelineCheckpointStore } from "@/interfaces/IPipelineCheckpoint";
import {
  assertRuntimeMockConfigurationAllowed,
  resolveTTSProvider,
} from "@/config/runtimeMocks";
import type { IGitHubService } from "@/interfaces/IGitHubService";
import type { IInstallationRepository } from "@/interfaces/IInstallationRepository";
import type { IApiKeyRepository } from "@/interfaces/IApiKeyRepository";
import type { IDeliveryRepository } from "@/interfaces/IDeliveryRepository";
import type { GitHubAppTokenService } from "@/infrastructure/github/GitHubAppTokenService";
import { deriveLegacyApiKeyId } from "@/lib/auth";
import type { IInputSanitizer, IOutputValidator } from "@/interfaces/IPromptInjectionGuard";
import { ReviewPageAssembler } from "@/domain/services/ReviewPageAssembler";
import type { OversizedFileProcessor } from "@/domain/services/OversizedFileProcessor";

export interface Container {
  diffAnalyzer: IDiffAnalyzer;
  scriptWriter: IScriptWriter;
  ttsService: ITTSService;
  videoCompositor: IVideoCompositor;
  storageService: IStorageService;
  jobRepository: IJobRepository;
  checkpointStore: IPipelineCheckpointStore;
  githubService: IGitHubService;
  installationRepository: IInstallationRepository;
  apiKeyRepository: IApiKeyRepository;
  deliveryRepository: IDeliveryRepository;
  githubAppTokenService?: GitHubAppTokenService;
  inputSanitizer: IInputSanitizer;
  outputValidator: IOutputValidator;
  reviewPageAssembler?: ReviewPageAssembler;
  oversizedFileProcessor?: OversizedFileProcessor;
}

let container: Container | null = null;

export async function getContainer(): Promise<Container> {
  if (container) return container;

  const isTestEnv = process.env.NODE_ENV === "test";
  const useMockServices = process.env.USE_MOCK_SERVICES === "true";
  assertRuntimeMockConfigurationAllowed(process.env);

  if (isTestEnv || useMockServices) {
    container = createMockContainer();
  } else {
    container = await createProductionContainer();
  }

  return container;
}

function createMockContainer(): Container {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockScriptWriter } = require("@/mocks/MockScriptWriter");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockVideoCompositor } = require("@/mocks/MockVideoCompositor");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockTTSService } = require("@/mocks/MockTTSService");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockStorageService } = require("@/mocks/MockStorageService");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockJobRepository } = require("@/mocks/MockJobRepository");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { HeuristicDiffAnalyzer } = require("@/infrastructure/diff/HeuristicDiffAnalyzer");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LocalCheckpointStore } = require("@/infrastructure/persistence/LocalCheckpointStore");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockGitHubService } = require("@/mocks/MockGitHubService");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockInstallationRepository } = require("@/mocks/MockInstallationRepository");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockApiKeyRepository } = require("@/mocks/MockApiKeyRepository");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockDeliveryRepository } = require("@/mocks/MockDeliveryRepository");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockInputSanitizer } = require("@/mocks/MockInputSanitizer");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockOutputValidator } = require("@/mocks/MockOutputValidator");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockRollingSummariser } = require("@/infrastructure/llm/oversizedFileSummariser");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OversizedFileProcessor } = require("@/domain/services/OversizedFileProcessor");

  const storageService = new MockStorageService();

  return {
    diffAnalyzer: new HeuristicDiffAnalyzer(),
    scriptWriter: new MockScriptWriter(),
    ttsService: new MockTTSService(),
    videoCompositor: new MockVideoCompositor(),
    storageService,
    jobRepository: new MockJobRepository(),
    checkpointStore: new LocalCheckpointStore(),
    githubService: new MockGitHubService(),
    installationRepository: new MockInstallationRepository(),
    apiKeyRepository: new MockApiKeyRepository(),
    deliveryRepository: new MockDeliveryRepository(),
    inputSanitizer: new MockInputSanitizer(),
    outputValidator: new MockOutputValidator(),
    reviewPageAssembler: new ReviewPageAssembler(storageService),
    oversizedFileProcessor: new OversizedFileProcessor(new MockRollingSummariser()),
  };
}

function createDisabledGitHubService(message: string): IGitHubService {
  return {
    async fetchPRContext() {
      throw new Error(message);
    },
    async fetchRepositoryFiles() {
      throw new Error(message);
    },
    async postComment() {
      throw new Error(message);
    },
  };
}

type ScriptWriterType = "claude-sdk" | "claude-cli" | "gemini-sdk" | "gemini-cli" | "codex-cli" | "mock";

const VALID_SCRIPT_WRITERS = new Set<ScriptWriterType>(["claude-sdk", "claude-cli", "gemini-sdk", "gemini-cli", "codex-cli", "mock"]);

function resolveScriptWriterType(): ScriptWriterType {
  const explicit = process.env.SCRIPT_WRITER;
  if (explicit) {
    if (VALID_SCRIPT_WRITERS.has(explicit as ScriptWriterType)) {
      return explicit as ScriptWriterType;
    }
    throw new Error(
      `Invalid SCRIPT_WRITER="${explicit}". Must be one of: ${[...VALID_SCRIPT_WRITERS].join(", ")}`,
    );
  }
  if (process.env.USE_CLAUDE_CLI === "true") return "claude-cli";
  return "claude-sdk";
}

type SummariserType = "claude-sdk" | "claude-cli" | "gemini-sdk" | "gemini-cli" | "codex-cli" | "mock";

const VALID_SUMMARISER_TYPES = new Set<SummariserType>(["claude-sdk", "claude-cli", "gemini-sdk", "gemini-cli", "codex-cli", "mock"]);

function resolveSummariserType(): SummariserType {
  const explicit = process.env.SUMMARISER_PROVIDER;
  if (explicit) {
    if (VALID_SUMMARISER_TYPES.has(explicit as SummariserType)) {
      return explicit as SummariserType;
    }
    throw new Error(
      `Invalid SUMMARISER_PROVIDER="${explicit}". Must be one of: ${[...VALID_SUMMARISER_TYPES].join(", ")}`,
    );
  }
  return resolveScriptWriterType();
}

/**
 * Valid scene durations (seconds). Constrains LLM output and clip cover calculations.
 */
export const VALID_SCENE_DURATIONS: readonly number[] = [4, 6, 8];

async function seedLegacyApiSecretKey(
  apiKeyRepository: IApiKeyRepository,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const legacySecret = process.env.API_SECRET_KEY;
  if (!legacySecret) return;

  const keyId = deriveLegacyApiKeyId(legacySecret);
  const existing = await apiKeyRepository.findByKeyId(keyId);
  if (existing) {
    logger.info("Legacy API_SECRET_KEY already present in api_keys", { keyId, status: existing.status });
    return;
  }

  const pepper = process.env.APP_ENCRYPTION_KEY ?? "";
  if (!pepper) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ENCRYPTION_KEY must be set in production");
    }
    logger.warn("APP_ENCRYPTION_KEY is not set while seeding legacy API key");
  }

  const { hash } = await import("@node-rs/argon2");
  const keyHash = await hash(pepper + legacySecret);
  await apiKeyRepository.create({
    keyId,
    keyHash,
    name: "legacy API_SECRET_KEY",
    isAdmin: true,
    scopes: ["*"],
  });
  logger.warn("Seeded legacy API_SECRET_KEY into api_keys", { keyId });
}

async function createProductionContainer(): Promise<Container> {
  const logger = createLogger("container");
  assertRuntimeMockConfigurationAllowed(process.env);
  const { HeuristicDiffAnalyzer } = await import("@/infrastructure/diff/HeuristicDiffAnalyzer");
  const { PostgresJobRepository } = await import("@/infrastructure/persistence/PostgresJobRepository");
  const { LocalCheckpointStore } = await import("@/infrastructure/persistence/LocalCheckpointStore");
  const { InputSanitizer } = await import("@/domain/services/InputSanitizer");
  const { OutputValidator } = await import("@/domain/services/OutputValidator");
  const inputSanitizer = new InputSanitizer();
  const outputValidator = new OutputValidator();

  type CompositorType = "ffmpeg" | "remotion";
  const VALID_COMPOSITORS = new Set<CompositorType>(["ffmpeg", "remotion"]);
  const rawCompositor = (process.env.VIDEO_COMPOSITOR ?? "ffmpeg") as CompositorType;
  if (!VALID_COMPOSITORS.has(rawCompositor)) {
    throw new Error(
      `Invalid VIDEO_COMPOSITOR="${rawCompositor}". Must be one of: ${[...VALID_COMPOSITORS].join(", ")}`,
    );
  }
  let videoCompositor: IVideoCompositor;
  if (rawCompositor === "remotion") {
    try {
      const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
      videoCompositor = new RemotionCompositor();
    } catch (err) {
      throw new Error(
        `VIDEO_COMPOSITOR=remotion but Remotion packages are not installed. ` +
        `If this is a Docker image, rebuild with: docker build --build-arg VIDEO_COMPOSITOR=remotion .`,
        { cause: err },
      );
    }
  } else {
    const { FFmpegCompositor } = await import("@/infrastructure/video/FFmpegCompositor");
    videoCompositor = new FFmpegCompositor();
  }
  logger.info("videoCompositor resolved", { compositor: rawCompositor });

  const writerType = resolveScriptWriterType();
  let llmClient!: ILLMClient;
  let createAnthropicLlmClient: (maxTokens: number) => ILLMClient = () => llmClient;
  let createScriptWriter: (validDurations: readonly number[]) => IScriptWriter;
  switch (writerType) {
    case "mock": {
      const { MockScriptWriter } = await import("@/mocks/MockScriptWriter");
      createScriptWriter = () => new MockScriptWriter();
      break;
    }
    case "claude-cli": {
      logger.warn("SCRIPT_WRITER=claude-cli: prompt injection input sanitization and output validation are not available for CLI-based script writers");
      const { CliScriptWriter } = await import("@/infrastructure/llm/CliScriptWriter");
      createScriptWriter = (validDurations) => new CliScriptWriter(validDurations);
      const { createClaudeCliLlmClient } = await import("@/infrastructure/llm/cliLlmClient");
      llmClient = createClaudeCliLlmClient();
      break;
    }
    case "gemini-cli": {
      logger.warn("SCRIPT_WRITER=gemini-cli: prompt injection input sanitization and output validation are not available for CLI-based script writers");
      const { GeminiCliScriptWriter } = await import("@/infrastructure/llm/GeminiCliScriptWriter");
      createScriptWriter = (validDurations) => new GeminiCliScriptWriter(validDurations);
      const { createGeminiCliLlmClient } = await import("@/infrastructure/llm/cliLlmClient");
      llmClient = createGeminiCliLlmClient();
      break;
    }
    case "codex-cli": {
      logger.warn("SCRIPT_WRITER=codex-cli: prompt injection input sanitization and output validation are not available for CLI-based script writers");
      const { CodexCliScriptWriter } = await import("@/infrastructure/llm/CodexCliScriptWriter");
      createScriptWriter = (validDurations) => new CodexCliScriptWriter(validDurations);
      const { createCodexCliLlmClient } = await import("@/infrastructure/llm/cliLlmClient");
      llmClient = createCodexCliLlmClient();
      break;
    }
    case "gemini-sdk": {
      const { getGoogleGenAI, createGenAiLlmClient } = await import("@/infrastructure/llm/genaiClient");
      const genAiClient = getGoogleGenAI();
      const { GeminiSdkScriptWriter } = await import("@/infrastructure/llm/GeminiSdkScriptWriter");
      createScriptWriter = (validDurations) =>
        new GeminiSdkScriptWriter(genAiClient, validDurations, outputValidator, inputSanitizer);
      llmClient = createGenAiLlmClient({
        model: process.env.GEMINI_MODEL ?? "gemini-2.5-pro",
        label: "genai.sdk.llmClient",
        client: genAiClient,
      });
      break;
    }
    case "claude-sdk": {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const anthropicClient = new Anthropic();
      const anthropicModel = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514";
      const { ClaudeScriptWriter } = await import("@/infrastructure/llm/ClaudeScriptWriter");
      createScriptWriter = (validDurations) =>
        new ClaudeScriptWriter(anthropicClient, validDurations, outputValidator, inputSanitizer);
      const { retryLlmCall } = await import("@/infrastructure/llm/retryLlmCall");
      createAnthropicLlmClient = (maxTokens: number): ILLMClient => ({
        complete: async (system, userPrompt) => {
          const response = await retryLlmCall(
            () => anthropicClient.messages.create({
              model: anthropicModel,
              max_tokens: maxTokens,
              system,
              messages: [{ role: "user", content: userPrompt }],
            }),
            { label: `anthropic.llmClient.maxTokens=${maxTokens}` },
          );
          const block = response.content[0];
          if (block?.type !== "text") {
            throw new Error(
              `Anthropic API returned non-text content block (type=${block?.type ?? "empty"}, count=${response.content.length})`,
            );
          }
          return block.text;
        },
      });
      llmClient = createAnthropicLlmClient(1024);
      break;
    }
  }
  const scriptWriter = createScriptWriter(VALID_SCENE_DURATIONS);
  logger.info("script writer resolved", {
    writerType,
    durations: [...VALID_SCENE_DURATIONS],
  });

  type StorageProvider = "local" | "r2" | "s3";
  const VALID_STORAGE_PROVIDERS = new Set<StorageProvider>(["local", "r2", "s3"]);
  let rawStorageProvider: string;
  if (process.env.USE_LOCAL_STORAGE === "true") {
    rawStorageProvider = "local";
    if (process.env.STORAGE_PROVIDER && process.env.STORAGE_PROVIDER !== "local") {
      logger.warn("USE_LOCAL_STORAGE=true overrides STORAGE_PROVIDER — set STORAGE_PROVIDER=local to silence this warning", {
        ignoredStorageProvider: process.env.STORAGE_PROVIDER,
      });
    }
  } else {
    rawStorageProvider = process.env.STORAGE_PROVIDER ?? "r2";
  }
  if (!VALID_STORAGE_PROVIDERS.has(rawStorageProvider as StorageProvider)) {
    throw new Error(
      `Invalid STORAGE_PROVIDER="${rawStorageProvider}". Must be one of: ${[...VALID_STORAGE_PROVIDERS].join(", ")}`,
    );
  }
  const storageProvider = rawStorageProvider as StorageProvider;
  let storageService: IStorageService;
  switch (storageProvider) {
    case "local": {
      // Fail loudly at boot if the HMAC secret is missing, rather than
      // per-request when an asset URL is first minted. The signed-URL
      // contract is the only thing standing between leaked URLs and
      // indefinite access — refuse to start without it.
      const { readStorageUrlSecret } = await import("@/lib/storage/signLocalUrl");
      readStorageUrlSecret();
      const { LocalStorageService } = await import("@/infrastructure/storage/LocalStorageService");
      storageService = new LocalStorageService();
      break;
    }
    case "s3": {
      const { S3StorageService } = await import("@/infrastructure/storage/S3StorageService");
      storageService = new S3StorageService();
      break;
    }
    case "r2": {
      const { R2StorageService } = await import("@/infrastructure/storage/R2StorageService");
      storageService = new R2StorageService();
      break;
    }
  }
  logger.info("storageService resolved", { storageProvider });

  const useBuiltinTTS = process.env.USE_BUILTIN_TTS === "true";
  const ttsProvider = useBuiltinTTS ? null : resolveTTSProvider(process.env);
  let ttsService: ITTSService;
  if (useBuiltinTTS) {
    ttsService = {
      synthesize: async () => ({ audioBuffer: Buffer.alloc(0), wordTimings: [], audioDurationSeconds: 0 }),
    };
  } else if (ttsProvider === "mock") {
    const { MockTTSService } = await import("@/mocks/MockTTSService");
    ttsService = new MockTTSService();
  } else {
    const { GoogleTTSService } = await import("@/infrastructure/tts/GoogleTTSService");
    ttsService = new GoogleTTSService();
  }
  logger.info("ttsService resolved", {
    ttsService:
      useBuiltinTTS
        ? "NoopTTS"
        : ttsProvider === "mock"
          ? "MockTTSService"
          : "GoogleTTSService",
  });

  let githubService: IGitHubService;
  let githubAppTokenService: GitHubAppTokenService | undefined;
  if (process.env.GITHUB_APP_ID) {
    if (!process.env.GITHUB_APP_PRIVATE_KEY) {
      throw new Error("GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY is missing");
    }
    const { GitHubAppTokenService: AppTokenSvc } = await import("@/infrastructure/github/GitHubAppTokenService");
    const { AppGitHubService } = await import("@/infrastructure/github/AppGitHubService");
    githubAppTokenService = new AppTokenSvc();
    githubService = new AppGitHubService(githubAppTokenService);
    logger.info("GitHub auth mode: app");
  } else if (process.env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is set but GITHUB_APP_ID is missing");
  } else if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY for GitHub App mode",
    );
  } else {
    githubService = createDisabledGitHubService(
      "GitHub integration is not configured. Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY.",
    );
    logger.warn("GitHub integration disabled in non-production because no credentials are configured");
  }

  const { InstallationRepository } = await import("@/infrastructure/persistence/InstallationRepository");
  const { ApiKeyRepository } = await import("@/infrastructure/persistence/ApiKeyRepository");
  const { DeliveryRepository } = await import("@/infrastructure/persistence/DeliveryRepository");

  const installationRepository = new InstallationRepository();
  const apiKeyRepository = new ApiKeyRepository();
  const deliveryRepository = new DeliveryRepository();

  try {
    await seedLegacyApiSecretKey(apiKeyRepository, logger);
  } catch (err) {
    throw new Error(
      `Failed to seed legacy API key during container initialization: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const jobRepository = new PostgresJobRepository();
  const reviewPageAssembler = new ReviewPageAssembler(storageService);

  const summariserType = resolveSummariserType();
  let oversizedFileProcessor: OversizedFileProcessor | undefined;
  {
    const { OversizedFileProcessor: Processor } = await import("@/domain/services/OversizedFileProcessor");
    const { createCliLlmClient } = await import("@/infrastructure/llm/cliLlmClient");
    const {
      AnthropicRollingSummariser,
      CliRollingSummariser,
      MockRollingSummariser,
    } = await import("@/infrastructure/llm/oversizedFileSummariser");

    let summariserModel: string;
    switch (summariserType) {
      case "mock": {
        oversizedFileProcessor = new Processor(new MockRollingSummariser());
        summariserModel = "mock";
        break;
      }
      case "claude-sdk": {
        summariserModel = process.env.CLAUDE_SUMMARISER_MODEL ?? "claude-haiku-4-5-20251001";
        oversizedFileProcessor = new Processor(new AnthropicRollingSummariser());
        break;
      }
      case "claude-cli": {
        summariserModel = process.env.CLAUDE_SUMMARISER_MODEL ?? "claude-haiku-4-5-20251001";
        const claudeSummariserClient = createCliLlmClient({
          command: "claude",
          label: "claude.cli.summariser",
          resolveModel: () => process.env.CLAUDE_SUMMARISER_MODEL ?? "claude-haiku-4-5-20251001",
          buildArgs: (model) => ["-p", "--model", model, "--output-format", "text"],
          stdinInput: (prompt) => prompt,
          env: () => { const e = { ...process.env }; delete e.CLAUDECODE; return e; },
        });
        oversizedFileProcessor = new Processor(new CliRollingSummariser(claudeSummariserClient));
        break;
      }
      case "gemini-sdk": {
        summariserModel = process.env.GEMINI_SUMMARISER_MODEL ?? "gemini-2.5-flash";
        const { createGenAiLlmClient } = await import("@/infrastructure/llm/genaiClient");
        const { resolveGeminiSummariserMaxTokens } = await import(
          "@/infrastructure/llm/geminiSummariserConfig"
        );
        const genAiSummariserClient = createGenAiLlmClient({
          model: summariserModel,
          label: "genai.sdk.summariser",
          maxTokens: resolveGeminiSummariserMaxTokens(),
          thinkingBudget: 0,
        });
        oversizedFileProcessor = new Processor(new CliRollingSummariser(genAiSummariserClient));
        break;
      }
      case "gemini-cli": {
        summariserModel = process.env.GEMINI_SUMMARISER_MODEL ?? "gemini-2.5-flash";
        const geminiSummariserClient = createCliLlmClient({
          command: "gemini",
          label: "gemini.cli.summariser",
          resolveModel: () => process.env.GEMINI_SUMMARISER_MODEL ?? "gemini-2.5-flash",
          buildArgs: (model) => ["-m", model, "--output-format", "text"],
          stdinInput: (prompt) => prompt,
        });
        oversizedFileProcessor = new Processor(new CliRollingSummariser(geminiSummariserClient));
        break;
      }
      case "codex-cli": {
        summariserModel = process.env.CODEX_SUMMARISER_MODEL ?? "o4-mini";
        const codexSummariserClient = createCliLlmClient({
          command: "codex",
          label: "codex.cli.summariser",
          resolveModel: () => process.env.CODEX_SUMMARISER_MODEL ?? "o4-mini",
          buildArgs: (model, prompt) => [
            "exec", "--sandbox", "read-only",
            "-c", `model="${model}"`,
            "--model", model,
            prompt,
          ],
          stdinInput: () => null,
        });
        oversizedFileProcessor = new Processor(new CliRollingSummariser(codexSummariserClient));
        break;
      }
      default: {
        const exhaustive: never = summariserType;
        throw new Error(`Unhandled SUMMARISER_PROVIDER="${exhaustive}"`);
      }
    }
    logger.info("oversizedFileSummariser resolved", { summariserType, summariserModel });
  }

  try {
    const STARTUP_STALE_THRESHOLD_MINUTES = 30;
    const reaped = await jobRepository.failStaleProcessingJobs(STARTUP_STALE_THRESHOLD_MINUTES);
    if (reaped > 0) {
      logger.warn("Reaped stale processing jobs on startup", { count: reaped });
    }
  } catch (err) {
    logger.error("Failed to reap stale processing jobs on startup", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const releasedKeys = await apiKeyRepository.releaseOrphanedKeys();
    if (releasedKeys > 0) {
      logger.warn("Released orphaned one-time keys on startup", { count: releasedKeys });
    }
  } catch (err) {
    logger.error("Failed to release orphaned one-time keys on startup", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    diffAnalyzer: new HeuristicDiffAnalyzer(),
    scriptWriter,
    ttsService,
    videoCompositor,
    storageService,
    jobRepository,
    checkpointStore: new LocalCheckpointStore(),
    githubService,
    githubAppTokenService,
    installationRepository,
    apiKeyRepository,
    deliveryRepository,
    inputSanitizer,
    outputValidator,
    reviewPageAssembler,
    oversizedFileProcessor,
  };
}

/** Reset the container (for testing) */
export function resetContainer(): void {
  container = null;
}

/** Override the container (for testing with custom mocks) */
export function setContainer(custom: Container): void {
  container = custom;
}
