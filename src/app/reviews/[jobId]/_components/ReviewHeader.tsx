"use client";

export function ReviewHeader(props: {
  repoFullName: string;
  prNumber: number;
  durationMode: string;
  headline: string;
}) {
  return (
    <header className="rounded-2xl border border-white/10 bg-black/40 px-5 py-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/50">
            PR Walkthrough
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white md:text-3xl">
            {props.repoFullName} • PR #{props.prNumber}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/70">
            {props.headline}
          </p>
        </div>
        <span className="self-start rounded-full border border-white/20 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
          {props.durationMode}
        </span>
      </div>
    </header>
  );
}
