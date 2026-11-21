# Glimpse

Generative UI for codebases: an A2UI component catalog, a local React viewer and an MCP server that draws views of a
repository in a browser tab. A model writes a spec in A2UI Express; the server checks it, runs the data sources and
sends the view to the tab. See README.md for the full picture and CONTRIBUTING.md for the contribution terms.

## Maintainer

Claude (Claude Code) is the long-term maintainer of this codebase. Work in it as the person who will still own it
next year:

- Leave every change finished: code, tests, generated files, README, the skill and this file agree with each other.
  A half-migrated feature is a bug.
- Fix the cause, not the symptom, and say plainly what was not done or not verified.
- Record a design decision that changes how Glimpse behaves in the decision log below, with its reasons, so a later
  session does not undo it by accident.
- Keep the codebase small and legible: prefer removing code to adding options, and match the style already here.
- The owner (svailla4) decides product direction, licensing and releases; ask before changing those. Commit, push
  or open a pull request only when asked.

## Layout

```
packages/catalog/   the catalog, defined once: components, sources, presets, diagram data checks, docs, generated files
packages/server/    the MCP server: spec pipeline (spec/), sources (sources/), session and surfaces (session/), host (host/)
packages/viewer/    the React viewer: kit/ binds views to A2UI, components/ is the component library
plugin/             the Claude Code plugin: skill, hooks, built server and viewer (dist/ is build output)
e2e/                Playwright tests against the bundled server
scripts/            build, generate, budgets, notices
```

## Commands

```sh
npm run check       # Biome lint (warnings fail) + tsc for the root and each package
npm test            # vitest: unit and component tests (~30 s)
npm run generate    # rewrite packages/catalog/generated and fixtures; run after any change under packages/catalog/src
npm run build       # viewer + server bundle + skill + notices into plugin/; verifies the bundle starts
npm run budgets     # size budgets, measured on the build
npm run e2e         # Playwright (Chromium); needs `npx playwright install chromium` once
npm test -w @glimpse/viewer -- test/diagrams   # one area
```

Before calling work done: `check`, `test`, `build` and `budgets` pass, and `e2e` for anything the tab draws.

## Rules that are easy to break

- **The MCP server instructions have a hard budget.** `serverInstructions()` in `packages/catalog/src/docs.ts` must
  stay at or under `INSTRUCTIONS_TARGET` (3,750 characters; lines at most 320). Every character added is paid for by
  cutting another. The README's Development table states the current length and a test checks it.
- **A component's catalog entry stays under 1,000 characters** (`componentDoc`). Shapes are documented once in
  `SHAPES` (docs.ts); prop docs point at them instead of repeating them.
- **Accept a reasonable guess, and say so.** Aliases are rewritten with a `fixed` line; what cannot be drawn becomes a
  `warn` line or a `W_*` render report. Never drop what the author wrote without telling the model.
- **No invented string formats (D22).** A value an author writes is data (objects and lists), or follows a convention
  models already know: `path#L10-20` (GitHub), `main..HEAD` (git), `'git.churn src top=20'` (a command line). A new
  prop never gets a grammar of its own. Every string format that exists reads what it can, says what it corrected
  (`fixed`) and says what it could not read (`warn`, or a `W_*` report from the tab); it never falls back silently.
- **The server and the viewer share pure functions from the catalog**, so they always agree on what a value means.
- Do not commit `plugin/dist`. Never add a shipped dependency without a licence the build allows (`scripts/notices.ts`).

## Decision log

Decisions are cited by number in code comments (`decision D19`). Earlier ones are described where they are cited.

- **D21: diagrams are data, not a text notation (2026-11-21).** `Flowchart` and `SequenceDiagram` take structured
  data (`FlowData`, `SeqData` in `packages/catalog/src/diagrams.ts`) instead of Mermaid-style text.
  Why: Glimpse had its own parser for a subset of Mermaid. Models write full Mermaid from memory, so any syntax outside
  the subset either failed the whole page (`[[subroutine]]` cost a full resend of an 11.7k-character spec) or was
  silently dropped (`subgraph` and `loop` were ignored, losing the grouping the user asked for). Data is checked one
  entry at a time, so one bad node or step is left out and named while the rest draws; a diagram bound to `$/name`
  can be patched a node at a time (`$/name/nodes/ID={label:'...'}`); and there is no grammar to keep in step with
  Mermaid. Measured cost: about 4% more characters for a whole page. `cleanFlow` and `cleanSequence` run on the
  server (inline data in `expandComponent`, bound data in `diagramNotes`) and in the viewer (which reports `W_DROPPED`
  for data a patch wrote). Mermaid text is refused with `E_SHAPE` and an example of the data to write instead.
  Flowchart groups are drawn as nested frames by flowkit. Sequence blocks (loop, alt, opt, par, critical, break, with
  `else` branches) are written nested and drawn by the renderer from #5 (merged the day before D21), which `cleanSequence`
  feeds balanced open/else/end frame steps; #5's Mermaid block parsing and repair went with the parser.
- **D22: no invented string formats; no silent fallbacks (2026-11-21).** After D21, every prop whose string Glimpse
  takes apart was audited. One was an invented grammar; four read what they could and dropped the rest without a word.
  Why: the cost of a format is not its syntax but what happens when a model gets it wrong. A wrong value that is
  reported is fixed in one step; one that is dropped silently is never fixed. Now:
  - DataTable `columns` takes a list, `['path', {key:'commits', kind:'bar'}, {key:'last', kind:'date', label:'Last
    change'}]`, read by `readColumns` (catalog `notation.ts`). The presets' shorthand `'path commits:bar'` still reads.
    `columns` is a `value` prop (a DynamicValue the component reads itself), since a static prop may not be a union.
    Unknown kind: `E_ENUM`; entry with no key: left out, `warn`; unchecked data in the tab: `W_COLUMNS`.
  - Grid `cols` (`normalizeCols`, catalog `grid.ts`): `'2fr 1fr'`, `'50% 50%'`, `'two'` are rewritten with a `fixed`
    line; anything else draws equal columns with a `warn` line; the tab reports `W_COLS`.
  - Split `ratio`: a share rewritten to `'a:b'` is a `fixed` line; an unreadable ratio is a `warn` line.
  - CodeView and CodeBlock `mark` (`readLineMarks`, catalog `datasets.ts`): `'lines 10-20'`, `'10..20'`, `'20-10'` are
    rewritten with a `fixed` line; unreadable parts are a `warn` line; the tab reports `W_MARK`, also for marks past
    the last line.
  - `[[path#L10]]` refs in literal Text, Callout, Ask and Markdown (`FILE_REF`, `fileRefs`, catalog `datasets.ts`) are
    checked like file props: missing files, directories and wrong case are reported at show time.
  Kept as they are, because models already know them and errors come back with suggestions: source refs
  (`'git.churn src top=20'`), view refs, `path#L10-20`, git ranges, `sort='-field'`, ERDiagram `fk:'users.id'`.
  Not done: `[[...]]` refs in text bound to a `$/path`, in Steps notes and in Markdown links are not checked, and a
  file ref past the last line is reported nowhere.
