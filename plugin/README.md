# Glimpse plugin for Claude Code

Glimpse lets Claude show you a codebase instead of describing it. Ask for an overview, a dependency map, the hotspots, a review of a branch or a walk through a file, and a view opens in a local browser tab: tables, charts, diagrams, code and diffs drawn from a fixed, designed component catalog. Claude writes a short spec that names components and data sources; the server computes the data on your machine and the viewer paints it. File contents and analysis results never pass through the model.

## What is in here

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest. |
| `.mcp.json` | Starts the Glimpse MCP server: `node dist/server.mjs`, one process per Claude Code session. |
| `skills/glimpse/SKILL.md` | Tells Claude when and how to use Glimpse. Generated from the catalog by the build; do not edit by hand. |
| `hooks/hooks.json` | A `UserPromptSubmit` hook. It asks the server what you did in the tab since the last prompt (a selection, a button, an answer) and passes that to Claude, so "click, then type" works without an extra tool call. |
| `dist/server.mjs` | The server, bundled into one file with no dependencies to install. Build output. |
| `dist/viewer/` | The viewer, a static single-page app served by the server. Build output. |
| `dist/THIRD_PARTY_NOTICES.md` | The licences of the third-party components bundled into `dist/`. Build output. |
| `LICENSE.md`, `NOTICE.md` | Glimpse's licence, and what it covers. See [Licence](#licence). |

`dist/` is not committed on `main`: it is produced by `npm run build` at the repository root, and the release workflow builds it onto the `release` branch, which is what installs come from.

## Using it

Install (Node 22.18 or newer):

```sh
claude plugin marketplace add svailla4/glimpse
claude plugin install glimpse@glimpse
```

Then ask, for example, "show me an overview of this repo" or "review my working tree in Glimpse". Update with `claude plugin update glimpse@glimpse`.

To run your own build from a checkout instead:

```sh
npm install          # .npmrc sets ignore-scripts
npm run build        # writes plugin/dist/server.mjs, plugin/dist/viewer/ and plugin/skills/glimpse/SKILL.md
cd /path/to/your/project
claude --plugin-dir /path/to/glimpse/plugin
```

Run `npm run build` again after pulling changes.

## What the server does on your machine

- It reads only the project directory Claude Code was started in, and runs `git` there. It makes no network requests and writes nothing into the project.
- Nothing happens until Claude first calls a Glimpse tool. The first `show` starts a web server bound to `127.0.0.1` (port 4517, or the next free one) and opens one browser tab. Up to five tabs can follow a session at once; a browser gives one site only six connections, and a sixth live tab would leave none for loading data.
- Every tool call first looks at HEAD and the working tree, so answers reflect what is on disk now, whether or not a tab is open.
- The tab talks to that server only. Requests need a random per-session token, which travels in the URL fragment and is never sent anywhere else; requests from other sites are refused. Only files in the repository's inventory are served: `.git` and ignored files are not.
- Nothing from the repository is executed. "Open in editor" starts your editor on the file, never the system's default opener.
- When the Claude Code session ends, the server exits. The tab keeps its last picture and says the session has ended.

The repository's main `README.md` has the full security model.

## Settings

Environment variables read by the server:

| Variable | Effect |
|---|---|
| `GLIMPSE_PORT` | Preferred port (default 4517; `0` picks any free port). |
| `GLIMPSE_NO_OPEN=1` | Never open a browser tab or an editor; the tool result carries the URL to open instead. |
| `GLIMPSE_EDITOR` | Command used to open a file from the viewer, for example `code -g {file}:{line}`. Without it Glimpse uses the first editor it knows on the PATH (`code`, `cursor`, `zed` and a few more); if there is none, nothing is opened. |

## Tools

| Tool | Purpose |
|---|---|
| `show` | Render a preset view (`overview`, `tree`, `deps`, `hotspots`, `history`, `file`, `symbol`, `stack`, `diff`, `feature`, `gallery`) or a custom spec, or patch a view that is already open. |
| `catalog` | Look up a component, a data source, a preset or the spec grammar. |
| `query` | Run a data source and get a few rows back as text. |
| `events` | What you did in the tab since the last call; can wait for the next interaction. |
| `pending_context` | Used by the hook above; hidden from the model. |

## Licence

Glimpse is source-available, not open source. Its own code is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) (`LICENSE.md`), which allows noncommercial purposes only: among them personal study, hobby projects and research for public knowledge without any anticipated commercial application, and use by charities, educational institutions, public research, safety, health and environmental organizations and government institutions. If you pass the plugin on, include `LICENSE.md` (or the licence URL) with its `Required Notice:` line.

Commercial use, which is likely to include using the plugin in paid work for a business (your employer or a client), needs a separate licence from the copyright holder. Ask through GitHub: [github.com/svailla4](https://github.com/svailla4).

The third-party components bundled into `dist/` keep their own licences, listed with their texts in `dist/THIRD_PARTY_NOTICES.md`. elkjs (in the ELK layout worker) is distributed under the Eclipse Public License 2.0 (`dist/viewer/assets/elkjs-LICENSE.txt`); the fonts are under the SIL Open Font License 1.1 (`dist/viewer/assets/OFL-*.txt`). `NOTICE.md` lists exactly what Glimpse's licence does not cover.
