interface SkeletonCardProps {
  lines?: number;
  className?: string;
}

export function SkeletonCard({ lines = 3, className = "" }: SkeletonCardProps) {
  return (
    <div
      className={`rounded-xl border border-[var(--border)] bg-[var(--background-panel)] p-5 ${className}`}
      aria-hidden="true"
    >
      {/* Header skeleton */}
      <div className="mb-4 h-5 w-2/5 animate-pulse rounded bg-[var(--background-panel-strong)]" />
      {/* Body line skeletons */}
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="mb-2.5 h-3.5 animate-pulse rounded bg-[var(--background-panel-strong)]"
          style={{ width: `${80 - i * 15}%` }}
        />
      ))}
    </div>
  );
}
