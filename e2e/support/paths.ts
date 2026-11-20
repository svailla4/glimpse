// Where the end-to-end suite finds things. Nothing here is machine-specific: every path is derived from this file's
// location or from an environment variable.
//
//   GLIMPSE_DIST            directory holding server.mjs and viewer/ (default: plugin/dist). Point it at the output of
//                           `node scripts/build.mjs --out <dir>` to test a build without touching plugin/dist.
//   GLIMPSE_E2E_ARTIFACTS   where screenshots, timings and Playwright's own output go (default: test-results/)
//   GLIMPSE_E2E_NO_BUILD    1 = never build; fail when the bundle is missing
//   GLIMPSE_E2E_REPO        an extra repository to run the real-repository checks against (optional)
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = resolve(process.env.GLIMPSE_DIST || join(ROOT, 'plugin', 'dist'));
export const BUNDLE = join(DIST, 'server.mjs');
export const VIEWER_INDEX = join(DIST, 'viewer', 'index.html');
export const ARTIFACTS = resolve(process.env.GLIMPSE_E2E_ARTIFACTS || join(ROOT, 'test-results'));
export const TIMINGS_FILE = join(ARTIFACTS, 'timings.json');
export const GALLERY_SHOTS = join(ARTIFACTS, 'gallery');
export const EXTRA_REPO = process.env.GLIMPSE_E2E_REPO ? resolve(process.env.GLIMPSE_E2E_REPO) : undefined;
