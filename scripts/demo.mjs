// scripts/demo.mjs - see Glimpse work without an agent: starts the bundled server for a repository, plays the part of
// the agent over MCP (three `show` calls) and leaves the viewer open until Ctrl-C.
//
//   npm run demo                      this repository
//   npm run demo -- ../some-repo      another one
//   npm run demo -- --no-open         do not open a browser tab (the link is printed)
//   npm run demo -- --exit            leave after the calls instead of staying up (used by CI as a smoke test)
//
// It builds the plugin first when plugin/dist is missing. GLIMPSE_DIST selects another build directory;
// GLIMPSE_PORT, GLIMPSE_TOKEN, GLIMPSE_NO_OPEN and GLIMPSE_EDITOR are passed to the server unchanged.
// For each call it prints the result the agent would read and what the call costs: the characters the model has to
// write (the arguments) and to read (the result), with a rough token count (four characters per token).
import {spawnSync} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(arg => arg.startsWith('--')));
const positional = argv.filter(arg => !arg.startsWith('--'));
const unknown = [...flags].filter(flag => !['--no-open', '--exit', '--help'].includes(flag));
if (flags.has('--help') || unknown.length > 0 || positional.length > 1) {
  if (unknown.length > 0) console.error(`demo: unknown option ${unknown.join(' ')}`);
  console.error('usage: npm run demo -- [<repository>] [--no-open] [--exit]');
  process.exit(flags.has('--help') ? 0 : 2);
}

const target = resolve(positional[0] ?? root);
if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`demo: ${target} is not a directory`);
  process.exit(2);
}

const customDist = process.env.GLIMPSE_DIST ? resolve(process.env.GLIMPSE_DIST) : undefined;
const dist = customDist ?? join(root, 'plugin', 'dist');
const bundle = join(dist, 'server.mjs');
if (!existsSync(bundle) || !existsSync(join(dist, 'viewer', 'index.html'))) {
  console.log(`demo: no build in ${dist}; building it first.`);
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs'), ...(customDist ? ['--out', customDist] : [])], {cwd: root, stdio: 'inherit'});
  if (built.status !== 0) {
    console.error('demo: the build failed; see its output above.');
    process.exit(1);
  }
}

// The SDK client is a dev dependency of the server package; resolve it from there rather than rely on hoisting.
const require = createRequire(join(root, 'packages', 'server', 'package.json'));
const {Client} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {StdioClientTransport} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')).href);

// The server gets the caller's environment (a desktop session, PATH for git and the editor), plus the project.
const env = Object.fromEntries(Object.entries(process.env).filter(entry => typeof entry[1] === 'string'));
env.CLAUDE_PROJECT_DIR = target;
if (flags.has('--no-open')) env.GLIMPSE_NO_OPEN = '1';

const transport = new StdioClientTransport({command: process.execPath, args: [bundle], env, stderr: 'inherit'});
const client = new Client({name: 'glimpse-demo', version: '0.0.0'}, {versionNegotiation: {mode: 'auto'}});

let closing = false;
async function leave(code) {
  if (closing) return;
  closing = true;
  await client.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => void leave(0));
process.on('SIGTERM', () => void leave(0));
transport.onclose = () => {
  if (!closing) {
    console.error('demo: the server went away.');
    process.exit(1);
  }
};

const tokens = chars => Math.max(1, Math.round(chars / 4));
let failed = false;
let link;
try {
  await client.connect(transport);
  const instructions = client.getInstructions() ?? '';
  console.log(`demo: Glimpse for ${target}`);
  console.log(`demo: the agent reads ${instructions.length.toLocaleString('en-US')} characters of instructions once per session (about ${tokens(instructions.length).toLocaleString('en-US')} tokens).\n`);

  for (const args of [{view: 'gallery'}, {view: 'overview'}, {view: 'diff'}]) {
    const written = JSON.stringify(args);
    const started = performance.now();
    const result = await client.callTool({name: 'show', arguments: args});
    const ms = Math.round(performance.now() - started);
    const text = result.content.map(block => block.text ?? '').join('\n');
    if (result.isError) failed = true;
    link ??= /open (http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/.exec(text)?.[1] ?? /(http:\/\/127\.0\.0\.1:\d+\/)#/.exec(text)?.[1];
    console.log(`show ${written}`);
    console.log(text.split('\n').map(line => `  ${line}`).join('\n'));
    console.log(`  -- ${ms} ms; the model wrote ${written.length} characters (about ${tokens(written.length)} output tokens) and read ${text.length.toLocaleString('en-US')} (about ${tokens(text.length)} tokens)${result.isError ? '; ERROR' : ''}\n`);
  }
} catch (error) {
  console.error(`demo: ${String(error?.message ?? error)}`);
  await leave(1);
}

if (flags.has('--exit')) await leave(failed ? 1 : 0);
console.log(`demo: the viewer is at ${link ?? 'the address above'}`);
console.log('demo: click around; rows, files and graph nodes select, buttons queue events. Ctrl-C ends the session.');
// The open stdio transport keeps the process alive until a signal arrives or the server goes away.
