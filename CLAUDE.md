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
  automatic, see Releasing); ask before changing those. Finish work by committing, pushing the feature branch and
  opening a pull request without asking (owner, 2026-11-22); force-pushing a feature branch is allowed. Merge only
  when the owner says so, and never push to `main` directly.

## Layout

```
packages/catalog/   the catalog, defined once: components, sources, presets, diagram data checks, docs, generated files
packages/server/    the MCP server: spec pipeline (spec/), sources (sources/), session and surfaces (session/), host (host/)
packages/viewer/    the React viewer: kit/ binds views to A2UI, components/ is the component library
plugin/             the Claude Code plugin: skill, commands, hooks, built server and viewer (dist/ is build output)
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
which `.github/workflows/release.yml` writes (decision `release-every-merge`):

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
- **No invented string formats (`no-invented-string-formats`).** A value an author writes is data (objects and lists), or follows a convention
  models already know: `path#L10-20` (GitHub), `main..HEAD` (git), `'git.churn src top=20'` (a command line). A new
  prop never gets a grammar of its own. Every string format that exists reads what it can, says what it corrected
  (`fixed`) and says what it could not read (`warn`, or a `W_*` report from the tab); it never falls back silently.
- **The server and the viewer share pure functions from the catalog**, so they always agree on what a value means.
- **The viewer is compiled by the React Compiler (`compiled-viewer`).** A value read during render from something
  mutable (the A2UI surface and component models, a closure over outside state) is cached and never read again: read
  it through `useSyncExternalStore` (`kit/subscribe.ts`). A `useMemo` or `useCallback` dependency the callback does
  not read is dropped: make a refetch trigger part of the value. The viewer tests run compiled code.
- **A CSS custom property in a `style` object is a plain key: `style={{'--gl-span': span}}`.** `packages/viewer/src/css.d.ts`
  types every `--name` key, so it needs no cast and no helper. Never write `['--x' as never]` or `{...} as CSSProperties`:
  a cast is not checked, and the React Compiler leaves a function with a cast inside an object key uncompiled.
- Do not commit `plugin/dist`. Never add a shipped dependency without a licence the build allows (`scripts/notices.ts`).

## Decision log

Each decision has a short name that says what was decided, and code comments cite it by that name
(`decision content-sized-plates`), so a reader finds the reason with one search. A new decision gets a new name, never a
number: names read as words, and two branches cannot take the same one (numbers did, 2026-11-21). Until 2026-11-22
decisions were numbered D1 to D28; "was D20" keeps old commit messages and pull requests traceable. In anything people
read, write the decision in plain words and give the name beside it.

Decisions explained in the code that cites them:

| Name | Was | What was decided | Explained in |
|---|---|---|---|
| `drill-has-way-back` | D1 | A drill into a dataset is kept by the server and survives a reload; the scope row is the one way back | server `session/session.ts` (`drillOf`) |
| `hyphenated-surface-ids` | D2 | A view id may use letters, digits, `_` and `-`, because models write kebab-case first | server `mcp/show.ts` |
| `show-reports-what-tab-drew` | D3 | A `show` result says what the tab drew instead of a component, not a bare "ok" | server `mcp/show.ts` |
| `patch-sends-whole-slot` | D4 | A patch below a top-level slot is published as the whole slot, so bound views redraw | server `session/surfaces.ts` |
| `accept-familiar-variants` | D5 | Variants models commonly write (enum synonyms, 1-based steps, list-form ER) are read, not refused | server `test/spec/repair.test.ts` |
| `stable-category-colours` | D6 | A category keeps its colour on every plate; colours do not move as rows change | viewer `kit/color.ts` |
| `readable-module-graph` | D7 | The module graph is cut to what a plate shows legibly (about 24 nodes) | catalog `sources.ts` |
| `fresh-tree-every-call` | D8 | Every call checks HEAD, the working tree and the index first, tab or no tab | server `session/freshness.ts` |
| `untrusted-input-contained` | D10 | Repository and tab text cannot reach outside the inventory, pollute objects or forge result lines | server `mcp/result.ts`, `session/env.ts` |
| `header-keeps-title` | D11 | A plate header never loses its title or lets its controls out of the frame | viewer `kit/Frame.tsx` |
| `paths-keep-file-name` | D12 | A path cut for space keeps its file name: whole directories give way first | viewer `kit/entity.tsx` |
| `budgets-keep-headroom` | D13 | Every size budget keeps headroom under its hard limit, so the next component fits | `scripts/budgets.mjs` |
| `reports-are-component-state` | D14 | What the tab drew is each component's current state, not an event; only problems reach the model, once | server `session/reports.ts` |
| `guessed-fields-repaired` | D15 | A field name the author plainly meant is rewritten; anything else is dropped and said | server `spec/expand.ts` |
| `numbers-on-a-page-agree` | D16 | Each number on a page counts what the other plates on that page show | server `sources/files/repo.ts` |
| `layout-does-the-obvious` | D17 | `span` is always the 12-column grid, rows stay full, wide windows keep the spec's spans | viewer `components/layout/Grid.tsx`, `kit/arrange.tsx` |
| `diagrams-open-readable` | D18 | Every diagram opens with on-screen text of at least 10 px | viewer `components/diagrams/flowkit/sizing.ts` |
| `diagram-engine-in-worker` | D19 | One diagram engine: ELK lays out in a same-origin worker, React Flow draws | viewer `components/diagrams/flowkit/Diagram.tsx` |
| `content-sized-plates` | D20 | A plate is as tall as its content; `size` is a maximum; plates are not stretched to their row | viewer `kit/sizeCap.ts`, `styles/base.css` |
| `one-zoom-bar` | — | Every diagram that zooms draws the one zoom bar, with the same buttons, keys and limits; only its zoom arithmetic and the bar's place are its own | viewer `components/diagrams/flowkit/ZoomBar.tsx` |
| `scroll-pans-what-overflows` | — | A two-finger scroll pans a diagram that does not fit and scrolls the page otherwise; a gesture stays with what it first moved | viewer `components/diagrams/flowkit/Diagram.tsx` |

Decisions explained here:

- **`diagrams-are-data`: diagrams are data, not a text notation (was D21, 2026-11-21).** `Flowchart` and `SequenceDiagram` take structured
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
  `else` branches) are written nested and drawn by the renderer from #5 (merged the day before `diagrams-are-data`), which `cleanSequence`
  feeds balanced open/else/end frame steps; #5's Mermaid block parsing and repair went with the parser.
- **`no-invented-string-formats`: no invented string formats; no silent fallbacks (was D22, 2026-11-21).** After `diagrams-are-data`, every prop whose string Glimpse
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
  last line is reported nowhere. (Since `links-through-node-ids` the `file` of a Flowchart node, Layers item, ER table and Steps item is
  checked at show time, inline or bound to a `$/path`.)
- **`release-every-merge`: every merge into main is released (was D23, 2026-11-21).** `release.yml` runs on pushes to `main` as well as on
  version tags, and releases a merge as the next patch version.
  Why: installs come from the `release` branch, and nothing had been tagged for a day of merges, so `diagrams-are-data` and `no-invented-string-formats` were
  on `main` but not installable, and the owner tested an old build without knowing it. The tag is pushed by the same
  run after the build passes, not by a separate workflow: a tag pushed with `GITHUB_TOKEN` starts no other run, and a
  broken `main` should get no version. A commit that already has a version tag is left to that tag's run. Runs are
  serialized (`concurrency: release`), so each counts from the tag the last one pushed.
- **`links-through-node-ids`: links are one hub of diagram node ids; a message is a path (was D24, 2026-11-21).** An item names the diagram node it
  stands for with `node:'ID'` (or a list; `nodes` is fixed to `node`): Layers and Steps items, ER tables, rows of a
  DataTable that do not come from a source, and sequence actors, whose node is their id unless given. A sequence
  message may list the nodes it passes through, `via:['CDN','Q']` (a list, or `{via}`, after a list message's label or
  arrow is read as its via, with a `fixed` line; further elements are a `warn` line). Flowchart nodes gain `note` and
  `file`: the note shows on hover and in the plate margin, and a file makes the node carry a path, so CodeView follows
  it and Cmd-click opens it. `path` is read as `file` (and a node's `notes` as `note`) with a `fixed` line on every
  item that takes a file. One reader, `readNodes` (catalog `links.ts`, kept apart from `diagrams.ts` so eager Steps
  stays small), and `rowNodes` for table rows (`rowlinks.ts`, so it stays out of the eager script).
  - DataTable rows (owner's rule): a row links only through a field named exactly `node` holding a text id or a list
    of them; `nodes` is not read and numbers are not ids. What a row's node did not link is said only when the view
    declares diagram nodes and one of the table's rows names one of them (`linkNotes`), worded `row 2: node null is
    not a node id, not linked`, never `not drawn` (the row draws). Otherwise nothing is said. Why: a row is data. The
    review found `{cluster, nodes:12}` tables told `nodes -> node`, pods with `node:null` told their rows were not
    drawn, and a column of counts read as node ids that cross-linked other parts; each line asked the model to rename
    correct data.
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
  identity. Budgets: the diagrams chunk limit went from 36 to 43 kB by the `diagram-engine-in-worker` rule (measured plus about 15%).
  Not done: the rename of a file in diagram or Steps data written in another case. Where the file system ignores
  case it opens, so the check says it (`"CALC.ts" is "src/calc.ts" on disk; write that`, `checkNamed`), but the
  selection keeps the spelling written until the model fixes it; where case matters it is a missing file. Also not
  done: `fixed` lines for Steps status synonyms, links on List, charts and Stats, edge selection, and `[[refs]]` in
  diagram notes.
- **`what-if-as-a2ui-calls`: what-if inputs and computed values are A2UI calls (was D25, 2026-11-21).** `add|sub|mul|div(a, b)`, written
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
    keeps what the user set, with a `fixed $/w/seats stays 80000 (set in the tab)` line, held to the min and max of
    the Slider shown now (the line then says `set in the tab to 80000, held to the Slider's range`). Only own
    properties of the data are read (`lookup`), so `$/w/toString` is an unset path. The server recomputes what
    reads the path and puts it, or why it failed, in one coalesced `viewer: set` line (`events.latest`): per
    component the values that computed, then one group per distinct problem.
  - Checks, for what the upstream compiler does silently or reports in its own words (`no-invented-string-formats`): a function written
    another way (`multiply`, `Div`, `mult`) is renamed at every call before the first compile, one `fixed` line per
    name, so aliases never spend repair passes. An unknown callee is read by `calleeKind` (errors.ts): a lower-case
    name that is a component or a word of one in another case (`table` -> DataTable, `tree` -> FileTree), or a near
    miss of one longer than four letters (`tabel`), is that component; a word of several (`chart`) is `E_UNKNOWN ...
    not a component or a function` with both lists; any other lower-case name is `E_UNKNOWN` with the four names, so
    `pow` is never repaired to `Row`; `catalog{}` answers such a name with the four too, and gives their doc once per
    call. A missing or wrong-typed operand is `E_TYPE`, an unknown keyword `E_PROP`; `*` and `+` get the "no
    operators" hint; a third positional argument is `E_TYPE`; a bare call statement and a named call nothing uses are
    `warn` lines (in a whole spec `nothing uses rps`; in a patch, resend the parts that use it; a patch of only such a
    call is the `E_REF` with that text); a call in `$/data` or as an action, a Slider bound to a literal, a call, a
    relative path or a path under `/ui`, `/ds` or `/meta`, `min >= max` and a seed outside min..max are reported;
    `calcNotes` warns about a call that cannot compute from the model's own data, and about a relative `$path` inside
    a call (reason `relative`). Inline diagram, Steps and table data is checked as the tab draws it (`asDrawn`,
    authored.ts): A2UI computes the calls and resolves the `$/paths` inside a component's arguments before the view
    reads them, so a call is checked as its number, and inline data with `$/paths` inside is checked by
    `diagramNotes` against the data model. Judging the call or binding objects themselves gave `not drawn` lines for
    parts that drew.
  Why: `fn(args)` is A2UI's own convention, so there is no grammar of ours (`no-invented-string-formats`), and A2UI already does reactivity and
  two-way binding. Outputs stay ordinary props, so any Stat, Stats row or table cell can show one and `links-through-node-ids` links can
  reach them. Rejected: a formula string (a grammar, refused as Mermaid was under `diagrams-are-data`); a self-contained what-if
  component with JSON Logic (its outputs reach no other component, and the numbers live in one browser); a tab-side
  call reporter (eager code, and it would blame the model for the user's input); `sum` and `product` of up to 8
  arguments and no `sub`; `round`; storing inputs under `/ui`.
  Budgets: instructions 3,748 (`Components (? optional):` paid for the Slider index entry), 3,723 once merged with
  `no-markdown-component`. The eager script did not fit: the component `example` strings (44 since `no-markdown-component`) moved from `ComponentMeta` to
  `COMPONENT_EXAMPLES` in docs.ts, since the tab never reads them (about 1.4 kB gzip); it was 194,207 of 195,000 bytes
  with the Slider, 193,782 once merged with `no-markdown-component`, 193,927 once merged with `only-problems-are-errors`. GRAMMAR rule 9 is shorter than designed, to stay under F043's 1,600
  characters.
  Not done: a call reading `/ds` is not checked at show time; the model resets a number only by writing its leaf
  path; a second tab sees a set number at its next snapshot; a number set after the session ended changes only the
  tab; a step of 0 or less is read as no step without a report; a call with a relative `$path` is warned at show
  time but left out of the `viewer: set` line. A call in data bound to a `$/path` is not computed
  (the `$/data` warning says so), and the tab then draws a diagram label holding one as its id, without a report of
  its own.
- **`no-markdown-component`: no Markdown component; Text is the one text component (was D26, 2026-11-21).** The owner's call: Markdown was only
  used for text. `Text` draws inline `code`, *em*, **strong** and `[[path#L10]]` refs and keeps line breaks; headings
  are a `Section`, tables a `DataTable`, code a `CodeBlock`. A spec that still writes `Markdown(...)` is drawn as Text
  with a `fixed` line that says what Text does not draw (`REMOVED_COMPONENTS`, server `spec/errors.ts`). A removed
  name is read in any case, as `what-if-as-a2ui-calls` reads a component name (`removedComponent`): `markdown(` is Text with the same
  line, where main alone, before `what-if-as-a2ui-calls`, gave `E_UNKNOWN`. `catalog{names:['Markdown']}` answers with Text's entry and
  the same note, not with near misses.
  Why: Markdown was a way around the catalog. A table or a code fence in it drew as plain HTML: no checks, dead paths,
  no sorting, no entity ids, so nothing could be selected, patched or (later) commented row by row, and a Markdown
  table hugged its content and left two thirds of its frame empty beside a DataTable that does all of that. Same
  reasoning as `diagrams-are-data`. Gone with it: `markdown-to-jsx`, its lazy chunk, and the fenced-block mode of `replaceFileRefs`.
  Long text is set in columns (`Text.tsx`, `Text.module.css`): over 400 characters, not `mono`, columns of at least
  34em once the box is 992 px wide. Why: Markdown capped prose at 72ch, so a full-width plate was half empty beside
  its text ("there is nothing next to it"), and Text had no measure at all. Short text is never set in columns: one
  filled column beside an empty one is the same hole.
  Tried and dropped: placing a lone text plate beside the next plate (a shared `pairProse` in the viewer, a `fixed`
  line from the server). It moved the hole below the text and halved the neighbour (a graph opened zoomed, with a
  minimap). Stretching plates to the height of their row would undo `content-sized-plates`.
- **`only-problems-are-errors`: only a problem is an A2UI renderer error (was D27, 2026-11-21).** The tab posts a W_* or E_* report as an A2UI
  `error` message (`Name#id: text`), and I_* and OK as Glimpse `ComponentState`s in `RendererPost.states` (catalog
  `transport.ts`), beside the A2UI messages. The server refuses a problem posted as a state, and an I_* or OK posted
  as an `error` is only logged, never stored as the component's state (`ActionRouter.state`, server `actions.ts`).
  Why: the A2UI docs use `error` for validation and rendering failures. A truthful empty state ("no import cycles")
  or "draws as asked" is neither, so sending them as `error` bent the protocol (found by checking Glimpse against
  a2ui.org through context7). The model sees no change: the same report store, the same `viewer:` lines.
- **`no-a2ui-over-mcp`: no A2UI over MCP (was D28, 2026-11-21).** The owner's call. The a2ui.org guide "A2UI over MCP" has the MCP server
  serve layout templates as `a2ui://` resources (`application/a2ui+json`), return `updateDataModel` in tool results
  with `_meta.ui.resourceUri`, and take clicks and errors as `a2ui_action` and `a2ui_error` tool calls, so that the
  MCP host draws the UI inline. Glimpse does not do this, and should not be made to.
  Why: Glimpse is meant to be used in the browser. Its views are drawn in its own tab beside the conversation, not
  inside the host, and that is what lets a view be large and live (a watched tree, drilling, a selection the code
  follows) and read files, diffs and table pages from the local server's HTTP endpoints, which an MCP host cannot
  reach. Following the guide would also cost two tool definitions from the instruction budget and put view data in
  tool results, which the model reads. Glimpse is not another MCP server whose UI the host renders. Revisit only if
  Glimpse is ever meant to draw inside a host.
- **`views-are-blueprints`: the skill teaches what to draw, one guide per task (2026-11-22).** The owner's call, after
  a review page that was a raw diff "doesn't explain the architecture and why those decisions were taken": a view is a
  blueprint for the people who build, approve or maintain the code. Intent first, plain words, one claim per figure,
  every reason sourced, and code only as short evidence, least of all in a design; the rest of the code is one click
  away (a `file=` on a box, a `CodeView()` that follows the selection). The plugin skill is generated by
  `pluginFiles()` (catalog `skill.ts`): a core `SKILL.md` (when to draw, what every view does, how to use the live tab,
  the reader check, the spec reference, quick recipes) and one guide per task under `references/` (`design.md`,
  `review.md`, `explain.md`), each with its page order and the worked examples of `EXAMPLES` tagged with its `guide`.
  `/glimpse:design`, `/glimpse:review` and `/glimpse:explain` (`commands/`) load the skill with a guide. Before a
  design, a review or an explanation is called ready, a fresh agent that has not seen the conversation answers five
  questions about the page (`READER_PROMPT`), and the author patches what it found.
  Why: research across Anthropic's skill guidance and artifact skills, visual-explainer, superpowers, EGM, Google's
  design-doc and review practice, C4 and ADRs. One skill rather than one per task: skills that teach the same job
  compete, and a model follows one and drops the other's rules (a preprint measured 93-99% rule-following alone, about
  61% with a second same-job skill; read at the abstract only), and Anthropic's guide puts per-task workflows in files
  read for that task. Worked examples steer a model more than rules do, and a wrong example teaches a wrong page, so
  each is printed once (in its guide, or in SKILL.md for a quick recipe) and server `test/session/skill.test.ts` shows
  every recipe and allows no `fixed` line and no `warn` line but the missing example paths. The live tab is what no
  static-page skill covers: code behind a click, linked parts, questions answered in the tab, patches instead of
  redraws. The server instructions are unchanged (they stay within their budget); all of this is skill text.
  Measured (2026-11-22, v0.1.6, one run per task, so a direction and not a statistic): the same three requests (design
  comments on a view, review pull request #11, explain how a `show` call becomes a page) drawn by fresh agents with the
  old skill and with this one, scored blind on seven criteria out of 35: design 23 -> 29, review 17 -> 32, explain
  19 -> 29. Code on the page fell from a 4-stop tour (about 154 lines) to two short sketches in the design, and from
  a 13-stop tour (about 447 lines) to none in the explanation, the code opening from the map on a click. The cost:
  specs 1.7 to 2.9 times longer and about 4.7 minutes a page instead of 3.3, most of it the reader check. The judge
  still found a wrong budget figure and a line range opening the wrong function on the winning pages, and a review
  of 12 parts for one merge decision: hence numbers and ranges read in the session (rule 7), the reader's sixth
  question (check three claims in the repository) and the review's limit of about eight parts.
  Not done: re-measuring after those three changes; a check that a cited line range starts at the symbol it names.
- **`compiled-viewer`: the React Compiler compiles the whole viewer (2026-11-22).** The owner's call. The viewer build
  and the viewer tests run `babel-plugin-react-compiler` 1.0 through `@rolldown/plugin-babel` (`reactCompiler()` in
  `packages/viewer/vite.config.ts`, imported by `vitest.config.ts`), on every file under `src/`; node_modules are left
  as published. The compiled code imports `react/compiler-runtime`, part of `react`, so no shipped dependency was added.
  Why: memoization by hand is easy to get wrong and is spread over every view; the compiler memoizes each component and
  hook by what it reads. Rejected: compiling only the lazy chunks (the eager script still reached 200.0 kB, as layout
  and content are eager); annotation mode (`'use memo'` per component, little benefit until components are marked);
  the Rust port `oxc-transform-react` (plugin-react marks it experimental).
  Cost, measured gzip: the eager script 193.8 -> 204.6 kB, so its limit went from 195 to 210 kB and the hard figure
  from 200 to 215 kB (the owner's figures); the diagrams chunk 39.2 -> 45.1 kB, line 43 -> 52 kB by the
  `diagram-engine-in-worker` rule; charts 48.6 -> 60.3, table 24.1 -> 28.8, code 13.9 -> 20.5 kB.
  What it broke, and the rule it gives (see Rules that are easy to break): `useRows` listed the envelope and the
  revision as `useMemo` dependencies its callback did not read, so the compiler dropped them and a re-run never
  refetched (they are fields of the request now); `useCalcNote` read a Slider's bound path from the component model
  during render, so a Slider the spec rebound kept its old path (now a `useSyncExternalStore` snapshot through
  `subscribeComponent`, with a test); the test harness read the surface during render and kept the deleted one.
  Nine components were left uncompiled by a cast inside a style key (`['--kv-cols' as never]`); `css.d.ts` now types
  custom properties, so every cast and the `vars()` helper went (see Rules that are easy to break), and they compile:
  the eager script 204.6 -> 205.4 kB, table 28.8 -> 34.2, code 20.5 -> 22.0 kB.
  Not done: 30 functions are left uncompiled (184 compile), which the compiler does silently (they run as written):
  most read a ref during render (the latest-value pattern in `kit/hooks.ts`, `kit/report.ts`, flowkit,
  `chartkit/Chart.tsx`), some use syntax it does not read yet (`||=`, `??=`, a getter in an object literal), and
  `table/nav.ts` uses `@tanstack/react-virtual`, which it marks incompatible. `DateCell` is compiled, so its age
  ("3 d") is kept until its date changes, also across midnight. No lint rule for the Rules of React (Biome has none).
