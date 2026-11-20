// The guard matrix of the loopback host (design 2.5, 2.8), against a real listener: DNS rebinding, cross-site
// requests, the token, JSON-only POSTs, traversal and range validation.
import {mkdir, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {tokenMatches} from '../../src/host/guard.ts';
import {isSafeRange, resolveInside} from '../../src/session/paths.ts';
import {tempRoot, TOKEN, until} from '../session/fakes.ts';
import {fakeViewer, json, raw, startFixture, type HostFixture} from './support.ts';

let dir: Awaited<ReturnType<typeof tempRoot>>;
let fx: HostFixture;
let port: number;
beforeAll(async () => {
  dir = await tempRoot();
  fx = await startFixture(dir.root, {viewerDir: await fakeViewer(dir.root)});
  port = fx.port;
  await fx.t.session.show({id: 'demo', sources: [`root=Page('Demo',[DataTable('fake.rows',title='Rows')])`], fresh: false});
});
afterAll(async () => {
  fx.t.session.dispose();
  await dir.cleanup();
});

describe('Host, Origin and Sec-Fetch-Site', () => {
  it.each([
    ['evil.example', 403],
    ['evil.example:80', 403],
    ['127.0.0.1', 403],
    ['127.0.0.1:1', 403],
    ['[::1]:PORT', 403],
    ['127.0.0.1.evil.example:PORT', 403],
    ['127.0.0.1:PORT', 200],
    ['localhost:PORT', 200],
  ])('Host %s -> %i', async (host, status) => {
    const value = host.replace('PORT', String(port));
    expect((await raw(port, '/api/health', {headers: {host: value}})).status).toBe(status);
    expect((await raw(port, '/', {headers: {host: value}, auth: false})).status).toBe(status);
  });

  it('a request without a Host header is refused (by Node itself, before the guard)', async () => {
    expect([400, 403]).toContain((await raw(port, '/api/health', {headers: {host: undefined}})).status);
  });

  it.each([
    ['https://evil.example', 403],
    ['http://evil.example', 403],
    ['null', 403],
    ['http://127.0.0.1:1', 403],
    ['https://127.0.0.1:PORT', 403],
    ['http://127.0.0.1:PORT', 200],
    ['http://localhost:PORT', 200],
  ])('Origin %s -> %i', async (origin, status) => {
    expect((await raw(port, '/api/health', {headers: {origin: origin.replace('PORT', String(port))}})).status).toBe(status);
  });

  it.each([['cross-site', 403], ['same-site', 403], ['same-origin', 200], ['none', 200]])('Sec-Fetch-Site %s -> %i', async (site, status) => {
    expect((await raw(port, '/api/health', {headers: {'sec-fetch-site': site}})).status).toBe(status);
    expect((await raw(port, '/', {headers: {'sec-fetch-site': site}, auth: false})).status).toBe(status);
  });

  it('the Host check comes first: a bad Host with a bad token is 403, not 401', async () => {
    expect((await raw(port, '/api/health', {headers: {host: 'evil.example', authorization: 'Bearer nope'}})).status).toBe(403);
  });
});

describe('token', () => {
  it('every /api route needs it; the shell and assets do not', async () => {
    for (const path of ['/api/health', '/api/events', '/api/file?path=a.ts', '/api/diff', '/api/outline?path=a.ts', '/api/ds/demo/fake_rows/rows', '/api/nope', '/api']) {
      expect((await raw(port, path, {auth: false})).status, path).toBe(401);
    }
    expect((await raw(port, '/api/renderer', {auth: false, body: '{"messages":[]}'})).status).toBe(401);
    expect((await raw(port, '/', {auth: false})).status).toBe(200);
    expect((await raw(port, '/assets/index-abc123.js', {auth: false})).status).toBe(200);
  });

  it.each([['Bearer wrong'], [`Bearer ${TOKEN}x`], [`Bearer ${TOKEN.slice(1)}`], [`Basic ${TOKEN}`], [TOKEN], ['Bearer '], [`bearer${TOKEN}`]])('rejects %s', async header => {
    expect((await raw(port, '/api/health', {headers: {authorization: header}})).status).toBe(401);
  });

  it('accepts ?t= only on /api/events', async () => {
    expect((await raw(port, `/api/health?t=${TOKEN}`, {auth: false})).status).toBe(401);
    expect((await raw(port, `/api/file?path=a.ts&t=${TOKEN}`, {auth: false})).status).toBe(401);
    expect((await raw(port, '/api/events?t=wrong', {auth: false})).status).toBe(401);
  });

  it('tokenMatches compares in constant time and by length', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN + ' ', TOKEN)).toBe(false);
    expect(tokenMatches('é'.repeat(TOKEN.length), TOKEN)).toBe(false);
  });

  it('the shell page does not contain the token', async () => {
    expect((await raw(port, '/', {auth: false})).body).not.toContain(TOKEN);
  });
});

describe('POST bodies', () => {
  it.each([['text/plain'], ['application/x-www-form-urlencoded'], ['multipart/form-data; boundary=x'], ['application/jsonp'], [undefined]])('content-type %s -> 415', async type => {
    const response = await raw(port, '/api/renderer', {body: '{"messages":[]}', headers: {'content-type': type}});
    expect(response.status).toBe(415);
  });

  it('application/json with a charset is accepted', async () => {
    expect((await raw(port, '/api/renderer', {body: '{"messages":[]}', headers: {'content-type': 'application/json; charset=utf-8'}})).status).toBe(204);
  });

  it('a POST to a page is 415 or 405, never served', async () => {
    expect((await raw(port, '/', {method: 'POST', body: '{}', auth: false})).status).toBe(405);
    expect((await raw(port, '/', {method: 'POST', headers: {'content-type': 'text/plain'}, auth: false})).status).toBe(415);
  });

  it('refuses malformed JSON (400), bodies over 1 MB (413) and wrong shapes (400)', async () => {
    expect((await raw(port, '/api/renderer', {body: '{nope'})).status).toBe(400);
    expect((await raw(port, '/api/renderer', {body: '{"messages":"x"}'})).status).toBe(400);
    expect((await raw(port, '/api/renderer', {body: JSON.stringify({messages: [], pad: 'x'.repeat(1024 * 1024 + 10)})})).status).toBe(413);
    expect((await raw(port, '/api/highlight', {body: '{"lang":"ts"}'})).status).toBe(400);
  });

  it('wrong methods are 405', async () => {
    expect((await raw(port, '/api/renderer')).status).toBe(405);
    expect((await raw(port, '/api/health', {body: '{}'})).status).toBe(405);
    expect((await raw(port, '/api/highlight')).status).toBe(405);
  });
});

describe('no CORS, no cookies, hardening headers', () => {
  it('no response carries CORS headers or cookies, whatever the request asks', async () => {
    const responses = await Promise.all([
      raw(port, '/', {auth: false}),
      raw(port, '/api/health'),
      raw(port, '/api/health', {headers: {origin: 'https://evil.example'}}),
      raw(port, '/api/health', {method: 'OPTIONS', headers: {origin: `http://127.0.0.1:${port}`, 'access-control-request-method': 'POST'}}),
      raw(port, '/assets/index-abc123.js', {auth: false}),
    ]);
    for (const response of responses) {
      expect(Object.keys(response.headers).filter(name => name.startsWith('access-control-') || name === 'set-cookie')).toEqual([]);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('the shell has the strict CSP and is never cached', async () => {
    const shell = await raw(port, '/', {auth: false});
    expect(shell.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(shell.headers['cache-control']).toBe('no-store');
    expect(shell.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('binds the loopback interface only', () => {
    expect(fx.host.address).toBe('127.0.0.1');
  });
});

describe('paths and ranges', () => {
  it.each([['../outside.txt'], ['/etc/passwd'], ['src/../../x'], ['..'], ['C:\\Windows\\win.ini'], ['a\u0000b']])('/api/file?path=%j answers outside-root without reading anything', async path => {
    const before = fx.t.deps.calls.files.length;
    const response = await raw(port, `/api/file?path=${encodeURIComponent(path)}`);
    expect(response.status).toBe(200);
    expect(json(response)).toMatchObject({skipped: 'outside-root', lines: [], total: 0});
    expect(fx.t.deps.calls.files).toHaveLength(before);
  });

  it('/api/file passes a path inside the root, with its window, to the code service', async () => {
    const response = await raw(port, '/api/file?path=src/a.ts&start=10&end=40');
    expect(json(response)).toMatchObject({path: 'src/a.ts', lang: 'typescript', rev: 1});
    expect(fx.t.deps.calls.files.at(-1)).toBe('src/a.ts');
    expect((await raw(port, '/api/file')).status).toBe(400);
  });

  // Decision D10, findings F052 and F095: only files of the inventory are read for the viewer.
  describe('files that exist but are not the project\'s', () => {
    beforeAll(async () => {
      await mkdir(join(dir.root, '.git', 'hooks'), {recursive: true});
      await mkdir(join(dir.root, 'src'), {recursive: true});
      await writeFile(join(dir.root, '.git', 'config'), '[remote "origin"]\n\ttoken = not-for-the-viewer\n');
      await writeFile(join(dir.root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(join(dir.root, '.env'), 'API_KEY=not-for-the-viewer\n');
      await writeFile(join(dir.root, 'src', 'real.ts'), 'export const real = 1;\n');
      await symlink(join(dir.root, 'src', 'real.ts'), join(dir.root, 'inner-link.ts')).catch(() => {});
    });

    it.each([['.git/config'], ['.git/HEAD'], ['.git/hooks'], ['.GIT/config'], ['./.git/config'], ['src/../.git/config'], ['.env'], ['inner-link.ts']])('/api/file?path=%s is refused and nothing is read', async path => {
      const before = fx.t.deps.calls.files.length;
      const response = await raw(port, `/api/file?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(200);
      expect(json(response)).toMatchObject({skipped: 'outside-root', lines: [], total: 0});
      expect(response.body).not.toContain('not-for-the-viewer');
      expect(fx.t.deps.calls.files).toHaveLength(before);
    });

    it('/api/outline and /api/diff refuse them too; a real file and a file that is gone pass', async () => {
      for (const path of ['.git/config', '.env', 'inner-link.ts']) {
        const outline = await raw(port, `/api/outline?path=${encodeURIComponent(path)}`);
        expect([outline.status, json(outline).error]).toEqual([400, {code: 'E_TARGET', message: 'path is not a file of the project'}]);
        const diff = await raw(port, `/api/diff?range=wt&path=${encodeURIComponent(path)}`);
        expect([diff.status, json(diff).error]).toEqual([400, {code: 'E_TARGET', message: 'path is not a file of the project'}]);
      }
      expect(fx.t.deps.calls.outlines).toEqual([]);
      expect((await raw(port, '/api/file?path=src/real.ts')).status).toBe(200);
      expect(fx.t.deps.calls.files.at(-1)).toBe('src/real.ts');
      // the old side of a deletion: no file on disk, still a diff
      const before = fx.t.deps.calls.diffs.length;
      expect((await raw(port, '/api/diff?range=main..HEAD&path=src/deleted.ts')).status).toBe(200);
      expect(fx.t.deps.calls.diffs).toHaveLength(before + 1);
    });

    it('gl_open posted by a tab opens none of them', async () => {
      const post = (file: string) => raw(port, '/api/renderer', {body: JSON.stringify({messages: [{version: '1.0', action: {name: 'gl_open', surfaceId: 'demo', sourceComponentId: 'root', timestamp: '', context: {file}}}]})});
      for (const file of ['.git/hooks', '.git/config', '.env', 'inner-link.ts', 'run.command']) expect((await post(file)).status).toBe(204);
      await until(() => fx.logged.filter(line => line.includes('refused to open')).length === 5);
      expect(fx.launched).toEqual([]);
    });
  });

  it('/api/outline and /api/diff refuse a path outside the root', async () => {
    expect((await raw(port, '/api/outline?path=../x.ts')).status).toBe(400);
    expect((await raw(port, '/api/diff?range=wt&path=../x.ts')).status).toBe(400);
    expect(fx.t.deps.calls.outlines).toEqual([]);
    expect(json(await raw(port, '/api/outline?path=src/a.ts'))).toEqual({path: 'src/a.ts', symbols: []});
  });

  it.each([['--output=x'], ['-p'], ['main..HEAD; rm -rf x'], ['a b'], ['$(id)'], ['main..HEAD\n--output=x'], ['a|b'], ['x'.repeat(300)]])('/api/diff?range=%s is refused before git sees it', async range => {
    const before = fx.t.deps.calls.diffs.length;
    const response = await raw(port, `/api/diff?range=${encodeURIComponent(range)}`);
    expect(response.status).toBe(400);
    expect(json(response).error.code).toBe('E_TARGET');
    expect(fx.t.deps.calls.diffs).toHaveLength(before);
  });

  it.each([['wt'], ['staged'], ['main'], ['main..HEAD'], ['main...feature/x'], ['HEAD~3..HEAD^'], ['v1.2.0..@{upstream}']])('/api/diff?range=%s reaches the diff service', async range => {
    const response = await raw(port, `/api/diff?range=${encodeURIComponent(range)}`);
    expect(response.status).toBe(200);
    expect(json(response).range).toBe(range);
  });

  it('a service error is reported with its code; the default range is wt', async () => {
    const response = await raw(port, '/api/diff?range=unknown-ref');
    expect(response.status).toBe(422);
    expect(json(response)).toEqual({error: {code: 'E_TARGET', message: 'unknown revision'}});
    expect(json(await raw(port, '/api/diff')).range).toBe('wt');
  });

  it('isSafeRange and resolveInside', async () => {
    expect(isSafeRange('main..HEAD')).toBe(true);
    expect(isSafeRange('-n')).toBe(false);
    expect(isSafeRange('')).toBe(false);
    expect(await resolveInside(dir.root, 'viewer-dist/index.html')).toMatch(/viewer-dist/);
    expect(await resolveInside(dir.root, 'does/not/exist.ts')).toBeDefined();
    expect(await resolveInside(dir.root, '../x')).toBeUndefined();
    expect(await resolveInside(dir.root, '')).toBeUndefined();
    // the repository's own .git is never inside, whether or not the path exists
    for (const path of ['.git', '.git/config', '.git/objects/nope', '.Git/HEAD', 'src/../.git/config']) expect(await resolveInside(dir.root, path), path).toBeUndefined();
    expect(await resolveInside(dir.root, '.gitignore')).toBeDefined();
    expect(await resolveInside(dir.root, 'docs/.git-notes.md')).toBeDefined();
  });
});

describe('port selection', () => {
  it('moves to the next port when the preferred one is taken', async () => {
    const blocker = createServer();
    const taken = await new Promise<number>(resolve => blocker.listen({host: '127.0.0.1', port: 0}, () => resolve((blocker.address() as {port: number}).port)));
    const other = await startFixture(dir.root, {env: {GLIMPSE_PORT: String(taken)}});
    try {
      expect(other.port).not.toBe(taken);
      expect(other.port).toBeGreaterThan(taken);
      expect(other.port).toBeLessThanOrEqual(taken + 19);
      expect((await raw(other.port, '/api/health')).status).toBe(200);
    } finally {
      other.t.session.dispose();
      await new Promise(resolve => blocker.close(resolve));
    }
  });
});
