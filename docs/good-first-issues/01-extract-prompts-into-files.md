# Extract LLM prompts into dedicated prompt files

**Labels:** `good first issue` · `help wanted` · `enhancement` · `refactor` · `area: llm`

**Effort:** Medium (can be done incrementally, one prompt at a time)

## Summary

PRVOD's LLM prompts are currently hard-coded as large inline template literals
mixed into TypeScript control-flow code. The current industry standard is to
treat prompts as **first-class, versionable assets** that live in their own
files, separate from the code that assembles and sends them. This issue moves
the prompt text out of the `.ts` files and into a dedicated `prompts/` location,
leaving the TypeScript to handle only data interpolation and orchestration.

## Background — why this matters

Inline prompts have well-known downsides that this codebase already exhibits:

- **Hard to review.** A prompt change shows up as a diff buried inside a 650–1000
  line `.ts` file, alongside unrelated logic.
- **Hard to diff and version.** Prompt engineering is iterative; reviewers want
  to see _only_ the wording change, not the surrounding code.
- **Hard to reuse and test.** The same instructions are re-expressed across
  multiple providers (Claude / Gemini / CLI) instead of sharing a single source.
- **Mixes two concerns.** Natural-language instructions and program logic have
  different authors, review cadences, and failure modes.

Extracting prompts into their own files is the established pattern in modern LLM
applications precisely to fix these problems.

## Where the prompts live today

The prompt text is embedded as template literals across the LLM infrastructure:

| File | Lines | What's inline |
|------|-------|---------------|
| `src/infrastructure/llm/script-prompt.ts` | `262`, `575` | The main video-script system prompt (`You are a video script writer…`, ~150 lines) and the narration-retime prompt (`You are revising narration…`). |
| `src/infrastructure/llm/oversizedFileSummariser.ts` | `15` | `SYSTEM_PROMPT` for chunk-by-chunk file summarization. |
| `src/infrastructure/llm/promptPipelineV2.ts` | `30`, `41`, `55` | The security preamble (`<security_rules>…`) and the per-family `You are ${task}` preambles with their `<rules>`/`<workflow>` blocks. |

These are the confirmed starting points; grep for `You are ` and `SYSTEM_PROMPT`
under `src/infrastructure/llm` to find the full set.

## Proposed approach

The goal is **separation of text from logic** — keep the runtime interpolation in
TypeScript, move the static wording into files.

1. **Create a home for prompts**, e.g. `src/infrastructure/llm/prompts/`, with one
   file per logical prompt:
   - `videoScript.system.md`
   - `narrationRetime.system.md`
   - `oversizedFileSummariser.system.md`
   - `promptPipelineV2.securityRules.md`
   - `promptPipelineV2.familyPreamble.claude.md` / `.generic.md`
2. **Keep the dynamic parts as named placeholders.** The current prompts
   interpolate values like `${preambleDuration}`, `${totalDurRange}`,
   `${durList}`, `${task}`. Replace them with stable tokens (e.g. `{{durList}}`)
   and do the substitution in TypeScript, so the files stay free of code.
3. **Add a tiny loader/renderer helper**, e.g. `loadPrompt(name, vars)`, that
   reads the file and fills placeholders. Decide one mechanism for bundling the
   text (import as a string, `fs.readFileSync` at module load, or a small
   codegen step) and apply it consistently — call this out in the PR description
   so reviewers can weigh in.
4. **Replace the inline literals** in the files above with calls to the loader.
5. **Update the existing tests** that assert on prompt content so they import the
   same source of truth instead of re-stating the wording.

> Tip: this is naturally incremental. A reviewer-friendly PR can extract **just
> one prompt** (e.g. `oversizedFileSummariser.ts`, the smallest) to establish the
> pattern; follow-up PRs migrate the rest. Feel free to scope your PR that way.

## Acceptance criteria

- [ ] Prompt wording lives in dedicated files under a `prompts/` directory, not as
      multi-line template literals inside logic files.
- [ ] Dynamic values are interpolated in TypeScript via named placeholders; the
      prompt files contain no executable code.
- [ ] A single loader/renderer is used consistently for every extracted prompt.
- [ ] No behavioral change: the rendered prompt string for a given input is
      byte-for-byte identical to today (add/keep a snapshot test to prove this).
- [ ] `npm run lint`, `npm run typecheck`, and `npm test` all pass.

## Files you'll likely touch

- `src/infrastructure/llm/script-prompt.ts`
- `src/infrastructure/llm/oversizedFileSummariser.ts`
- `src/infrastructure/llm/promptPipelineV2.ts`
- new files under `src/infrastructure/llm/prompts/`
- the corresponding tests under `tests/unit/infrastructure/llm/`

## Why this is a good first issue

It's mechanical and low-risk (no behavior change), it has a built-in correctness
check (snapshot the rendered output before and after), and it can be scoped down
to a single prompt. Along the way the contributor learns the project's LLM
architecture and a pattern they'll reuse in any serious LLM codebase.
