# Glimpse

Generative UI for codebases. Glimpse lets a coding agent *show* you a repository instead of describing it: an architecture map, a churn-against-complexity scatter, a sortable hotspot table, a diff with its blast radius, a guided tour through a file. The agent writes a few lines naming components and data sources; a local server computes the data on your machine and a browser tab draws it.

Glimpse is two things:

- **A component library**: 44 React components behind an [A2UI](https://a2ui.org) v1.0 catalog, drawn in one design language, Linework.
- **An MCP server** with five tools. It compiles the agent's spec, runs the repository analyzers, and hosts the viewer on `127.0.0.1`.

**Status: working but young.** All 44 components, the 26 data sources, the ten preset views and the five tools are implemented and covered by unit, component and end-to-end tests. It has been run on macOS with Chromium only and has had one round of testing with a model writing the specs. [Status and known limitations](#status-and-known-limitations) has the details.

## What it looks like

There are no screenshots here yet, so in words. A view is a sheet of warm paper under a hairline top bar. Each titled component is a *plate*: a frame with small registration ticks at the corners, a vermilion `PL. 03` numeral and a serif title, like a figure in an engineering atlas. Text is IBM Plex with Newsreader for titles and the large numerals; code and identifiers are monospace. Colour is used for data: a language or a module keeps the same ink in every plate of the session, and vermilion marks the selection. There is a dark theme (`t`) and a denser row height (`d`).

Everything is linked. Click a file in a table, a treemap cell, a graph node or a commit and it becomes the selection everywhere: a `CodeView` beside a `FileTree` is a file browser with no wiring. Diagrams you write link the same way: a Layers or Steps item, an ER table, a table row or a sequence actor with `node:'PG'` lights with Flowchart node PG, and a selected message lights the boxes and arrows it passes through. Tables sort, filter and page; graphs pan, zoom and let you drag nodes; plates can be dragged into another order or resized, and the tab remembers. While data is being computed a plate shows a *drafting* frame at its final size; a failure is a *redline* with the error code, confined to that plate.

## Why

Asking a model to write an HTML page for every explanation is slow and costs thousands of tokens. Glimpse turns that around:

- **The model names things; it does not draw them.** `show{view:"overview"}` is about five output tokens. A bespoke view is a few lines of spec, 20 to 160 tokens.
- **Data stays on your machine.** The agent writes `DataTable('git.churn src/auth top=20')`. The rows are computed locally and bound straight into the page; they never pass through the model. The tool result carries a one-line summary per dataset (row count, field names, the top row) so the agent can talk about what you see.
- **The agent is told what you actually see.** A result lists what the server corrected for it (`fixed`) and what the tab could not draw (`warn`), so an `ok` is not a guess.
- **A standard wire format.** Server and viewer speak A2UI v1.0, and the catalog is published as `catalog.json`.

The whole up-front cost for the agent is the server instructions (about 3,700 characters) plus two tool definitions (about 1,150 characters): roughly 1,250 tokens per session.

## Install

Requirements: Node 22.18 or newer and `git` on the PATH.

### As a Claude Code plugin

```sh
claude plugin marketplace add svailla4/glimpse
claude plugin install glimpse@glimpse
```

Then start Claude Code in any project and ask for something: "show me an overview of this repo", "what does this branch change?", "walk me through `src/auth/service.ts`". The first view opens a browser tab.

The plugin brings the MCP server, a skill that tells Claude when to use Glimpse and what a good view of a design, a review or an explanation looks like, the commands `/glimpse:design`, `/glimpse:review` and `/glimpse:explain`, and a `UserPromptSubmit` hook that passes along what you clicked in the tab since your last prompt. Nothing is built on your machine: the install comes from the `release` branch, which the release workflow builds from each version tag.

To update: `claude plugin update glimpse@glimpse` (or turn on auto-update for the marketplace under `/plugin`), then `/reload-plugins` in an open session.

### From source

`plugin/dist` (the bundled server and the built viewer) is build output and is not committed on `main`. To run your own build:

```sh
git clone <this repository> glimpse
cd glimpse
npm install          # .npmrc sets ignore-scripts: no dependency runs code at install time
npm run build        # writes plugin/dist/server.mjs, plugin/dist/viewer/, the skill and the commands
```

The build also writes the third-party notices, `plugin/dist/THIRD_PARTY_NOTICES.md`, and the licence files that the fonts and the ELK layout engine need next to them (see [Licence](#licence)).

`npm run build` ends by starting the bundle from an empty directory to check that it runs with no `node_modules`. After it, `plugin/` is a complete Claude Code plugin and `plugin/dist/server.mjs` is a self-contained MCP server.

To use your build with Claude Code, start it in the project you want to look at, pointing at the built plugin (the marketplace entry always installs the published release, not your checkout):

```sh
cd /path/to/your/project
claude --plugin-dir /path/to/glimpse/plugin
```

Rebuild (`npm run build`) after pulling changes.

### Releasing

Every merge into `main` is released as the next patch version. The release workflow (`.github/workflows/release.yml`) runs the check, the unit tests and the build on macOS, then tags the merge (`v0.1.2` after `v0.1.1`), sets the plugin's version from it and pushes the built plugin to the `release` branch, where installs and updates come from. A failed run leaves no tag. For a minor or major version, push the tag by hand: `git tag v0.2.0 && git push origin v0.2.0`.

### As a plain MCP server

The bundle is one file with no dependencies to install. For any MCP host that speaks stdio, in `.mcp.json` or the host's equivalent:

```json
{
  "mcpServers": {
    "glimpse": {
      "command": "node",
      "args": ["/path/to/glimpse/plugin/dist/server.mjs", "--root", "/path/to/your/project"]
    }
  }
}
```

The project root is `CLAUDE_PROJECT_DIR` when the host sets it, else `--root`, else the directory the server is started in. Without the plugin's hook, what you do in the tab reaches the agent on its next Glimpse call or through the `events` tool.

### Without an agent

```sh
npm run demo                    # this repository
npm run demo -- ../some-repo    # any other
```

The demo plays the agent's part: it starts the server, calls `show` three times (gallery, overview, working-tree diff), opens the tab and prints each tool result with what the call cost.

### Settings

| Variable | Effect |
|---|---|
| `GLIMPSE_PORT` | Preferred port (default 4517, then the next 19, then any free port; `0` picks any free port). |
| `GLIMPSE_NO_OPEN=1` | Never open a browser tab or an editor; the tool result carries the link instead. |
| `GLIMPSE_EDITOR` | Command that opens a file from the viewer, for example `code -g {file}:{line}`. Without it Glimpse uses the first editor it knows on the PATH (`code`, `cursor`, `zed` and a few more). If there is none, nothing is opened: a repository file is never handed to the system's default opener. |

## Tools

| Tool | Purpose |
|---|---|
| `show` | Render a preset (`view`), a custom view (`id` plus `spec`), or patch a view that is already open (its `id` plus only the parts that change). Returns the dataset summaries, the named parts of the view, what was corrected, what the tab could not draw, and anything you did in the tab. |
| `catalog` | Look up a component (its props, the shape of its data with an example), a data source, a preset (`view:diff` returns its source, which doubles as an example), the spec grammar or worked examples. |
| `query` | Run a data source and return a few rows as text, without rendering, so the agent can ground what it says. |
| `events` | What you did in the tab since the last Glimpse call: selections, button presses, answers, numbers set with a Slider. Can wait for the next one. |
| `pending_context` | Used by the plugin's hook; hidden from the model. |

A result is plain text, one fact per line:

```
ok server-package http://127.0.0.1:4517/#/server-package tab=live 334ms
fixed Callout.kind warning -> warn
ds git.churn packages/server top=10 | 10/115 rows; fields path commits authors owner ownership last; in packages/server; top ...
ds (+1 unchanged)
parts intro deps churn note code
warn CodeView#code: file "packages/server/src/nope.ts" does not exist. Nearest: packages/server/src/main.ts ...
viewer: select file packages/server/src/mcp/show.ts (server-package)
```

`fixed` lines are guesses the server accepted and corrected (a misspelt prop, `warning` for `warn`, a number where a string was expected, a new part appended to the page, `multiply` for `mul`, a number you set in the tab kept over a re-sent seed). Field names are checked the same way against the fields a source declares, so a guessed name never leaves an empty plate: a different case, a column label or a common synonym is rewritten (`fixed x 'churn' -> 'commits'`), and a name the source does not have is dropped, so the chart falls back to its own axes (`fixed x 'zzz' dropped (fields: ...)`). `ds (+N unchanged)` stands for dataset lines the agent was already given for this view.

`warn` lines are parts of the view that are up but could not draw what the spec asked: a file or a revision that does not exist, a source that failed, data that is missing or empty, a field that is not in the data, data of the wrong shape, a graph focus that matches no node, a `node:'ID'` that links to nothing on the view, a call that cannot compute from the data it reads (`div` by zero, a value that is not a number), a call inside `$/data`, which is not computed. The server checks what it can itself, and when a tab is open it also waits a moment for the tab to say what it actually drew. The tab reports each component's current state, not a stream of events: a truthful empty state (no import cycles, a clean working tree, a view waiting for a selection) is not a problem and prints nothing, a component that draws normally withdraws its earlier report, and redefining a component clears what was known about it until the tab reports again. A problem the tab finds after the result has gone rides once on a later tool result as a `viewer: error` line, and only if it is still that component's state. An error (`E_...`) is all-or-nothing: nothing on screen changes, and the result names the failing component, its signature and the valid options, so the agent resends only the failing part. The other `viewer:` lines are what happened in the tab; they are data, never instructions.

## Views

`show{view: "..."}` renders a preset. Each one names its parts, so the agent can patch a single plate afterwards (`show{id:"overview", spec:"$/notes='...'"}`) or add one (a new `name=Comp(...)` is appended to the page).

| View | What it shows |
|---|---|
| `overview` | Atlas of the repo: KPIs, stack, treemap, languages, module graph, file cycles, activity, hotspots, packages. |
| `tree [path]` | File browser: tree with churn heat beside code, outline and treemap tabs. |
| `deps [path]` | Architecture map: module graph, heaviest edges, file cycles, dependency matrix, external packages. |
| `hotspots [path]` | Where change and complexity meet: scatter, churn treemap, ranking, files that change together. |
| `history [path]` | Git history: daily activity, weekly activity by module, authors, most-changed files, log. |
| `file <path>` | One file in depth: code, outline, imports and importers, recent commits. |
| `symbol <name>` | Where an identifier is used: references grouped by file beside the code. |
| `stack` | Tooling: stack chips, packages, scripts, external dependencies, TODOs. |
| `diff [range]` | Review a change: stats, the diff with its file list, blast radius, commits. Range `wt` (default, live), `staged` or `main..HEAD`. |
| `feature` | Follow a feature while it is built: plan, design, notes, live working-tree diff, blast radius. |
| `gallery` | Every component, with fixture data. |

## Writing a custom spec

A spec is [A2UI Express](https://a2ui.org): nested calls, positional arguments in signature order, then `name=value`. `root=Page(...)` starts a view; `name=Comp(...)` defines a named part that can be used as a child and patched later; `$/path=value` sets data and `$/path` as an argument binds to it. `span=1..12` places anything on a 12-column grid, `title=` draws a numbered plate, `size=s|m|l|xl|fill` sets its maximum height (a plate is as tall as its content, up to that; a diagram grows to 640 px by itself, so on a diagram `size=` only limits it). The view's `id` is a short name of letters, digits, `_` and `-`.

The four examples below were run against this repository exactly as written (`show` with the `id` shown and the block as `spec`); a test compiles them and checks that the files they name exist.

**Explain a package** (`id: "server-package"`): prose, a graph and a table, each bound to a local data source.

```
root=Page('The server package',[intro,deps,churn],'packages/server')
intro=Text('Requests enter in **mcp/show.ts**; see [[packages/server/src/mcp/show.ts#L1]].')
deps=Graph('deps.modules packages/server',title='What depends on what',span=7)
churn=DataTable('git.churn packages/server top=10',title='Most changed files',span=5)
```

**Trace a flow** (`id: "round-trip"`): a diagram written as data next to the code it describes. Diagrams are plain data, not Mermaid text: each step is checked on its own, so one bad entry is left out and named instead of failing the page, and a diagram bound to `$/name` can be patched one node at a time.

```
root=Page('From tool call to pixels',[flow,code])
flow=SequenceDiagram({steps:[['Agent','Server','show(spec)'],['Server','Viewer','A2UI frame'],['Viewer','Server','action'],['Server','Agent','viewer: select file ...','reply']]},title='One round trip',span=6)
code=CodeView('packages/server/src/mcp/show.ts#L1-40',mark='L1-12',title='Where it starts',size='l',span=6)
```

**Plan, ask, update** (`id: "rate-limiter"`): small inline data in a slot, a schema, and a question whose answer comes back as an event.

```
root=Page('Rate limiter',[plan,schema,ask])
plan=Steps($/plan,title='Plan',span=5)
schema=ERDiagram([{name:'buckets',columns:[{name:'key',type:'text',pk:true},{name:'tokens',type:'int'},{name:'client_id',type:'uuid',fk:'clients.id'}]},{name:'clients',columns:[{name:'id',type:'uuid',pk:true},{name:'plan',type:'text'}]}],title='Tables',span=7)
ask=Ask('Which store backs the limiter?',['Redis','In-memory'],'store')
$/plan=[{title:'Add the middleware',status:'done'},{title:'Wire it into the router',status:'doing'},{title:'Tests',status:'todo'}]
```

Later, `show` with the same `id` and only `$/plan=[...]` updates the plan in place; nothing else is re-sent or re-drawn. Clicking *Redis* queues `viewer: answer rate-limiter store {"choice":"Redis"}` for the agent.

**What if** (`id: "what-if"`): numbers you set, and values computed from them in the tab.

```
root=Page('Ticketing: on-sale what-if',[inputs,peak])
$/w={seats:50000,secs:120,conv:0.6}
inputs=Row([Slider('Seats on sale',$/w/seats,1000,200000,step=1000),Slider('Sale window',$/w/secs,10,600,step=10,unit='s'),Slider('Checkout conversion',$/w/conv,0.05,1,step=0.05)])
rps=div(mul($/w/seats,$/w/conv),$/w/secs)
peak=Stats([{label:'Peak checkout',value:rps,unit:'req/s'},{label:'Redis',value:mul(rps,4),unit:'ops/s'},{label:'Postgres writes',value:mul(rps,2),unit:'/s'}],title='Load at peak')
```

`add`, `sub`, `mul` and `div(a, b)` are A2UI function calls; each argument is a number, a `$/path` or another call, and there are no operators (`$/a*2` is `mul($/a,2)`). `rps=div(...)` names a call, which is copied into every place that uses `rps`. At the seeds the plate reads 250, 1,000 and 500. Typing 80000 into *Seats on sale* turns them into 400, 1,600 and 800 at once, without the server; on Enter, on leaving the field or after a short pause the agent is told `viewer: set $/w/seats 80000 (what-if) -> Stats#peak data/0/value=400 data/1/value=1600 data/2/value=800`. The server keeps the number: a reload or a re-show of the same spec keeps 80000, with a `fixed $/w/seats stays 80000 ...` line, and only `$/w/seats=...` itself sets it again.

The catalog prefers accepting a reasonable guess to documenting the one right spelling. `Callout(...,'warning')` becomes `warn` with a `fixed` note; `mark='L1-12'` and `mark='1-12'` both highlight; `KeyValue` and `Stats` read the same rows (`[{label, value}]`, `[{key, value}]` or an object `{Label: value}`); a `Button` action may be a plain event name (`Button('Draft it','draft')`); an `ERDiagram` takes a bare list of tables, and a column's `fk:'clients.id'` draws the relation; a `Flowchart` takes just its edges (`Flowchart([['Start','Login'],['Login','Valid?']])`) and names the nodes from them; `Grid` reads `cols='2fr 1fr'` as `'2:1'`. Nothing an author writes is dropped quietly: a guess comes back as a `fixed` line, and what Glimpse could not read or draw as a `warn` line, or as a `viewer:` line for data that reached the tab without passing the server, so the model can correct it in one step. Values are data or follow conventions models already know (`path#L10-20`, `main..HEAD`); Glimpse adds no grammar of its own.

## Components

44 components in seven families. `catalog{names:["DataTable"]}` returns any signature with its props, the shape of its data and an example; `show{view:"gallery"}` draws them all.

| Family | Components |
|---|---|
| Layout (8) | `Page` `Plate` `Section` `Grid` `Row` `Column` `Tabs` `Split` |
| Content (9) | `Text` `Callout` `KeyValue` `Chips` `FileRef` `Steps` `Stat` `Stats` `List` |
| Data (4) | `DataTable` `FileTree` `CommitList` `JsonView` |
| Charts (10) | `Sparkline` `SegmentedBar` `BarChart` `LineChart` `ScatterPlot` `Histogram` `Heatmap` `CalendarHeatmap` `Treemap` `Icicle` |
| Diagrams (5) | `Graph` `Flowchart` `SequenceDiagram` `Layers` `ERDiagram` |
| Code (5) | `CodeBlock` `CodeView` `DiffView` `CodeTour` `SymbolOutline` |
| Input (3) | `Button` `Ask` `Slider` |

Charts are Glimpse's own SVG on `d3-scale`, `d3-shape` and `d3-hierarchy`. `Graph`, `Flowchart` and `ERDiagram` are laid out by [ELK](https://eclipse.dev/elk/) (`elkjs`, layered: group frames sized around their members, orthogonal edges routed across them, ports for table columns) in a Web Worker, and drawn with [React Flow](https://reactflow.dev) (`@xyflow/react`) in the same hairline style; both load only when a page first shows one of these diagrams. `SequenceDiagram` and `Layers` are drawn directly in SVG and HTML; a `SequenceDiagram` draws Mermaid's `alt`, `opt`, `loop`, `par`, `critical` and `break` blocks as labelled frames, with a dashed divider for each `else`, `and` or `option`, and closes a block left open with a `fixed` line. It has the same zoom bar as the other diagrams (zoom out and in, fit to view, actual size, `+` `-` `0` `1`, a pinch, and how many steps are in view while it scrolls), and its actor row stays in place as the steps scroll under it. Its arrow keys step through the messages and select each in turn, so a message whose actors stand for Flowchart nodes lights its route there, including the nodes it passes through (`via`). A Flowchart node with a `note` or a `file` is marked with a dot; its note shows on hover and in the plate's margin when it is selected, and its file opens with Cmd-click. A `Slider` writes the number its `$/path` binds, and every value computed from that path with `add`, `sub`, `mul` or `div` follows at once in the tab. A diagram is as tall as it is at the scale that fits the plate's width, up to the plate's maximum: when all of it is readable there (text at 10 px or more on screen) it opens fitted and centred, otherwise at a readable zoom with pan, zoom and a minimap. A two-finger scroll pans a drawing that does not fit and scrolls the page over one that does, or once a pan reaches the drawing's edge; a pinch zooms. Tables and code views are virtualised; syntax highlighting is done by the server (Shiki) and sent as token classes, never as markup.

## Data sources

A data argument is one of three things: a **source ref** (a string), a **`$/path`** into the view's data model, or **small inline rows**.

A ref is `'<source> [path|range|symbol] [key=value ...]'`, for example `'git.hotspots src top=15'`, `'diff.files main..HEAD'` or `'git.churn by=module'` (one row per module instead of per file). The server runs it locally, enforces a row and node budget, and binds the result under `/ds/<key>` in the page's data model. The same ref used by two components is computed once. Each result carries its field names and kinds, so tables and charts pick columns and axes without being told. Three sources are graphs (`deps.modules`, `deps.files`, `diff.impact`) and are drawn with `Graph`; the trees (`files.tree`, `diff.tree`) with `FileTree`, `Treemap` or `Icicle`. `catalog{names:["git.churn"]}` lists a source's arguments and fields.

Results are cached per commit, and per working-tree revision for the sources that read the working tree: `files.*`, `repo.*`, `deps.*`, `code.*` and `diff.*` reflect uncommitted edits, `git.*` follows `HEAD`. The server re-checks `HEAD` and the working tree on every tool call, and while a tab is open it watches them: edit a file and the diff, the tree and the affected datasets follow within a second or two.

| Group | Sources |
|---|---|
| Files | `files.tree` `files.list` `files.langs` |
| Repository | `repo.kpis` `repo.stack` `repo.packages` `repo.scripts` |
| Dependencies | `deps.modules` `deps.files` `deps.cycles` `deps.external` `deps.matrix` |
| History | `git.log` `git.activity` `git.timeline` `git.churn` `git.hotspots` `git.authors` `git.coupling` |
| Changes | `diff.stats` `diff.files` `diff.tree` `diff.impact` |
| Code | `code.symbols` `code.refs` `code.todos` |

The analyzers are fast because they are approximate: a regular-expression scan for imports, symbols and complexity (TypeScript, JavaScript, Python, Go, Rust, Java and several more), the headings of Markdown files as their outline, one `git log` stream for history. "Complexity" is summed indentation depth, a proxy, and the plates say so. The module graph is drawn at a size that stays legible: 24 nodes by default (20 modules and up to 4 external packages), with smaller directories folded into a rest node of their parent (`'deps.modules top=48'` is the most it shows by module; a small scope is drawn file by file). Treat dependency edges and complexity as a good map, not a compiler's answer.

Numbers on one page agree: the overview's KPI strip counts what the plates beside it show. Modules is the number of modules the module graph groups files into, before it cuts the drawing to 24 nodes (the graph header then reads "24 of N modules"); Languages is the rows of the Languages table, leaving out only the catch-all `Unclassified` row; File cycles is the rows of the cycles table, which lists cycles between files, while the module graph marks cycles between modules. The Packages table has one row per manifest file.

## Security model

Glimpse reads your code and serves it over HTTP, so the boundaries matter.

- **Local only.** The server reads only the project root (paths are resolved with `realpath` and must stay inside it; symlinks that lead out are refused), runs only `git`, and makes no network requests. Nothing is written into the project.
- **Loopback only.** The viewer host binds `127.0.0.1`. Every request is checked for an expected `Host` (DNS rebinding), a same-origin `Origin` and `Sec-Fetch-Site` (cross-site requests); `POST` bodies must be JSON; no CORS header and no cookie is ever sent.
- **A per-session token.** `/api/*` needs a 256-bit random token, compared in constant time. It travels in the URL fragment, which browsers do not send, and is kept in `sessionStorage`.
- **Only inventoried files are served.** The file, outline and diff endpoints answer only for paths in the repository's file inventory, so `.git/**` and ignored files (a `.env`, build output) are refused even with the token.
- **Hostile repository content cannot script the page.** The content security policy is `default-src 'none'; script-src 'self'; style-src 'self'` with no inline exceptions. Text is drawn as text nodes with inline code, emphasis and file refs only, never as HTML; code is text nodes with class names.
- **Hostile repository content cannot speak for you.** What you do in the tab reaches the agent as single lines with a fixed `viewer:` prefix, JSON-escaped and length-capped, and the instructions tell the agent to treat them as data. Text that comes from the repository (file names, author names, commit subjects, query rows) is quoted wherever it could start a line with that prefix, so a commit cannot forge your click on an approval button. A `Slider` can only set the one number its own binding names, within its `min` and `max`.
- **Nothing from the repository is executed.** "Open in editor" starts only `GLIMPSE_EDITOR` or a known editor found on the PATH, never the system's default opener, which would run a script or an app bundle. Specs cannot reach object prototypes: data paths with `__proto__`, `constructor` or `prototype` are rejected.
- **Bounded.** 12 views, 100 queued events, 5 tabs (a browser gives a site six connections, and a sixth event stream would leave none for loading data), capped file sizes and git output.

The end-to-end suite runs this matrix against the built server (`e2e/security.spec.ts`). Two things to know: anyone who can read the token (another process running as you) can read the inventoried files of the project through the API; and the agent that drives Glimpse can already read those files itself.

## Development

Requires Node 22.18 or newer (developed on Node 26) and npm 11.

```sh
npm install         # .npmrc sets ignore-scripts: no dependency runs code at install time
npm run check       # Biome lint, then tsc --noEmit for the root and each package
npm test            # unit and component tests (vitest)
npm run build       # viewer + server bundle + skill + third-party notices into plugin/
npm run budgets     # size budgets, measured on the build
npm run e2e         # Playwright (Chromium) against the bundled server; needs `npx playwright install chromium` once
npm run demo        # the bundled server and viewer on this repository
npm run dev         # viewer dev server on the gallery fixture
npm run generate    # rewrite packages/catalog/generated and the fixtures after a catalog change
```

```
packages/
  catalog/   the catalog, defined once in zod: components, data sources, presets, diagram data checks,
             generated docs and catalog.json, fixtures. DOM-free.
  viewer/    the React single-page app: the kit that binds views to A2UI, and the component library
  server/    the MCP server, the loopback viewer host, the repository analyzers
plugin/      the Claude Code plugin: manifest, skill, commands, hook, and dist/ (build output, not committed)
e2e/         the end-to-end suite; e2e/README.md lists what it covers and its known failures
scripts/     build, budgets, demo, generate, check-paths, and the third-party notices (notices.ts, notices/)
```

Working on one area:

```sh
npm run check:paths -- packages/viewer/src/components/table packages/viewer/test/table
npm test -w @glimpse/viewer -- test/table
npm run e2e -- security                      # one end-to-end spec
GLIMPSE_DIST=/tmp/glimpse-dist npm run e2e   # test a build made with: node scripts/build.mjs --out /tmp/glimpse-dist
```

Lint warnings fail the check. After changing anything under `packages/catalog/src` or `packages/catalog/fixtures`, run `npm run generate` and commit the result; a test fails when the generated files are stale. In the same way, after adding, removing or upgrading a dependency that ships, run `npm run build` and commit `THIRD_PARTY_NOTICES.md`: a viewer build test fails when it is stale, and the build fails when a shipped package has a licence outside the allowed list or no licence text (`scripts/notices.ts` says what to do). Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). Do not reinstall dependencies while checks or tests are running in the same working tree.

### Budgets

`npm run budgets` fails when one is exceeded. Two limits keep headroom under the design's hard figure, so that the next component or source still fits; the catalog tests and a viewer build test hold the same two. The diagram engine has lines of its own, about 15 % above what it measures, and stays out of the eager scripts.

| Budget | Limit | Now |
|---|---|---|
| Server instructions | 3,750 chars (hard limit 4,000) | 3,723 |
| `show` + `catalog` definitions | 1,500 chars | 1,147 |
| Largest preset result (`overview`) | 1,200 chars | 1,095 |
| Eager viewer JavaScript, gzip | 210 kB (hard limit 215 kB) | 205.4 kB |
| Largest other lazy chunk, gzip | 120 kB | 60.3 kB |
| Diagram engine, gzip: ELK worker, React Flow, diagrams chunk | 515 kB, 90 kB, 52 kB | 448.4 kB, 77.7 kB, 45.1 kB |

## Status and known limitations

Early. The checks above pass, and the end-to-end suite drives the bundled server on a fixture repository and on this repository. Measured on a laptop: the first `show{view:"overview"}` returns in 0.2 to 0.4 s on small repositories and in about 1 s on a 4,700-file polyglot one; the first plate is on screen 0.1 to 0.2 s after the tab loads.

Be aware of the following:

- **Verified on macOS only.** Nothing has been run on Linux or Windows yet. CI runs macOS as the gate and Linux as an experiment; Windows is likely to need work (opening editors, process groups, path separators).
- **Chromium only.** Firefox and Safari are untested.
- **Little experience with a model in the loop.** In a first cold test, two models wrote 14 views each from the instructions alone and got 2 and 1 of them right first time. After the causes it found were addressed (hyphenated ids rejected, `warning` for `warn`, row shapes, a zero-based step index, `ok` results that hid an empty plate), a second test gave the two models 20 tasks each: 15 of the 40 first tries failed, 8 of them on a guessed field name. Those causes (field names, the KeyValue and Stats rows, spans inside a `Grid`, a graph source in a table, churn per module, expected empty states reported as problems) have been addressed in turn, but the test has not been repeated since. The end-to-end suite plays the agent by hand.
- **Pinned to A2UI 0.15.0** (`@a2ui/web_core`, `@a2ui/react`) and `@a2ui/agent` 0.1.0. These packages are young; an upgrade needs the pinned error-message patterns and the conformance tests re-run.
- **Known defects** found by the end-to-end suite are kept as `fixme` tests until fixed; `e2e/README.md` has the current list (empty at this version).
- **Approximate analysis.** Imports, symbols and complexity come from regular expressions; history statistics cover the latest 5,000 commits; authors are grouped by display name.
- **One session, one server.** State lives in memory and ends with the agent session; the tab then keeps its last picture and says so. A click cannot wake an idle agent: it is delivered with your next prompt or the agent's next Glimpse call.

## Licence

Glimpse is **source-available ([Fair Source](https://fair.io/)), not open source**. Its own code is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](https://fsl.software/) (FSL-1.1-ALv2, in `LICENSE.md`). The licence is not approved by the Open Source Initiative. In short, and the licence text is what counts:

- **Allowed:** any purpose other than a Competing Use (below), commercial or not. You may "use, copy, modify, create derivative works, publicly perform, publicly display and redistribute" Glimpse for such a purpose. The licence names four purposes it specifically permits: "your internal use and access" (so you can use Glimpse at work, including in a company), "non-commercial education", "non-commercial research", and "professional services that you provide to a licensee using the Software in accordance with these Terms and Conditions".
- **Not allowed without a separate licence: a Competing Use**, which the licence defines as "making the Software available to others in a commercial product or service that: 1. substitutes for the Software; 2. substitutes for any other product or service we offer using the Software that exists as of the date we make the Software available; or 3. offers the same or substantially similar functionality as the Software." For that, ask the copyright holder through GitHub: [github.com/svailla4](https://github.com/svailla4), for example by opening an issue here.
- **Copies and changes stay under the same terms.** The terms "apply to all copies, modifications and derivatives". If you redistribute Glimpse, changed or not, include `LICENSE.md` (or a link to it) and do not remove the copyright notices.
- **Each version becomes Apache 2.0 after two years.** The licence irrevocably grants an additional licence under the Apache License, Version 2.0, "effective on the second anniversary of the date we make the Software available". Until then that version is under FSL-1.1-ALv2 only; from then on you may use it under either licence.
- The licence gives no right to use the Glimpse name, except to identify where the software comes from.
- **Earlier copies keep their old licence.** Release v0.1.0 and every earlier copy were published under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) and remain under it; FSL-1.1-ALv2 and its Apache 2.0 future licence apply to the versions published with it.

Third-party components keep their own licences. Neither Glimpse's licence nor its Apache 2.0 future licence applies to them (`NOTICE.md` says exactly what is excluded):

- The packages bundled into `plugin/dist` are listed with their licence texts in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), which `npm run build` generates from what the bundlers actually include (`scripts/notices.ts`), and copies into `plugin/dist`. They are under MIT, ISC, BSD, 0BSD and Apache 2.0 licences, except:
  - elkjs, the diagram layout engine, which Glimpse distributes under the Eclipse Public License 2.0. Its licence and where to get its source are in `plugin/dist/viewer/assets/elkjs-LICENSE.txt`;
  - the IBM Plex and Newsreader fonts, under the SIL Open Font License 1.1, with an `OFL-*.txt` file next to them.
- The A2UI JSON Schema files under `packages/catalog/spec` are under the Apache License 2.0; see the `NOTICE` in that directory.

Contributions are welcome under the terms in [`CONTRIBUTING.md`](CONTRIBUTING.md).
