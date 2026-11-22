// The /api routes (design 2.5). Every request here has already passed the guards in guard.ts, token included.
// Paths and ranges are checked again at this boundary, whatever the services behind it do.
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {FileSlice, Health} from '@glimpse/catalog';
import {SourceError} from '../contracts.ts';
import type {ActionRouter} from '../session/actions.ts';
import {isSafeRange} from '../session/paths.ts';
import type {Servable, Session} from '../session/session.ts';
import type {SseHub} from './sse.ts';

const MAX_BODY = 1024 * 1024;
const MAX_MESSAGES = 200;

export interface ApiContext {
  session: Session;
  router: ActionRouter;
  sse: SseHub;
  health(): Health;
  log(message: string): void;
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text)});
  res.end(text);
}

/** Reads a JSON body of at most 1 MB. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (error: HttpError) => {
      if (done) return;
      done = true;
      req.resume();
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) fail(new HttpError(413, 'E_ARGS', 'body larger than 1 MB'));
      else if (!done) chunks.push(chunk);
    });
    req.on('error', () => fail(new HttpError(400, 'E_ARGS', 'unreadable body')));
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'E_ARGS', 'body is not JSON'));
      }
    });
  });
}

const integer = (value: string | null): number | undefined => (value !== null && /^\d{1,9}$/.test(value) ? Number(value) : undefined);

function need(method: string, req: IncomingMessage): void {
  if (req.method !== method) throw new HttpError(405, 'E_ARGS', `${method} only`);
}

/**
 * Decision D10: only files of the inventory are read for the viewer. `refused` covers everything else that exists
 * (.git, ignored files, symbolic links, paths outside the root); `missing` is a path with no file, which the
 * services answer themselves ("does not exist", or the old side of a diff).
 */
function servable(session: Session, path: string | null): Promise<Servable> {
  if (path === null || path === '') throw new HttpError(400, 'E_ARGS', 'path is required');
  return session.servable(path);
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, api: ApiContext): Promise<void> {
  const {session} = api;
  const {pathname, searchParams: query} = url;

  if (pathname === '/api/events') {
    need('GET', req);
    api.sse.connect(res);
    return;
  }
  if (pathname === '/api/health') {
    need('GET', req);
    return json(res, 200, api.health());
  }
  if (pathname === '/api/renderer') {
    need('POST', req);
    const body = await readJson(req) as {messages?: unknown; states?: unknown};
    if (typeof body !== 'object' || body === null || !Array.isArray(body.messages)) throw new HttpError(400, 'E_ARGS', 'expected {messages: [...]}');
    for (const message of body.messages.slice(0, MAX_MESSAGES)) api.router.handle(message);
    // Decision D27: component states that are not errors (I_*, OK) come beside the A2UI messages, not as messages.
    if (Array.isArray(body.states)) for (const state of body.states.slice(0, MAX_MESSAGES)) api.router.state(state);
    res.writeHead(204, {'cache-control': 'no-store'});
    res.end();
    return;
  }

  const rows = /^\/api\/ds\/([^/]+)\/([^/]+)\/rows$/.exec(pathname);
  if (rows) {
    need('GET', req);
    const offset = integer(query.get('offset'));
    const limit = integer(query.get('limit'));
    const sort = query.get('sort')?.slice(0, 200);
    const q = query.get('q')?.slice(0, 200);
    const page = await session.rows(decodeURIComponent(rows[1]!), decodeURIComponent(rows[2]!), {
      ...(offset !== undefined ? {offset} : {}), ...(limit !== undefined ? {limit} : {}), ...(sort ? {sort} : {}), ...(q ? {q} : {}),
    });
    if (!page) throw new HttpError(404, 'E_ARGS', 'no such dataset');
    if ('error' in page) throw new HttpError(422, page.error.code, page.error.message);
    return json(res, 200, page);
  }

  // Everything below reads the repository through the services.
  const services = await session.services();
  if (pathname === '/api/file') {
    need('GET', req);
    const path = query.get('path');
    if ((await servable(session, path)) === 'refused') {
      const refused: FileSlice = {path: String(path).slice(0, 400), lang: '', total: 0, start: 0, end: 0, lines: [], size: 0, skipped: 'outside-root', rev: session.meta().rev};
      return json(res, 200, refused);
    }
    const start = integer(query.get('start'));
    const end = integer(query.get('end'));
    return json(res, 200, await services.code.file({path: path!, ...(start !== undefined ? {start} : {}), ...(end !== undefined ? {end} : {})}));
  }
  if (pathname === '/api/outline') {
    need('GET', req);
    const path = query.get('path');
    if ((await servable(session, path)) === 'refused') throw new HttpError(400, 'E_TARGET', 'path is not a file of the project');
    return json(res, 200, await services.code.outline(path!));
  }
  if (pathname === '/api/diff') {
    need('GET', req);
    const range = query.get('range') || 'wt';
    if (!isSafeRange(range)) throw new HttpError(400, 'E_TARGET', 'invalid range');
    const given = query.get('path');
    // A file the change deleted is `missing` here and still has a diff; a file that exists must be in the inventory.
    if (given !== null && given !== '' && (await servable(session, given)) === 'refused') throw new HttpError(400, 'E_TARGET', 'path is not a file of the project');
    return json(res, 200, await services.diff.diff({range, ...(given ? {path: given} : {})}));
  }
  if (pathname === '/api/highlight') {
    need('POST', req);
    const body = await readJson(req) as {code?: unknown; lang?: unknown};
    if (typeof body !== 'object' || body === null || typeof body.code !== 'string') throw new HttpError(400, 'E_ARGS', 'expected {code, lang?}');
    return json(res, 200, await services.code.highlight(body.code, typeof body.lang === 'string' ? body.lang.slice(0, 40) : undefined));
  }
  throw new HttpError(404, 'E_ARGS', 'not found');
}

/** Answers one /api request; failures become `{error: {code, message}}` with a matching status. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, api: ApiContext): Promise<void> {
  try {
    await route(req, res, url, api);
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HttpError) return json(res, error.status, {error: {code: error.code, message: error.message}});
    if (error instanceof SourceError) return json(res, error.code === 'E_INTERNAL' ? 500 : 422, {error: {code: error.code, message: error.message}});
    if (error instanceof URIError) return json(res, 400, {error: {code: 'E_ARGS', message: 'malformed URL'}});
    api.log(`glimpse: ${req.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
    json(res, 500, {error: {code: 'E_INTERNAL', message: 'internal error'}});
  }
}
