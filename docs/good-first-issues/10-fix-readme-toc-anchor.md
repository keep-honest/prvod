# Fix the broken "Project Structure" link in the README TOC

**Labels:** `good first issue` · `documentation` · `area: docs`

**Effort:** Small

## The problem

The README Table of Contents links to a Project Structure section:

```md
- [Project Structure](#project-structure)
```

…but there is **no `## Project Structure` heading** in the document. The actual
content lives inside a collapsible block:

```md
<summary><b>Project Structure</b></summary>
```

(around line 731). Because `<summary>` text is not a markdown heading, GitHub
doesn't generate a `#project-structure` anchor for it, so the TOC link is dead — it
scrolls nowhere.

## Proposed approach

Pick whichever keeps the README's existing style:

- **Option A (minimal):** add a real heading immediately above the
  `<details>` block, e.g. `## Project Structure`, so the `#project-structure`
  anchor resolves. Keep the collapsible body as-is.
- **Option B:** remove the `Project Structure` entry from the TOC if the
  maintainers prefer to keep that section collapsed and unlinked.

While you're there, verify the other TOC links resolve (e.g. `Known Limitations`,
`One-Time Trial Keys`) and note any other broken anchors in your PR.

Confirm by viewing the rendered README on your branch and clicking the TOC link.

## Acceptance criteria

- [ ] The "Project Structure" TOC entry navigates to the right place (or is
      removed), with no other TOC link left broken.

## Files you'll likely touch

- `README.md`

## Why this is a good first issue

A real, reproducible docs bug with a one-line fix — a perfect first contribution
that gets a newcomer comfortable with the PR workflow.
