export type TTSProvider = "google" | "mock";

const VALID_TTS_PROVIDERS = new Set<TTSProvider>(["google", "mock"]);

function getActiveMockFlags(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const flags: string[] = [];

  if (env.USE_MOCK_SERVICES === "true") {
    flags.push("USE_MOCK_SERVICES=true");
  }
  if (env.SCRIPT_WRITER?.trim() === "mock") {
    flags.push("SCRIPT_WRITER=mock");
  }
  if (env.TTS_PROVIDER?.trim() === "mock") {
    flags.push("TTS_PROVIDER=mock");
  }

  return flags;
}

export function assertRuntimeMockConfigurationAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NODE_ENV !== "production") return;

  const activeFlags = getActiveMockFlags(env);
  if (activeFlags.length === 0) return;

  throw new Error(
    `Mock providers are not allowed when NODE_ENV=production: ${activeFlags.join(", ")}`,
  );
}

export function resolveTTSProvider(
  env: Record<string, string | undefined> = process.env,
): TTSProvider {
  const explicit = env.TTS_PROVIDER?.trim();
  if (!explicit) return "google";

  if (VALID_TTS_PROVIDERS.has(explicit as TTSProvider)) {
    return explicit as TTSProvider;
  }

  throw new Error(
    `Invalid TTS_PROVIDER="${explicit}". Must be one of: ${[...VALID_TTS_PROVIDERS].join(", ")}`,
  );
}
