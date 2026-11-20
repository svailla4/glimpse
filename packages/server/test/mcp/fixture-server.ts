// A whole Glimpse server process on fake sources and stub services, for the stdio tests: the same serve() as
// src/main.ts, composed without loading analyzer or git code. Not a test file (vitest runs *.test.ts only).
import {SOURCE_BY_NAME} from '@glimpse/catalog';
import {serve} from '../../src/mcp/server.ts';
import {fakeDeps, fixedSource} from '../session/fakes.ts';

const langs = [{lang: 'TypeScript', files: 20, loc: 7100, pct: 71}, {lang: 'CSS', files: 6, loc: 1200, pct: 12}, {lang: 'Markdown', files: 4, loc: 900, pct: 9}, {lang: 'JSON', files: 2, loc: 800, pct: 8}];

serve({
  env: process.env,
  argv: process.argv.slice(2),
  loadDeps: async () => fakeDeps({
    slowMs: Number(process.env.GLIMPSE_TEST_SLOW_MS ?? 600),
    extra: [{meta: SOURCE_BY_NAME.get('files.langs')!, run: async () => ({data: langs, summary: '4 rows; fields lang files loc pct; top TypeScript 71%'})}, fixedSource('repo.stack', ['TypeScript', 'Vite'], '2 chips')],
  }),
  viewerDirs: process.env.GLIMPSE_VIEWER_DIR ? [process.env.GLIMPSE_VIEWER_DIR] : [],
  settleMs: Number(process.env.GLIMPSE_TEST_SETTLE_MS ?? 250),
});
