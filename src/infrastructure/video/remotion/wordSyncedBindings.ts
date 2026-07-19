/**
 * Word-synced code-binding resolver.
 *
 * Two inputs: per-scene `WordTiming[]` (millisecond ranges per spoken word)
 * and the scene's `codeBindings` (LLM-emitted word-index→codeBrollIndex maps).
 * When `codeBindings` is absent or malformed, a deterministic heuristic
 * parses backtick identifiers + file basenames out of the narration and
 * synthesises bindings.
 *
 * Output: `ResolvedBinding[]` ordered by `wordStartIndex`, each binding
 * pre-resolved to millisecond ranges so the per-frame lookup is a pure
 * binary search.
 *
 * The whole module is deterministic and pure — no React, no Remotion — so
 * it's straightforward to unit-test.
 */
import type { WordTiming } from "@/interfaces/ITTSService";
import type { CodeBroll, CodeBinding, Scene } from "@/domain/entities/VideoScript";
import { sanitizeSpokenNarrationText } from "@/lib/narrationText";
import { createLogger } from "@/lib/logger";

const logger = createLogger("wordSyncedBindings");

export interface ResolvedBinding extends CodeBinding {
  startMs: number;
  endMs: number;
}

function tokenizeNarration(narration: string): string[] {
  return sanitizeSpokenNarrationText(narration).split(/\s+/).filter(Boolean);
}

/** Strip surrounding backticks, quotes, punctuation, then lowercase. */
function cleanToken(raw: string): string {
  return raw
    .replace(/^[`'"([{<]+/, "")
    .replace(/[`'"),.:;!?\]}>]+$/, "")
    .toLowerCase();
}

/** Extract identifier-like substrings from a code blob (lower-cased). */
function extractCodeIdentifiers(code: string): Set<string> {
  const ids = new Set<string>();
  const matches = code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const id of matches) {
    if (id.length >= 2) ids.add(id.toLowerCase());
  }
  return ids;
}

/** Extract backtick-quoted phrases from narration (lower-cased, single-word). */
function extractBacktickIdentifiers(narration: string): Set<string> {
  const ids = new Set<string>();
  const matches = narration.match(/`([^`]+)`/g) ?? [];
  for (const raw of matches) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length >= 2 && !inner.includes(" ")) {
      ids.add(inner.toLowerCase());
    }
  }
  return ids;
}

interface SnippetIndex {
  /** Lower-cased identifier candidates (backticked OR camel/snake-cased symbols in `code`). */
  identifiers: Set<string>;
  /** Lower-cased file basename (with extension). */
  basename: string | null;
  /** Lower-cased file basename without extension. */
  basenameNoExt: string | null;
  /** Line-number index for fast highlightLines lookup. */
  lineMap: Map<string, number[]>; // identifier (lower-case) → line numbers within lineRange
}

function buildSnippetIndex(codeBroll: CodeBroll[]): SnippetIndex[] {
  return codeBroll.map((cb) => {
    const identifiers = extractCodeIdentifiers(cb.code);
    const basename = cb.filePath ? cb.filePath.split("/").pop()?.toLowerCase() ?? null : null;
    const basenameNoExt = basename ? basename.replace(/\.[^.]+$/, "") : null;
    if (basenameNoExt) identifiers.add(basenameNoExt);

    // Build per-line identifier index (line numbers are absolute when lineRange is set,
    // otherwise relative to the snippet's own line numbering starting at 1).
    const lineMap = new Map<string, number[]>();
    const baseLine = cb.lineRange ? cb.lineRange[0] : 1;
    const lines = cb.code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const absoluteLine = baseLine + i;
      const lineIds = lines[i].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
      for (const id of lineIds) {
        if (id.length < 2) continue;
        const key = id.toLowerCase();
        const arr = lineMap.get(key);
        if (arr) arr.push(absoluteLine);
        else lineMap.set(key, [absoluteLine]);
      }
    }

    return { identifiers, basename, basenameNoExt, lineMap };
  });
}

/**
 * Heuristic bindings: parse narration for backtick identifiers + file
 * basenames + camel/snake-cased code identifiers. For each matched span,
 * emit a binding. Tie-breaker: lowest codeBrollIndex wins (stable, matches
 * "earliest declared / most prominent" intent).
 *
 * Never synthesises `relatesToCodeBrollIndices` — arrows are LLM-only.
 */
export function buildHeuristicBindings(args: {
  narration: string;
  wordTimings: WordTiming[];
  codeBroll: CodeBroll[];
}): CodeBinding[] {
  const { narration, wordTimings, codeBroll } = args;
  if (codeBroll.length === 0) return [];
  const tokens = tokenizeNarration(narration);
  if (tokens.length === 0) return [];
  // Tokens-to-wordTimings is a 1:1 invariant maintained by the TTS pipeline
  // (restoreDots* / restoreDataFormatNames*). Best-effort if mismatched.
  const tokenCount = Math.min(tokens.length, wordTimings.length);
  if (tokenCount === 0) return [];

  const snippetIndex = buildSnippetIndex(codeBroll);
  const backtickIds = extractBacktickIdentifiers(narration);

  const bindings: CodeBinding[] = [];
  let currentBinding: CodeBinding | null = null;

  for (let i = 0; i < tokenCount; i++) {
    const cleaned = cleanToken(tokens[i]);
    if (cleaned.length < 2) {
      // Short token (single char, e.g. "a", "I") — treat as a gap.
      // Must emit any pending binding before nulling it, otherwise the
      // accumulated span for prior matching tokens is silently lost.
      // Mirrors the no-match branch below.
      if (currentBinding) {
        bindings.push(currentBinding);
        currentBinding = null;
      }
      continue;
    }
    // Find the lowest codeBrollIndex whose snippet matches this token.
    let matched: { index: number; lines: number[] } | null = null;
    for (let cbIdx = 0; cbIdx < snippetIndex.length; cbIdx++) {
      const snip = snippetIndex[cbIdx];
      const isBacktickHit = backtickIds.has(cleaned) && snip.identifiers.has(cleaned);
      const isBasenameHit =
        cleaned === snip.basename ||
        cleaned === snip.basenameNoExt;
      const isIdentifierHit = snip.identifiers.has(cleaned);
      if (isBacktickHit || isBasenameHit || isIdentifierHit) {
        matched = { index: cbIdx, lines: snip.lineMap.get(cleaned) ?? [] };
        break; // lowest-index wins
      }
    }

    if (!matched) {
      // No match — emit any pending binding and reset.
      if (currentBinding) {
        bindings.push(currentBinding);
        currentBinding = null;
      }
      continue;
    }

    if (currentBinding && currentBinding.codeBrollIndex === matched.index) {
      // Extend the current span.
      currentBinding.wordEndIndex = i;
      // Union highlightLines deterministically.
      for (const line of matched.lines) {
        if (!currentBinding.highlightLines.includes(line)) {
          currentBinding.highlightLines.push(line);
        }
      }
    } else {
      if (currentBinding) bindings.push(currentBinding);
      currentBinding = {
        wordStartIndex: i,
        wordEndIndex: i,
        codeBrollIndex: matched.index,
        highlightLines: [...matched.lines],
        relatesToCodeBrollIndices: [],
      };
    }
  }
  if (currentBinding) bindings.push(currentBinding);

  // Sort highlightLines per binding for stable output.
  for (const b of bindings) b.highlightLines.sort((a, b) => a - b);
  return bindings;
}

/**
 * Drop bindings that reference invalid indices or word ranges, filter
 * out-of-range `highlightLines`, and enforce word-span disjointness.
 *
 * This runs on every resolver path — including ones that bypass the runner's
 * `validateCodeBindings` (e.g. checkpoint resume of a persisted script) — so
 * it mirrors the validator's highlightLines range logic and makes overlap
 * handling deterministic: bindings are sorted by `wordStartIndex` and any
 * later-starting binding whose span overlaps the previous kept binding is
 * dropped (a nested span would otherwise permanently shadow the outer one
 * in the sticky-forward `findActiveBinding`).
 */
function sanitizeBindings(
  bindings: CodeBinding[],
  scene: Scene,
  wordCount: number,
): CodeBinding[] {
  const cbCount = scene.codeBroll.length;
  const out: CodeBinding[] = [];
  let filteredHighlightLineCount = 0;
  for (const b of bindings) {
    if (b.codeBrollIndex < 0 || b.codeBrollIndex >= cbCount) continue;
    if (b.wordStartIndex < 0 || b.wordEndIndex < b.wordStartIndex) continue;
    if (b.wordStartIndex >= wordCount) continue;
    // Clamp wordEndIndex to wordCount-1.
    const wordEndIndex = Math.min(b.wordEndIndex, wordCount - 1);
    // Filter (not drop-the-binding) out-of-range highlightLines, mirroring
    // validateCodeBindings' range logic. An OOB line that survives here is
    // silently invisible: HighlightBand's relative-index filter renders
    // nothing for it on every frame.
    const target = scene.codeBroll[b.codeBrollIndex];
    const snippetLineCount = target.code.split("\n").length;
    const minLine = target.lineRange ? target.lineRange[0] : 1;
    const maxLine = target.lineRange ? target.lineRange[1] : snippetLineCount;
    const highlightLines = (b.highlightLines ?? []).filter(
      (line) => line >= minLine && line <= maxLine,
    );
    filteredHighlightLineCount += (b.highlightLines ?? []).length - highlightLines.length;
    // Filter relatesToCodeBrollIndices to valid OTHER indices.
    const relatesTo = (b.relatesToCodeBrollIndices ?? [])
      .filter((idx) => idx >= 0 && idx < cbCount && idx !== b.codeBrollIndex);
    out.push({ ...b, wordEndIndex, highlightLines, relatesToCodeBrollIndices: relatesTo });
  }

  if (filteredHighlightLineCount > 0) {
    logger.warn("Word-synced bindings: filtered out-of-range highlightLines during sanitization", {
      errorTag: "OOB_HIGHLIGHT_LINES_FILTERED",
      sceneNumber: scene.sceneNumber,
      filteredLineCount: filteredHighlightLineCount,
    });
  }

  // Enforce span disjointness deterministically: sort by wordStartIndex
  // (tie-break on wordEndIndex) and drop any binding overlapping the
  // previous kept one.
  out.sort(
    (a, b) => a.wordStartIndex - b.wordStartIndex || a.wordEndIndex - b.wordEndIndex,
  );
  const disjoint: CodeBinding[] = [];
  let droppedOverlapCount = 0;
  for (const b of out) {
    const last = disjoint[disjoint.length - 1];
    if (last && b.wordStartIndex <= last.wordEndIndex) {
      droppedOverlapCount++;
      continue;
    }
    disjoint.push(b);
  }
  if (droppedOverlapCount > 0) {
    logger.warn("Word-synced bindings: dropped overlapping word spans during sanitization", {
      errorTag: "OVERLAPPING_CODE_BINDINGS_DROPPED",
      sceneNumber: scene.sceneNumber,
      droppedBindingCount: droppedOverlapCount,
      keptBindingCount: disjoint.length,
    });
  }
  return disjoint;
}

/**
 * Resolve LLM bindings (preferred) or fall back to heuristic bindings,
 * then attach millisecond ranges from `wordTimings`. Output sorted by
 * `wordStartIndex` for binary-search lookups.
 *
 * Mixing LLM + heuristic is NOT allowed in the normal flow: if LLM
 * bindings are present, they're used as-is after sanitization. However,
 * when EVERY LLM binding gets stripped by sanitization (stale indices in
 * older persisted scripts, non-V2 ingestion), fall back to heuristic —
 * the alternative is sitting on the default snippet forever, which
 * contradicts the documented malformed-binding fallback.
 */
export function resolveBindings(args: {
  scene: Scene;
  wordTimings: WordTiming[];
}): ResolvedBinding[] {
  const { scene, wordTimings } = args;
  const tokens = tokenizeNarration(scene.narration);
  // The schema contract declares tokens ↔ wordTimings 1:1 (maintained by the
  // TTS pipeline's restoreDots*/restoreDataFormatNames*). A mismatch means
  // bindings past the shorter list get silently truncated below, so surface
  // it — once per scene, since resolveBindings runs once per (scene,
  // wordTimings) via the stage's useMemo.
  if (scene.codeBroll.length > 0 && tokens.length !== wordTimings.length) {
    logger.warn("Word-synced bindings: narration token count does not match wordTimings count — truncating to the shorter", {
      errorTag: "WORD_TIMING_TOKEN_COUNT_MISMATCH",
      sceneNumber: scene.sceneNumber,
      tokenCount: tokens.length,
      wordTimingCount: wordTimings.length,
    });
  }
  const wordCount = Math.min(tokens.length, wordTimings.length);
  if (wordCount === 0 || scene.codeBroll.length === 0) return [];

  let source: CodeBinding[] = [];
  const llmBindingCount = scene.codeBindings?.length ?? 0;
  if (llmBindingCount > 0 && scene.codeBindings) {
    source = sanitizeBindings(scene.codeBindings, scene, wordCount);
  }
  // Heuristic fires when (a) no LLM bindings were emitted, OR (b) all
  // LLM bindings stripped during sanitization. Either way the stage
  // would otherwise be stuck on the default snippet — fall through.
  if (source.length === 0) {
    // Defense-in-depth observability: when LLM bindings WERE emitted but
    // sanitization wiped all of them, log a breadcrumb so a debugger seeing
    // heuristic-shaped bindings can trace back. The runner-level
    // `validateCodeBindings` already logs INVALID_CODE_BINDINGS_STRIPPED for
    // script-load paths; this duplicate-but-cheap warn covers any path that
    // reaches the resolver without going through that validator (e.g. retry
    // resume from a persisted checkpoint that bypasses script-completion
    // validation).
    if (llmBindingCount > 0) {
      logger.warn("All LLM codeBindings stripped during sanitization — falling back to heuristic", {
        errorTag: "LLM_BINDINGS_FULLY_STRIPPED_HEURISTIC_FALLBACK",
        sceneNumber: scene.sceneNumber,
        emittedBindingCount: llmBindingCount,
      });
    }
    source = buildHeuristicBindings({
      narration: scene.narration,
      wordTimings,
      codeBroll: scene.codeBroll,
    });
    // Observability for the silent path: heuristic ran (either because no
    // LLM bindings were emitted, or because all were stripped). 0 bindings
    // with a non-trivial narration + codeBroll means the word-synced stage
    // is showing a frozen default snippet for the whole scene — operators
    // need a structured signal so they can detect "WORD_SYNCED_CODE on but
    // nothing syncing" without scrubbing the rendered video.
    if (source.length === 0) {
      logger.warn("Word-synced bindings: heuristic produced no bindings", {
        errorTag: "WORD_SYNCED_HEURISTIC_PRODUCED_NO_BINDINGS",
        sceneNumber: scene.sceneNumber,
        wordCount,
        codeBrollCount: scene.codeBroll.length,
        emittedBindingCount: llmBindingCount,
      });
    } else {
      logger.debug("Word-synced bindings: heuristic produced bindings", {
        sceneNumber: scene.sceneNumber,
        bindingCount: source.length,
        emittedBindingCount: llmBindingCount,
      });
    }
  }
  if (source.length === 0) return [];

  // Sort by wordStartIndex for binary search.
  source.sort((a, b) => a.wordStartIndex - b.wordStartIndex);

  return source.map<ResolvedBinding>((b) => ({
    ...b,
    startMs: wordTimings[b.wordStartIndex]?.startTimeMs ?? 0,
    endMs: wordTimings[Math.min(b.wordEndIndex, wordTimings.length - 1)]?.endTimeMs ?? 0,
  }));
}

/**
 * Index-returning core of {@link findActiveBinding}: rightmost binding whose
 * `startMs <= currentTimeMs` (binary search over the sorted list), or -1 when
 * the first binding is still in the future.
 *
 * Exported so the card-slot/transition derivation (`cardTransitions.ts`)
 * shares the exact same sticky-forward search — the stage's active-binding
 * lookup and the layout's segment lookup can never diverge.
 */
export function findActiveBindingIndex(
  resolved: ResolvedBinding[],
  currentTimeMs: number,
): number {
  let lo = 0;
  let hi = resolved.length - 1;
  let candidateIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (resolved[mid].startMs <= currentTimeMs) {
      candidateIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidateIdx;
}

/**
 * Given `currentTimeMs`, return the binding whose [startMs, endMs] range
 * contains it. If none, return the MOST RECENT past binding (sticky-forward
 * for visual continuity — the previous snippet stays visible during un-bound
 * narration). Returns null only when no past binding exists yet.
 */
export function findActiveBinding(
  resolved: ResolvedBinding[],
  currentTimeMs: number,
): ResolvedBinding | null {
  const candidateIdx = findActiveBindingIndex(resolved, currentTimeMs);
  if (candidateIdx === -1) return null;
  return resolved[candidateIdx];
}

