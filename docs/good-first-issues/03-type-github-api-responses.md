# Replace `any` casts in `AppGitHubService` with typed API responses

**Labels:** `good first issue` · `type-safety` · `refactor` · `area: github`

**Effort:** Small

## The problem

`src/infrastructure/github/AppGitHubService.ts` casts two GitHub REST responses to
`any`, which disables type checking at exactly the boundary where untrusted
external data enters the app:

```ts
// line 77
const pr: any = await prRes.json();
// line 99
const issue: any = await res.json();
```

`any` here means typos in field names compile silently and the downstream code has
no autocomplete or safety.

## Proposed approach

1. Define minimal interfaces for the fields actually read from each response — not
   the entire GitHub schema, just what the code uses (e.g. `title`, `body`,
   `number`, `user.login`, `head.sha`, etc.). Inspect the lines after 77 and 99 to
   see which fields are accessed.
2. Replace `: any` with those interfaces:
   ```ts
   interface PullRequestResponse { title: string; body: string | null; /* … */ }
   const pr = (await prRes.json()) as PullRequestResponse;
   ```
3. Place the interfaces near the top of the file (or in a small
   `githubApiTypes.ts` if you prefer to reuse them).

## Acceptance criteria

- [ ] No `any` on the two `.json()` results in `AppGitHubService.ts`.
- [ ] Interfaces cover exactly the fields the code reads.
- [ ] `npm run typecheck` and `npm run lint` pass with no new warnings.

## Files you'll likely touch

- `src/infrastructure/github/AppGitHubService.ts`

## Why this is a good first issue

Tightly scoped (two casts), it teaches typing of external API boundaries, and the
"only type what you use" approach keeps it from ballooning.
