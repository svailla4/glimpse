// scripts/budgets.mjs - the size budgets of design section 10, measured on the built plugin, not on the sources.
//
//   node scripts/budgets.mjs                 check plugin/dist (or $GLIMPSE_DIST)
//   node scripts/budgets.mjs --dist <dir>    check another build (the output of scripts/build.mjs --out <dir>)
//   node scripts/budgets.mjs --repo <dir>    also measure the preset results on that repository (default: this one)
//   node scripts/budgets.mjs --json          print the measurements as JSON instead of a table
//
// Each limit keeps headroom under the hard figure of design section 10 (decision D13), so the next component or
// source still fits: the hard figure is in parentheses.
// What the agent pays for, in characters (the bundled server is started over stdio and asked through the MCP client):
//   instructions                 <= 3,750   sent once per session (4,000; the catalog's INSTRUCTIONS_TARGET)
//   show + catalog definitions   <= 1,500   the two always-loaded tools: name, description and input schema as JSON
//   a preset result              <= 1,200   every preset, on the deterministic fixture repository and on --repo,
//                                           first call and repeat call (when every dataset has settled)
// What the browser pays for, gzip (default level, as Vite reports it; 1 kB = 1,000 bytes):
//   eager viewer JS              <= 195 kB  the entry script and everything it imports statically (200 kB;
//                                           the same figure as packages/viewer/test/build.test.ts)
//   each lazy chunk              <= 120 kB  every other script
// Exits 1 when a budget is exceeded or a measurement could not be taken.
import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The catalog (and below, the fixture) is TypeScript; Node strips the types itself (22.18 or newer, as package.json
// requires).
const {INSTRUCTIONS_TARGET} = await import(pathToFileURL(join(root, 'packages', 'catalog', 'src', 'docs.ts')).href);
const LIMITS = {instructions: INSTRUCTIONS_TARGET, definitions: 1500, preset: 1200, eager: 195_000, lazy: 120_000};

const argv = process.argv.slice(2);
const option = name => {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`budgets: ${name} needs a directory`);
    process.exit(2);
  }
  return value;
};
if (argv.includes('--help')) {
  console.log('usage: node scripts/budgets.mjs [--dist <dir>] [--repo <dir>] [--json]');
  process.exit(0);
}
const dist = resolve(option('--dist') ?? process.env.GLIMPSE_DIST ?? join(root, 'plugin', 'dist'));
const repo = resolve(option('--repo') ?? root);
const asJson = argv.includes('--json');
const bundle = join(dist, 'server.mjs');
const viewer = join(dist, 'viewer');
if (!existsSync(bundle) || !existsSync(join(viewer, 'index.html'))) {
  console.error(`budgets: no build in ${dist} (server.mjs and viewer/index.html are needed). Run: npm run build`);
  process.exit(1);
}

/** One measured line of the report. */
const rows = [];
const check = (group, name, value, limit, unit) => rows.push({group, name, value, limit, unit, ok: value <= limit});
const failures = [];

// ---------------------------------------------------------------- the viewer's scripts
async function measureViewer() {
  const html = await readFile(join(viewer, 'index.html'), 'utf8');
  const entry = /<script[^>]*type="module"[^>]*src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
  if (!entry) {
    failures.push('viewer/index.html has no module entry script');
    return;
  }
  const assets = join(viewer, 'assets');
  const scripts = (await readdir(assets)).filter(name => name.endsWith('.js'));
  const source = new Map(await Promise.all(scripts.map(async name => [name, await readFile(join(assets, name))])));
  // Static imports only (`from"./x.js"`, `import"./x.js"`); `import("./x.js")` is what makes a chunk lazy.
  const staticImports = name => [...source.get(name).toString('utf8').matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)].map(match => match[1]).filter(file => source.has(file));
  const eager = new Set();
  const visit = name => {
    if (eager.has(name)) return;
    eager.add(name);
    for (const next of staticImports(name)) visit(next);
  };
  visit(entry);
  // Anything index.html preloads is fetched up front as well.
  for (const match of html.matchAll(/rel="modulepreload"[^>]*href="\/assets\/([^"]+\.js)"/g)) if (source.has(match[1])) visit(match[1]);

  const gz = name => gzipSync(source.get(name)).length;
  const eagerBytes = [...eager].reduce((sum, name) => sum + gz(name), 0);
  check('viewer', `eager JS (${[...eager].map(name => name.replace(/-[\w-]{8}\.js$/, '')).join(' + ')})`, eagerBytes, LIMITS.eager, 'B gz');
  for (const name of scripts.filter(file => !eager.has(file)).sort((a, b) => gz(b) - gz(a))) check('viewer', `lazy chunk ${name}`, gz(name), LIMITS.lazy, 'B gz');
}

// ---------------------------------------------------------------- what the agent reads
async function mcpClient() {
  // The SDK client is a dev dependency of the server package; resolve it from there rather than rely on hoisting.
  const require = createRequire(join(root, 'packages', 'server', 'package.json'));
  const load = async specifier => import(pathToFileURL(require.resolve(specifier)).href);
  return {...(await load('@modelcontextprotocol/client')), ...(await load('@modelcontextprotocol/client/stdio'))};
}

async function withServer(projectDir, run) {
  const {Client, StdioClientTransport} = await mcpClient();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    stderr: 'ignore',
    env: {PATH: process.env.PATH ?? '', ...(process.env.HOME ? {HOME: process.env.HOME} : {}), CLAUDE_PROJECT_DIR: projectDir, GLIMPSE_NO_OPEN: '1', GLIMPSE_PORT: '0', GLIMPSE_TOKEN: 'budget-token'},
  });
  const client = new Client({name: 'glimpse-budgets', version: '0.0.0'}, {versionNegotiation: {mode: 'auto'}});
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({name, arguments: args});
    return {text: result.content.map(block => block.text ?? '').join('\n'), isError: result.isError === true};
  };
  try {
    return await run(client, call);
  } finally {
    await client.close().catch(() => {});
  }
}

async function measurePresets(label, projectDir) {
  await withServer(projectDir, async (_client, call) => {
    // A real file and a real symbol of this repository, for the two presets that need a target.
    const file = (await call('query', {ref: 'git.hotspots top=1', fields: 'path'})).text.split('\n')[1]
      ?? (await call('query', {ref: 'files.list top=1', fields: 'path'})).text.split('\n')[1];
    const symbol = file ? (await call('query', {ref: `code.symbols ${file}`, fields: 'name', limit: 1})).text.split('\n')[1] : undefined;
    const views = ['overview', 'tree', 'deps', 'hotspots', 'history', ...(file ? [`file ${file}`] : []), ...(symbol && /^\w+$/.test(symbol) ? [`symbol ${symbol}`] : []), 'stack', 'diff', 'feature', 'gallery'];
    for (const view of views) {
      const first = await call('show', {view});
      const again = await call('show', {view});
      const name = view.split(' ')[0];
      if (first.isError || again.isError) {
        failures.push(`${label}: show{view:"${view}"} failed: ${(first.isError ? first : again).text.split('\n')[0]}`);
        continue;
      }
      check(`presets on ${label}`, `show ${name}${name === view ? '' : ' <target>'}`, Math.max(first.text.length, again.text.length), LIMITS.preset, 'chars');
    }
  });
}

async function measureSession() {
  await withServer(repo, async client => {
    check('session', 'instructions', (client.getInstructions() ?? '').length, LIMITS.instructions, 'chars');
    const {tools} = await client.listTools();
    const upfront = ['show', 'catalog'].map(name => {
      const tool = tools.find(candidate => candidate.name === name);
      if (!tool) failures.push(`tools/list has no "${name}" tool`);
      return tool ? JSON.stringify({name, description: tool.description, inputSchema: tool.inputSchema}) : '';
    });
    check('session', 'show + catalog definitions', upfront.join('').length, LIMITS.definitions, 'chars');
  });
}

let fixture;
try {
  await measureSession();
  const {makeFixtureRepo} = await import(pathToFileURL(join(root, 'packages', 'server', 'test', 'fixtures', 'repo.ts')).href);
  fixture = await makeFixtureRepo();
  await measurePresets('the fixture repository', fixture.root);
  await measurePresets(repo === root ? 'this repository' : '--repo', repo);
  await measureViewer();
} catch (error) {
  failures.push(`could not measure: ${String(error?.message ?? error).split('\n')[0]}`);
} finally {
  await fixture?.cleanup();
}

const over = rows.filter(row => !row.ok);
if (asJson) {
  console.log(JSON.stringify({dist: option('--dist') ? dist : undefined, rows, failures}, null, 1));
} else {
  const format = (value, unit) => (unit === 'B gz' ? `${(value / 1000).toFixed(1)} kB gz` : `${value.toLocaleString('en-US')} chars`);
  let group = '';
  for (const row of rows) {
    if (row.group !== group) {
      group = row.group;
      console.log(`\n${group}`);
    }
    const share = `${Math.round((row.value / row.limit) * 100)}%`.padStart(4);
    console.log(`  ${row.ok ? 'ok  ' : 'OVER'} ${row.name.padEnd(46)} ${format(row.value, row.unit).padStart(14)}  of ${format(row.limit, row.unit).padStart(12)} ${share}`);
  }
  console.log('');
  for (const failure of failures) console.error(`budgets: ${failure}`);
  if (over.length > 0) console.error(`budgets: ${over.length} budget${over.length === 1 ? '' : 's'} exceeded.`);
  else if (failures.length === 0) console.log(`budgets: all ${rows.length} measurements are within budget.`);
}
process.exit(over.length > 0 || failures.length > 0 ? 1 : 0);
