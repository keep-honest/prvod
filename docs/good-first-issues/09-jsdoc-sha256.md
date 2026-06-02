# Add JSDoc to the `sha256()` utility

**Labels:** `good first issue` · `documentation` · `area: lib`

**Effort:** Small

## The problem

`src/lib/crypto.ts` exports `sha256(input)`:

```ts
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
```

It has no JSDoc, so callers can't tell from the signature what encoding the input
uses, what the output format is, or what it's appropriate for.

## Proposed approach

Add a JSDoc block documenting:

- the input is hashed as **UTF-8**,
- the return value is a **lowercase hex** digest (64 characters),
- intended use (e.g. hashing tokens/identifiers for storage or lookup) and the
  caveat that a bare SHA-256 is **not** suitable for hashing passwords (the repo
  uses argon2 for that — see `@node-rs/argon2` usage).

Match the JSDoc style already used in neighboring `src/lib` files (e.g.
`math.ts`, `url.ts`).

## Acceptance criteria

- [ ] `sha256` has a clear JSDoc block describing input encoding, output format,
      and intended/inappropriate uses.
- [ ] `npm run lint` and `npm run typecheck` pass.

## Files you'll likely touch

- `src/lib/crypto.ts`

## Why this is a good first issue

A one-function, documentation-only change that's a gentle first PR and teaches the
contributor where crypto helpers fit in the codebase.
