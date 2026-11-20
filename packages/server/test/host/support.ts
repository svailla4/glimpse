// Helpers for tests of the real loopback host: a session on fakes with the production startHost on an ephemeral
// port, raw HTTP requests (so the Host header can be forged) and an SSE reader.
import {mkdir, writeFile} from 'node:fs/promises';
import {request, type IncomingHttpHeaders} from 'node:http';
import {join} from 'node:path';
import type {ServerEvent} from '@glimpse/catalog';
import {startHost, type Host} from '../../src/host/host.ts';
import {fakeDeps, testSession, TOKEN, until, type FakeDeps, type TestSession} from '../session/fakes.ts';

export interface HostFixture {
  t: TestSession;
  host: Host;
  port: number;
  launched: Array<[string, string[]]>;
  logged: string[];
}

export const HOST_ENV = {GLIMPSE_PORT: '0', GLIMPSE_NO_OPEN: '1', GLIMPSE_TOKEN: TOKEN};

/** A minimal built viewer: index.html plus two hashed assets. */
export async function fakeViewer(root: string): Promise<string> {
  const dir = join(root, 'viewer-dist');
  await mkdir(join(dir, 'assets'), {recursive: true});
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Glimpse</title><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script>');
  await writeFile(join(dir, 'assets', 'index-abc123.js'), 'console.log("viewer")');
  await writeFile(join(dir, 'assets', 'index-abc123.css'), '@layer gl.tokens;');
  await writeFile(join(dir, 'assets', '.hidden'), 'secret');
  return dir;
}

export async function startFixture(root: string, options: {env?: NodeJS.ProcessEnv; viewerDir?: string; deps?: FakeDeps; now?: () => number} = {}): Promise<HostFixture> {
  const env = {...HOST_ENV, ...options.env};
  const launched: Array<[string, string[]]> = [];
  const logged: string[] = [];
  const deps = options.deps ?? fakeDeps();
  const t = testSession(root, {
    deps, env,
    log: message => void logged.push(message),
    startHost: session => startHost({
      session, env, log: message => void logged.push(message), viewerDir: options.viewerDir,
      launcher: (command, args) => void launched.push([command, args]),
      ...(options.now ? {now: options.now} : {}),
    }),
  });
  const host = (await t.session.ensureHost()) as Host;
  return {t, host, port: host.port, launched, logged};
}

export interface RawResponse { status: number; headers: IncomingHttpHeaders; body: string }

export interface RawOptions {
  method?: string;
  /** Replaces the default headers entry by entry; undefined removes one. */
  headers?: Record<string, string | undefined>;
  body?: string;
  /** false: send no Authorization header. */
  auth?: boolean;
}

/** One request to 127.0.0.1:<port>, with a correct Host header and the bearer token unless overridden. */
export function raw(port: number, path: string, options: RawOptions = {}): Promise<RawResponse> {
  const headers: Record<string, string> = {host: `127.0.0.1:${port}`};
  if (options.auth !== false) headers.authorization = `Bearer ${TOKEN}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, path, method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers, setHost: false}, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

export const json = <T = any>(response: RawResponse): T => JSON.parse(response.body) as T;

export interface Stream {
  status: number;
  headers: IncomingHttpHeaders;
  events: ServerEvent[];
  /** Raw text received so far (comments and retry lines included). */
  text(): string;
  /** Resolves when at least `count` events have arrived. */
  waitFor(count: number): Promise<ServerEvent[]>;
  ended: Promise<void>;
  close(): void;
}

/** Opens GET /api/events the way EventSource does: token in the query string. */
export function openStream(port: number, query = `?t=${TOKEN}`): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, path: `/api/events${query}`, headers: {host: `127.0.0.1:${port}`, accept: 'text/event-stream'}, setHost: false}, res => {
      let received = '';
      const events: ServerEvent[] = [];
      let parsed = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        received += chunk;
        for (;;) {
          const end = received.indexOf('\n\n', parsed);
          if (end < 0) break;
          const block = received.slice(parsed, end);
          parsed = end + 2;
          const lines = block.split('\n');
          if (lines[0] === 'event: glimpse' && lines[1]?.startsWith('data: ')) events.push(JSON.parse(lines[1].slice(6)) as ServerEvent);
        }
      });
      const ended = new Promise<void>(done => {
        res.on('end', done);
        res.on('close', done);
        res.on('error', () => done());
      });
      resolve({
        status: res.statusCode ?? 0, headers: res.headers, events, ended,
        text: () => received,
        waitFor: async count => {
          await until(() => events.length >= count, 3000);
          return events;
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}
