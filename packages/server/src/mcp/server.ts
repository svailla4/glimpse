// The MCP surface (design 6) and the process wiring around it (design 2.1). createMcpServer() registers the five
// tools on one McpServer; serve() runs a whole server process over stdio: project root, session, lazy host, shutdown.
import {existsSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serverInstructions} from '@glimpse/catalog';
import {fromJsonSchema, McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {startHost} from '../host/host.ts';
import type {Launcher} from '../host/open.ts';
import {Session, type ServerDeps} from '../session/session.ts';
import {CATALOG_DESCRIPTION, CATALOG_SCHEMA, catalogTool} from './catalogTool.ts';
import {EVENTS_DESCRIPTION, EVENTS_SCHEMA, eventsTool} from './events.ts';
import {PENDING_CONTEXT_DESCRIPTION, pendingContextTool} from './pendingContext.ts';
import {QUERY_DESCRIPTION, QUERY_SCHEMA, queryTool, type QueryArgs} from './query.ts';
import {failure, type ToolResult} from './result.ts';
import {DEFAULT_SETTLE_MS, SHOW_DESCRIPTION, SHOW_SCHEMA, showTool, type ShowArgs} from './show.ts';
import {VERSION} from './version.ts';

const ANNOTATIONS = {readOnlyHint: true, idempotentHint: true, openWorldHint: false} as const;
const ALWAYS_LOAD = {'anthropic/alwaysLoad': true} as const;

export interface McpOptions {
  session: Session;
  /** How long `show` waits for its datasets before answering. */
  settleMs?: number;
}

/** A handler that cannot throw: whatever goes wrong becomes an error result the model can read. */
const safely = async (work: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await work();
  } catch (error) {
    return failure(error);
  }
};

/** One McpServer with the five Glimpse tools. The session is process-wide; the server object is per connection. */
export function createMcpServer(options: McpOptions): McpServer {
  const {session} = options;
  const server = new McpServer({name: 'glimpse', version: session.version}, {instructions: serverInstructions()});

  server.registerTool(
    'show',
    {description: SHOW_DESCRIPTION, inputSchema: fromJsonSchema<ShowArgs>(SHOW_SCHEMA), annotations: ANNOTATIONS, _meta: ALWAYS_LOAD},
    args => safely(() => {
      session.warm();
      return showTool(session, args, options.settleMs ?? DEFAULT_SETTLE_MS);
    }),
  );

  server.registerTool(
    'catalog',
    {description: CATALOG_DESCRIPTION, inputSchema: fromJsonSchema<{names?: string[]}>(CATALOG_SCHEMA), annotations: ANNOTATIONS, _meta: ALWAYS_LOAD},
    args => safely(async () => {
      session.warm();
      const result = await catalogTool(args, session.registry);
      const events = result.isError ? [] : session.events.drain();
      return events.length > 0 ? {...result, content: [{type: 'text', text: `${result.content[0]!.text}\n\n${events.join('\n')}`}]} : result;
    }),
  );

  server.registerTool(
    'query',
    {description: QUERY_DESCRIPTION, inputSchema: fromJsonSchema<QueryArgs>(QUERY_SCHEMA), annotations: ANNOTATIONS},
    args => safely(() => {
      session.warm();
      return queryTool(session, args);
    }),
  );

  server.registerTool(
    'events',
    {description: EVENTS_DESCRIPTION, inputSchema: fromJsonSchema<{wait?: number}>(EVENTS_SCHEMA), annotations: ANNOTATIONS},
    (args, ctx) => safely(() => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      return eventsTool(session.events, args, {
        signal: ctx.mcpReq.signal,
        ...(progressToken !== undefined
          ? {progress: count => void ctx.mcpReq.notify({method: 'notifications/progress', params: {progressToken, progress: count, message: 'waiting for the viewer'}}).catch(() => {})}
          : {}),
      });
    }),
  );

  // Hidden from the model (visibility: app), still callable by the plugin's UserPromptSubmit hook. It must not warm
  // anything: it runs on every prompt, also in sessions that never use Glimpse.
  server.registerTool(
    'pending_context',
    {description: PENDING_CONTEXT_DESCRIPTION, annotations: ANNOTATIONS, _meta: {ui: {visibility: ['app']}}},
    () => safely(() => pendingContextTool(session.events)),
  );

  return server;
}

// ---------------------------------------------------------------- process
export interface ServeOptions {
  env: NodeJS.ProcessEnv;
  /** Command-line arguments after the script (`--root <dir>`). */
  argv: readonly string[];
  /** Loads the analyzers and services on the first tool call. */
  loadDeps(): Promise<ServerDeps>;
  /** Where a built viewer may be, best first; the first that holds an index.html is served. */
  viewerDirs: ReadonlyArray<string | URL>;
  settleMs?: number;
  launcher?: Launcher;
}

/** CLAUDE_PROJECT_DIR, else --root <dir>, else the working directory; as a realpath. */
export function projectRoot(env: NodeJS.ProcessEnv, argv: readonly string[], cwd: string = process.cwd()): string {
  const flag = argv.indexOf('--root');
  const inline = argv.find(arg => arg.startsWith('--root='))?.slice('--root='.length);
  const given = env.CLAUDE_PROJECT_DIR || inline || (flag >= 0 ? argv[flag + 1] : undefined) || cwd;
  const absolute = resolve(cwd, given);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function findViewer(candidates: ReadonlyArray<string | URL>): string | undefined {
  return candidates.map(candidate => (typeof candidate === 'string' ? candidate : fileURLToPath(candidate))).find(dir => existsSync(join(dir, 'index.html')));
}

/**
 * Runs the server on this process's stdio until the client goes away. Process start does nothing but serve MCP:
 * no port is bound, no browser opened and no analyzer loaded before a tool asks for it.
 */
export function serve(options: ServeOptions): void {
  // The installed SDK has no logger option and prints diagnostics through console; none of it may reach stdout.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const {env} = options;
  const log = (message: string) => void process.stderr.write(`${message}\n`);
  const session: Session = new Session({
    root: projectRoot(env, options.argv),
    version: VERSION,
    env,
    log,
    loadDeps: options.loadDeps,
    startHost: current => startHost({session: current, env, log, viewerDir: findViewer(options.viewerDirs), ...(options.launcher ? {launcher: options.launcher} : {})}),
    ...(options.launcher ? {launcher: options.launcher} : {}),
  });

  let stopping = false;
  // Synchronous and well under 50 ms: Claude Code sends SIGINT, SIGTERM 100 ms later and SIGKILL 400 ms after that.
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    session.dispose();
    process.exit(code);
  };

  serveStdio(
    () => {
      const server = createMcpServer({session, ...(options.settleMs !== undefined ? {settleMs: options.settleMs} : {})});
      server.server.onclose = () => shutdown(0);
      return server;
    },
    {onerror: error => log(`glimpse: mcp ${error.message}`)},
  );
  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('close', () => shutdown(0));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => shutdown(0));
  process.on('uncaughtException', error => log(`glimpse: uncaught ${error.stack ?? error.message}`));
  process.on('unhandledRejection', reason => log(`glimpse: unhandled rejection ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
}
