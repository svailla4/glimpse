# Glimpse plugin for Claude Code

Glimpse lets Claude show you a codebase instead of describing it. Ask for an overview, a dependency map, the hotspots, a review of a branch or a walk through a file, and a view opens in a local browser tab: tables, charts, diagrams, code and diffs drawn from a fixed, designed component catalog. Claude writes a short spec that names components and data sources; the server computes the data on your machine and the viewer paints it. File contents and analysis results never pass through the model.

## What is in here

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest. |
| `.mcp.json` | Starts the Glimpse MCP server: `node dist/server.mjs`, one process per Claude Code session. |
| `skills/glimpse/SKILL.md` | Tells Claude when and how to use Glimpse. Generated from the catalog; do not edit by hand. |
| `hooks/hooks.json` | A `UserPromptSubmit` hook. It asks the server what you did in the tab since the last prompt (a selection, a button, an answer) and passes that to Claude, so "click, then type" works without an extra tool call. |
| `dist/server.mjs` | The server, bundled into one file with no dependencies to install. Build output. |
| `dist/viewer/` | The viewer, a static single-page app served by the server. Build output. |

`dist/` is produced by `npm run build` at the repository root and is committed only for a release.

## Using it

From a checkout of the repository:

```sh
npm install --ignore-scripts
npm run build
claude --plugin-dir ./plugin
```

Then ask, for example, "show me an overview of this repo" or "review my working tree in Glimpse".

Once the repository is published as a marketplace:

```sh
claude plugin marketplace add <owner>/<repo>
claude plugin install glimpse@glimpse
```

## What the server does on your machine

- It reads only the project directory Claude Code was started in, and runs `git` there. It makes no network requests.
- Nothing happens until Claude first calls a Glimpse tool. The first `show` starts a web server bound to `127.0.0.1` (port 4517, or the next free one) and opens one browser tab.
- The tab talks to that server only. Requests need a random per-session token, which travels in the URL fragment and is never sent anywhere else; requests from other sites are refused.
- When the Claude Code session ends, the server exits. The tab keeps its last picture and says the session has ended.

## Settings

Environment variables read by the server:

| Variable | Effect |
|---|---|
| `GLIMPSE_PORT` | Preferred port (default 4517; `0` picks any free port). |
| `GLIMPSE_NO_OPEN=1` | Never open a browser tab or an editor; the tool result carries the URL to open instead. |
| `GLIMPSE_EDITOR` | Command used to open a file from the viewer, for example `code -g {file}:{line}`. Without it Glimpse tries `code`, `cursor` and `zed`, then the system default. |

## Tools

| Tool | Purpose |
|---|---|
| `show` | Render a preset view (`overview`, `tree`, `deps`, `hotspots`, `history`, `file`, `symbol`, `stack`, `diff`, `feature`, `gallery`) or a custom spec, or patch a view that is already open. |
| `catalog` | Look up a component, a data source, a preset or the spec grammar. |
| `query` | Run a data source and get a few rows back as text. |
| `events` | What you did in the tab since the last call; can wait for the next interaction. |
| `pending_context` | Used by the hook above; hidden from the model. |
