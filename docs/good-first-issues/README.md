# Good First Issues

A curated set of small, well-scoped tasks for newcomers to PRVOD. Each one is
self-contained, touches a limited number of files, and comes with enough context
to start without deep knowledge of the whole pipeline.

New here? Read [CONTRIBUTING.md](../../CONTRIBUTING.md) first for setup, then pick
an issue below. Comment on the corresponding GitHub issue to claim it before you
start so two people don't duplicate work.

## The issues

| # | Title | Area | Type | Effort |
|---|-------|------|------|--------|
| 01 | [Extract LLM prompts into dedicated prompt files](./01-extract-prompts-into-files.md) | `area: llm` | refactor, enhancement | Medium |
| 02 | [Replace `console.*` calls with the centralized logger](./02-replace-console-with-logger.md) | `area: lib` | refactor, security | Small |
| 03 | [Replace `any` casts in `AppGitHubService` with typed API responses](./03-type-github-api-responses.md) | `area: github` | type-safety, refactor | Small |
| 04 | [Add unit tests for `clamp()`](./04-test-clamp-math.md) | `area: lib` | testing | Small |
| 05 | [Add unit tests and JSDoc for `isValidUuid()`](./05-test-isvaliduuid-validation.md) | `area: lib` | testing, documentation | Small |
| 06 | [Add unit tests for `escapeXml()`](./06-test-escapexml.md) | `area: lib` | testing | Small |
| 07 | [Add unit tests for the `retry()` helper](./07-test-retry-helper.md) | `area: lib` | testing | Medium |
| 08 | [Add unit tests for the in-memory rate limiter](./08-test-rate-limiter.md) | `area: lib` | testing | Medium |
| 09 | [Add JSDoc to the `sha256()` utility](./09-jsdoc-sha256.md) | `area: lib` | documentation | Small |
| 10 | [Fix the broken "Project Structure" link in the README TOC](./10-fix-readme-toc-anchor.md) | `area: docs` | documentation | Small |

> **Maintainers:** issue 01 (prompt extraction) is the flagship task — it aligns
> the project with the current industry standard of keeping prompts as
> first-class, versionable assets rather than inline string literals.

## Label legend

These markdown files are the source of truth for the issue text. When you open
the matching GitHub issues, apply the labels listed at the top of each file. The
full label set used across these issues:

### Workflow labels

| Label | Color | Meaning |
|-------|-------|---------|
| `good first issue` | `#7057ff` | Suitable for a first-time contributor. |
| `help wanted` | `#008672` | Maintainers would welcome a PR for this. |

### Type labels

| Label | Color | Meaning |
|-------|-------|---------|
| `enhancement` | `#a2eeef` | New capability or improvement to existing behavior. |
| `refactor` | `#d4c5f9` | Internal restructuring with no change in behavior. |
| `documentation` | `#0075ca` | Docs, comments, or JSDoc. |
| `testing` | `#c5def5` | Adds or improves automated tests. |
| `type-safety` | `#fbca04` | Removes `any`/unsafe casts or tightens types. |
| `security` | `#d73a4a` | Reduces a security or data-leak risk. |

### Area labels

| Label | Color | Meaning |
|-------|-------|---------|
| `area: llm` | `#5319e7` | LLM / prompt / script-generation code. |
| `area: lib` | `#bfdadc` | Shared utilities in `src/lib`. |
| `area: github` | `#e99695` | GitHub App / API integration. |
| `area: docs` | `#c2e0c6` | Repository documentation. |
| `area: video` | `#f9d0c4` | Video composition / Remotion components. |

### Creating the labels

If a label does not yet exist in the repository, create it once with the GitHub
CLI (colors are the hex values above, without the leading `#`):

```bash
gh label create "good first issue" --color 7057ff --description "Suitable for a first-time contributor" --force
gh label create "help wanted"      --color 008672 --description "Maintainers would welcome a PR"        --force
gh label create "enhancement"      --color a2eeef --force
gh label create "refactor"         --color d4c5f9 --force
gh label create "documentation"    --color 0075ca --force
gh label create "testing"          --color c5def5 --force
gh label create "type-safety"      --color fbca04 --force
gh label create "security"         --color d73a4a --force
gh label create "area: llm"        --color 5319e7 --force
gh label create "area: lib"        --color bfdadc --force
gh label create "area: github"     --color e99695 --force
gh label create "area: docs"       --color c2e0c6 --force
gh label create "area: video"      --color f9d0c4 --force
```
