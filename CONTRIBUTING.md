# Contributing to Glimpse

Bug reports, ideas and pull requests are welcome. Please read the terms below before you send code or documentation:
they are what allows Glimpse to accept it.

## Terms for contributions

Glimpse is published under the PolyForm Noncommercial License 1.0.0 (`LICENSE.md`). That licence lets other people
use Glimpse for noncommercial purposes only. The copyright holder, svailla4 (https://github.com/svailla4), also uses
Glimpse commercially and may license it to others for commercial use. That is only possible for material the copyright
holder has the rights to, and the PolyForm licence alone would not give the copyright holder those rights in your
contribution. So contributions are accepted only on these terms.

By submitting a contribution (a pull request, a patch, or any code, documentation or other material that you intend
to be included in Glimpse), you agree to the following.

1. **Copyright licence.** You grant the copyright holder of Glimpse, and anyone to whom that copyright is later
   transferred, a perpetual, worldwide, non-exclusive, royalty-free, irrevocable licence to use, reproduce, modify,
   prepare derivative works of, publicly display, publicly perform, distribute and sublicense your contribution, and
   to license it to others under any terms, including commercial and proprietary terms and licences other than the
   one Glimpse is published under. This applies to your contribution on its own and as part of Glimpse or of any other
   work.
2. **Patent licence.** You grant the same people a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
   licence under any patent claims you can license that are infringed by your contribution, alone or combined with
   Glimpse, to make, have made, use, sell, offer for sale, import and otherwise transfer it.
3. **You are entitled to grant this.** The contribution is your own original work, or you have the right to submit it
   on these terms. If your employer or a client has rights in work you create, you have their permission to
   contribute it on these terms. If any part comes from someone else (code copied from another project, for example),
   you say so in the pull request, with its source and licence.
4. **You keep your copyright.** This is a licence, not a transfer of ownership: you can still use your own
   contribution as you like.
5. **No obligation, no warranty.** The copyright holder does not have to use your contribution. Apart from point 3,
   you provide it as is, without warranties or conditions of any kind.
6. **What the public receives.** Once included, your contribution is distributed to the public as part of Glimpse,
   under Glimpse's licence at the time.

To confirm, put this line in the description of your pull request:

```
I agree to the contribution terms in CONTRIBUTING.md.
```

A pull request without it cannot be merged. For a contribution made on behalf of a company, the company must agree to
these terms too; open an issue first.

### Third-party code

Do not paste code from other projects unless you say where it comes from and its licence is one that the build allows
for shipped code (`ALLOWED` in `scripts/notices.ts`: MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0,
OFL-1.1). A new dependency that ships must have such a licence and a licence file; the build checks both and lists the
dependency in `THIRD_PARTY_NOTICES.md`.

## Development

Requires Node 22.18 or newer (developed on Node 26), npm 11 and `git`.

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

Working on one area:

```sh
npm run check:paths -- packages/viewer/src/components/table packages/viewer/test/table
npm test -w @glimpse/viewer -- test/table
npm run e2e -- security     # one end-to-end spec
```

Before you open a pull request:

- `npm run check`, `npm test`, `npm run build` and `npm run budgets` pass. Lint warnings fail the check.
- After changing anything under `packages/catalog/src` or `packages/catalog/fixtures`, run `npm run generate` and
  commit the result.
- After adding, removing or upgrading a dependency that ships, run `npm run build` and commit the regenerated
  `THIRD_PARTY_NOTICES.md` and `plugin/skills/glimpse/SKILL.md` if they changed.
- Do not commit `plugin/dist`: it is build output, committed only for a release.

The README's [Development](README.md#development) section has more detail, including the size budgets.
