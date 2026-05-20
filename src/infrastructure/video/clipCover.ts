export interface ClipCoverResult {
  durations: number[];
  totalSeconds: number;
}

/**
 * Compute the minimum-cost set of clip durations (with repetition) whose sum ≥ targetSeconds.
 *
 * Optimization order:
 * 1. Minimize total seconds (cost)
 * 2. Break ties by minimizing clip count
 *
 * Uses DP over candidate totals in [ceil(target), ceil(target) + maxDur).
 * For each candidate, checks whether it can be expressed as a sum of validDurations
 * and tracks the fewest clips needed.
 */
export function computeClipCover(
  targetSeconds: number,
  validDurations: readonly number[],
): ClipCoverResult {
  if (targetSeconds <= 0) {
    throw new Error(`computeClipCover: targetSeconds must be positive, got ${targetSeconds}`);
  }

  if (!validDurations.length) {
    const ceil = Math.max(1, Math.ceil(targetSeconds));
    return { durations: [ceil], totalSeconds: ceil };
  }

  const sorted = [...validDurations].sort((a, b) => a - b);
  const minDur = sorted[0];
  const maxDur = sorted[sorted.length - 1];

  // Single clip covers the target
  const ceiling = sorted.find((d) => d >= targetSeconds);
  if (ceiling !== undefined) {
    return { durations: [ceiling], totalSeconds: ceiling };
  }

  // Need multiple clips. Search candidate totals from ceil(target) upward.
  const target = Math.ceil(targetSeconds);
  const searchLimit = target + maxDur; // worst-case overshoot
  const maxClips = Math.ceil(target / minDur) + 1;

  // dp[total] = minimum number of clips to make exactly `total`, or Infinity
  // parent[total] = which duration was last added to reach `total`
  const dp = new Int32Array(searchLimit + 1).fill(0x7fffffff);
  const parent = new Int32Array(searchLimit + 1).fill(-1);
  dp[0] = 0;

  for (let t = 1; t <= searchLimit; t++) {
    for (const dur of sorted) {
      if (dur > t) break;
      const prev = dp[t - dur];
      if (prev < 0x7fffffff && prev + 1 < dp[t]) {
        dp[t] = prev + 1;
        parent[t] = dur;
      }
    }
  }

  // Find the best candidate total ≥ target: minimize total, then minimize clip count
  let bestTotal = -1;
  let bestCount = Infinity;

  for (let t = target; t <= searchLimit; t++) {
    if (dp[t] >= 0x7fffffff) continue;
    const count = dp[t];
    if (count > maxClips) continue;

    if (bestTotal === -1 || t < bestTotal || (t === bestTotal && count < bestCount)) {
      bestTotal = t;
      bestCount = count;
      break; // First reachable total ≥ target is the cheapest since we scan upward
    }
  }

  if (bestTotal === -1) {
    throw new Error(
      `computeClipCover: no combination of valid durations [${sorted.join(",")}] ` +
      `can cover target ${targetSeconds}s within search limit ${searchLimit}s`,
    );
  }

  // Reconstruct the durations from the DP parent pointers
  const durations: number[] = [];
  let remaining = bestTotal;
  while (remaining > 0) {
    const dur = parent[remaining];
    durations.push(dur);
    remaining -= dur;
  }

  return { durations, totalSeconds: bestTotal };
}

/**
 * Split narration text into segments proportional to clip durations.
 * Each segment gets a share of words proportional to its duration relative to the total.
 * Remaining words (from rounding) are appended to the last segment.
 */
export function splitNarrationByDurations(narration: string, durations: number[]): string[] {
  const words = narration.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return durations.map(() => "");
  }

  if (durations.length <= 1) {
    return [words.join(" ")];
  }

  const totalDuration = durations.reduce((s, d) => s + d, 0);
  if (totalDuration <= 0) {
    throw new Error(`splitNarrationByDurations: total duration must be positive, got ${totalDuration}`);
  }

  const segments: string[] = [];
  let wordOffset = 0;

  for (let i = 0; i < durations.length; i++) {
    if (i === durations.length - 1) {
      // Last segment gets all remaining words
      segments.push(words.slice(wordOffset).join(" "));
    } else {
      const proportional = Math.round((durations[i] / totalDuration) * words.length);
      const wordCount = wordOffset < words.length ? Math.max(1, proportional) : 0;
      const end = Math.min(wordOffset + wordCount, words.length);
      segments.push(words.slice(wordOffset, end).join(" "));
      wordOffset = end;
    }
  }

  return segments;
}
