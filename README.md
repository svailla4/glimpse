# Glimpse

Generative UI for codebases. Glimpse is an [A2UI](https://a2ui.org) v1.0 component catalog plus an MCP server that lets a coding agent render rich, interactive views of any repository (architecture diagrams, dependency graphs, sortable tables, charts, diff walkthroughs) in a local browser viewer, without the agent writing HTML.

> Status: early development. The contracts, the catalog and the test scaffolding exist. The MCP server, the analyzers and the components are being built; today the viewer renders a fixture in which every component shows a "not implemented" placeholder.

## Why

Asking a model to write a full HTML page for every explanation is slow and token-heavy. Glimpse flips that around:

- **A fixed, well-designed component catalog.** The agent writes a compact spec that names components (`Page`, `DataTable`, `Graph`, `DiffView`, 44 in all); the viewer renders them.
- **Data stays on your machine.** The server computes file trees, dependency graphs and git statistics locally and binds them straight into the UI's data model. The agent names a source (`'git.churn src/auth top=20'`); the rows never pass through the model.
- **Standard protocol.** The wire format is A2UI v1.0, so the catalog works with any A2UI-capable renderer or agent.

## Layout

```
packages/
  catalog/   the catalog, defined once in zod: 44 components, 26 data sources, preset views,
             the notation parsers, generated docs and catalog.json, fixtures. DOM-free.
  viewer/    React single-page app: the kit that binds views to A2UI, and the component library
  server/    MCP server, loopback viewer host, repository analyzers
scripts/     generate.ts (catalog artifacts and fixtures), check-paths.mjs (checks for one area),
             task.mjs (build, e2e and demo dispatcher)
```

## Development

Requires Node 22.18 or newer (developed on Node 26) and npm 11.

```sh
npm install --ignore-scripts
npm run check       # Biome lint, then tsc --noEmit for the root scripts and each package
npm test            # every unit and component test (vitest)
npm run generate    # rewrite packages/catalog/generated and packages/catalog/fixtures
npm run dev         # viewer dev server showing the gallery fixture
npm run build       # production build (the viewer only, until the server bundle exists)
```

`npm run e2e` and `npm run demo` exist but report that nothing is there yet.

Working on one area:

```sh
npm run check:paths -- packages/viewer/src/components/table packages/viewer/test/table
                                                # lint, typecheck and test only these paths; type errors in other
                                                # files of the package are counted, not shown, and do not fail
npm run check -w @glimpse/viewer                # lint and typecheck one package (catalog, server, viewer)
npm test -w @glimpse/server                     # tests of one package
npm test -w @glimpse/viewer -- test/table       # tests of one directory or file of a package
npx vitest run packages/catalog/test/notation.test.ts
npx biome check --error-on-warnings packages/viewer/src/components/charts
```

Lint warnings fail the check (unused imports and variables included). Under `packages/viewer` the accessibility rules that reject ARIA widget patterns built from `div` and SVG elements (virtualised rows with `role="row"`, trees, roving `tabIndex`, clickable SVG groups) are switched off in `biome.json`; the rest of the recommended set applies. For a single justified exception use `// biome-ignore lint/<group>/<rule>: <reason>`.

Do not reinstall dependencies (`npm install`, `npm ci`) while checks or tests are running in the same working tree: `tsc` and `vitest` fail with missing-type errors while `node_modules` is being rewritten.

After changing anything under `packages/catalog/src` or `packages/catalog/fixtures`, run `npm run generate` and commit the result; a test fails when the generated files are stale.

## Tests

- `packages/catalog/test`: catalog lint, conformance of `catalog.json` and of every preset, example and recipe against the A2UI v1.0 runtime and the vendored spec schemas, the notation parsers, the generated docs, the fixtures.
- `packages/server/test/fixtures/repo.ts` builds a small deterministic git repository (TypeScript, Python and Go; 12 commits by three authors; a feature branch; a dirty working tree) for analyzer and git tests.
- `packages/viewer/test/harness.tsx` renders real A2UI messages through the real components under jsdom, with canned data and a fake layout, for component tests. It loads the six component chunks separately, so a chunk that fails to import shows an error on its own components and does not stop the tests of the others.
- Three test files are shared gates that load every area at once and so can fail because of any of them: `packages/viewer/test/harness.test.tsx` (all six chunks, the app catalog, the gallery fixture), `packages/viewer/test/build.test.ts` (an in-memory production build: no inline script or style, cascade-layer order) and `packages/server/test/sources/all.test.ts` (every source implementation).

## Licence

No licence has been chosen yet; all rights reserved for now. The A2UI JSON Schema files under `packages/catalog/spec` are third-party files under the Apache License 2.0: see the `NOTICE` in that directory.
