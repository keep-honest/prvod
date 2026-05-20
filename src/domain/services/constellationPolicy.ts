/**
 * Constellation policy helpers extracted from VideoOrchestrator.
 *
 * These are pure, side-effect-free decisions about when and how to compute
 * the constellation graph layout. Keeping them in their own module makes
 * them trivially testable without needing the full orchestrator harness.
 */

import type { VideoScript } from "@/domain/entities/VideoScript";
import { computeGraphLayout } from "@/infrastructure/video/graph/computeGraphLayout";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import { createLogger } from "@/lib/logger";

const logger = createLogger("constellationPolicy");

/**
 * Reads `VIDEO_COMPOSITOR` from the provided env bag (defaults to
 * `process.env`) to decide whether the Remotion-specific animation suffix
 * (shrink-to-node + edge reveal) should be appended to code-first scene
 * durations. Returns `false` for the default FFmpeg path.
 */
export function shouldInflateForConstellation(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.VIDEO_COMPOSITOR ?? "ffmpeg").toLowerCase() === "remotion";
}

/**
 * Computes the constellation graph layout for the script. Returns
 * `undefined` when no scene has a `codeBroll` entry. Emits distinct log
 * lines for each skip reason so operators can tell expected skips from
 * unexpected empty-node outcomes.
 */
export function computeGraphLayoutIfApplicable(
  script: VideoScript,
): GraphLayoutData | undefined {
  const hasCodeBroll = script.scenes.some((s) => s.codeBroll.length > 0);
  if (!hasCodeBroll) {
    logger.warn(
      "Script has no codeBroll entries; skipping constellation graph",
      { sceneCount: script.scenes.length },
    );
    return undefined;
  }

  const layout = computeGraphLayout(script);
  if (layout.nodes.length === 0) {
    logger.error(
      "Constellation graph produced zero nodes despite codeBroll presence",
      {
        sceneCount: script.scenes.length,
        firstScenePreview: script.scenes[0]?.codeBroll[0]?.filePath ?? null,
      },
    );
    return undefined;
  }

  // Log "revisit" scenes — scenes whose codeBroll file was first introduced
  // by an earlier scene. These render as plain AnimatedCodeCard instead of
  // shrinking into the graph, which is intentional but worth observing.
  const ownerScenes = new Set(layout.nodes.map((n) => n.sceneNumber));
  const revisitScenes = script.scenes.filter(
    (s) => s.codeBroll.length > 0 && !ownerScenes.has(s.sceneNumber),
  );
  if (revisitScenes.length > 0) {
    logger.info(
      "Constellation: scenes will render as revisits (no owned node due to filePath dedup)",
      {
        revisitSceneNumbers: revisitScenes.map((s) => s.sceneNumber),
        revisitFilePaths: revisitScenes.flatMap((s) =>
          s.codeBroll.map((b) => b.filePath),
        ),
      },
    );
  }

  return layout;
}
