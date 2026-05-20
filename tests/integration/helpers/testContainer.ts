import type { Container } from "@/config/container";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";
import { LocalCheckpointStore } from "@/infrastructure/persistence/LocalCheckpointStore";
import { MockJobRepository } from "@/mocks/MockJobRepository";
import { MockScriptWriter } from "@/mocks/MockScriptWriter";
import { MockStorageService } from "@/mocks/MockStorageService";
import { MockTTSService } from "@/mocks/MockTTSService";
import { MockVideoCompositor } from "@/mocks/MockVideoCompositor";
import { ReviewPageAssembler } from "@/domain/services/ReviewPageAssembler";
import { MockGitHubService } from "@/mocks/MockGitHubService";
import { MockInstallationRepository } from "@/mocks/MockInstallationRepository";
import { MockApiKeyRepository } from "@/mocks/MockApiKeyRepository";
import { MockDeliveryRepository } from "@/mocks/MockDeliveryRepository";
import { MockInputSanitizer } from "@/mocks/MockInputSanitizer";
import { MockOutputValidator } from "@/mocks/MockOutputValidator";
import { deriveLegacyApiKeyId } from "@/lib/auth";
import type { IApiKeyRepository } from "@/interfaces/IApiKeyRepository";

export function makeTestContainer(): Container {
  const scriptWriter = new MockScriptWriter();
  const storageService = new MockStorageService();
  const jobRepository = new MockJobRepository();

  return {
    diffAnalyzer: new HeuristicDiffAnalyzer(),
    scriptWriter,
    ttsService: new MockTTSService(),
    videoCompositor: new MockVideoCompositor(),
    storageService,
    jobRepository,
    checkpointStore: new LocalCheckpointStore(),
    githubService: new MockGitHubService(),
    installationRepository: new MockInstallationRepository(),
    apiKeyRepository: new MockApiKeyRepository(),
    deliveryRepository: new MockDeliveryRepository(),
    inputSanitizer: new MockInputSanitizer(),
    outputValidator: new MockOutputValidator(),
    reviewPageAssembler: new ReviewPageAssembler(storageService),
  };
}

/**
 * Seed the legacy API_SECRET_KEY into the mock API key repository so that
 * test requests with `Authorization: Bearer <secret>` pass DB-backed auth.
 */
export async function seedTestApiKey(
  apiKeyRepo: IApiKeyRepository,
  secret: string = process.env.API_SECRET_KEY ?? "test-secret",
): Promise<void> {
  const keyId = deriveLegacyApiKeyId(secret);
  const existing = await apiKeyRepo.findByKeyId(keyId);
  if (existing) return;

  const pepper = process.env.APP_ENCRYPTION_KEY ?? "";
  const { hash } = await import("@node-rs/argon2");
  const keyHash = await hash(pepper + secret);
  await apiKeyRepo.create({
    keyId,
    keyHash,
    name: "test-legacy-key",
    isAdmin: true,
    scopes: ["*"],
  });
}
