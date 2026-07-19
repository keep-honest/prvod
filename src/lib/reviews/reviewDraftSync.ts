import { z } from "zod";
import type { ReviewPageModel } from "@/domain/entities/ReviewPage";
import { findDiffLineById } from "./reviewDiffSnapshot";

export interface LocalDraftCommentInput {
  localDraftId: string;
  body: string;
  anchorIds: string[];
  pinIds: string[];
  filePath?: string | null;
  lineId?: string | null;
  position?: number | null;
}

export interface SyncDraftCommentsRequest {
  drafts: LocalDraftCommentInput[];
  pendingReviewId?: number | null;
}

const localDraftCommentInputSchema = z.object({
  localDraftId: z.string(),
  body: z.string(),
  anchorIds: z.array(z.string()).default([]),
  pinIds: z.array(z.string()).default([]),
  filePath: z.string().nullish(),
  lineId: z.string().nullish(),
  position: z.number().int().positive().nullish(),
});

export const syncDraftCommentsRequestSchema = z.object({
  drafts: z.array(localDraftCommentInputSchema).default([]),
  pendingReviewId: z.number().int().positive().nullish(),
});

export const submitDraftCommentsRequestSchema = z.object({
  pendingReviewId: z.number().int().positive(),
  body: z.string().optional(),
});

export interface SyncDraftCommentsResponse {
  // null when the request discarded an orphaned remote pending review and did
  // not create a replacement (drafts: [] + pendingReviewId provided).
  pendingReviewId: number | null;
  commentCount: number;
  syncedDraftIds: string[];
  /**
   * Drafts the server could not map to a diff position (overview-precision
   * anchors, or lines missing from the captured snapshot). They were NOT sent
   * to GitHub — the client must surface them distinctly instead of leaving
   * them looking merely "local".
   */
  skippedDraftIds?: string[];
  discardedPendingReviewId?: number | null;
}

export interface SubmitDraftCommentsRequest {
  pendingReviewId: number;
  body?: string;
}

export interface SubmitDraftCommentsResponse {
  submittedReviewId: number;
}

export function buildGitHubDraftComments(
  reviewPage: ReviewPageModel,
  drafts: LocalDraftCommentInput[],
): Array<{ localDraftId: string; path: string; position: number; body: string }> {
  const anchorsById = new Map(reviewPage.sceneAnchors.map((anchor) => [anchor.anchorId, anchor] as const));
  const result: Array<{ localDraftId: string; path: string; position: number; body: string }> = [];

  for (const draft of drafts) {
    if (draft.filePath && draft.position) {
      result.push({ localDraftId: draft.localDraftId, path: draft.filePath, position: draft.position, body: draft.body });
      continue;
    }

    // Find the first anchor with exact diff line data
    const anchor = draft.anchorIds
      .map((anchorId) => anchorsById.get(anchorId))
      .find((candidate) => candidate && candidate.lineIds.length > 0);

    if (!anchor || !anchor.filePath) {
      // Overview-precision anchor: no diff position is available — skip this draft
      continue;
    }

    // Prefer the current/post-change side. For modified-line anchors,
    // buildSceneDiffAnchors collects both the removed and added line ids in
    // diff-source order — the removed line comes first, so a naive
    // anchor.lineIds[0] would attach the suggested comment to the deleted
    // line instead of the line the walkthrough is actually discussing.
    const candidates = anchor.lineIds
      .map((lineId) => findDiffLineById(reviewPage.diffSnapshot, lineId))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null && candidate.position !== null);
    const line = candidates.find((candidate) => candidate.kind === "added")
      ?? candidates.find((candidate) => candidate.kind === "context")
      ?? candidates.find((candidate) => candidate.kind === "removed")
      ?? candidates[0];
    if (!line?.position) {
      // Line not found in the captured diff snapshot — skip this draft
      continue;
    }

    result.push({ localDraftId: draft.localDraftId, path: anchor.filePath, position: line.position, body: draft.body });
  }

  return result;
}

/**
 * Typed transport error for the draft-comment API routes. Preserves the HTTP
 * status and the server's { error, message } JSON body so callers can branch
 * per error code (e.g. 409 OUTDATED_WALKTHROUGH → "regenerate" guidance)
 * instead of pattern-matching an opaque response.text() string.
 */
export class DraftSyncError extends Error {
  readonly status: number;
  /** Machine-readable server error code (e.g. "OUTDATED_WALKTHROUGH"), if any. */
  readonly code: string | null;
  /** Human-readable message from the server body, if any. */
  readonly serverMessage: string | null;

  constructor(args: { operation: string; status: number; code: string | null; serverMessage: string | null }) {
    super(args.serverMessage ?? `${args.operation} failed with status ${args.status}`);
    this.name = "DraftSyncError";
    this.status = args.status;
    this.code = args.code;
    this.serverMessage = args.serverMessage;
  }
}

async function throwDraftSyncError(operation: string, response: Response): Promise<never> {
  let code: string | null = null;
  let serverMessage: string | null = null;
  try {
    const body = await response.json() as { error?: unknown; message?: unknown };
    code = typeof body.error === "string" ? body.error : null;
    serverMessage = typeof body.message === "string" ? body.message : null;
  } catch {
    // Non-JSON error body (proxy/edge failure) — status alone still lets
    // callers distinguish auth vs conflict vs server error.
  }
  throw new DraftSyncError({ operation, status: response.status, code, serverMessage });
}

export async function syncDraftComments(
  jobId: string,
  request: SyncDraftCommentsRequest,
): Promise<SyncDraftCommentsResponse> {
  const response = await fetch(`/api/reviews/${jobId}/draft-comments/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    await throwDraftSyncError("syncDraftComments", response);
  }

  try {
    return await response.json() as SyncDraftCommentsResponse;
  } catch {
    throw new Error(`syncDraftComments: server returned non-JSON response (status ${response.status})`);
  }
}

export async function submitDraftComments(
  jobId: string,
  request: SubmitDraftCommentsRequest,
): Promise<SubmitDraftCommentsResponse> {
  const response = await fetch(`/api/reviews/${jobId}/draft-comments/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    await throwDraftSyncError("submitDraftComments", response);
  }

  try {
    return await response.json() as SubmitDraftCommentsResponse;
  } catch {
    throw new Error(`submitDraftComments: server returned non-JSON response (status ${response.status})`);
  }
}
