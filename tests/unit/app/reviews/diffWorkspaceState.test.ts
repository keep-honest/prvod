import { describe, expect, it } from "vitest";
import type { SceneDiffAnchor } from "@/domain/entities/ReviewDiffSnapshot";
import { findFocusFilePath } from "@/app/reviews/[jobId]/_components/diffWorkspaceState";

const authAnchor: SceneDiffAnchor = {
  anchorId: "anchor-auth",
  sceneNumber: 4,
  filePath: "src/lib/auth.ts",
  startLine: 1,
  endLine: 2,
  precision: "exact",
  lineIds: ["f1-src-lib-auth-ts-1"],
};

describe("findFocusFilePath", () => {
  it("keeps an explicit file selection ahead of the active narration anchor", () => {
    expect(
      findFocusFilePath({
        activeAnchor: authAnchor,
        preferredFilePath: "SECURITY.md",
        availableFilePaths: ["src/lib/auth.ts", "SECURITY.md"],
      }),
    ).toBe("SECURITY.md");
  });

  it("keeps a selected file visible even when it is missing from the diff snapshot", () => {
    expect(
      findFocusFilePath({
        activeAnchor: authAnchor,
        preferredFilePath: "SECURITY.md",
        availableFilePaths: ["src/lib/auth.ts"],
      }),
    ).toBe("SECURITY.md");
  });

  it("falls back to the active anchor when no file has been selected", () => {
    expect(
      findFocusFilePath({
        activeAnchor: authAnchor,
        availableFilePaths: ["src/app/page.tsx", "src/lib/auth.ts"],
      }),
    ).toBe("src/lib/auth.ts");
  });
});
