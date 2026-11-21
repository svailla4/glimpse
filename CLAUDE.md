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
  Flowchart groups are drawn as nested frames by flowkit; sequence blocks (loop, alt, opt, par, critical, break,
  group, with `else` branches) are drawn as frames.
