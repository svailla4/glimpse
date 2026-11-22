// DatasetStore: memoization per ref, HEAD and working-tree revision; failures as outcomes; paging.
import type {Rows, SourceMeta} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import type {GitInfo, RepoContext, Source} from '../../src/contracts.ts';
import {boundWarnings, DatasetStore, envelopeOf, MAX_RESULTS, pageRows, pendingEnvelope, rowsOf} from '../../src/session/datasets.ts';
import {createRegistry} from '../../src/sources/registry.ts';
import {FAKE_ROWS, fakeSources} from './fakes.ts';

function setup(extra: Source[] = []) {
  const fakes = fakeSources();
  const state = {rev: 1, git: {head: 'aaa', shallow: false} as GitInfo | null};
  const logged: string[] = [];
  const ctx = {get git() { return state.git; }, rev: () => state.rev} as unknown as RepoContext;
  const store = new DatasetStore({registry: createRegistry([fakes.rows, fakes.slow, ...extra]), context: () => ctx, log: m => void logged.push(m)});
  return {fakes, state, store, logged};
}
const ref = (source: string, target?: string, args: Record<string, string> = {}) => ({source, ...(target ? {target} : {}), args});
const total = (fakes: ReturnType<typeof fakeSources>) => [...fakes.runs.values()].reduce((a, b) => a + b, 0);

// Finding V009: a table bound to a graph source draws the graph's nodes as rows, from the same run as the graph.
describe('a graph read as rows', () => {
  it('runs the graph once and answers `as=rows` with its nodes, fields and roles', async () => {
    let runs = 0;
    const graphMeta: SourceMeta = {name: 'fake.graph', kind: 'graph', doc: 'A graph.', shape: 'GraphData', budget: 150, target: 'range'};
    const graph: Source = {
      meta: graphMeta,
      run: async () => {
        runs++;
        return {data: {nodes: [{id: 'src/a.ts', label: 'a.ts', fanIn: 3, fanOut: 1, status: 'modified'}, {id: 'src/b.ts', label: 'b.ts', fanIn: 0}], edges: [{from: 'src/a.ts', to: 'src/b.ts'}]}, summary: '2 nodes 1 edge'};
      },
    };
    const {store} = setup([graph]);
    const asRows = await store.run(ref('fake.graph', 'wt', {as: 'rows'}));
    expect(asRows.ok && asRows.meta.kind).toBe('rows');
    if (!asRows.ok) throw new Error('expected rows');
    expect(asRows.result.data).toEqual([{label: 'a.ts', id: 'src/a.ts', status: 'modified', fanIn: 3, fanOut: 1}, {label: 'b.ts', id: 'src/b.ts', fanIn: 0}]);
    expect(asRows.meta.fields?.map(field => field.key)).toEqual(['label', 'id', 'status', 'fanIn', 'fanOut']);
    expect(asRows.meta.roles).toMatchObject({label: 'label', value: 'fanIn'});
    expect(asRows.result.summary).toBe('2 nodes as rows; fields label id status fanIn fanOut');
    await store.run(ref('fake.graph', 'wt'));
    expect(store.peek(ref('fake.graph', 'wt', {as: 'rows'}))?.meta.kind).toBe('rows');
    expect(runs).toBe(1);
    const envelope = envelopeOf('k', ref('fake.graph', 'wt', {as: 'rows'}), asRows);
    expect(envelope).toMatchObject({kind: 'rows', status: 'ready', source: 'fake.graph wt as=rows'});
  });
});

describe('DatasetStore', () => {
  it('runs a source once per canonical ref and answers later requests from memory', async () => {
    const {store, fakes} = setup();
    const first = await store.run(ref('fake.rows', 'src', {top: '3'}));
    expect(first).toMatchObject({ok: true, cached: false});
    const second = await store.run(ref('fake.rows', 'src', {top: '3'}));
    expect(second).toMatchObject({ok: true, cached: true});
    expect(total(fakes)).toBe(1);
    await store.run(ref('fake.rows', 'src', {top: '4'}));
    expect(total(fakes)).toBe(2);
    expect(store.peek(ref('fake.rows', 'src', {top: '3'}))?.result.data).toHaveLength(3);
    expect(store.peek(ref('fake.rows', 'other'))).toBeUndefined();
  });

  it('joins a run in flight instead of starting another', async () => {
    const {store, fakes} = setup();
    const a = store.run(ref('fake.slow'));
    const b = store.run(ref('fake.slow'));
    expect(store.peek(ref('fake.slow'))).toBeUndefined();
    fakes.release();
    expect(await a).toBe(await b);
    expect(total(fakes)).toBe(1);
  });

  it('memoizes per HEAD for every source and per revision only for working-tree sources', async () => {
    const {store, fakes, state} = setup();
    await store.run(ref('fake.rows'));
    const slow = store.run(ref('fake.slow'));
    fakes.release();
    await slow;
    state.rev = 2;
    await store.run(ref('fake.rows'));
    expect(fakes.runs.get('fake.rows  {}')).toBe(1);
    const again = store.run(ref('fake.slow'));
    fakes.release();
    await again;
    expect(fakes.runs.get('fake.slow ')).toBe(2);
    state.git = {head: 'bbb', shallow: false};
    await store.run(ref('fake.rows'));
    expect(fakes.runs.get('fake.rows  {}')).toBe(2);
  });

  it('turns a SourceError into an outcome and does not memoize it', async () => {
    const {store, fakes, logged} = setup();
    expect(await store.run(ref('fake.rows', 'boom'))).toEqual({ok: false, meta: fakes.rows.meta, error: {code: 'E_TARGET', message: 'no such path: boom'}});
    await store.run(ref('fake.rows', 'boom'));
    expect(total(fakes)).toBe(2);
    expect(logged).toEqual([]);
  });

  it('reports any other throw as E_INTERNAL and logs it; an unknown source is E_SOURCE', async () => {
    const meta: SourceMeta = {name: 'fake.broken', kind: 'rows', doc: '', shape: 'Rows', budget: 1};
    const {store, logged} = setup([{meta, run: () => { throw new TypeError('x is\nnot a function'); }}]);
    expect(await store.run(ref('fake.broken'))).toMatchObject({ok: false, error: {code: 'E_INTERNAL', message: 'x is not a function'}});
    expect(logged).toEqual(['glimpse: source fake.broken failed: x is not a function']);
    expect(await store.run(ref('nope.nope'))).toEqual({ok: false, meta: undefined, error: {code: 'E_SOURCE', message: 'unknown source "nope.nope"'}});
  });

  it('a catalog source without an implementation fails with E_INTERNAL "not implemented", quietly', async () => {
    const {store, logged} = setup();
    expect(await store.run(ref('git.churn'))).toMatchObject({ok: false, error: {code: 'E_INTERNAL', message: 'not implemented'}});
    expect(logged).toEqual([]);
  });

  it('keeps at most 64 results, dropping the least recently used', async () => {
    const {store} = setup();
    for (let i = 0; i < MAX_RESULTS + 6; i++) await store.run(ref('fake.rows', `t${i}`));
    expect(store.peek(ref('fake.rows', 't0'))).toBeUndefined();
    expect(store.peek(ref('fake.rows', 't5'))).toBeUndefined();
    expect(store.peek(ref('fake.rows', 't6'))).toBeDefined();
    await store.run(ref('fake.rows', 't6'));
    await store.run(ref('fake.rows', 'one-more'));
    expect(store.peek(ref('fake.rows', 't6'))).toBeDefined();
    expect(store.peek(ref('fake.rows', 't7'))).toBeUndefined();
  });

  it('close aborts runs in flight and refuses new ones', async () => {
    const {store} = setup();
    const running = store.run(ref('fake.slow'));
    store.close();
    expect(await running).toMatchObject({ok: false, error: {code: 'E_INTERNAL', message: 'aborted'}});
    expect(await store.run(ref('fake.rows'))).toMatchObject({ok: false, error: {message: 'the session has ended'}});
  });
});

describe('DatasetStore: pending runs are capped and timed', () => {
  const hanging = (name: string, started: string[]): Source => ({
    meta: {name, kind: 'rows', doc: '', shape: 'Rows', budget: 5},
    // ignores the abort signal on purpose: the store has to end the run by itself
    run: (_ctx, r) => new Promise(() => void started.push(r.target ?? '')),
  });
  const limited = (options: {maxRunning?: number; maxWaiting?: number; runTimeoutMs?: number}, extra: Source[] = []) => {
    const fakes = fakeSources();
    const logged: string[] = [];
    const ctx = {git: {head: 'aaa', shallow: false}, rev: () => 1} as unknown as RepoContext;
    const store = new DatasetStore({registry: createRegistry([fakes.rows, fakes.slow, ...extra]), context: () => ctx, log: m => void logged.push(m), ...options});
    return {store, fakes, logged};
  };

  it('runs at most maxRunning sources at once; the rest start as slots free up, in order', async () => {
    const {store, fakes} = limited({maxRunning: 2});
    const runs = ['a', 'b', 'c', 'd'].map(target => store.run(ref('fake.slow', target)));
    expect(store.load).toEqual({running: 2, waiting: 2});
    expect([...fakes.runs.keys()]).toEqual(['fake.slow a', 'fake.slow b']);
    fakes.release();
    await Promise.all(runs.slice(0, 2));
    await Promise.resolve();
    expect([...fakes.runs.keys()]).toEqual(['fake.slow a', 'fake.slow b', 'fake.slow c', 'fake.slow d']);
    expect(store.load).toEqual({running: 2, waiting: 0});
    fakes.release();
    expect((await Promise.all(runs)).every(outcome => outcome.ok)).toBe(true);
    expect(store.load).toEqual({running: 0, waiting: 0});
  });

  it('refuses new runs once too many are waiting, and says so', async () => {
    const {store, fakes} = limited({maxRunning: 1, maxWaiting: 2});
    const runs = ['a', 'b', 'c'].map(target => store.run(ref('fake.slow', target)));
    expect(await store.run(ref('fake.slow', 'd'))).toMatchObject({ok: false, error: {code: 'E_INTERNAL', message: '2 sources are already waiting to run; ask again in a moment'}});
    // a ref already asked for joins its run instead of being refused
    expect(store.run(ref('fake.slow', 'c'))).toBe(runs[2]);
    for (let i = 0; i < 3; i++) { fakes.release(); await runs[i]; }
    // once the queue has drained, new runs are welcome again
    expect(await store.run(ref('fake.rows'))).toMatchObject({ok: true});
  });

  it('a source that never answers is stopped after the timeout and its slot is given back', async () => {
    const started: string[] = [];
    const {store, logged} = limited({maxRunning: 1, runTimeoutMs: 30}, [hanging('fake.hang', started)]);
    const stuck = store.run(ref('fake.hang', 'x'));
    const next = store.run(ref('fake.rows'));
    expect(await stuck).toEqual({ok: false, meta: expect.objectContaining({name: 'fake.hang'}), error: {code: 'E_INTERNAL', message: 'fake.hang x did not finish within 0 s and was stopped'}});
    expect(await next).toMatchObject({ok: true});
    expect(store.load).toEqual({running: 0, waiting: 0});
    expect(logged).toEqual(['glimpse: source fake.hang x failed: fake.hang x did not finish within 0 s and was stopped']);
    // a failure is not memoized: the next request tries again
    void store.run(ref('fake.hang', 'x'));
    expect(started).toEqual(['x', 'x']);
    store.close();
  });

  it('close lets waiting runs answer "ended" without starting them', async () => {
    const {store, fakes} = limited({maxRunning: 1});
    const first = store.run(ref('fake.slow', 'a'));
    const waiting = store.run(ref('fake.slow', 'b'));
    store.close();
    expect(await first).toMatchObject({ok: false, error: {message: 'aborted'}});
    expect(await waiting).toMatchObject({ok: false, error: {message: 'the session has ended'}});
    expect([...fakes.runs.keys()]).toEqual(['fake.slow a']);
  });
});

describe('a drilled dataset carries its scope in every state (decision drill-has-way-back)', () => {
  it('pending, ready and error envelopes take the drill; without one the field is absent', async () => {
    const {store, fakes} = setup();
    const drill = {target: 'src/deep', up: 'src'};
    expect(pendingEnvelope('k', ref('fake.rows', 'src/deep'), fakes.rows.meta, drill).drill).toEqual(drill);
    expect(envelopeOf('k', ref('fake.rows', 'src/deep'), await store.run(ref('fake.rows', 'src/deep')), drill)).toMatchObject({status: 'ready', drill});
    expect(envelopeOf('k', ref('fake.rows', 'boom'), await store.run(ref('fake.rows', 'boom')), {target: 'boom', up: ''})).toMatchObject({status: 'error', drill: {target: 'boom', up: ''}});
    expect('drill' in envelopeOf('k', ref('fake.rows'), await store.run(ref('fake.rows')))).toBe(false);
    expect('drill' in pendingEnvelope('k', ref('fake.rows'), fakes.rows.meta)).toBe(false);
  });
});

describe('warnings are deduplicated and bounded', () => {
  it('boundWarnings keeps eight distinct one-line warnings of at most 300 characters', () => {
    expect(boundWarnings(['a', 'a', ' a ', 'b\nc', '', 7, null])).toEqual(['a', 'b c']);
    const many = boundWarnings(Array.from({length: 30}, (_, i) => `warning ${i}`));
    expect(many).toHaveLength(8);
    expect(many.at(-1)).toBe('(23 more warnings)');
    expect(boundWarnings(['x'.repeat(1000)])[0]).toHaveLength(300);
  });

  it('an envelope never carries more than that, whatever the source returned', async () => {
    const noisy: Source = {
      meta: {name: 'fake.noisy', kind: 'rows', doc: '', shape: 'Rows', budget: 5},
      run: async () => ({data: [], summary: 'noisy', warnings: Array.from({length: 500}, (_, i) => (i % 2 ? 'same' : `w${i} ${'y'.repeat(900)}`))}),
    };
    const {store} = setup([noisy]);
    const envelope = envelopeOf('k', ref('fake.noisy'), await store.run(ref('fake.noisy')));
    expect(envelope.warnings).toHaveLength(8);
    expect(JSON.stringify(envelope.warnings).length).toBeLessThan(2600);
  });
});

describe('envelopes', () => {
  it('pending, ready and error envelopes carry the key, the kind and the canonical ref', async () => {
    const {store, fakes} = setup();
    const r = ref('fake.rows', 'src', {top: '3'});
    expect(pendingEnvelope('k', r, fakes.rows.meta)).toEqual({$ds: 'k', kind: 'rows', status: 'pending', source: 'fake.rows src top=3', note: 'running fake.rows src top=3'});
    expect(pendingEnvelope('k', ref('fake.slow'), fakes.slow.meta).wt).toBe(true);
    const ready = envelopeOf('k', r, await store.run(r));
    expect(ready).toMatchObject({
      $ds: 'k', kind: 'rows', status: 'ready', source: 'fake.rows src top=3', total: 25, pageable: true, cache: 'miss',
      fields: fakes.rows.meta.fields, roles: {label: 'path', value: 'n'}, truncated: {total: 25, returned: 3, strategy: 'topN'},
    });
    expect(ready.data).toHaveLength(3);
    expect(typeof ready.elapsedMs).toBe('number');
    expect(envelopeOf('k', r, await store.run(r)).cache).toBe('hit');
    expect(envelopeOf('k', ref('fake.rows', 'boom'), await store.run(ref('fake.rows', 'boom')))).toEqual({
      $ds: 'k', kind: 'rows', status: 'error', source: 'fake.rows boom', error: {code: 'E_TARGET', message: 'no such path: boom'},
    });
    expect('note' in ready).toBe(false);
  });

  // Kit handoff (finding F008): an empty result says why. Real data read 'no data from diff.files' while the
  // summary said 'wt: 0 files; no changes'.
  it('a ready result with nothing in it carries its summary as the note, on one line', async () => {
    const meta = (name: string, kind: SourceMeta['kind']): SourceMeta => ({name, kind, doc: 'test', shape: 'unknown', budget: 10});
    const fixed = (name: string, kind: SourceMeta['kind'], data: unknown, summary: string): Source => ({meta: meta(name, kind), run: async () => ({data, summary})});
    const {store} = setup([
      fixed('fake.none', 'rows', [], 'wt: 0 files;\n no changes'),
      fixed('fake.graph', 'graph', {nodes: [], edges: []}, '0 nodes 0 edges'),
      fixed('fake.tree', 'tree', {name: '', path: '', dir: true, files: 0, loc: 0, bytes: 0, children: []}, 'no files under x'),
      fixed('fake.record', 'record', {}, ''),
      fixed('fake.some', 'graph', {nodes: [{id: 'a'}], edges: []}, '1 node'),
      fixed('fake.pairs', 'rows', [], '0 rows; fields a b shared degree; 3 commits over 30 files ignored; no pair shares 3 commits'),
      fixed('fake.bare', 'rows', [], '0 rows; fields a b'),
    ]);
    const note = async (name: string) => envelopeOf('k', ref(name), await store.run(ref(name))).note;
    expect(await note('fake.none')).toBe('wt: 0 files; no changes');
    expect(await note('fake.graph')).toBe('0 nodes 0 edges');
    expect(await note('fake.tree')).toBe('no files under x');
    expect(await note('fake.record')).toBeUndefined();
    expect(await note('fake.some')).toBeUndefined();
    // the count and the field list are for the model; the person reads why
    expect(await note('fake.pairs')).toBe('3 commits over 30 files ignored; no pair shares 3 commits');
    expect(await note('fake.bare')).toBe('0 rows; fields a b');
  });
});

describe('pageRows', () => {
  const rows: Rows = [
    {path: 'b.ts', n: 2, tag: 'x'}, {path: 'a.ts', n: 10, tag: null}, {path: 'c.ts', n: '3', tag: 'Y'}, {path: 'd.ts', tag: 'x'}, {path: 'e.ts', n: 2, tag: {deep: 'needle'}},
  ];

  it('windows with offset and limit, clamped', () => {
    expect(pageRows(FAKE_ROWS, {})).toMatchObject({total: 25, offset: 0});
    expect(pageRows(FAKE_ROWS, {offset: 20, limit: 10}).rows).toHaveLength(5);
    expect(pageRows(FAKE_ROWS, {offset: 99}).rows).toEqual([]);
    expect(pageRows(FAKE_ROWS, {limit: 100_000}).rows).toHaveLength(25);
    expect(pageRows(FAKE_ROWS, {offset: -5, limit: 0}).rows).toHaveLength(1);
    expect(pageRows(Array.from({length: 900}, (_, i) => ({i})), {limit: 100_000}).rows).toHaveLength(500);
  });

  it('sorts numerically, both ways, with missing values last and ties in original order', () => {
    expect(pageRows(rows, {sort: 'n'}).rows.map(r => r.path)).toEqual(['b.ts', 'e.ts', 'c.ts', 'a.ts', 'd.ts']);
    expect(pageRows(rows, {sort: '-n'}).rows.map(r => r.path)).toEqual(['a.ts', 'c.ts', 'b.ts', 'e.ts', 'd.ts']);
    expect(pageRows(rows, {sort: 'path'}).rows.map(r => r.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    expect(pageRows(rows, {sort: 'nope'}).rows).toEqual(rows);
  });

  it('searches every cell, case-insensitively, objects included; total counts the matches', () => {
    expect(pageRows(rows, {q: 'y'}).rows.map(r => r.path)).toEqual(['c.ts']);
    expect(pageRows(rows, {q: 'NEEDLE'})).toMatchObject({total: 1});
    expect(pageRows(rows, {q: '  '}).total).toBe(5);
    expect(pageRows(rows, {q: 'x', sort: '-path', limit: 1})).toEqual({rows: [rows[3]], total: 2, offset: 0});
  });
});

describe('rowsOf', () => {
  it('prefers the full row set of a pageable source and refuses non-rows results', async () => {
    const {store} = setup();
    const outcome = await store.run(ref('fake.rows', undefined, {top: '2'}));
    expect(rowsOf(outcome)).toHaveLength(25);
    expect(rowsOf({ok: false, meta: undefined, error: {code: 'E', message: 'm'}})).toBeUndefined();
    expect(rowsOf({ok: true, meta: {name: 'x.tree', kind: 'tree', doc: '', shape: 'DirNode', budget: 1}, result: {data: {}, summary: ''}, elapsedMs: 0, cached: false})).toBeUndefined();
  });
});
