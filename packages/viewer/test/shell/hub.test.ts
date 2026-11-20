// packages/viewer/test/shell/hub.test.ts - HubTransport against a fake EventSource and a fake fetch.
import type {LinkStatus, ServerEvent} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import {createHubTransport} from '../../src/transport/hub.ts';

class FakeSource {
  static last: FakeSource | undefined;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  private readonly listeners = new Map<string, Array<(event: {data: string}) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeSource.last = this;
  }
  addEventListener(type: string, listener: (event: {data: string}) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail(readyState = 0) {
    this.readyState = readyState;
    this.onerror?.();
  }
  push(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({data});
  }
}

interface Call { url: string; init: RequestInit | undefined }
function fakeFetch(answer: (call: Call) => Response = () => Response.json({ok: true})) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {url: String(input), init};
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  return {calls, fetch};
}

function connect(token = 'tok/en+1') {
  const http = fakeFetch();
  const transport = createHubTransport({token, EventSource: FakeSource as unknown as typeof EventSource, fetch: http.fetch});
  const events: ServerEvent[] = [];
  const statuses: LinkStatus[] = [];
  const disconnect = transport.connect(event => void events.push(event), status => void statuses.push(status));
  return {transport, events, statuses, disconnect, source: FakeSource.last!, calls: http.calls};
}
const headers = (call: Call) => new Headers(call.init?.headers);

describe('HubTransport', () => {
  it('opens the event stream with the token in the query and reports the link status', () => {
    const {source, statuses, events} = connect();
    expect(source.url).toBe('/api/events?t=tok%2Fen%2B1');
    expect(statuses).toEqual(['connecting']);
    source.open();
    expect(statuses).toEqual(['connecting', 'live']);
    const hello: ServerEvent = {type: 'hello', v: 1, epoch: 'e1', session: {id: 's', project: 'p', repo: {name: 'demo'}, version: '0'}, surfaces: []};
    source.push('glimpse', JSON.stringify(hello));
    source.push('glimpse', 'not json');
    source.push('glimpse', 'null');
    source.push('other', JSON.stringify(hello));
    expect(events).toEqual([hello]);
  });

  it('keeps retrying through a blip, and gives up after repeated failures', () => {
    const {source, statuses} = connect();
    source.open();
    source.fail();
    expect(statuses.at(-1)).toBe('connecting');
    source.open();
    expect(statuses.at(-1)).toBe('live');
    for (let i = 0; i < 4; i++) source.fail();
    expect(statuses.at(-1)).toBe('connecting');
    expect(source.closed).toBe(false);
    source.fail();
    expect(statuses.at(-1)).toBe('ended');
    expect(source.closed).toBe(true);
  });

  it('ends at once when the host refuses the stream', () => {
    const {source, statuses} = connect();
    source.fail(2);
    expect(statuses).toEqual(['connecting', 'ended']);
  });

  it('bye delivers the event, closes the stream and stops posting', async () => {
    const {transport, source, statuses, events, calls} = connect();
    source.open();
    transport.send([{version: '1.0', error: {code: 'E', message: 'before'}}]);
    source.push('glimpse', JSON.stringify({type: 'bye', reason: 'shutdown'}));
    expect(events).toEqual([{type: 'bye', reason: 'shutdown'}]);
    expect(statuses.at(-1)).toBe('ended');
    expect(source.closed).toBe(true);
    transport.send([{version: '1.0', error: {code: 'E', message: 'after'}}]);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it('disconnecting closes the stream and silences it', () => {
    const {source, statuses, events, disconnect} = connect();
    source.open();
    disconnect();
    expect(source.closed).toBe(true);
    source.push('glimpse', JSON.stringify({type: 'bye', reason: 'shutdown'}));
    source.fail();
    expect(events).toEqual([]);
    expect(statuses).toEqual(['connecting', 'live']);
  });

  it('posts renderer messages as JSON with the bearer token', () => {
    const {transport, calls} = connect('secret');
    transport.send([]);
    expect(calls).toEqual([]);
    const action = {name: 'gl_open', surfaceId: 's', sourceComponentId: 'c', timestamp: '2026-01-01T00:00:00Z', context: {file: 'a.ts'}};
    transport.send([{version: '1.0', action}]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('/api/renderer');
    expect(call!.init?.method).toBe('POST');
    expect(headers(call!).get('authorization')).toBe('Bearer secret');
    expect(headers(call!).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(call!.init?.body))).toEqual({messages: [{version: '1.0', action}]});
  });

  it('a post that fails is dropped without an unhandled rejection', async () => {
    const transport = createHubTransport({token: 't', EventSource: FakeSource as unknown as typeof EventSource, fetch: () => Promise.reject(new Error('offline'))});
    expect(() => transport.send([{version: '1.0', error: {code: 'E', message: 'm'}}])).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('maps the DataClient to the host endpoints', async () => {
    const http = fakeFetch();
    const transport = createHubTransport({token: 'secret', base: 'http://127.0.0.1:4517', EventSource: FakeSource as unknown as typeof EventSource, fetch: http.fetch});
    const signal = new AbortController().signal;
    await transport.rows({surfaceId: 'over view', key: 'git_churn_1a2b3c', offset: 200, limit: 200, sort: '-commits', q: 'src/a b'}, signal);
    await transport.rows({surfaceId: 's', key: 'k'});
    await transport.file({path: 'src/a b.ts', start: 1, end: 400});
    await transport.diff({range: 'main..HEAD', path: 'src/a.ts'});
    await transport.diff({range: 'wt'});
    await transport.outline('src/a.ts');
    await transport.highlight('const a = 1', 'ts');
    await transport.highlight('plain');
    expect(http.calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:4517/api/ds/over%20view/git_churn_1a2b3c/rows?offset=200&limit=200&sort=-commits&q=src%2Fa+b',
      'http://127.0.0.1:4517/api/ds/s/k/rows',
      'http://127.0.0.1:4517/api/file?path=src%2Fa+b.ts&start=1&end=400',
      'http://127.0.0.1:4517/api/diff?range=main..HEAD&path=src%2Fa.ts',
      'http://127.0.0.1:4517/api/diff?range=wt',
      'http://127.0.0.1:4517/api/outline?path=src%2Fa.ts',
      'http://127.0.0.1:4517/api/highlight',
      'http://127.0.0.1:4517/api/highlight',
    ]);
    for (const call of http.calls) expect(headers(call).get('authorization')).toBe('Bearer secret');
    expect(http.calls[0]!.init?.signal).toBe(signal);
    expect(http.calls[6]!.init?.method).toBe('POST');
    expect(JSON.parse(String(http.calls[6]!.init?.body))).toEqual({code: 'const a = 1', lang: 'ts'});
    expect(JSON.parse(String(http.calls[7]!.init?.body))).toEqual({code: 'plain'});
  });

  it('turns an error answer into an Error with the host text', async () => {
    const answers = [
      Response.json({error: {code: 'E_TARGET', message: 'path is outside the repository'}}, {status: 400}),
      Response.json({message: 'bad range'}, {status: 400}),
      new Response('nope', {status: 401, statusText: 'Unauthorized'}),
    ];
    const http = fakeFetch(() => answers.shift()!);
    const transport = createHubTransport({token: 't', EventSource: FakeSource as unknown as typeof EventSource, fetch: http.fetch});
    await expect(transport.file({path: '../x'})).rejects.toThrow('path is outside the repository');
    await expect(transport.diff({range: '--x'})).rejects.toThrow('bad range');
    await expect(transport.outline('a.ts')).rejects.toThrow('host answered 401 Unauthorized');
  });

  it('without EventSource the link is ended, not broken', () => {
    const transport = createHubTransport({token: 't', EventSource: null as never, fetch: fakeFetch().fetch});
    const statuses: LinkStatus[] = [];
    const saved = globalThis.EventSource;
    (globalThis as {EventSource?: unknown}).EventSource = undefined;
    try {
      const none = createHubTransport({token: 't', fetch: fakeFetch().fetch});
      none.connect(() => {}, status => void statuses.push(status))();
    } finally {
      (globalThis as {EventSource?: unknown}).EventSource = saved;
    }
    expect(statuses).toEqual(['ended']);
    expect(typeof transport.send).toBe('function');
  });
});
