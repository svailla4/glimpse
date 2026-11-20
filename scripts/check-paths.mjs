// scripts/check-paths.mjs - lint, typecheck and test only the paths you name.
//
//   npm run check:paths -- packages/viewer/src/components/table packages/viewer/test/table
//   node scripts/check-paths.mjs packages/server/src/git packages/server/test/git
//
// `npm run check` and `npm test` cover the whole repository, so they fail on anybody's unfinished file. While several
// areas are being built at once, this checks one area:
//   1. Biome on the given paths (warnings fail, as in `npm run check`).
//   2. tsc on each package that holds one of the paths, reporting only the errors in files under those paths. Errors
//      elsewhere in the package are counted, not shown, and do not fail the run.
//   3. vitest on the given paths that are test directories or test files.
// Exit status 0 means the named paths are clean. Run the full `npm run check` and `npm test` before merging.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.error('usage: node scripts/check-paths.mjs <file or directory> [...]   (paths relative to the repository root)');
  process.exit(2);
}

const posix = path => path.split(sep).join('/');
const own = args.map(arg => resolve(root, arg));
for (const path of own) {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`check-paths: ${path} is outside the repository`);
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`check-paths: ${posix(rel)} does not exist`);
    process.exit(2);
  }
}
const isOwn = file => own.some(path => file === path || file.startsWith(path + sep));
const bin = name => join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const run = (name, argv, cwd, capture) =>
  spawnSync(bin(name), argv, {cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: process.platform === 'win32'});

let failed = false;

// 1. lint
console.log(`biome: ${own.map(path => posix(relative(root, path))).join(' ')}`);
const lint = run('biome', ['check', '--error-on-warnings', ...own.map(path => relative(root, path))], root, false);
if (lint.status !== 0) failed = true;

// 2. types: the tsconfig project that covers each path (a package, or the root project for scripts/ and e2e/)
const projects = new Set();
for (const path of own) {
  const [first, second] = posix(relative(root, path)).split('/');
  projects.add(first === 'packages' && second ? join(root, 'packages', second) : root);
}
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (?:error|warning) TS\d+:/;
for (const project of projects) {
  const name = posix(relative(root, project)) || '.';
  if (!existsSync(join(project, 'tsconfig.json'))) continue;
  const tsc = run('tsc', ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], project, true);
  const lines = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.split(/\r?\n/);
  const shown = [];
  let elsewhere = 0;
  let keep = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = DIAGNOSTIC.exec(line);
    if (match) {
      keep = isOwn(resolve(project, match[1]));
      if (keep) shown.push(posix(relative(root, resolve(project, match[1]))) + line.slice(match[1].length));
      else elsewhere++;
    } else if (/^\s/.test(line)) {
      if (keep) shown.push(line); // continuation of the previous diagnostic
    } else {
      keep = true; // a diagnostic without a file (bad config, missing types): always relevant
      shown.push(line);
    }
  }
  if (tsc.error) shown.push(`could not run tsc: ${tsc.error.message}`);
  const outside = elsewhere > 0 ? `; ${elsewhere} error${elsewhere === 1 ? '' : 's'} in other files of ${name} not shown` : '';
  if (shown.length > 0) {
    failed = true;
    console.log(`tsc ${name}: errors in your paths${outside}`);
    console.log(shown.join('\n'));
  } else {
    console.log(`tsc ${name}: your paths are clean${outside}`);
  }
}

// 3. tests
const isTestPath = path => /(^|\/)test(\/|$)/.test(posix(relative(root, path))) || /\.test\.tsx?$/.test(path);
const tests = own.filter(isTestPath).map(path => posix(relative(root, path)));
if (tests.length > 0) {
  console.log(`vitest: ${tests.join(' ')}`);
  const vitest = run('vitest', ['run', ...tests], root, false);
  if (vitest.status !== 0) failed = true;
} else {
  console.log('vitest: none of the paths is a test directory or test file, so no tests were run');
}

process.exit(failed ? 1 : 0);
