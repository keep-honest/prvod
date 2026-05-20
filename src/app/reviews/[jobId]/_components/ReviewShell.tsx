"use client";

import type { ReactNode } from "react";

export function ReviewShell(props: {
  header: ReactNode;
  children: ReactNode;
  theaterMode?: boolean;
}) {
  return (
    <main className="min-h-screen bg-[var(--background)] px-3 py-3 text-[var(--foreground)] md:px-6 md:py-4">
      <div className={`mx-auto flex min-h-[calc(100vh-1.5rem)] flex-col gap-3 rounded-[28px] border border-[var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.03),transparent_18%),rgba(8,8,8,0.92)] p-3 shadow-[0_40px_120px_rgba(0,0,0,0.55)] md:min-h-[calc(100vh-2rem)] md:gap-4 md:rounded-[32px] md:p-5 ${props.theaterMode ? "" : "max-w-[1760px]"}`}>
        {props.header}
        {props.children}
      </div>
    </main>
  );
}
