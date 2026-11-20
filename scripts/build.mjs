// scripts/build.mjs - builds the Claude Code plugin in plugin/.
//
//   node scripts/build.mjs             everything: viewer, server bundle, skill, then a start-up check of the bundle
//   node scripts/build.mjs --server    server bundle and skill only (does not touch the viewer)
//   node scripts/build.mjs --viewer    viewer only
//   add --no-verify to skip the start-up check
//   add --out <dir> to write the build output there instead of plugin/dist (used by the tests)
//
// What it writes:
//   plugin/dist/server.mjs            packages/server/src/main.ts and all its dependencies in one ESM file; it runs
//                                     with no node_modules (the check starts it from an empty directory)
//   plugin/dist/viewer/               a copy of packages/viewer/dist; the server serves it from next to the bundle
//   plugin/skills/glimpse/SKILL.md    generated from the catalog (skillMarkdown() in packages/catalog/src/docs.ts)
//   plugin/dist/THIRD_PARTY_NOTICES.md  the licences of every third-party component in the bundle and the viewer
//                                     (scripts/notices.ts), with the licence files the fonts and the ELK worker need
//                                     next to them in plugin/dist/viewer/assets; the same notices are kept in
//                                     THIRD_PARTY_NOTICES.md at the repository root, which is committed
//
// The steps are independent. When the viewer does not build, the server bundle and the skill are still written, the
// previous plugin/dist/viewer (if any) is left in place, and the script says which parts are current and exits 1.
import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
// Node strips the types of these TypeScript modules itself (22.18 or newer, as package.json requires).
import {collect, MODULE_RECORD, NOTICES_FILE, render} from './notices.ts';
import {serverBuildOptions} from './server-bundle.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugin');

const argv = process.argv.slice(2);
const flags = new Set();
let outDir;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--out') outDir = argv[++i] ?? '';
  else if (arg.startsWith('--out=')) outDir = arg.slice('--out='.length);
  else flags.add(arg);
}
const known = ['--server', '--viewer', '--no-verify', '--help'];
const unknown = [...flags].filter(flag => !known.includes(flag));
if (flags.has('--help') || unknown.length > 0 || outDir === '') {
  if (unknown.length > 0) console.error(`build: unknown option ${unknown.join(' ')}`);
  if (outDir === '') console.error('build: --out needs a directory');
  console.error('usage: node scripts/build.mjs [--server | --viewer] [--no-verify] [--out <dir>]');
  process.exit(flags.has('--help') && unknown.length === 0 && outDir !== '' ? 0 : 2);
}
const dist = outDir === undefined ? join(plugin, 'dist') : resolve(outDir);
const bundle = join(dist, 'server.mjs');
/** Repository-relative for paths inside it, absolute otherwise. */
const rel = path => {
  const relativePath = relative(root, path);
  return relativePath.startsWith('..') ? path : relativePath.split('\\').join('/');
};
const wantServer = flags.has('--server') || !flags.has('--viewer');
const wantViewer = flags.has('--viewer') || !flags.has('--server');

/** One line per step, e.g. `server  ok      plugin/dist/server.mjs (3.2 MB)`. */
const report = [];
const note = (step, status, detail) => report.push({step, status, detail});
const size = bytes => (bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} kB`);

async function buildViewer() {
  const viewerDist = join(root, 'packages', 'viewer', 'dist');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('build: viewer (vite build)');
  const result = spawnSync(npm, ['run', 'build', '-w', '@glimpse/viewer'], {cwd: root, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32'});
  if (result.error || result.status !== 0 || !existsSync(join(viewerDist, 'index.html'))) {
    const kept = existsSync(join(dist, 'viewer', 'index.html')) ? `${rel(join(dist, 'viewer'))} still holds the previous build` : `${rel(join(dist, 'viewer'))} does not exist: the server will answer "viewer not built"`;
    note('viewer', 'FAILED', `vite build failed (see its output above); ${kept}`);
    return false;
  }
  // Copy next to the old directory, then swap, so a failure never leaves half a viewer behind.
  const staging = join(dist, `viewer.new-${process.pid}`);
  await rm(staging, {recursive: true, force: true});
  await mkdir(dist, {recursive: true});
  // The module record is for the notices (below); it does not ship.
  viewerRecord = JSON.parse(await readFile(join(viewerDist, MODULE_RECORD), 'utf8'));
  await cp(viewerDist, staging, {recursive: true, filter: source => relative(viewerDist, source).split(/[\\/]/)[0] !== '.vite'});
  await rm(join(dist, 'viewer'), {recursive: true, force: true});
  await rename(staging, join(dist, 'viewer'));
  note('viewer', 'ok', `${rel(join(dist, 'viewer'))} (copied from ${rel(viewerDist)})`);
  return true;
}

async function buildServer() {
  console.log('build: server bundle (esbuild)');
  try {
    await mkdir(dist, {recursive: true});
    const result = await build(serverBuildOptions(root, bundle));
    serverMetafile = result.metafile;
    const byPackage = new Map();
    for (const [file, info] of Object.entries(result.metafile.inputs)) {
      const name = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file)?.[1] ?? '(glimpse)';
      byPackage.set(name, (byPackage.get(name) ?? 0) + info.bytes);
    }
    const largest = [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, bytes]) => `${name} ${size(bytes)}`).join(', ');
    note('server', 'ok', `${rel(bundle)} (${size((await stat(bundle)).size)}; largest inputs: ${largest})`);
    return true;
  } catch (error) {
    // esbuild has already printed the errors with file and line.
    note('server', 'FAILED', `esbuild could not bundle packages/server/src/main.ts: ${String(error?.message ?? error).split('\n')[0]}`);
    return false;
  }
}

async function writeSkill() {
  try {
    // Node strips the types of the catalog sources itself (Node 22.18 or newer, as package.json requires).
    const {skillMarkdown} = await import(pathToFileURL(join(root, 'packages', 'catalog', 'src', 'docs.ts')).href);
    const file = join(plugin, 'skills', 'glimpse', 'SKILL.md');
    const text = skillMarkdown();
    const before = await readFile(file, 'utf8').catch(() => undefined);
    await mkdir(dirname(file), {recursive: true});
    if (before !== text) await writeFile(file, text);
    note('skill', 'ok', `${rel(file)} (${before === text ? 'unchanged' : 'written'})`);
    return true;
  } catch (error) {
    note('skill', 'FAILED', `could not generate SKILL.md from packages/catalog/src/docs.ts: ${String(error?.message ?? error).split('\n')[0]}`);
    return false;
  }
}

/**
 * Starts the bundle from an empty directory (so nothing can come from a node_modules folder), speaks MCP to it on
 * stdio, expects the five tools and shows the gallery on an ephemeral loopback port without opening a browser.
 * Checks too that stdout carried nothing but JSON and that closing stdin ends the process.
 */
async function verifyBundle() {
  const cwd = await mkdtemp(join(tmpdir(), 'glimpse-build-check-'));
  try {
    const env = {PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: cwd, GLIMPSE_NO_OPEN: '1', GLIMPSE_PORT: '0'};
    const child = spawn(process.execPath, [bundle], {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const answer = async id => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const line = stdout.split('\n').find(text => text.includes(`"id":${id}`));
        if (line) return JSON.parse(line);
        if (child.exitCode !== null) throw new Error(`the server exited with code ${child.exitCode}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
        if (Date.now() > deadline) throw new Error('no answer within 15 s');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'glimpse-build', version: '0'}}});
      const initialized = await answer(1);
      send({jsonrpc: '2.0', method: 'notifications/initialized'});
      send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
      const tools = (await answer(2)).result?.tools?.map(tool => tool.name) ?? [];
      send({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'catalog', arguments: {names: ['grammar']}}});
      const grammar = (await answer(3)).result?.content?.[0]?.text ?? '';
      // The gallery needs no repository: it proves the composition (services, host, viewer files) inside the bundle.
      send({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'show', arguments: {view: 'gallery'}}});
      const shown = (await answer(4)).result ?? {};
      const shownText = shown.content?.[0]?.text ?? '';
      const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(shownText)?.[0];
      const shell = origin && !shown.isError ? (await fetch(`${origin}/`)).status : 0;
      child.stdin.end();
      const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))]);
      const expected = ['show', 'catalog', 'query', 'events', 'pending_context'];
      if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error(`tools/list answered ${JSON.stringify(tools)}`);
      if (!grammar.includes('Grammar Rules')) throw new Error('the Express compiler did not load inside the bundle');
      if (!initialized.result?.instructions) throw new Error('initialize carried no instructions');
      if (shown.isError || !shownText.startsWith('ok gallery ')) throw new Error(`show{view:"gallery"} answered: ${shownText.split('\n')[0]}`);
      if (shell !== 200 && shell !== 503) throw new Error(`the viewer host answered ${shell} for /`);
      if (code !== 0) throw new Error(`the server did not exit cleanly when stdin closed (${code})`);
      for (const line of stdout.split('\n').filter(Boolean)) JSON.parse(line);
      const viewer = shell === 200 ? 'serves the viewer' : 'has no viewer next to it yet (the page says so)';
      note('verify', 'ok', `the bundle starts from an empty directory, lists ${tools.length} tools, renders the gallery, ${viewer} and exits when stdin closes`);
      return true;
    } finally {
      child.kill('SIGKILL');
    }
  } catch (error) {
    note('verify', 'FAILED', String(error?.message ?? error).split('\n')[0]);
    return false;
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
}

/**
 * Writes dist/THIRD_PARTY_NOTICES.md and the licence files next to the fonts and the ELK worker, and keeps the
 * committed THIRD_PARTY_NOTICES.md at the repository root equal to it. The parts not built in this run are read back:
 * the server is bundled again in memory, the viewer's module record comes from packages/viewer/dist. Fails when a
 * shipped component has no acceptable licence or no licence text (scripts/notices.ts says which and what to do).
 */
async function writeNotices() {
  try {
    if (!serverMetafile) serverMetafile = (await build({...serverBuildOptions(root, bundle), write: false, logLevel: 'silent'})).metafile;
    const record = join(root, 'packages', 'viewer', 'dist', MODULE_RECORD);
    if (!viewerRecord && existsSync(join(dist, 'viewer', 'index.html')) && existsSync(record)) viewerRecord = JSON.parse(await readFile(record, 'utf8'));
    const collection = collect(root, serverMetafile, viewerRecord);
    if (collection.problems.length > 0) {
      for (const problem of collection.problems) console.error(`build: notices: ${problem}`);
      note('notices', 'FAILED', `${collection.problems.length} third-party licence problem${collection.problems.length === 1 ? '' : 's'} (listed above)`);
      return false;
    }
    const {notices, files} = render(collection);
    await mkdir(dist, {recursive: true});
    await writeFile(join(dist, NOTICES_FILE), notices);
    for (const [path, text] of Object.entries(files)) {
      if (path.startsWith('viewer/') && !existsSync(join(dist, 'viewer'))) continue;
      await writeFile(join(dist, path), text);
    }
    let committed = 'not updated: this build has no viewer';
    if (collection.complete) {
      const file = join(root, NOTICES_FILE);
      const before = await readFile(file, 'utf8').catch(() => undefined);
      if (before !== notices) await writeFile(file, notices);
      committed = `${rel(file)} ${before === notices ? 'unchanged' : 'written'}`;
    }
    note('notices', 'ok', `${rel(join(dist, NOTICES_FILE))} (${collection.components.length} components, ${Object.keys(files).length} licence files next to them; ${committed})`);
    return true;
  } catch (error) {
    note('notices', 'FAILED', `could not write the third-party notices: ${String(error?.message ?? error).split('\n')[0]}`);
    return false;
  }
}

/** The esbuild metafile of the server bundle and the viewer's module record, when built in this run (for the notices). */
let serverMetafile;
let viewerRecord;
const results = [];
if (wantViewer) results.push(await buildViewer());
if (wantServer) {
  const bundled = await buildServer();
  results.push(bundled, await writeSkill());
  if (bundled && !flags.has('--no-verify')) results.push(await verifyBundle());
}
results.push(await writeNotices());

console.log('');
for (const {step, status, detail} of report) console.log(`build: ${step.padEnd(7)} ${status.padEnd(7)} ${detail}`);
if (results.includes(false)) {
  console.error('build: incomplete. The parts marked ok above are current; fix the failed step and run the build again.');
  process.exit(1);
}
