// Request guards of the loopback host (design 2.5), in the order of the verified hub spike: Host allow-list (DNS
// rebinding), Origin, Sec-Fetch-Site (cross-site requests), then the token on /api/*, then JSON-only POST bodies.
// No CORS header and no cookie is ever sent, so a page on another origin can neither read nor forge a request.
import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';

export interface Denial { status: 403 | 401 | 415; message: string }

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Undefined when the request may proceed. `pathname` and `query` come from the already parsed URL.
 * The token is accepted as `Authorization: Bearer`; `?t=` only on /api/events, because EventSource cannot set headers.
 */
export function checkRequest(req: IncomingMessage, pathname: string, query: URLSearchParams, port: number, token: string): Denial | undefined {
  const host = single(req.headers.host) ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return {status: 403, message: 'bad host'};

  const origin = single(req.headers.origin);
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return {status: 403, message: 'bad origin'};

  const site = single(req.headers['sec-fetch-site']);
  if (site !== undefined && site !== '' && site !== 'same-origin' && site !== 'none') return {status: 403, message: 'cross-site request'};

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const header = single(req.headers.authorization) ?? '';
    const bearer = /^Bearer (.+)$/.exec(header)?.[1] ?? (pathname === '/api/events' ? query.get('t') ?? '' : '');
    if (!tokenMatches(bearer, token)) return {status: 401, message: 'bad token'};
  }

  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(single(req.headers['content-type']) ?? '')) {
    return {status: 415, message: 'application/json only'};
  }
  return undefined;
}
