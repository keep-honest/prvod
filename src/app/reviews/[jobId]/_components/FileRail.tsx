"use client";

import type { ReviewFileEntry } from "@/domain/entities/ReviewPage";
import type { ReviewPinCategory } from "@/domain/entities/ReviewDiffSnapshot";
import { VirtualizedScrollList } from "./VirtualizedScrollList";

const VIRTUALIZE_FILES_THRESHOLD = 14;
const CATEGORY_ORDER: ReviewPinCategory[] = ["risk", "test_gap", "question", "intent"];

function badgeTone(category: ReviewPinCategory): string {
  switch (category) {
    case "risk":
      return "border-orange-400/45 bg-orange-400/14 text-orange-200";
    case "test_gap":
      return "border-yellow-300/45 bg-yellow-300/12 text-yellow-100";
    case "question":
      return "border-fuchsia-400/45 bg-fuchsia-400/12 text-fuchsia-200";
    case "intent":
      return "border-sky-400/45 bg-sky-400/12 text-sky-200";
    default:
      return "border-[var(--border)] bg-white/5 text-[var(--foreground-soft)]";
  }
}

function formatCount(count: number): string {
  return count === 1 ? "1 diff scene" : `${count} diff scenes`;
}

export function FileRail(props: {
  files: ReviewFileEntry[];
  fileCategoriesByPath?: Record<string, ReviewPinCategory[]>;
  locked: boolean;
  selectedFilePath: string | null;
  onSelectFile: (file: ReviewFileEntry) => void;
}) {
  const renderFileButton = (file: ReviewFileEntry) => {
    const selected = props.selectedFilePath === file.filePath;
    const categories = (props.fileCategoriesByPath?.[file.filePath] ?? [])
      .slice()
      .sort((left, right) => CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right));
    return (
      <button
        key={file.filePath}
        type="button"
        data-testid="review-file-entry"
        data-file-path={file.filePath}
        disabled={props.locked}
        onClick={() => props.onSelectFile(file)}
        className={`cine-transition w-full rounded-2xl border px-4 py-3 text-left ${
          selected
            ? "border-[var(--accent)] bg-[var(--accent-soft)]"
            : "border-[var(--border)] bg-black/20 hover:border-[var(--border-strong)] hover:bg-white/6"
        } ${props.locked ? "cursor-not-allowed opacity-55" : ""}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="truncate font-medium text-[var(--foreground)]">{file.filePath}</div>
              {categories.map((category) => (
                <span
                  key={`${file.filePath}-${category}`}
                  className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] ${badgeTone(category)}`}
                >
                  {category.replaceAll("_", " ")}
                </span>
              ))}
            </div>
            <div className="mt-1 text-xs text-[var(--foreground-soft)]">
              {formatCount(file.sceneNumbers.length)}
            </div>
          </div>
          <span className="rounded-full bg-black/30 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--accent-secondary)]">
            {file.primarySceneNumber ? `S${file.primarySceneNumber}` : "replay"}
          </span>
        </div>
      </button>
    );
  };

  return (
    <div className="review-surface developer-grid relative flex h-full flex-col overflow-hidden rounded-[28px]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--foreground-soft)]">
          Replay rail
        </p>
        <div className="mt-2 flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Files in focus</h2>
            <p className="mt-1 text-sm text-[var(--foreground-muted)]">
              Choose a file to jump the walkthrough and diff to the relevant region
            </p>
          </div>
          <span className="rounded-full border border-[var(--border)] bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--foreground-soft)]">
            {props.files.length} files
          </span>
        </div>
      </div>

      <VirtualizedScrollList
        items={props.files}
        threshold={VIRTUALIZE_FILES_THRESHOLD}
        estimateSize={88}
        overscan={6}
        getKey={(f) => f.filePath}
        renderItem={renderFileButton}
      />
    </div>
  );
}
