# Glimpse

Generative UI for codebases. Glimpse lets a coding agent *show* you a repository instead of describing it: an architecture map, a churn-against-complexity scatter, a sortable hotspot table, a diff with its blast radius, a guided tour through a file. The agent writes a few lines naming components and data sources; a local server computes the data on your machine and a browser tab draws it.

Glimpse is two things:

- **A component library**: 44 React components behind an [A2UI](https://a2ui.org) v1.0 catalog, drawn in one design language, Linework.
- **An MCP server** with five tools. It compiles the agent's spec, runs the repository analyzers, and hosts the viewer on `127.0.0.1`.

## What it looks like

There are no screenshots here yet, so in words. A view is a sheet of warm paper under a hairline top bar. Each titled component is a *plate*: a frame with small registration ticks at the corners, a vermilion `PL. 03` numeral and a serif title, like a figure in an engineering atlas. Text is IBM Plex with Newsreader for titles and the large numerals; code and identifiers are monospace. Colour is used for data: a language or a module keeps the same ink in every plate of the session, and vermilion marks the selection. There is a dark theme (`t`) and a denser row height (`d`).

Everything is linked. Click a file in a table, a treemap cell, a graph node or a commit and it becomes the selection everywhere: a `CodeView` beside a `FileTree` is a file browser with no wiring. Tables sort, filter and page; graphs pan, zoom and let you drag nodes; plates can be dragged into another order or resized, and the tab remembers. While data is being computed a plate shows a *drafting* frame at its final size; a failure is a *redline* with the error code, confined to that plate.

## Why

Asking a model to write an HTML page for every explanation is slow and costs thousands of tokens. Glimpse turns that around:

- **The model names things; it does not draw them.** `show{view:"overview"}` is about five output tokens. A bespoke view is a few lines of spec, 20 to 160 tokens.
- **Data stays on your machine.** The agent writes `DataTable('git.churn src/auth top=20')`. The rows are computed locally and bound straight into the page; they never pass through the model. The tool result carries a one-line summary per dataset (row count, field names, the top row) so the agent can talk about what you see.
- **A standard wire format.** Server and viewer speak A2UI v1.0, and the catalog is published as `catalog.json`.

The whole up-front cost for the agent is the server instructions (3,896 characters) plus two tool definitions (1,075 characters): about 1,250 tokens per session.

## Install

Requirements: Node 22.18 or newer and `git` on the PATH. `plugin/dist` is build output and is not committed yet, so today every route starts from a checkout:

```sh
git clone <this repository> glimpse
cd glimpse
npm install
npm run build        # writes plugin/dist/server.mjs and plugin/dist/viewer
```

### As a Claude Code plugin

```sh
claude --plugin-dir /path/to/glimpse/plugin
```

Or register the checkout as a local marketplace and install from it:

```sh
claude plugin marketplace add /path/to/glimpse
claude plugin install glimpse@glimpse
```

The plugin brings the MCP server, a skill that tells Claude when and how to use Glimpse, and a `UserPromptSubmit` hook that passes along what you clicked in the tab since your last prompt. Then ask for something: "show me an overview of this repo", "what does this branch change?", "walk me through `src/auth/service.ts`".

Installing straight from the hosted repository (`claude plugin marketplace add <owner>/<repo>`) will work once a release commits `plugin/dist`; until then the installed plugin has no server to start.

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

The project root is `CLAUDE_PROJECT_DIR` when the host sets it, else `--root`, else the directory the server is started in. Without the plugin's hook, interactions reach the agent on its next Glimpse call or through the `events` tool.

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
| `GLIMPSE_EDITOR` | Command that opens a file from the viewer, for example `code -g {file}:{line}`. Without it Glimpse tries `code`, `cursor` and `zed`, then the system default. |

## Tools

| Tool | Purpose |
|---|---|
| `show` | Render a preset (`view`), a custom view (`spec`), or patch a view that is already open (`id` plus `spec`). Returns the dataset summaries, the named parts of the view, warnings, and anything you did in the tab. |
| `catalog` | Look up a component, a data source, a preset (`view:diff` returns its source, which doubles as an example), the spec grammar or worked examples. |
| `query` | Run a data source and return a few rows as text, without rendering, so the agent can ground what it says. |
| `events` | What you did in the tab since the last Glimpse call: selections, button presses, answers. Can wait for the next one. |
| `pending_context` | Used by the plugin's hook; hidden from the model. |

Errors are all-or-nothing and specific: a bad spec changes nothing on screen, and the result names the failing component, its signature and the valid options, so the agent resends only the failing part.

## Views

`show{view: "..."}` renders a preset. Each one names its parts, so the agent can patch a single plate afterwards.

| View | What it shows |
|---|---|
| `overview` | Atlas of the repo: KPIs, stack, treemap, languages, module graph, cycles, activity, hotspots, packages. |
| `tree [path]` | File browser: tree with churn heat beside code, outline and treemap tabs. |
| `deps [path]` | Architecture map: module graph, heaviest edges, cycles, dependency matrix, external packages. |
| `hotspots [path]` | Where change and complexity meet: scatter, churn treemap, ranking, files that change together. |
| `history [path]` | Git history: daily activity, weekly activity by module, authors, most-changed files, log. |
| `file <path>` | One file in depth: code, outline, imports and importers, recent commits. |
| `symbol <name>` | Where an identifier is used: references grouped by file beside the code. |
| `stack` | Tooling: stack chips, packages, scripts, external dependencies, TODOs. |
| `diff [range]` | Review a change: stats, changed-file tree, diff, blast radius, commits. Range `wt` (default, live), `staged` or `main..HEAD`. |
| `feature` | Follow a feature while it is built: plan, design, notes, live working-tree diff, blast radius. |
| `gallery` | Every component with fixture data. |

## Writing a custom spec

A spec is [A2UI Express](https://a2ui.org): nested calls, positional arguments in signature order, then `name=value`. `root=Page(...)` starts a view; `name=Comp(...)` defines a named part that can be used as a child and patched later; `$/path=value` sets data and `$/path` as an argument binds to it. `span=1..12` places anything on a 12-column grid, `title=` draws a numbered plate, `size=s|m|l|xl|fill` sets its height.

The three examples below run against this repository as written (`show` with `id` and `spec`).

**Explain a package** — prose, a graph and a table, each bound to a local data source:

```
root=Page('The server package',[intro,deps,churn],'packages/server')
intro=Markdown('Requests enter in **mcp/show.ts**; see [[packages/server/src/mcp/show.ts#L1]].')
deps=Graph('deps.modules packages/server',title='What depends on what',size='l',span=7)
churn=DataTable('git.churn packages/server top=10',title='Most changed files',span=5)
```

**Trace a flow** — a diagram written in a Mermaid-like notation next to the code it describes:

```
root=Page('From tool call to pixels',[flow,code])
flow=SequenceDiagram('Agent->>Server: show(spec)\nServer->>Viewer: A2UI frame\nViewer->>Server: action\nServer-->>Agent: viewer: select file ...',title='One round trip',span=6)
code=CodeView('packages/server/src/mcp/show.ts#L1-40',title='Where it starts',size='l',span=6)
```

**Plan, ask, update** — small inline data in a slot, and a question whose answer comes back as an event:

```
root=Page('Rate limiter',[plan,ask])
plan=Steps($/plan,title='Plan',span=7)
ask=Ask('Which store backs the limiter?',['Redis','In-memory'],'store',span=5)
$/plan=[{title:'Add the middleware',status:'done'},{title:'Wire it into the router',status:'doing'},{title:'Tests',status:'todo'}]
```

Later, `show` with the same `id` and only `$/plan=[...]` updates the plan in place; nothing else is re-sent or re-drawn. Clicking *Redis* queues `viewer: answer <id> store {"choice":"Redis"}` for the agent.

## Components

44 components in seven families. `catalog{names:["DataTable"]}` returns any signature with its props and an example; `show{view:"gallery"}` draws them all.

| Family | Components |
|---|---|
| Layout (8) | `Page` `Plate` `Section` `Grid` `Row` `Column` `Tabs` `Split` |
| Content (10) | `Text` `Markdown` `Callout` `KeyValue` `Chips` `FileRef` `Steps` `Stat` `Stats` `List` |
| Data (4) | `DataTable` `FileTree` `CommitList` `JsonView` |
| Charts (10) | `Sparkline` `SegmentedBar` `BarChart` `LineChart` `ScatterPlot` `Histogram` `Heatmap` `CalendarHeatmap` `Treemap` `Icicle` |
| Diagrams (5) | `Graph` `Flowchart` `SequenceDiagram` `Layers` `ERDiagram` |
| Code (5) | `CodeBlock` `CodeView` `DiffView` `CodeTour` `SymbolOutline` |
| Input (2) | `Button` `Ask` |

Charts and diagrams are Glimpse's own SVG on `d3-scale`, `d3-shape`, `d3-hierarchy` and `dagre`; tables and code views are virtualised; syntax highlighting is done by the server (Shiki) and sent as token classes, never as markup.

## Data sources

A data argument is one of three things: a **source ref** (a string), a **`$/path`** into the view's data model, or **small inline rows**.

A ref is `'<source> [path|range|symbol] [key=value ...]'`, for example `'git.hotspots src top=15'` or `'diff.files main..HEAD'`. The server runs it locally, caches the result per commit (and per working-tree revision for sources that read the working tree), enforces a row and node budget, and binds the result under `/ds/<key>` in the page's data model. The same ref used by two components is computed once. Each result carries its field names and kinds, so tables and charts pick columns and axes without being told. While a tab is open the working tree is watched: edit a file and the diff, the tree and the affected datasets follow within a second or two.

| Group | Sources |
|---|---|
| Files | `files.tree` `files.list` `files.langs` |
| Repository | `repo.kpis` `repo.stack` `repo.packages` `repo.scripts` |
| Dependencies | `deps.modules` `deps.files` `deps.cycles` `deps.external` `deps.matrix` |
| History | `git.log` `git.activity` `git.timeline` `git.churn` `git.hotspots` `git.authors` `git.coupling` |
| Changes | `diff.stats` `diff.files` `diff.tree` `diff.impact` |
| Code | `code.symbols` `code.refs` `code.todos` |

The analyzers are fast because they are approximate: a regular-expression scan for imports, symbols and complexity (TypeScript, JavaScript, Python, Go, Rust, Java and several more), one `git log` stream for history. Plate notes say what a number is based on; treat dependency edges and complexity as a good map, not a compiler's answer.

## Security model

Glimpse reads your code and serves it over HTTP, so the boundaries matter.

- **Local only.** The server reads only the project root (paths are resolved with `realpath` and must stay inside it; symlinks that lead out are refused), runs only `git`, and makes no network requests. Nothing is written into the project.
- **Loopback only.** The viewer host binds `127.0.0.1`. Every request is checked for an expected `Host` (DNS rebinding), a same-origin `Origin` and `Sec-Fetch-Site` (cross-site requests); `POST` bodies must be JSON; no CORS header and no cookie is ever sent.
- **A per-session token.** `/api/*` needs a 256-bit random token, compared in constant time. It travels in the URL fragment, which browsers do not send, and is kept in `sessionStorage`.
- **Hostile repository content cannot script the page.** The content security policy is `default-src 'none'; script-src 'self'; style-src 'self'` with no inline exceptions. Markdown is rendered with raw HTML disabled, only `http(s)` links, and no remote images; code is text nodes with class names.
- **Clicks are data.** What you do in the tab reaches the agent as single lines with a fixed `viewer:` prefix, JSON-escaped and length-capped, and the instructions tell the agent to treat them as data.
- **Bounded.** 12 views, 100 queued events, 8 tabs, capped file sizes and git output.

The end-to-end suite runs this matrix against the built server (`e2e/security.spec.ts`). Two things to know: anyone who can read the token (another process running as you) can read files under the project root through the API, including files under `.git`; and the agent that drives Glimpse can already read those files itself.

## Development

Requires Node 22.18 or newer (developed on Node 26) and npm 11.

```sh
npm install         # .npmrc sets ignore-scripts: no dependency runs code at install time
npm run check       # Biome lint, then tsc --noEmit for the root and each package
npm test            # unit and component tests (vitest)
npm run build       # viewer + server bundle + skill into plugin/
npm run budgets     # size budgets, measured on the build
npm run e2e         # Playwright (Chromium) against the bundled server; needs `npx playwright install chromium` once
npm run demo        # the bundled server and viewer on this repository
npm run dev         # viewer dev server on the gallery fixture
npm run generate    # rewrite packages/catalog/generated and the fixtures after a catalog change
```

```
packages/
  catalog/   the catalog, defined once in zod: components, data sources, presets, notation parsers,
             generated docs and catalog.json, fixtures. DOM-free.
  viewer/    the React single-page app: the kit that binds views to A2UI, and the component library
  server/    the MCP server, the loopback viewer host, the repository analyzers
plugin/      the Claude Code plugin: manifest, skill, hook, and dist/ (build output)
e2e/         the end-to-end suite; e2e/README.md lists what it covers and its known failures
scripts/     build, budgets, demo, generate, check-paths
```

Working on one area:

```sh
npm run check:paths -- packages/viewer/src/components/table packages/viewer/test/table
npm test -w @glimpse/viewer -- test/table
npm run e2e -- security                      # one end-to-end spec
GLIMPSE_DIST=/tmp/glimpse-dist npm run e2e   # test a build made with: node scripts/build.mjs --out /tmp/glimpse-dist
```

Lint warnings fail the check. After changing anything under `packages/catalog/src` or `packages/catalog/fixtures`, run `npm run generate` and commit the result; a test fails when the generated files are stale. Do not reinstall dependencies while checks or tests are running in the same working tree.

### Budgets

`npm run budgets` fails when one is exceeded. Measured on the current build:

| Budget | Limit | Now |
|---|---|---|
| Server instructions | 4,000 chars | 3,896 |
| `show` + `catalog` definitions | 1,500 chars | 1,075 |
| Largest preset result (`overview`) | 1,200 chars | 1,199 |
| Eager viewer JavaScript, gzip | 200 kB | 195.9 kB |
| Largest lazy chunk (charts), gzip | 120 kB | 47.5 kB |

Three of these have almost no headroom. The overview result stays under its limit because long dataset summaries are clipped.

## Status and known limitations

Version 0.1.0, early. The checks above pass, and the end-to-end suite drives the bundled server on a fixture repository and on this repository. Measured on a laptop: the first `show{view:"overview"}` returns in 0.2 to 0.4 s on small repositories and in about 1 s on a 4,700-file polyglot one; the first plate is on screen 0.1 to 0.2 s after the tab loads.

Be aware of the following:

- **Verified on macOS only.** Nothing has been run on Linux or Windows yet. CI runs macOS as the gate and Linux as an experiment; Windows is likely to need work (opening editors, process groups, path separators).
- **Chromium only.** Firefox and Safari are untested.
- **Not yet tried with a model in the loop.** The suite plays the agent by hand. Whether a model writes correct specs first time from the compact instructions is unmeasured.
- **Pinned to A2UI 0.15.0** (`@a2ui/web_core`, `@a2ui/react`) and `@a2ui/agent` 0.1.0. These packages are young; an upgrade needs the pinned error-message patterns and the conformance tests re-run.
- **Known defects found by the end-to-end suite**, kept as `fixme` tests until fixed (`e2e/README.md`): a patch of one element inside a bound array (`$/plan/1/status='done'`) does not redraw the view, although replacing the whole value does; a new view opens at the previous view's scroll position; long paths in tables are cut at the end, hiding the file name; large module graphs open too small to read; a `CodeView` or `DiffView` pointed at a missing file or revision reports nothing back to the agent.
- **Approximate analysis.** Imports, symbols and complexity come from regular expressions; history statistics cover the latest 5,000 commits; authors are grouped by display name.
- **One session, one server.** State lives in memory and ends with the agent session; the tab then keeps its last picture and says so. A click cannot wake an idle agent: it is delivered with your next prompt or the agent's next Glimpse call.
- **No release build yet**, so the plugin cannot be installed directly from the hosted repository (see Install).

## Licence

Licence to be decided. The A2UI JSON Schema files under `packages/catalog/spec` are third-party files under the Apache License 2.0; see the `NOTICE` in that directory.
