# End-to-end suite

Playwright (Chromium) against the real bundled MCP server. Every test spawns `node <dist>/server.mjs` over stdio, drives it through `@modelcontextprotocol/client` the way an agent would, and looks at the viewer in a headless browser. Nothing is mocked.

```sh
npx playwright install chromium     # once
npm run e2e                         # everything (about a minute)
npm run e2e -- security             # one spec
```

| Spec | What it covers |
|---|---|
| `overview.spec.ts` | The nine steps of the design's end-to-end test on the fixture repository: tool result, first plate, a live patch, a click reaching the agent, the live working-tree diff, a bad spec, shutdown. Then the overview on this repository. |
| `views.spec.ts` | Every preset on the fixture repository and on this one: no redline, no console error, no CSP violation, result within 1,200 characters. `query` and `catalog`. |
| `interaction.spec.ts` | File tree to code view, `Ask` and `Button` events (tool result, `events`, long-poll, the hook's `pending_context`), plan updates, closing and refreshing, arranging plates and dragging graph nodes with persistence. |
| `gallery.spec.ts` | `show{view:"gallery"}`: all 44 components present, light and dark, 1320 px and 720 px, one screenshot per section. |
| `security.spec.ts` | The guard matrix: Host, Origin, Sec-Fetch-Site, token, JSON-only POST, no CORS, security headers, loopback bind, tab cap, path and range containment, hostile Markdown and file names, event-line injection. |

The repositories are `makeFixtureRepo()` (`packages/server/test/fixtures/repo.ts`: deterministic, built in a temp directory per test) and this checkout. Set `GLIMPSE_E2E_REPO` to add any other repository to the real-repository checks.

## Environment

| Variable | Effect |
|---|---|
| `GLIMPSE_DIST` | Directory holding `server.mjs` and `viewer/` (default `plugin/dist`). Use with `node scripts/build.mjs --out <dir>` to test a build without touching `plugin/dist`. |
| `GLIMPSE_E2E_ARTIFACTS` | Output directory (default `test-results/`). |
| `GLIMPSE_E2E_NO_BUILD=1` | Never build. Without it the suite builds when the bundle is missing or older than `packages/*/src`. |
| `GLIMPSE_E2E_REPO` | An extra repository for `overview.spec.ts` and `views.spec.ts`. |
| `GLIMPSE_E2E_KNOWN=1` | Run the known-defect tests below as ordinary tests (they fail until fixed). |

## Artifacts

Under `test-results/` (ignored by git; uploaded by CI):

- `gallery/<theme>-<width>/<n>-<section>.png` and `0-page.png`: the gallery screenshots, 32 files. There is no pixel gate yet; a visual diff is added once the look is approved.
- `timings.json`: time to result, time to first plate and others, per repository.
- `playwright/`: traces and screenshots of failed tests.

## Known defects

A test that fails because of a product defect is declared with `knownDefect(ref, ...)` (a `test.fixme`), so the suite stays green and the report still lists it. When the defect is fixed, turn the call back into `test(...)` and remove the entry here.

| Ref | Test | What is wrong |
|---|---|---|
| E2E-01 | `interaction.spec.ts`: a patch of one plan step updates the Steps view | `show{id, spec: "$/plan/1/status='done'"}` answers `ok` and changes the data model, but a view bound to the containing array (`Steps($/plan)`, and likewise `List`, `Stats`, tables on inline data) keeps its old rows. Replacing the whole array works. |
| E2E-02 | `interaction.spec.ts`: a new view opens at its top | The window's scroll offset is kept when another view takes focus, so a view shown while the previous one was scrolled opens part-way down. |
| E2E-03 | `gallery.spec.ts`: no gallery component is in its empty state | The gallery's `SymbolOutline('README.md')` always shows "no symbols in README.md". |
| E2E-04 | `views.spec.ts`: show tells the agent when a code or diff target does not exist | `CodeView('missing.ts')` and `DiffView('nosuchbranch..HEAD')` answer a bare `ok`; the person sees an empty plate or a redline and the agent is never told. Dataset refs with a bad target do produce a `warn` line. |
| E2E-05 | `overview.spec.ts`: the hotspots table shows the file name of every row | Path cells are cut at the end, so deep paths lose their file name ("packages/viewer/src/compon"). |
| E2E-06 | `overview.spec.ts`: the module graph opens with readable node labels | A 48-module graph is fitted into its plate at about 20% zoom; labels are about 3 px tall. |
