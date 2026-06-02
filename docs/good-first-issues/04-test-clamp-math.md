# Add unit tests for `clamp()`

**Labels:** `good first issue` · `testing` · `area: lib`

**Effort:** Small

## The problem

`src/lib/math.ts` exports a single pure function, `clamp(value, min, max)`, with
deliberate edge-case behavior: non-finite inputs (`NaN`, `±Infinity`) return the
**midpoint** of the range to prevent `NaN` from propagating into SVG/canvas
coordinates and crashing the renderer. There is currently **no test file** for it,
so that safety guarantee is unverified and could regress unnoticed.

## Proposed approach

Create `tests/unit/lib/math.test.ts` using Vitest (see existing tests under
`tests/unit/lib/` for the style). Cover at least:

- a value inside the range is returned unchanged,
- a value below `min` clamps to `min`,
- a value above `max` clamps to `max`,
- values exactly equal to `min` and `max`,
- `NaN` returns `(min + max) / 2`,
- `Infinity` and `-Infinity` each return the midpoint,
- a negative range (e.g. `clamp(x, -10, -5)`).

## Acceptance criteria

- [ ] New `tests/unit/lib/math.test.ts` covering the cases above.
- [ ] `npm run test:unit` passes.

## Files you'll likely touch

- `tests/unit/lib/math.test.ts` (new)

## Why this is a good first issue

A small, fully pure function with interesting, documented edge cases — ideal for
learning the project's Vitest setup without touching production code.
