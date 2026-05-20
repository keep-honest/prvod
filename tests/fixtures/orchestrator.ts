import type { PRContext } from "@/domain/entities/PRContext";
import type { IScriptWriter } from "@/interfaces/IScriptWriter";

/** Standard test diff for auth rate limiting. */
export const TEST_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index abc123..def456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
 export function auth() {
+  checkRateLimit();
   return true;
 }
+function checkRateLimit() {}`;

/** Base PRContext for orchestrator/pipeline tests. */
export const mockContext: PRContext = {
  repoFullName: "owner/repo",
  prNumber: 42,
  prTitle: "Add rate limiting",
  prDescription: "Adds rate limiting to the auth endpoint.",
  diffSource: { kind: "github_pr", repoFullName: "owner/repo", prNumber: 42, installationId: 1 },
  baseBranch: "main",
  headBranch: "feature/rate-limit",
  headSha: "",
  issues: [],
  milestone: null,
  isPrivate: false,
  durationMode: "default" as const,
  deepdive: false,
};

/** Passthrough retimeNarration that keeps the original narration unchanged. */
export const passthroughRetimeNarration: IScriptWriter["retimeNarration"] = async (
  _context,
  _analysis,
  script,
  _sceneBudgets,
  targetSceneNumbers,
) => ({
  scenes: script.scenes
    .filter((scene) => !targetSceneNumbers || targetSceneNumbers.includes(scene.sceneNumber))
    .map((scene) => ({
      sceneNumber: scene.sceneNumber,
      narration: scene.narration,
    })),
});


