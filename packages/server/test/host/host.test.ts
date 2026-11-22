// The host as a viewer sees it: the event stream (hello, replay, live frames in order, bye), the renderer endpoint,
// row paging, static files and tab opening.
import {connect} from 'node:net';
import type {A2uiMessage, Dataset, ServerEvent} from '@glimpse/catalog';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {HEADERS_TIMEOUT_MS, MAX_CONNECTIONS, REQUEST_TIMEOUT_MS} from '../../src/host/host.ts';
import {MAX_CLIENTS} from '../../src/host/sse.ts';
import {fakeDeps, sleep, tempRoot, TOKEN, until} from '../session/fakes.ts';
import {fakeViewer, json, openStream, raw, startFixture, type HostFixture, type Stream} from './support.ts';

let dir: Awaited<ReturnType<typeof tempRoot>>;
let viewerDir: string;
beforeAll(async () => {
  dir = await tempRoot();
  viewerDir = await fakeViewer(dir.root);
});
afterAll(() => dir.cleanup());

const fixtures: HostFixture[] = [];
const streams: Stream[] = [];
async function start(options: Parameters<typeof startFixture>[1] = {}): Promise<HostFixture> {
  const fx = await startFixture(dir.root, {viewerDir, ...options});
  fixtures.push(fx);
  return fx;
}
async function stream(fx: HostFixture, query?: string): Promise<Stream> {
  const s = await openStream(fx.port, query);
  streams.push(s);
  return s;
}
afterEach(() => {
  for (const s of streams.splice(0)) s.close();
  for (const fx of fixtures.splice(0)) fx.t.session.dispose();
});

const show = (fx: HostFixture, id: string, text: string) => fx.t.session.show({id, sources: [text], fresh: false});
type A2uiEvent = Extract<ServerEvent, {type: 'a2ui'}>;
const a2ui = (events: ServerEvent[]) => events.filter((e): e is A2uiEvent => e.type === 'a2ui');
const kindsOf = (event: A2uiEvent) => event.messages.map((m: A2uiMessage) => Object.keys(m).find(k => k !== 'version'));
const BASE = `root=Page('Demo',[DataTable('fake.rows',title='Rows'),DataTable('fake.slow')])`;

describe('event stream', () => {
  it('starts with retry and hello, then one snapshot per surface, then live frames in order', async () => {
    const fx = await start();
    const first = await show(fx, 'demo', BASE);
    await first.datasets[0]!.settled;
    await show(fx, 'other', `$/n=1\nroot=Page('Other',[Text('x')])`);

    const s = await stream(fx);
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['cache-control']).toBe('no-store');
    const replay = await s.waitFor(3);
    expect(s.text().startsWith('retry: 1000\n\n')).toBe(true);
    expect(replay[0]).toMatchObject({type: 'hello', v: 1, epoch: fx.host.epoch, focus: 'other', session: {id: fx.t.session.id, version: '0.0.0-test', repo: {name: fx.t.session.name, branch: 'main'}}});
    expect((replay[0] as Extract<ServerEvent, {type: 'hello'}>).surfaces.map(x => [x.id, x.title])).toEqual([['demo', 'Demo'], ['other', 'Other']]);
    const snapshots = a2ui(replay);
    expect(snapshots.map(e => [e.surfaceId, kindsOf(e)])).toEqual([['demo', ['createSurface']], ['other', ['createSurface']]]);
    const model = (snapshots[0]!.messages[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface.dataModel as {ds: Record<string, Dataset>};
    expect(Object.values(model.ds).map(d => d.status)).toEqual(['ready', 'pending']);

    // live: a patch, a dataset filling, a replace
    await show(fx, 'other', `$/n=2`);
    fx.t.deps.sources.release();
    await first.datasets[1]!.settled;
    // (a new root whose old child is gone: the surface is recreated; one that keeps it is updated in place, F028)
    await show(fx, 'other', `root=Page('Other again',[])`);
    await show(fx, 'other', `root=Page('Other, third',[Text('z')])`);
    const all = a2ui(await s.waitFor(7));
    const live = all.slice(2);
    expect(live.map(e => [e.surfaceId, kindsOf(e), e.focus])).toEqual([
      ['other', ['updateDataModel'], 'other'],
      ['demo', ['updateDataModel'], undefined],
      ['other', ['deleteSurface', 'createSurface'], 'other'],
      ['other', ['updateDataModel', 'updateComponents'], 'other'],
    ]);
    expect(all.map(e => e.seq)).toEqual([...all.map(e => e.seq)].sort((a, b) => a - b));
    expect(new Set(all.map(e => e.seq)).size).toBe(all.length);
    expect(live.at(-2)!.surfaces.map(x => x.title)).toEqual(['Demo', 'Other again']);
    expect(live.at(-1)!.surfaces.map(x => x.title)).toEqual(['Demo', 'Other, third']);
  });

  it('counts tabs, reports them in health, and starts the watcher only while one is connected', async () => {
    const fx = await start();
    await show(fx, 'demo', `root=Page('Demo',[])`);
    expect(json(await raw(fx.port, '/api/health'))).toEqual({app: 'glimpse', version: '0.0.0-test', epoch: fx.host.epoch, tabs: 0});
    expect(fx.t.deps.watching()).toBe(false);
    const a = await stream(fx);
    const b = await stream(fx);
    await b.waitFor(2);
    expect(fx.host.tabs()).toBe(2);
    expect(json(await raw(fx.port, '/api/health')).tabs).toBe(2);
    expect(fx.t.deps.watching()).toBe(true);
    a.close();
    b.close();
    await until(() => fx.host.tabs() === 0);
    expect(fx.t.deps.watching()).toBe(false);
  });

  it('a reconnecting tab gets the same epoch and a fresh replay', async () => {
    const fx = await start();
    await show(fx, 'demo', `$/n=1\nroot=Page('Demo',[])`);
    const first = await stream(fx);
    await first.waitFor(2);
    first.close();
    await until(() => fx.host.tabs() === 0);
    await show(fx, 'demo', `$/n=2`);
    const second = await stream(fx);
    const events = await second.waitFor(2);
    expect((events[0] as {epoch: string}).epoch).toBe(fx.host.epoch);
    expect((a2ui(events)[0]!.messages[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface.dataModel).toMatchObject({n: 2});
  });

  // Finding F025: a browser gives one origin six connections; a sixth stream starved every tab's data requests.
  it('holds five streams and refuses a sixth tab with 503 and a sentence a person can act on', async () => {
    expect(MAX_CLIENTS).toBe(5);
    const fx = await start();
    for (let i = 0; i < MAX_CLIENTS; i++) await stream(fx);
    await until(() => fx.host.tabs() === MAX_CLIENTS);
    const extra = await raw(fx.port, `/api/events?t=${TOKEN}`, {auth: false});
    expect(extra.status).toBe(503);
    expect(extra.headers['retry-after']).toBe('5');
    expect(extra.body).toBe('too many Glimpse tabs: 5 are open for this session. Close one and this tab connects by itself.');
    // with every stream held, data requests still answer
    expect((await raw(fx.port, '/api/health')).status).toBe(200);
    // a slot frees up when a tab goes away
    streams[0]!.close();
    await until(() => fx.host.tabs() === MAX_CLIENTS - 1);
    expect((await stream(fx)).status).toBe(200);
  });

  // Finding F056: Node only checks its timeouts every connectionsCheckingInterval, 30 s by default.
  it('configures the listener: timeouts that actually fire, and a connection cap', async () => {
    expect(HEADERS_TIMEOUT_MS).toBe(5000);
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(MAX_CONNECTIONS).toBeGreaterThanOrEqual(MAX_CLIENTS * 6);
    const fx = await start();
    // a client that opens a socket and never finishes its headers is cut off within the header timeout plus one check
    const socket = connect(fx.port, '127.0.0.1');
    let answer = '';
    const closed = new Promise<number>(resolve => {
      const started = Date.now();
      // The socket must be read: an unread socket never sees the end of the stream, so 'close' would never fire.
      socket.on('data', chunk => { answer += String(chunk); });
      socket.on('close', () => resolve(Date.now() - started));
      socket.on('error', () => {});
    });
    socket.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    expect(await closed).toBeLessThan(HEADERS_TIMEOUT_MS + 4000);
    expect(answer).toMatch(/^HTTP\/1\.1 408 /);
  }, 15_000);

  it('close says bye, ends every stream and stops listening', async () => {
    const fx = await start();
    await show(fx, 'demo', `root=Page('Demo',[])`);
    const s = await stream(fx);
    await s.waitFor(2);
    fx.t.session.dispose();
    await s.ended;
    expect(s.events.at(-1)).toEqual({type: 'bye', reason: 'shutdown'});
    await expect(raw(fx.port, '/api/health')).rejects.toThrow();
  });
});

describe('POST /api/renderer', () => {
  const post = (fx: HostFixture, messages: unknown[]) => raw(fx.port, '/api/renderer', {body: JSON.stringify({messages})});
  const action = (name: string, context: Record<string, unknown>, source = 'root') =>
    ({version: '1.0', action: {name, surfaceId: 'demo', sourceComponentId: source, timestamp: new Date(0).toISOString(), context}});

  it('queues actions for the agent and answers 204 with no body', async () => {
    const fx = await start();
    await show(fx, 'demo', `root=Page('Demo',[go])\ngo=Button('Go',Event('approve',{plan:1}))`);
    const response = await post(fx, [action('gl_select', {ref: {type: 'file', id: 'a.ts', path: 'a.ts'}}), action('approve', {plan: 1}, 'go'), {nonsense: true}]);
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    expect(fx.t.session.events.drain()).toEqual(['viewer: select file a.ts (demo)', 'viewer: press demo approve {"plan":1}']);
  });

  // Review S4: a message that threw (gl_set on $/w/toString cloned a native function) failed the post and dropped the rest.
  it('a message that throws is logged and skipped; the rest of the batch is handled and the post answers 204', async () => {
    const fx = await start();
    await show(fx, 'demo', `root=Page('Demo',[go,s])\n$/w={seats:5}\ngo=Button('Go',Event('approve',{plan:1}))\ns=Slider('S',$/w/toString,0,10)`);
    const select = fx.t.session.select.bind(fx.t.session);
    fx.t.session.select = (...args: Parameters<typeof select>) => { if (args[1]?.id === 'boom') throw new Error('boom'); return select(...args); };
    const response = await post(fx, [action('gl_select', {ref: {type: 'file', id: 'boom', path: 'boom'}}), action('gl_set', {value: 3}, 's'), action('approve', {plan: 1}, 'go')]);
    expect(response.status).toBe(204);
    expect(fx.logged).toContain('glimpse: a renderer message failed: boom');
    // an inherited property is not the model's data: gl_set writes the path as its own number, and nothing throws
    expect(fx.t.session.surfaces.get('demo')!.data.w).toEqual({seats: 5, toString: 3});
    expect(fx.t.session.events.drain()).toEqual(['viewer: set $/w/toString 3 (demo)', 'viewer: press demo approve {"plan":1}']);
  });

  // Review S4 with decision only-problems-are-errors: a component state that throws is skipped the same way.
  it('a state that throws is logged and skipped; the other states are kept and the post answers 204', async () => {
    const fx = await start();
    await show(fx, 'demo', `root=Page('Demo',[go])\ngo=Button('Go',Event('approve',{plan:1}))`);
    const kept: string[] = [];
    fx.t.session.viewerReport = (_surface, _name, id, code) => {
      if (id === 'boom') throw new Error('boom');
      kept.push(`${id} ${code}`);
      return true;
    };
    const state = (id: string, code: string) => ({surfaceId: 'demo', component: 'Button', id, code});
    const response = await raw(fx.port, '/api/renderer', {body: JSON.stringify({messages: [], states: [state('boom', 'OK'), state('go', 'OK')]})});
    expect(response.status).toBe(204);
    expect(fx.logged).toContain('glimpse: a renderer state failed: boom');
    expect(kept).toEqual(['go OK']);
  });

  it('gl_close from the shell removes the surface and broadcasts the deletion', async () => {
    const fx = await start();
    await show(fx, 'demo', `root=Page('Demo',[])`);
    const s = await stream(fx);
    await s.waitFor(2);
    await post(fx, [action('gl_close', {})]);
    const events = await s.waitFor(3);
    expect(events.at(-1)).toMatchObject({type: 'a2ui', surfaceId: 'demo', messages: [{deleteSurface: {surfaceId: 'demo'}}], surfaces: []});
  });
});

describe('GET /api/ds/:surfaceId/:key/rows', () => {
  it('pages, sorts and searches the full row set of a pageable dataset', async () => {
    const fx = await start();
    const outcome = await show(fx, 'demo', `root=Page('Demo',[DataTable('fake.rows top=5')])`);
    const key = outcome.datasets[0]!.key;
    const page = json(await raw(fx.port, `/api/ds/demo/${key}/rows?offset=20&limit=10`));
    expect(page).toMatchObject({total: 25, offset: 20});
    expect(page.rows).toHaveLength(5);
    const sorted = json(await raw(fx.port, `/api/ds/demo/${key}/rows?sort=n&limit=2`));
    expect(sorted.rows.map((r: {n: number}) => r.n)).toEqual([1, 2]);
    const found = json(await raw(fx.port, `/api/ds/demo/${key}/rows?q=file07`));
    expect(found).toMatchObject({total: 1, rows: [{path: 'src/file07.ts'}]});
    expect(json(await raw(fx.port, `/api/ds/demo/${key}/rows?limit=99999`)).rows).toHaveLength(25);
  });

  it('404 for an unknown surface or dataset, 422 with the code when the source fails', async () => {
    const fx = await start();
    const outcome = await show(fx, 'demo', `root=Page('Demo',[DataTable('fake.rows boom'),Stats()])`);
    expect((await raw(fx.port, '/api/ds/nope/fake_rows/rows')).status).toBe(404);
    expect((await raw(fx.port, '/api/ds/demo/nope/rows')).status).toBe(404);
    const failed = await raw(fx.port, `/api/ds/demo/${outcome.datasets[0]!.key}/rows`);
    expect(failed.status).toBe(422);
    expect(json(failed)).toEqual({error: {code: 'E_TARGET', message: 'no such path: boom'}});
  });
});

describe('POST /api/highlight', () => {
  it('returns token lines from the code service', async () => {
    const fx = await start();
    await show(fx, 'demo', `root=Page('Demo',[])`);
    const response = await raw(fx.port, '/api/highlight', {body: JSON.stringify({code: 'const a = 1\nreturn a', lang: 'ts'})});
    expect(json(response)).toEqual({lang: 'ts', lines: [[['const a = 1', 0]], [['return a', 0]]]});
  });
});

describe('static files', () => {
  it('serves hashed assets as immutable with the right type, and nothing else', async () => {
    const fx = await start();
    const js = await raw(fx.port, '/assets/index-abc123.js', {auth: false});
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('console.log("viewer")');
    expect((await raw(fx.port, '/assets/index-abc123.css', {auth: false})).headers['content-type']).toBe('text/css; charset=utf-8');
    for (const path of ['/assets/', '/assets/missing.js', '/assets/.hidden', '/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/..%2f..%2fpackage.json', '/assets/%00', '/assets/%zz', '/favicon.ico', '/src/main.ts', '/index.htm']) {
      expect((await raw(fx.port, path, {auth: false})).status, path).toBe(404);
    }
  });

  it('says so when no viewer build is present', async () => {
    const fx = await startFixture(dir.root, {});
    fixtures.push(fx);
    const response = await raw(fx.port, '/', {auth: false});
    expect(response.status).toBe(503);
    expect(response.body).toMatch(/not built/);
  });
});

describe('opening the tab', () => {
  const desktop = {GLIMPSE_NO_OPEN: undefined, CI: undefined, SSH_CONNECTION: undefined, SSH_TTY: undefined, DISPLAY: ':0'};

  it('never opens under GLIMPSE_NO_OPEN=1', async () => {
    const fx = await start();
    expect((await show(fx, 'demo', `root=Page('Demo',[])`)).tab).toBe('none');
    expect(fx.launched).toEqual([]);
  });

  it('opens once with the token in the fragment, not again within five seconds, and reports live once connected', async () => {
    let clock = 10_000;
    const fx = await start({env: desktop, now: () => clock});
    const first = await show(fx, 'demo', `root=Page('Demo',[])`);
    expect(first.tab).toBe('opened');
    expect(fx.launched).toHaveLength(1);
    // finding V019: the opener by its absolute path
    expect(fx.launched[0]![0]).toMatch(/^\/usr\/bin\/(?:open|xdg-open|rundll32)$/);
    expect(fx.launched[0]![1].at(-1)).toBe(`http://127.0.0.1:${fx.port}/#t=${TOKEN}`);
    // finding V045: the route is a label; the link that works is the one with the token
    expect(first.url).toBe('#/demo');
    expect(first.openUrl).toBe(`http://127.0.0.1:${fx.port}/#t=${TOKEN}`);
    clock += 4000;
    expect((await show(fx, 'demo', `$/n=1`)).tab).toBe('opened');
    expect(fx.launched).toHaveLength(1);
    clock += 2000;
    expect((await show(fx, 'demo', `$/n=2`)).tab).toBe('opened');
    expect(fx.launched).toHaveLength(2);
    const s = await stream(fx);
    await s.waitFor(2);
    clock += 60_000;
    expect((await show(fx, 'demo', `$/n=3`)).tab).toBe('live');
    expect(fx.launched).toHaveLength(2);
  });
});

describe('robustness', () => {
  it('keeps serving after malformed requests', async () => {
    const fx = await start({deps: fakeDeps()});
    await show(fx, 'demo', `root=Page('Demo',[])`);
    await raw(fx.port, '/api/ds/%E0%A4%A/x/rows');
    await raw(fx.port, '/api/renderer', {body: '[]'});
    await raw(fx.port, '//api/health');
    await sleep(5);
    expect((await raw(fx.port, '/api/health')).status).toBe(200);
  });
});
