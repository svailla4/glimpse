// Runs once before the suite: makes sure the bundle under test exists and is not older than the sources (design 10,
// step 1), and empties the artifact folders this suite writes itself.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BUNDLE, DIST, GALLERY_SHOTS, ROOT, TIMINGS_FILE, VIEWER_INDEX} from './paths.ts';

/** Newest modification time of the files under `dir` (0 when it does not exist). */
function newest(dir: string): number {
  let latest = 0;
  if (!existsSync(dir)) return latest;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(path));
    else if (entry.isFile()) latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
}

function bundleState(): 'missing' | 'stale' | 'current' {
  if (!existsSync(BUNDLE) || !existsSync(VIEWER_INDEX)) return 'missing';
  const built = Math.min(statSync(BUNDLE).mtimeMs, statSync(VIEWER_INDEX).mtimeMs);
  const sources = Math.max(...['catalog', 'server', 'viewer'].map(name => newest(join(ROOT, 'packages', name, 'src'))));
  return sources > built ? 'stale' : 'current';
}

export default function globalSetup(): void {
  const state = bundleState();
  if (state !== 'current') {
    if (process.env.GLIMPSE_E2E_NO_BUILD === '1') {
      if (state === 'missing') throw new Error(`e2e: no bundle in ${DIST} and GLIMPSE_E2E_NO_BUILD=1. Run: node scripts/build.mjs --out ${DIST}`);
      console.warn(`e2e: the bundle in ${DIST} is older than packages/*/src; testing it anyway (GLIMPSE_E2E_NO_BUILD=1).`);
    } else {
      console.log(`e2e: the bundle in ${DIST} is ${state}; building it.`);
      const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--out', DIST], {cwd: ROOT, stdio: 'inherit'});
      if (result.status !== 0) throw new Error('e2e: scripts/build.mjs failed; see its output above.');
    }
  }
  rmSync(GALLERY_SHOTS, {recursive: true, force: true});
  mkdirSync(GALLERY_SHOTS, {recursive: true});
  writeFileSync(TIMINGS_FILE, '[]\n');
}
