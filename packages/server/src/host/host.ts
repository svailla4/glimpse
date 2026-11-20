// The loopback HTTP host (design 2.5): one per server process, bound to 127.0.0.1 only, started by the first `show`.
import {randomBytes} from 'node:crypto';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {Health} from '@glimpse/catalog';
import {ActionRouter} from '../session/actions.ts';
import {ownEnv} from '../session/env.ts';
import type {HostHandle, Session, TabState} from '../session/session.ts';
import {checkRequest} from './guard.ts';
import {canOpen, detachedLauncher, launchOptions, osOpenCommand, programFor, type Launcher} from './open.ts';
import {handleApi, type ApiContext} from './routes.ts';
import {SseHub} from './sse.ts';
import {serveStatic} from './static.ts';

export const DEFAULT_PORT = 4517;
const PORT_SPAN = 20;
const REOPEN_AFTER_MS = 5000;
export const HEADERS_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** Sockets the listener accepts at once: five tabs with six connections each, and room to spare. */
export const MAX_CONNECTIONS = 64;

export interface HostOptions {
  session: Session;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  /** Directory holding the built viewer (index.html, assets/); undefined when none was found. */
  viewerDir: string | undefined;
  launcher?: Launcher;
  /** Finds a program by name (tests); findProgram on the trusted PATH by default. */
  which?: (name: string) => string | undefined;
  now?: () => number;
}

export interface Host extends HostHandle {
  port: number;
  /** The address the listener is bound to: always the loopback interface. */
  address: string;
  epoch: string;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({host: '127.0.0.1', port, exclusive: true});
  });
}

/** GLIMPSE_PORT (0 = ephemeral) or 4517, then the next 19 ports, then an ephemeral port. */
export function portCandidates(env: NodeJS.ProcessEnv): number[] {
  const given = env.GLIMPSE_PORT !== undefined && /^\d{1,5}$/.test(env.GLIMPSE_PORT) ? Number(env.GLIMPSE_PORT) : undefined;
  const first = given !== undefined && given <= 65535 ? given : DEFAULT_PORT;
  if (first === 0) return [0];
  return [...Array.from({length: PORT_SPAN}, (_, i) => first + i).filter(port => port <= 65535), 0];
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
};

export async function startHost(options: HostOptions): Promise<Host> {
  const {session, log} = options;
  const env = ownEnv(options.env);
  const now = options.now ?? Date.now;
  const token = env.GLIMPSE_TOKEN && env.GLIMPSE_TOKEN.length >= 8 ? env.GLIMPSE_TOKEN : randomBytes(32).toString('base64url');
  const epoch = randomBytes(8).toString('hex');
  let port = 0;

  const sse = new SseHub({
    epoch,
    session: () => session.info(),
    surfaces: () => session.surfaceList(),
    replay: () => session.replay(),
    tabsChanged: count => session.tabsChanged(count),
  });
  const api: ApiContext = {
    session,
    router: new ActionRouter(session, log),
    sse,
    health: (): Health => ({app: 'glimpse', version: session.version, epoch, tabs: sse.size}),
    log,
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const deny = (status: number, message: string) => {
      res.writeHead(status, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      res.end(message);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      return deny(400, 'bad request');
    }
    const denial = checkRequest(req, url.pathname, url.searchParams, port, token);
    if (denial) return deny(denial.status, denial.message);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return void handleApi(req, res, url, api);
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'GET only');
    void serveStatic(res, url.pathname, options.viewerDir).catch(() => res.destroy());
  };

  // Node checks its timeouts only every connectionsCheckingInterval (30 s by default), so the interval is set too:
  // headers within 5 s, a whole request within 15 s. Event streams are responses and are not affected.
  const server = createServer({headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, connectionsCheckingInterval: 2000}, onRequest);
  server.maxConnections = MAX_CONNECTIONS;
  let bound = false;
  let lastError: unknown;
  for (const candidate of portCandidates(env)) {
    try {
      port = await listen(server, candidate);
      bound = true;
      break;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') break;
    }
  }
  if (!bound) throw new Error(`could not bind the viewer host on 127.0.0.1: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  // The host must never keep the process alive on its own: when the MCP connection ends, the process ends.
  server.unref();

  const listening = server.address();
  const address = typeof listening === 'object' && listening !== null ? listening.address : '';
  const origin = `http://127.0.0.1:${port}`;
  let openedAt = -Infinity;
  let closed = false;
  log(`glimpse: viewer host listening on ${origin}`);

  return {
    port, address, epoch, origin, token,
    tabs: () => sse.size,
    publish: (surfaceId, messages, focus) => sse.publish(surfaceId, messages, focus),
    ensureTab(): TabState {
      if (sse.size > 0) return 'live';
      if (!canOpen(env)) return 'none';
      if (now() - openedAt < REOPEN_AFTER_MS) return 'opened';
      openedAt = now();
      const [command, args] = osOpenCommand(`${origin}/#t=${token}`);
      // Finding V019: the opener by its absolute path, never one a relative PATH entry or the project supplies.
      const program = programFor(command, env, {root: session.root, ...(options.which ? {which: options.which} : {})});
      if (!program) {
        log(`glimpse: no ${command} on PATH to open the viewer; open ${origin}/#t=… from the tool result`);
        return 'none';
      }
      (options.launcher ?? detachedLauncher)(program, args, launchOptions(env, session.root));
      return 'opened';
    },
    close() {
      if (closed) return;
      closed = true;
      sse.close();
      server.close();
      server.closeAllConnections();
    },
  };
}
