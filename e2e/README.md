# End-to-end suite

Playwright (Chromium) against the real bundled MCP server. Every test spawns `node <dist>/server.mjs` over stdio, drives it through `@modelcontextprotocol/client` the way an agent would, and looks at the viewer in a headless browser. Nothing is mocked.

```sh
npx playwright install chromium     # once
npm run e2e                         # everything (about a minute)
npm run e2e -- security             # one spec
```

| Spec | What it covers |
|---|---|
| `overview.spec.ts` | The nine steps of the design's end-to-end test on the fixture repository: tool result, first plate, a live patch, a click reaching the agent, the live working-tree diff, a bad spec, shutdown. Then the overview on this repository: hotspot file names stay visible, and the module graph's labels are drawn at 10 px or more (decision D7). |
| `views.spec.ts` | Every preset on the fixture repository and on this one: no redline, no console error, no CSP violation, result within 1,200 characters. `query` and `catalog`. A missing file or an unknown revision in a spec is reported in the `show` result (D3). |
| `interaction.spec.ts` | File tree to code view (the tree preset opens on the README), `Ask` and `Button` events (tool result, `events`, long-poll, the hook's `pending_context`), plan updates whole and by one nested field (D4), a new view opening at its top, adding a plate without losing the tree's state, closing and refreshing, arranging plates and dragging graph nodes with persistence. |
| `decisions.spec.ts` | The review round's decisions: a drill and its way back across a reload, and a re-show that clears it (D1); a hyphenated id end to end (D2); an empty plate reported in the `show` result that drew it (D3); a file edited with no tab open seen by the next call (D8). |
| `gallery.spec.ts` | `show{view:"gallery"}`: all 44 components present, light and dark, 1320 px and 720 px, one screenshot per section; no redline and no empty plate, the Code section on a real file. |
| `security.spec.ts` | The guard matrix: Host, Origin, Sec-Fetch-Site, token, JSON-only POST, no CORS, security headers, loopback bind, the five-tab cap, path and range containment, surface ids, `$/__proto__` specs refused with the server still answering (D10), hostile Markdown and file names, event-line injection. |

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

A test that fails because of a product defect is declared with `knownDefect(ref, ...)` (a `test.fixme`, in `support/test.ts`), so the suite stays green and the report still lists it; list it here with its ref. When the defect is fixed, turn the call back into `test(...)` and remove the entry.

None is open: the six found when the suite was written (E2E-01 to E2E-06) were fixed in the review round and are ordinary tests again.
