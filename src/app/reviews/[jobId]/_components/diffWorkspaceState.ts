"use client";

import type {
  ReviewDiffFile,
  ReviewDiffLine,
  ReviewPin,
  SceneDiffAnchor,
} from "@/domain/entities/ReviewDiffSnapshot";

export type DiffWorkspaceRow =
  | { id: string; type: "file"; file: ReviewDiffFile }
  | { id: string; type: "hunk"; filePath: string; header: string }
  | { id: string; type: "line"; filePath: string; line: ReviewDiffLine };

export function flattenDiffWorkspaceRowsForFile(
  file: ReviewDiffFile,
): DiffWorkspaceRow[] {
  return [
    { id: `file:${file.filePath}`, type: "file" as const, file },
    ...file.hunks.flatMap((hunk) => [
      { id: `hunk:${hunk.hunkId}`, type: "hunk" as const, filePath: file.filePath, header: hunk.header },
      ...hunk.lines.map((line) => ({
        id: `line:${line.lineId}`,
        type: "line" as const,
        filePath: file.filePath,
        line,
      })),
    ]),
  ];
}

export function findPrimaryAnchorForScene(
  sceneNumber: number | null,
  anchors: SceneDiffAnchor[],
): SceneDiffAnchor | null {
  if (sceneNumber === null) {
    return null;
  }
  return anchors.find((anchor) => anchor.sceneNumber === sceneNumber) ?? null;
}

export function buildPinIndexByLineId(
  pins: ReviewPin[],
  anchors: SceneDiffAnchor[],
): Map<string, ReviewPin[]> {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.anchorId, anchor] as const));
  const index = new Map<string, ReviewPin[]>();

  for (const pin of pins) {
    for (const anchorId of pin.anchorIds) {
      const anchor = anchorsById.get(anchorId);
      if (!anchor) continue;
      for (const lineId of anchor.lineIds) {
        const bucket = index.get(lineId) ?? [];
        bucket.push(pin);
        index.set(lineId, bucket);
      }
    }
  }

  return index;
}

export function findRowIndexForAnchor(
  rows: DiffWorkspaceRow[],
  anchor: SceneDiffAnchor | null,
): number {
  if (!anchor || anchor.lineIds.length === 0) {
    return -1;
  }

  return rows.findIndex(
    (row) => row.type === "line" && anchor.lineIds.includes(row.line.lineId),
  );
}

export function findFocusFilePath(args: {
  activeAnchor: SceneDiffAnchor | null;
  preferredFilePath?: string | null;
  availableFilePaths: string[];
}): string | null {
  if (args.preferredFilePath) {
    return args.preferredFilePath;
  }

  if (args.activeAnchor?.filePath && args.availableFilePaths.includes(args.activeAnchor.filePath)) {
    return args.activeAnchor.filePath;
  }

  return args.availableFilePaths[0] ?? null;
}
