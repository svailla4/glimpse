// DatasetStore: memoization per ref, HEAD and working-tree revision; failures as outcomes; paging.
import type {Rows, SourceMeta} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import type {GitInfo, RepoContext, Source} from '../../src/contracts.ts';
import {DatasetStore, envelopeOf, MAX_RESULTS, pageRows, pendingEnvelope, rowsOf} from '../../src/session/datasets.ts';
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
