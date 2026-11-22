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
  - `[[path#L10]]` refs in literal Text, Callout, Ask and Markdown (`FILE_REF`, `fileRefs`, catalog `datasets.ts`) are
    checked like file props: missing files, directories and wrong case are reported at show time.
  Kept as they are, because models already know them and errors come back with suggestions: source refs
  (`'git.churn src top=20'`), view refs, `path#L10-20`, git ranges, `sort='-field'`, ERDiagram `fk:'users.id'`.
  Not done: `[[...]]` refs in text bound to a `$/path`, in Steps notes and in Markdown links are not checked, and a
  file ref past the last line is reported nowhere. (Since D24 the `file` of a Flowchart node, Layers item, ER table
  and Steps item is checked at show time, inline or bound to a `$/path`.)
- **D23: every merge into main is released (2026-11-21).** `release.yml` runs on pushes to `main` as well as on
  version tags, and releases a merge as the next patch version.
  Why: installs come from the `release` branch, and nothing had been tagged for a day of merges, so D21 and D22 were
  on `main` but not installable, and the owner tested an old build without knowing it. The tag is pushed by the same
  run after the build passes, not by a separate workflow: a tag pushed with `GITHUB_TOKEN` starts no other run, and a
  broken `main` should get no version. A commit that already has a version tag is left to that tag's run. Runs are
  serialized (`concurrency: release`), so each counts from the tag the last one pushed.
- **D24: links are one hub of diagram node ids; a message is a path (2026-11-21).** An item names the diagram node it
  stands for with `node:'ID'` (or a list; `nodes` is fixed to `node`): Layers and Steps items, ER tables, rows of a
  DataTable that do not come from a source, and sequence actors, whose node is their id unless given. A sequence
  message may list the nodes it passes through, `via:['CDN','Q']`. Flowchart nodes gain `note` and `file`: the note
  shows on hover and in the plate margin, and a file makes the node carry a path, so CodeView follows it and Cmd-click
  opens it. One reader, `readNodes` (catalog `links.ts`, kept apart from `diagrams.ts` so eager Steps stays small).
  - Selection: `EntityRef.nodes` carries the ids and `parseEntity` keeps 1 to 16 of them (anything else is dropped
    whole), so a trace survives a show and a reload. `ENTITY_TYPES` lives in the catalog. A message selects
    `{type:'message', id:'<comp>:<n>', nodes:[from, ...via, to]}`; an ER table always selects a `node`, with its path.
    Two `node` entities on one file are one place only where their line ranges meet.
  - Matching (`matchSelection` returns `'linked'`): an entity standing for one node lights when the selection names
    it; one standing for several lights when it stands for every node the selection names. One hop; links never
    chain. In flowkit only a node that is itself selected lights its neighbours; a linked node lights alone; a
    selection that is not a node lights only the edges between consecutive ids of its list (`legsOf`, by `edge.key`).
  - Checks: the Layers and ER readers moved to the catalog as `Clean<T>` cleaners (`cleanLayers`, `cleanSchema`), so
    unknown keys and bad entries are reported by the server and by the tab (`W_DROPPED`); inline Layers or ER data
    that is not the shape is now `E_SHAPE`. The server checks the files that diagram and Steps data name, after the
    files of props (`FileCheck.nested`), so under the cap on warning lines a plate whose own file is missing is never
    crowded out by links inside diagrams; and Steps keys (`cleanItems`). `linkNotes` warns when an id links to nothing
    on the view, naming the label it may mean or the nearest id. The gallery links its diagrams through node DB, and
    its files are lines of its one real file.
  Why: same-id `{type:'node'}` matching already linked Flowchart, ER and Graph by accident. Making that the documented
  hub costs one authored field and one EntityRef field, no new component or prop, 2 instruction characters and no
  grammar. Rejected: per-part id scoping (it breaks today's links and about 20 selection tests); link tags
  (`link:'pg'`, a second key space); a shortest path inferred through the Flowchart (a guess drawn as fact, where
  `via` says it); hiding a DataTable `node` column (it would hide real data); a global line-overlap rule for file
  identity. Budgets: the diagrams chunk limit went from 36 to 43 kB by the D19 rule (measured plus about 15%).
  Not done: a case fix inside nested files (a wrong case is only warned), `fixed` lines for Steps status synonyms,
  links on List, charts and Stats, edge selection, and `[[refs]]` in diagram notes.
- **D25: what-if inputs and computed values are A2UI calls (2026-11-21).** `add|sub|mul|div(a, b)`, written
  `div($/a,2)`, are A2UI function calls that the tab recomputes when a `$/path` they read changes; each argument is a
  number, an absolute `$/path` or another call, in any component argument and in inline rows. There are no operators
  and no `round`. `Slider(label, value, min?, max?, step?, unit?)` writes the `$/path` its value binds, through the
  binder's own `setValue`.
  - Catalog: `calc.ts` defines the four once, with strict schemas for the server and catalog.json (`calcApis`) and
    permissive ones for the tab (`calcFunctions`: a held value that is not a number gives no value, never an
    `EXPRESSION_ERROR` that only reaches the log). `calcName` reads a name, another case or an alias for the server's
    repair (`fixed multiply -> mul`) and for `catalog{names:['div']}`. The messages that say why a value is not
    computed (`explainValue`) and the readers of calls in props (`callsIn`, `reads`) are in `calls.ts`, apart from
    `calc.ts`, because the eager script imports `calc.ts` and a module it imports is bundled whole.
  - Tab: the Slider is in the lazy `charts` chunk, with its note hook in `kit/calcNote.ts` (views never import
    `@a2ui/*`). It writes while typing only a finite number within min and max, and commits one `gl_set {value}` on
    Enter, blur, range pointer-up or key-up, 600 ms idle or unmount. A bound value that is not a number is `W_VALUE`,
    reported and shown under the field; a value the user's number makes uncomputable is a note under the field and
    never a `viewer: error`.
  - Server: `gl_set` carries only the number. The path comes from the stored Slider's binding and the number is held
    to its min and max, so a tab can set only the numbers the model bound; `setInput` refuses a path it cannot write.
    The number goes into `record.data`, not `/ui` (writing `/ui` drops the selection), so a reload, a patch and a
    replace keep it. A spec that writes the exact path wins; re-sending an enclosing value whose leaf is unchanged
    keeps what the user set, with a `fixed $/w/seats stays 80000 (set in the tab)` line. The server recomputes what
    reads the path and puts it, or why it failed, in one coalesced `viewer: set` line (`events.latest`): per
    component the values that computed, then one group per distinct problem.
  - Checks, for what the upstream compiler does silently or reports in its own words (D22): an unknown function is
    `E_UNKNOWN` with the four names (a name is a function when `calcName` reads it, or it starts with a lower-case
    letter and no component has that name in any case, or it is a capitalised near miss of a function with no
    component near it, so `pow` is never repaired to `Row`); a missing or wrong-typed operand is `E_TYPE`, an unknown
    keyword `E_PROP`; `*` and `+` get the "no operators" hint; a third positional argument is `E_TYPE`; a bare call
    statement and a named call nothing uses are `warn` lines (a patch of only such a call is the `E_REF` with that
    text); a call in `$/data` or as an action, a Slider bound to a literal, a call, a relative path or a path under
    `/ui`, `/ds` or `/meta`, and `min >= max` are reported; `calcNotes` warns about a call that cannot compute from
    the model's own data.
  Why: `fn(args)` is A2UI's own convention, so there is no grammar of ours (D22), and A2UI already does reactivity and
  two-way binding. Outputs stay ordinary props, so any Stat, Stats row or table cell can show one and D24 links can
  reach them. Rejected: a formula string (a grammar, refused as Mermaid was under D21); a self-contained what-if
  component with JSON Logic (its outputs reach no other component, and the numbers live in one browser); a tab-side
  call reporter (eager code, and it would blame the model for the user's input); `sum` and `product` of up to 8
  arguments and no `sub`; `round`; storing inputs under `/ui`.
  Budgets: instructions 3,748 (`Components (? optional):` paid for the Slider index entry). The eager script did not
  fit: the 45 component `example` strings moved from `ComponentMeta` to `COMPONENT_EXAMPLES` in docs.ts, since the tab
  never reads them (about 1.4 kB gzip); it is 194,149 of 195,000 bytes with the Slider. GRAMMAR rule 9 is shorter
  than designed, to stay under F043's 1,600 characters.
  Not done: a call reading `/ds` is not checked at show time; the model resets a number only by writing its leaf
  path; a second tab sees a set number at its next snapshot; a number set after the session ended changes only the
  tab; a step of 0 or less is read as no step without a report. A call inside diagram data is not computed: a Layers
  item or ER entry holding one is left out with a warning, but a Flowchart or sequence label holding one is drawn as
  the id (or empty) with no report, a D22 gap in `labelOf` and the message reader that predates D25.
