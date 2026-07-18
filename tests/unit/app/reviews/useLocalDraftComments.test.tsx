/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewDiffLine, ReviewPin } from "@/domain/entities/ReviewDiffSnapshot";
import { useLocalDraftComments } from "@/app/reviews/[jobId]/useLocalDraftComments";

const samplePin: ReviewPin = {
  pinId: "pin-risk-playback",
  category: "risk",
  sceneNumbers: [3],
  anchorIds: ["anchor-scene-3-page"],
  filePaths: ["src/app/page.tsx"],
  prose: "Replay state can drift out of sync with narration.",
  suggestedComment: "Could this replay handoff drift during seek transitions?",
};

const sampleLine: ReviewDiffLine = {
  lineId: "f0-src-app-page-tsx-5",
  kind: "added",
  oldLineNumber: null,
  newLineNumber: 4,
  text: "  const playback = useReviewPlayback(reviewPage);",
  position: 5,
};

let latestHook: ReturnType<typeof useLocalDraftComments> | null = null;

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function Harness(props: {
  reviewerKey: string | null;
}) {
  latestHook = useLocalDraftComments({
    jobId: "job-123",
    reviewerKey: props.reviewerKey,
  });
  return null;
}

describe("useLocalDraftComments", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  afterEach(() => {
    latestHook = null;
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  it("persists saved local comment threads across remounts", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey="octocat" />);
    });

    expect(latestHook?.drafts).toEqual([]);

    await act(async () => {
      latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: samplePin.anchorIds,
        pinIds: [samplePin.pinId],
        body: "Please add a regression test for replay drift.",
      });
    });

    expect(latestHook?.drafts).toHaveLength(1);
    expect(latestHook?.drafts[0]?.body).toBe("Please add a regression test for replay drift.");
    expect(latestHook?.drafts[0]?.position).toBe(5);
    expect(latestHook?.drafts[0]?.source).toBe("manual");
    expect(latestHook?.drafts[0]?.startLineId).toBe(sampleLine.lineId);

    await act(async () => {
      root.unmount();
    });

    latestHook = null;
    const remountRoot = createRoot(container);
    await act(async () => {
      remountRoot.render(<Harness reviewerKey="octocat" />);
    });

    if (!latestHook) {
      throw new Error("Hook did not remount");
    }

    const remountedHook = latestHook as unknown as {
      drafts: Array<{ pinIds: string[]; body: string; source: string; lineIds: string[] }>;
    };
    expect(remountedHook.drafts).toHaveLength(1);
    expect(remountedHook.drafts[0]?.pinIds).toEqual([samplePin.pinId]);
    expect(remountedHook.drafts[0]?.body).toBe("Please add a regression test for replay drift.");
    expect(remountedHook.drafts[0]?.source).toBe("manual");
    expect(remountedHook.drafts[0]?.lineIds).toEqual([sampleLine.lineId]);
  });

  it("does not save a local thread without a reviewer identity", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey={null} />);
    });

    let savedThreadId: string | null | undefined;
    await act(async () => {
      savedThreadId = latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Manual comment.",
      });
    });

    expect(savedThreadId).toBeNull();
    expect(latestHook?.drafts).toEqual([]);
  });

  it("removes discarded local threads from persisted state", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey="octocat" />);
    });

    let savedThreadId: string | null | undefined;
    await act(async () => {
      savedThreadId = latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Delete this local comment.",
      });
    });

    expect(savedThreadId).toBeTruthy();
    expect(latestHook?.drafts).toHaveLength(1);

    await act(async () => {
      latestHook?.discardThread(savedThreadId ?? "");
    });

    expect(latestHook?.drafts).toEqual([]);

    await act(async () => {
      root.unmount();
    });

    latestHook = null;
    const remountRoot = createRoot(container);
    await act(async () => {
      remountRoot.render(<Harness reviewerKey="octocat" />);
    });

    if (!latestHook) {
      throw new Error("Hook did not remount");
    }

    const remountedHook = latestHook as unknown as {
      drafts: Array<{ body: string }>;
    };
    expect(remountedHook.drafts).toEqual([]);
  });

  it("rehydrates an orphan pending review marker from localStorage on remount", async () => {
    // Issue 2: orphanPendingReviewId must survive a refresh/remount,
    // otherwise submit re-enables itself with a stale remote pending review.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey="octocat" />);
    });

    let savedThreadId: string | null | undefined;
    await act(async () => {
      savedThreadId = latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Synced then deleted across remount.",
      });
    });

    const localDraftId = latestHook?.drafts[0]?.localDraftId ?? "";
    await act(async () => {
      latestHook?.markSynced([localDraftId], 7777);
    });
    await act(async () => {
      latestHook?.discardThread(savedThreadId ?? "");
    });

    expect(latestHook?.orphanPendingReviewId).toBe(7777);

    await act(async () => {
      root.unmount();
    });

    latestHook = null;
    const remountRoot = createRoot(container);
    await act(async () => {
      remountRoot.render(<Harness reviewerKey="octocat" />);
    });

    if (!latestHook) {
      throw new Error("Hook did not remount");
    }

    // TypeScript still narrows `latestHook` to `never` here because the
    // explicit `latestHook = null` assignment above out-narrows the
    // post-guard inference. Mirror the cast pattern used by the earlier
    // remount test in this file.
    const remountedHook = latestHook as unknown as {
      orphanPendingReviewId: number | null;
    };
    expect(remountedHook.orphanPendingReviewId).toBe(7777);
  });

  it("clears orphan and pendingReviewId references when the orphan is discarded on GitHub", async () => {
    // Issue 1 server response: when the resync deletes the orphan rather
    // than recreating it (drafts: [] + pendingReviewId), the hook must drop
    // the orphan marker and any stale pendingReviewId references.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey="octocat" />);
    });

    let savedThreadId: string | null | undefined;
    await act(async () => {
      savedThreadId = latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Synced and orphaned.",
      });
    });

    const localDraftId = latestHook?.drafts[0]?.localDraftId ?? "";
    await act(async () => {
      latestHook?.markSynced([localDraftId], 5555);
    });
    await act(async () => {
      latestHook?.discardThread(savedThreadId ?? "");
    });

    expect(latestHook?.orphanPendingReviewId).toBe(5555);

    await act(async () => {
      latestHook?.markPendingReviewDiscarded(5555);
    });

    expect(latestHook?.orphanPendingReviewId).toBeNull();
    expect(latestHook?.latestPendingReviewId).toBeNull();
  });

  it("flags an orphan pending review when a synced draft is edited then discarded (status reset to local)", async () => {
    // Regression test: editing a synced draft via saveThread resets its
    // status to "local" while preserving pendingReviewId. Discarding it
    // must still mark the remote pending review as orphan — otherwise the
    // UI would have zero drafts and no orphan marker, leaving the GitHub
    // pending review with the deleted comment and no way to clean it up.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey="octocat" />);
    });

    let savedThreadId: string | null | undefined;
    await act(async () => {
      savedThreadId = latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Synced, edited, then deleted.",
      });
    });

    const localDraftId = latestHook?.drafts[0]?.localDraftId ?? "";
    await act(async () => {
      latestHook?.markSynced([localDraftId], 9101);
    });

    expect(latestHook?.drafts[0]?.status).toBe("synced");
    expect(latestHook?.drafts[0]?.pendingReviewId).toBe(9101);

    // Edit the synced draft — saveThread resets status to "local" and
    // preserves pendingReviewId.
    await act(async () => {
      latestHook?.saveThread({
        threadId: savedThreadId ?? undefined,
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Edited body.",
      });
    });

    expect(latestHook?.drafts[0]?.status).toBe("local");
    expect(latestHook?.drafts[0]?.pendingReviewId).toBe(9101);

    // Discard the edited draft.
    await act(async () => {
      latestHook?.discardThread(savedThreadId ?? "");
    });

    // Without the fix, orphanPendingReviewId would stay null and the UI
    // would have no signal to clean up GitHub pending review 9101.
    expect(latestHook?.drafts).toEqual([]);
    expect(latestHook?.orphanPendingReviewId).toBe(9101);
  });

  it("does not flag an orphan when a submitted draft is discarded", async () => {
    // Submitted drafts carry their pendingReviewId, but the remote review
    // is no longer pending — it was converted to an actual review. Marking
    // it as orphan would surface a stale "discard-only sync" prompt for a
    // review that doesn't exist anymore.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey="octocat" />);
    });

    let savedThreadId: string | null | undefined;
    await act(async () => {
      savedThreadId = latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Synced and submitted.",
      });
    });

    const localDraftId = latestHook?.drafts[0]?.localDraftId ?? "";
    await act(async () => {
      latestHook?.markSynced([localDraftId], 9201);
    });
    await act(async () => {
      latestHook?.markSubmitted(9201);
    });

    // Submitted drafts are filtered out of the exposed `drafts` array
    // (see activeDrafts), so the discard call below operates on the raw
    // internal state via threadId.
    expect(latestHook?.drafts).toEqual([]);

    await act(async () => {
      latestHook?.discardThread(savedThreadId ?? "");
    });

    expect(latestHook?.orphanPendingReviewId).toBeNull();
  });

  it("flags an orphan pending review when a synced draft is discarded and clears it on resync", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness reviewerKey="octocat" />);
    });

    let savedThreadId: string | null | undefined;
    await act(async () => {
      savedThreadId = latestHook?.saveThread({
        source: "manual",
        kind: "line",
        filePath: "src/app/page.tsx",
        startLine: sampleLine,
        lineIds: [sampleLine.lineId],
        anchorIds: [],
        pinIds: [],
        body: "Synced and then deleted.",
      });
    });

    const localDraftId = latestHook?.drafts[0]?.localDraftId ?? "";
    await act(async () => {
      latestHook?.markSynced([localDraftId], 9001);
    });

    expect(latestHook?.latestPendingReviewId).toBe(9001);
    expect(latestHook?.orphanPendingReviewId).toBeNull();

    await act(async () => {
      latestHook?.discardThread(savedThreadId ?? "");
    });

    // Discarding a synced draft must mark the remote pending review as
    // orphaned so the UI can block submit until the next sync recreates it.
    expect(latestHook?.drafts).toEqual([]);
    expect(latestHook?.orphanPendingReviewId).toBe(9001);

    await act(async () => {
      latestHook?.markSynced([], 9002);
    });

    expect(latestHook?.orphanPendingReviewId).toBeNull();
  });
});
