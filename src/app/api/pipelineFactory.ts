import { PipelineRunner } from "@/domain/services/PipelineRunner";
import type { Container } from "@/config/container";
import type { PRContext } from "@/domain/entities/PRContext";
import type { IDiffSource } from "@/interfaces/IDiffSource";
import { LocalFileDiffSource } from "@/infrastructure/diff/LocalFileDiffSource";
import { GitHubFilesDiffSource } from "@/infrastructure/github/GitHubFilesDiffSource";

/**
 * Builds a PipelineRunner from the DI container.
 *
 * Centralises the deps-object wiring that was previously duplicated in
 * jobs/route, retry/route, and webhook/github/route.
 */
export function createPipelineRunner(
  container: Container,
  opts: {
    apiKeyRepository?: boolean;
    githubService?: boolean;
    diffSource?: boolean;
  } = {},
): PipelineRunner {
  // Wire diffSourceFactory when requested. If githubAppTokenService is absent, factory handles
  // local_diff_file only and returns undefined for github_pr (skipping corpus build).
  const diffSourceFactory = opts.diffSource
    ? buildDiffSourceFactory(container)
    : undefined;

  return new PipelineRunner(
    {
      diffAnalyzer: container.diffAnalyzer,
      scriptWriter: container.scriptWriter,
      ttsService: container.ttsService,
      videoCompositor: container.videoCompositor,
      storageService: container.storageService,
      checkpointStore: container.checkpointStore,
      outputValidator: container.outputValidator,
    },
    container.jobRepository,
    opts.apiKeyRepository ? container.apiKeyRepository : undefined,
    opts.githubService ? container.githubService : undefined,
    diffSourceFactory,
    opts.diffSource ? container.oversizedFileProcessor : undefined,
  );
}

function buildDiffSourceFactory(
  container: Container,
): (context: PRContext, installationId: number | undefined) => IDiffSource | undefined {
  return (context: PRContext, installationId: number | undefined): IDiffSource | undefined => {
    if (context.diffSource.kind === "local_diff_file") {
      return new LocalFileDiffSource(context.diffSource.tempPath);
    }

    // github_pr — needs GitHubAppTokenService + installationId; skip silently when unavailable
    if (!container.githubAppTokenService || !installationId) {
      return undefined;
    }

    return new GitHubFilesDiffSource(
      context.repoFullName,
      context.prNumber,
      installationId,
      container.githubAppTokenService,
    );
  };
}
