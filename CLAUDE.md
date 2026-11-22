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
- The owner (svailla4) decides product direction, licensing and minor or major versions (patch releases are
  automatic, see Releasing); ask before changing those. Commit, push or open a pull request only when asked.

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

## Releasing

An installed plugin runs neither this checkout nor `plugin/dist`: the marketplace entry installs the `release` branch,
which `.github/workflows/release.yml` writes (decision D23):

- Every merge into `main` is released as the next patch version. The workflow runs check, test and build, and only
  then pushes the tag (`v0.1.2` after `v0.1.1`) and the built plugin. A failed run leaves no tag: fix `main` and the
  next merge releases. Never move or delete a pushed tag.
- A minor or major version is a tag pushed by hand, and only with the owner's go-ahead:
  `git tag -a v0.2.0 -m 'Glimpse 0.2.0' origin/main && git push origin v0.2.0`.
- After a merge, watch the release run (`gh run list --workflow release.yml`), then refresh the local install:
  `claude plugin marketplace update glimpse && claude plugin update glimpse@glimpse`, and `/reload-plugins` in an
  open session. `plugin update` compares versions only, so it does nothing before the new version has published.
- To try work that is not merged: `npm run build`, `claude plugin disable glimpse@glimpse` (so two `glimpse` servers
  do not clash), then `claude --plugin-dir <checkout>/plugin`.

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
  - `[[path#L10]]` refs in literal Text, Callout and Ask (`FILE_REF`, `fileRefs`, catalog `datasets.ts`) are checked
    like file props: missing files, directories and wrong case are reported at show time.
  Kept as they are, because models already know them and errors come back with suggestions: source refs
  (`'git.churn src top=20'`), view refs, `path#L10-20`, git ranges, `sort='-field'`, ERDiagram `fk:'users.id'`.
  Not done: `[[...]]` refs in text bound to a `$/path` and in Steps notes are not checked, and a file ref past the
  last line is reported nowhere.
- **D23: every merge into main is released (2026-11-21).** `release.yml` runs on pushes to `main` as well as on
  version tags, and releases a merge as the next patch version.
  Why: installs come from the `release` branch, and nothing had been tagged for a day of merges, so D21 and D22 were
  on `main` but not installable, and the owner tested an old build without knowing it. The tag is pushed by the same
  run after the build passes, not by a separate workflow: a tag pushed with `GITHUB_TOKEN` starts no other run, and a
  broken `main` should get no version. A commit that already has a version tag is left to that tag's run. Runs are
  serialized (`concurrency: release`), so each counts from the tag the last one pushed.
- **D26: no Markdown component; Text is the one text component (2026-11-21).** The owner's call: Markdown was only
  used for text. `Text` draws inline `code`, *em*, **strong** and `[[path#L10]]` refs and keeps line breaks; headings
  are a `Section`, tables a `DataTable`, code a `CodeBlock`. A spec that still writes `Markdown(...)` is drawn as Text
  with a `fixed` line that says what Text does not draw (`REMOVED_COMPONENTS`, server `spec/errors.ts`).
  Why: Markdown was a way around the catalog. A table or a code fence in it drew as plain HTML: no checks, dead paths,
  no sorting, no entity ids, so nothing could be selected, patched or (later) commented row by row, and a Markdown
  table hugged its content and left two thirds of its frame empty beside a DataTable that does all of that. Same
  reasoning as D21. Gone with it: `markdown-to-jsx`, its lazy chunk, and the fenced-block mode of `replaceFileRefs`.
  Long text is set in columns (`Text.tsx`, `Text.module.css`): over 400 characters, not `mono`, columns of at least
  34em once the box is 992 px wide. Why: Markdown capped prose at 72ch, so a full-width plate was half empty beside
  its text ("there is nothing next to it"), and Text had no measure at all. Short text is never set in columns: one
  filled column beside an empty one is the same hole.
  Tried and dropped: placing a lone text plate beside the next plate (a shared `pairProse` in the viewer, a `fixed`
  line from the server). It moved the hole below the text and halved the neighbour (a graph opened zoomed, with a
  minimap). Stretching plates to the height of their row would undo D20.
- **D27: only a problem is an A2UI renderer error (2026-11-21).** The tab posts a W_* or E_* report as an A2UI
  `error` message (`Name#id: text`), and I_* and OK as Glimpse `ComponentState`s in `RendererPost.states` (catalog
  `transport.ts`), beside the A2UI messages. The server refuses a problem posted as a state, and an I_* or OK posted
  as an `error` is only logged, never stored as the component's state (`ActionRouter.state`, server `actions.ts`).
  Why: the A2UI docs use `error` for validation and rendering failures. A truthful empty state ("no import cycles")
  or "draws as asked" is neither, so sending them as `error` bent the protocol (found by checking Glimpse against
  a2ui.org through context7). The model sees no change: the same report store, the same `viewer:` lines.
- **D28: no A2UI over MCP (2026-11-21).** The owner's call. The a2ui.org guide "A2UI over MCP" has the MCP server
  serve layout templates as `a2ui://` resources (`application/a2ui+json`), return `updateDataModel` in tool results
  with `_meta.ui.resourceUri`, and take clicks and errors as `a2ui_action` and `a2ui_error` tool calls, so that the
  MCP host draws the UI inline. Glimpse does not do this, and should not be made to.
  Why: Glimpse is meant to be used in the browser. Its views are drawn in its own tab beside the conversation, not
  inside the host, and that is what lets a view be large and live (a watched tree, drilling, a selection the code
  follows) and read files, diffs and table pages from the local server's HTTP endpoints, which an MCP host cannot
  reach. Following the guide would also cost two tool definitions from the instruction budget and put view data in
  tool results, which the model reads. Glimpse is not another MCP server whose UI the host renders. Revisit only if
  Glimpse is ever meant to draw inside a host.
