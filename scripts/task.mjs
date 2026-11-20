// scripts/task.mjs - runs the root tasks whose real implementation belongs to a later work package, and says so
// plainly while that implementation is missing (WP0 placeholder dispatcher; the targets replace nothing here).
//   npm run build   ->  scripts/build.mjs   (WP1: viewer build + server bundle into plugin/dist)
//   npm run e2e     ->  Playwright suite in e2e/   (WP7)
//   npm run demo    ->  scripts/demo.mjs    (WP7)
// Extra arguments are passed through: npm run demo -- ../some-repo
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [task, ...rest] = process.argv.slice(2);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit'});
  if (result.error) {
    console.error(`glimpse: could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const tasks = {
  build() {
    const script = join(root, 'scripts', 'build.mjs');
    if (existsSync(script)) run(process.execPath, [script, ...rest]);
    console.error('glimpse: scripts/build.mjs does not exist yet, so only the viewer is built (packages/viewer/dist).');
    console.error('         The server bundle and plugin/dist arrive with the server core.');
    run(npm, ['run', 'build', '-w', '@glimpse/viewer']);
  },
  e2e() {
    const config = join(root, 'e2e', 'playwright.config.ts');
    if (existsSync(config)) run(npx, ['playwright', 'test', '--config', config, ...rest]);
    console.error('glimpse: there is no end-to-end suite yet (e2e/playwright.config.ts is missing). Nothing was run.');
    console.error('         Unit and component tests: npm test');
    process.exit(1);
  },
  demo() {
    const script = join(root, 'scripts', 'demo.mjs');
    if (existsSync(script)) run(process.execPath, [script, ...rest]);
    console.error('glimpse: there is no demo yet (scripts/demo.mjs is missing). Nothing was run.');
    console.error('         To see the component gallery fixture in a browser: npm run dev');
    process.exit(1);
  },
};

if (!task || !Object.hasOwn(tasks, task)) {
  console.error(`usage: node scripts/task.mjs <${Object.keys(tasks).join('|')}> [args]`);
  process.exit(2);
}
tasks[task]();
