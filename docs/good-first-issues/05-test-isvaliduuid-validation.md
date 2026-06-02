# Add unit tests and JSDoc for `isValidUuid()`

**Labels:** `good first issue` · `testing` · `documentation` · `area: lib`

**Effort:** Small

## The problem

`src/lib/validation.ts` exports `isValidUuid(value)`, backed by a regex. It is used
to validate IDs coming in from URLs/requests, but it has **no tests** and **no
JSDoc** documenting which UUID shapes it accepts (the regex is case-insensitive and
not version-pinned, so e.g. `00000000-0000-0000-0000-000000000000` passes).

## Proposed approach

1. Add a JSDoc comment to `isValidUuid` describing what it accepts (8-4-4-4-12 hex,
   case-insensitive, any version/variant) and that it does **not** assert a
   specific UUID version.
2. Create `tests/unit/lib/validation.test.ts` covering:
   - valid lowercase and uppercase UUIDs,
   - the all-zero UUID,
   - rejects empty string, wrong segment lengths, missing hyphens,
   - rejects non-hex characters (e.g. `g`),
   - rejects strings with surrounding whitespace or extra characters.

## Acceptance criteria

- [ ] `isValidUuid` has a JSDoc block.
- [ ] New `tests/unit/lib/validation.test.ts` with the cases above.
- [ ] `npm run test:unit` passes.

## Files you'll likely touch

- `src/lib/validation.ts`
- `tests/unit/lib/validation.test.ts` (new)

## Why this is a good first issue

Tiny surface area, combines two newcomer skills (documentation + tests), and
documents real validation behavior that downstream routes depend on.
