// The viewer shell and its hashed assets (design 2.5). Only `/` and `/assets/*` exist. The shell carries no secret:
// the token travels in the URL fragment, which never reaches this server.
import {createReadStream} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import type {ServerResponse} from 'node:http';
import {extname, join, normalize, sep} from 'node:path';

export const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const plain = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
  res.end(message);
};

/** Answers GET / and GET /assets/*. `viewerDir` is undefined when no built viewer was found. */
export async function serveStatic(res: ServerResponse, pathname: string, viewerDir: string | undefined): Promise<void> {
  if (pathname === '/') {
    const html = viewerDir ? await readFile(join(viewerDir, 'index.html')).catch(() => undefined) : undefined;
    if (!html) return plain(res, 503, 'The Glimpse viewer is not built. Run `npm run build` in the Glimpse repository, then reload.');
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP});
    res.end(html);
    return;
  }
  if (!viewerDir || !pathname.startsWith('/assets/')) return plain(res, 404, 'not found');
  let relative: string;
  try {
    relative = normalize(decodeURIComponent(pathname.slice('/assets/'.length)));
  } catch {
    return plain(res, 404, 'not found');
  }
  if (relative === '' || relative.includes('\u0000') || relative.split(sep).some(part => part === '..' || part.startsWith('.'))) return plain(res, 404, 'not found');
  const file = join(viewerDir, 'assets', relative);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return plain(res, 404, 'not found');
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'public, max-age=31536000, immutable',
    // A dedicated worker runs under the CSP of its own response, not the page's: without this header the layout
    // workers (assets/*.worker-<hash>.js; ELK among them, decision D19) would run with no policy at all. They get
    // the page's policy unchanged: neither needs eval. Other assets ignore the header.
    'content-security-policy': CSP,
  });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
