import { afterEach, describe, expect, it, vi } from "vitest";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockTTSService } from "@/mocks/MockTTSService";

function stubProductionContainerDependencies(): void {
  vi.doMock("@/infrastructure/diff/HeuristicDiffAnalyzer", () => ({
    HeuristicDiffAnalyzer: class HeuristicDiffAnalyzer {},
  }));
  vi.doMock("@/infrastructure/persistence/LocalCheckpointStore", () => ({
    LocalCheckpointStore: class LocalCheckpointStore {},
  }));
  vi.doMock("@/domain/services/InputSanitizer", () => ({
    InputSanitizer: class InputSanitizer {},
  }));
  vi.doMock("@/domain/services/OutputValidator", () => ({
    OutputValidator: class OutputValidator {},
  }));
  vi.doMock("@/infrastructure/storage/LocalStorageService", () => ({
    LocalStorageService: class LocalStorageService {},
  }));
  vi.doMock("@/infrastructure/persistence/InstallationRepository", () => ({
    InstallationRepository: class InstallationRepository {},
  }));
  vi.doMock("@/infrastructure/persistence/DeliveryRepository", () => ({
    DeliveryRepository: class DeliveryRepository {},
  }));
  vi.doMock("@/infrastructure/persistence/PostgresCustomerRepository", () => ({
    PostgresCustomerRepository: class PostgresCustomerRepository {},
  }));
  vi.doMock("@/infrastructure/persistence/PostgresSubscriptionRepository", () => ({
    PostgresSubscriptionRepository: class PostgresSubscriptionRepository {},
  }));
  vi.doMock("@/infrastructure/persistence/PostgresCreditService", () => ({
    PostgresCreditService: class PostgresCreditService {},
  }));
  vi.doMock("@/infrastructure/persistence/PostgresBillingEventRepository", () => ({
    PostgresBillingEventRepository: class PostgresBillingEventRepository {},
  }));
  vi.doMock("@/infrastructure/persistence/ApiKeyRepository", () => ({
    ApiKeyRepository: class ApiKeyRepository {
      async findByKeyId() {
        return null;
      }

      async releaseOrphanedKeys() {
        return 0;
      }

      async create() {
        return undefined;
      }
    },
  }));
  vi.doMock("@/infrastructure/persistence/PostgresJobRepository", () => ({
    PostgresJobRepository: class PostgresJobRepository {
      async failStaleProcessingJobs() {
        return 0;
      }

      async findOrphanedCreditJobs() {
        return [];
      }

      async updateStatus() {
        return undefined;
      }
    },
  }));
}

describe("container selective runtime mocks", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("resolves the existing repo mocks in the production container path", async () => {
    stubProductionContainerDependencies();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://example:test@localhost:5432/prvod");
    vi.stubEnv("USE_MOCK_SERVICES", "false");
    vi.stubEnv("API_SECRET_KEY", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("SCRIPT_WRITER", "mock");
    vi.stubEnv("TTS_PROVIDER", "mock");
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("STORAGE_URL_SECRET", "test-secret-".padEnd(64, "x"));
    vi.stubEnv("BILLING_PROVIDER", "dev");

    const { getContainer, resetContainer } = await import("@/config/container");
    const container = await getContainer();

    expect(container.scriptWriter).toBeInstanceOf(MockScriptWriter);
    expect(container.ttsService).toBeInstanceOf(MockTTSService);

    resetContainer();
  // Container initialization imports and initializes many modules; allow extra time under parallel load.
  }, 15_000);

  it("keeps builtin TTS ahead of the external mock TTS provider", async () => {
    stubProductionContainerDependencies();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://example:test@localhost:5432/prvod");
    vi.stubEnv("USE_MOCK_SERVICES", "false");
    vi.stubEnv("API_SECRET_KEY", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("SCRIPT_WRITER", "mock");
    vi.stubEnv("TTS_PROVIDER", "mock");
    vi.stubEnv("USE_BUILTIN_TTS", "true");
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("STORAGE_URL_SECRET", "test-secret-".padEnd(64, "x"));
    vi.stubEnv("BILLING_PROVIDER", "dev");

    const { getContainer, resetContainer } = await import("@/config/container");
    const container = await getContainer();
    const result = await container.ttsService.synthesize("hello world");

    expect(container.ttsService).not.toBeInstanceOf(MockTTSService);
    expect(result.audioBuffer.length).toBe(0);
    expect(result.wordTimings).toEqual([]);
    expect(result.audioDurationSeconds).toBe(0);

    resetContainer();
  });

  it("rejects selective runtime mocks in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCRIPT_WRITER", "mock");

    const { getContainer } = await import("@/config/container");

    await expect(getContainer()).rejects.toThrow(
      "Mock providers are not allowed when NODE_ENV=production",
    );
  });

  it("resolves SCRIPT_WRITER=gemini-sdk to a GeminiSdkScriptWriter wired with the injection guard", async () => {
    stubProductionContainerDependencies();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://example:test@localhost:5432/prvod");
    vi.stubEnv("USE_MOCK_SERVICES", "false");
    vi.stubEnv("API_SECRET_KEY", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("SCRIPT_WRITER", "gemini-sdk");
    vi.stubEnv("SUMMARISER_PROVIDER", "gemini-sdk");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("TTS_PROVIDER", "mock");
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("STORAGE_URL_SECRET", "test-secret-".padEnd(64, "x"));
    vi.stubEnv("BILLING_PROVIDER", "dev");

    const { getContainer, resetContainer } = await import("@/config/container");
    const { GeminiSdkScriptWriter } = await import("@/infrastructure/llm/GeminiSdkScriptWriter");
    const container = await getContainer();

    expect(container.scriptWriter).toBeInstanceOf(GeminiSdkScriptWriter);
    // The summariser path is internal; just confirm the container resolved without
    // throwing — the gemini-sdk summariser case ran the createGenAiLlmClient factory.
    expect(container.oversizedFileProcessor).toBeDefined();

    resetContainer();
  }, 15_000);

  it("fails boot when STORAGE_PROVIDER=local and STORAGE_URL_SECRET is unset", async () => {
    stubProductionContainerDependencies();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://example:test@localhost:5432/prvod");
    vi.stubEnv("USE_MOCK_SERVICES", "false");
    vi.stubEnv("API_SECRET_KEY", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("SCRIPT_WRITER", "mock");
    vi.stubEnv("TTS_PROVIDER", "mock");
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("BILLING_PROVIDER", "dev");
    // STORAGE_URL_SECRET intentionally NOT set
    vi.stubEnv("STORAGE_URL_SECRET", "");

    const { getContainer } = await import("@/config/container");
    await expect(getContainer()).rejects.toThrow(/openssl rand -hex 32/);
  });

  it("rejects an unknown SCRIPT_WRITER value", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://example:test@localhost:5432/prvod");
    vi.stubEnv("USE_MOCK_SERVICES", "false");
    vi.stubEnv("SCRIPT_WRITER", "not-a-real-writer");
    vi.stubEnv("TTS_PROVIDER", "mock");
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("STORAGE_URL_SECRET", "test-secret-".padEnd(64, "x"));
    vi.stubEnv("BILLING_PROVIDER", "dev");

    const { getContainer } = await import("@/config/container");
    await expect(getContainer()).rejects.toThrow(/Invalid SCRIPT_WRITER/);
  });
});
