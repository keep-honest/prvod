"use client";

import type { ReviewPin } from "@/domain/entities/ReviewDiffSnapshot";

export function ReviewPinCard(props: {
  pin: ReviewPin;
  onClose: () => void;
}) {
  return (
    <div className="review-surface shrink-0 rounded-[24px] p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--foreground-soft)]">
            Selected review pin
          </p>
          <h3 className="mt-2 text-lg font-semibold text-white">
            {props.pin.category.replaceAll("_", " ")}
          </h3>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground-soft)]"
        >
          Close
        </button>
      </div>
      <p className="mt-3 text-sm leading-6 text-[var(--foreground-muted)]">
        {props.pin.prose}
      </p>
    </div>
  );
}
