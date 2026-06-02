# Add unit tests for `escapeXml()`

**Labels:** `good first issue` · `testing` · `area: lib`

**Effort:** Small

## The problem

`src/lib/xml.ts` exports `escapeXml(text)`, which escapes the five XML-reserved
characters (`&`, `<`, `>`, `"`, `'`) so values can be embedded safely in SVG / SSML
/ XML output. This runs on user- and LLM-derived strings, so correct escaping
matters, but there is **no test file** for it.

## Proposed approach

Create `tests/unit/lib/xml.test.ts` covering:

- each of the five characters individually maps to its entity
  (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`),
- `&` is escaped first so a string like `"<&>"` doesn't double-escape into
  `&amp;lt;` (i.e. verify the output is `&lt;&amp;&gt;`),
- a string with no special characters is returned unchanged,
- the empty string returns the empty string,
- a realistic mixed string (e.g. `Tom & "Jerry" <3`).

## Acceptance criteria

- [ ] New `tests/unit/lib/xml.test.ts` with the cases above.
- [ ] `npm run test:unit` passes.

## Files you'll likely touch

- `tests/unit/lib/xml.test.ts` (new)

## Why this is a good first issue

A pure string function with one subtle ordering gotcha (escape `&` first) — a great
way to write a focused test that actually catches a real class of bug.
