"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface ShareDialogProps {
  jobId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ShareType = "full" | "video";

interface ShareState {
  loading: boolean;
  url: string | null;
  expiresAt: string | null;
  error: string | null;
  copied: boolean;
}

export function ShareDialog({ jobId, open, onOpenChange }: ShareDialogProps) {
  const [selectedType, setSelectedType] = useState<ShareType>("full");
  const [state, setState] = useState<ShareState>({
    loading: false,
    url: null,
    expiresAt: null,
    error: null,
    copied: false,
  });

  async function generateLink(type: ShareType) {
    setSelectedType(type);
    setState({ loading: true, url: null, expiresAt: null, error: null, copied: false });

    try {
      const res = await fetch(`/api/dashboard/jobs/${jobId}/share?type=${type}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Failed to generate link");
      }
      const data = await res.json();
      setState({
        loading: false,
        url: data.url,
        expiresAt: data.expiresAt,
        error: null,
        copied: false,
      });
    } catch (err) {
      setState({
        loading: false,
        url: null,
        expiresAt: null,
        error: err instanceof Error ? err.message : "Failed to generate link",
        copied: false,
      });
    }
  }

  function markCopied() {
    setState((prev) => ({ ...prev, copied: true, error: null }));
    setTimeout(() => setState((prev) => ({ ...prev, copied: false })), 2000);
  }

  async function copyToClipboard() {
    if (!state.url) return;
    const url = state.url;
    try {
      await navigator.clipboard.writeText(url);
      markCopied();
    } catch {
      // Fallback for older browsers — execCommand returns false when the
      // copy was refused, so only report success when it actually copied.
      let succeeded = false;
      try {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        succeeded = document.execCommand("copy");
        textarea.remove();
      } catch {
        succeeded = false;
      }
      if (succeeded) {
        markCopied();
      } else {
        setState((prev) => ({
          ...prev,
          copied: false,
          error: "Copy failed — select the link and copy it manually",
        }));
      }
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setState({ loading: false, url: null, expiresAt: null, error: null, copied: false });
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--background-elevated)] p-6 shadow-lg">
          <Dialog.Title className="mb-4 text-lg font-semibold text-[var(--foreground)]">
            Share Walkthrough
          </Dialog.Title>

          {/* Type selector */}
          <div className="mb-4 grid grid-cols-2 gap-2">
            <TypeButton
              label="Full Walkthrough"
              description="Interactive walkthrough"
              selected={selectedType === "full" && !state.loading}
              onClick={() => generateLink("full")}
            />
            <TypeButton
              label="Video Only"
              description="Public link"
              selected={selectedType === "video" && !state.loading}
              onClick={() => generateLink("video")}
            />
          </div>

          {/* Loading */}
          {state.loading && (
            <div className="flex items-center gap-2 py-4 text-sm text-[var(--foreground-muted)]">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              Generating link...
            </div>
          )}

          {/* Error */}
          {state.error && (
            <div className="rounded-lg bg-[var(--danger)]/10 p-3 text-sm text-[var(--danger)]">
              {state.error}
            </div>
          )}

          {/* Generated URL */}
          {state.url && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background-panel)] p-3">
                <input
                  readOnly
                  value={state.url}
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[var(--foreground-muted)] outline-none"
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={copyToClipboard}
                  className="cine-transition shrink-0 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  {state.copied ? "Copied!" : "Copy"}
                </button>
              </div>
              {state.expiresAt && (
                <p className="text-xs text-[var(--foreground-soft)]">
                  Expires in 7 days ({new Date(state.expiresAt).toLocaleDateString()})
                </p>
              )}
            </div>
          )}

          <Dialog.Close asChild>
            <button
              className="absolute right-4 top-4 rounded p-1 text-[var(--foreground-soft)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TypeButton({
  label,
  description,
  selected,
  onClick,
}: {
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`
        cine-transition rounded-lg border p-3 text-left
        ${
          selected
            ? "border-[var(--accent)] bg-[var(--accent-soft)]"
            : "border-[var(--border)] hover:border-[var(--border-strong)]"
        }
      `}
    >
      <div className={`text-sm font-medium ${selected ? "text-[var(--accent)]" : "text-[var(--foreground)]"}`}>
        {label}
      </div>
      <div className="mt-0.5 text-xs text-[var(--foreground-soft)]">{description}</div>
    </button>
  );
}
