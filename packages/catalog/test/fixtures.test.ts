import {describe, expect, it} from 'vitest';
import {
  DATASET_FIXTURES, HOST_FIXTURES, createFixtureHost, datasetFixture, errorDataset, pendingDataset, tokenizeLine,
} from '../fixtures/index.ts';
import {COMPONENTS, GALLERY_SPEC, SOURCES, TOKEN_CLASSES, datasetKey, isDataset, parseRef, type A2uiMessage, type DirNode, type GraphData, type TokenLine} from '../src/index.ts';
import {FIXTURE_META, buildSurface, strictErrors} from '../testing/index.ts';
import {readJson} from './support.ts';

const text = (line: TokenLine) => line.map(([t]) => t).join('');
const validTokens = (line: TokenLine) => line.every(([t, cls]) => typeof t === 'string' && cls >= 0 && cls < TOKEN_CLASSES.length);

describe('dataset fixtures', () => {
  it.each(SOURCES.map(s => [s.name, s] as const))('%s has a small ready envelope of the right kind', (name, source) => {
    const ds = DATASET_FIXTURES[name]!;
    expect(isDataset(ds)).toBe(true);
    expect(ds).toMatchObject({$ds: datasetKey({source: name, args: {}}), kind: source.kind, status: 'ready'});
    expect(parseRef(ds.source).source).toBe(name);
    expect(ds.pageable ?? false).toBe(source.pageable ?? false);
    expect(ds.wt ?? false).toBe(source.wt ?? false);
    if (source.kind === 'rows') {
      const rows = ds.data as Array<Record<string, unknown> | string>;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(source.budget);
      expect(ds.fields).toEqual(source.fields);
      // every default column exists in the first row
      for (const field of source.fields ?? []) expect(rows[0], `${name}.${field.key}`).toHaveProperty(field.key);
    }
    if (source.kind === 'tree') expect(ds.data as DirNode).toMatchObject({dir: true, path: ''});
    if (source.kind === 'graph') {
      const graph = ds.data as GraphData;
      const ids = new Set(graph.nodes.map(n => n.id));
      expect(ids.size).toBe(graph.nodes.length);
      for (const edge of graph.edges) expect(ids.has(edge.from) && ids.has(edge.to), `${name} edge ${edge.from}->${edge.to}`).toBe(true);
    }
    expect(JSON.stringify(ds)).not.toMatch(/@[a-z]+\.[a-z]{2,}|\/Users\//);
  });

  it('has exactly one fixture per source, and the JSON files carry the same data', () => {
    expect(Object.keys(DATASET_FIXTURES).sort()).toEqual(SOURCES.map(s => s.name).sort());
    for (const source of SOURCES) expect(readJson(`../fixtures/datasets/${source.name}.json`)).toEqual(JSON.parse(JSON.stringify(DATASET_FIXTURES[source.name])));
  });

  it('datasetFixture re-keys a copy for the ref and honours top=', () => {
    const bare = datasetFixture('git.churn');
    expect(bare).toEqual(DATASET_FIXTURES['git.churn']);
    expect(bare).not.toBe(DATASET_FIXTURES['git.churn']);
    const scoped = datasetFixture<unknown[]>('git.churn top=2 src/auth');
    expect(scoped.$ds).toBe(datasetKey(parseRef('git.churn src/auth top=2')));
    expect(scoped.source).toBe('git.churn src/auth top=2');
    expect(scoped.data).toHaveLength(2);
    expect(scoped.truncated).toEqual({total: 9, returned: 2, strategy: 'topN'});
    expect(() => datasetFixture('nope.nope')).toThrow(/no dataset fixture/);
  });

  it('pendingDataset and errorDataset build the other two envelope states', () => {
    expect(pendingDataset('git.log src')).toMatchObject({$ds: datasetKey(parseRef('git.log src')), kind: 'rows', status: 'pending', source: 'git.log src', note: 'running git.log src'});
    expect(errorDataset('deps.modules', 'E_NO_GIT', 'not a git repository')).toMatchObject({kind: 'graph', status: 'error', error: {code: 'E_NO_GIT', message: 'not a git repository'}});
  });
});

describe('gallery fixture', () => {
  const wire = readJson('../fixtures/gallery.wire.json') as A2uiMessage[];

  it('is the compiled GALLERY_SPEC with /ds, /ui and /meta', () => {
    expect(wire).toEqual(JSON.parse(JSON.stringify(buildSurface('gallery', GALLERY_SPEC))));
    expect(wire).toHaveLength(1);
    const surface = (wire[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface;
    expect(surface.surfaceId).toBe('gallery');
    expect(Object.keys(surface.dataModel ?? {})).toEqual(['g', 'ds', 'ui', 'meta']);
    expect(surface.dataModel).toMatchObject({ds: {}, ui: {sel: null, file: null}, meta: FIXTURE_META});
    expect(new Set(surface.components.map(c => c.component)).size).toBe(COMPONENTS.length);
  });

  it('is strictly valid', () => {
    expect(strictErrors(wire)).toEqual([]);
  });
});

describe('host fixtures and FixtureHost', () => {
  it('the canned answers are well formed and match the JSON files', () => {
    const {file, diff, outline, rows} = HOST_FIXTURES;
    expect(file.lines).toHaveLength(file.total);
    expect(file.lines.every(validTokens)).toBe(true);
    expect(text(file.lines[0]!)).toBe("import {cache} from './cache';");
    expect(diff.files.map(f => [f.path, f.status])).toEqual([['src/api/limiter.ts', 'A'], ['src/auth/service.ts', 'M']]);
    for (const f of diff.files) {
      const lines = f.hunks!.flatMap(h => h.lines);
      expect(lines.filter(l => l.t === '+')).toHaveLength(f.add);
      expect(lines.filter(l => l.t === '-')).toHaveLength(f.del);
      expect(lines.every(l => validTokens(l.tokens))).toBe(true);
      for (const l of lines) for (const [from, to] of l.marks ?? []) expect(from < to && to <= text(l.tokens).length).toBe(true);
    }
    expect(diff.totals).toEqual({files: 2, add: 13, del: 2});
    expect(outline.symbols.map(s => s.name)).toContain('issueToken');
    expect(rows.total).toBe(rows.rows.length);
    for (const name of ['file', 'diff', 'outline', 'rows'] as const) expect(readJson(`../fixtures/host/${name}.json`)).toEqual(JSON.parse(JSON.stringify(HOST_FIXTURES[name])));
  });

  it('tokenizeLine classifies keywords, strings, calls, numbers and comments and loses no text', () => {
    const line = "const n = await take('ip', 42); // limit";
    const tokens = tokenizeLine(line);
    expect(text(tokens)).toBe(line);
    expect(tokens).toContainEqual(['const', 1]);
    expect(tokens).toContainEqual(["'ip'", 2]);
    expect(tokens).toContainEqual(['take', 3]);
    expect(tokens).toContainEqual(['42', 5]);
    expect(tokens.at(-1)).toEqual(['// limit', 7]);
  });

  it('rows pages, sorts and filters the fixture of the dataset key', async () => {
    const host = createFixtureHost();
    const first = await host.rows({surfaceId: 's', key: 'files_list', offset: 0, limit: 3, sort: '-loc'});
    expect(first).toMatchObject({total: 9, offset: 0});
    expect(first.rows.map(r => r.loc)).toEqual([900, 820, 700]);
    const next = await host.rows({surfaceId: 's', key: 'files_list', offset: 3, limit: 3, sort: '-loc'});
    expect(next.rows.map(r => r.loc)).toEqual([410, 400, 400]);
    const filtered = await host.rows({surfaceId: 's', key: 'files_list_1a2b3c', q: 'AUTH', sort: 'path'});
    expect(filtered.rows.map(r => r.path)).toEqual(['src/auth/cache.ts', 'src/auth/schema.sql', 'src/auth/service.ts']);
    expect((await host.rows({surfaceId: 's', key: 'unknown_key'})).total).toBe(0);
    expect(host.calls.map(c => c.method)).toEqual(['rows', 'rows', 'rows', 'rows']);
  });

  it('file windows the slice, relabels the path and reports a missing file', async () => {
    const host = createFixtureHost();
    const slice = await host.file({path: 'src/x.ts', start: 8, end: 10});
    expect(slice).toMatchObject({path: 'src/x.ts', start: 8, end: 10, total: HOST_FIXTURES.file.total});
    expect(slice.lines.map(text)).toEqual([
      'export async function login(email: string, password: string): Promise<Session> {',
      '  const user = await db.users.findByEmail(email);',
      '  if (!user || !(await verify(password, user.hash))) {',
    ]);
    expect((await host.file({path: 'src/x.ts'})).lines).toHaveLength(HOST_FIXTURES.file.total);
    expect(await host.file({path: 'src/missing.ts'})).toMatchObject({skipped: 'missing', lines: []});
  });

  it('diff, highlight and outline answer for the requested range, code and path', async () => {
    const host = createFixtureHost();
    expect(await host.diff({range: 'main..HEAD'})).toMatchObject({range: 'main..HEAD', totals: {files: 2}});
    expect(await host.diff({range: 'wt', path: 'src/auth/service.ts'})).toMatchObject({totals: {files: 1, add: 3, del: 2}});
    expect((await host.highlight('const a = 1;\nreturn a;', 'ts')).lines.map(text)).toEqual(['const a = 1;', 'return a;']);
    expect(await host.outline('src/y.ts')).toMatchObject({path: 'src/y.ts'});
  });

  it('answers are copies, overrides replace methods and are recorded, an aborted signal rejects', async () => {
    const host = createFixtureHost({outline: async path => ({path, symbols: []})});
    const a = await host.file({path: 'a.ts'});
    a.lines.length = 0;
    expect((await host.file({path: 'a.ts'})).lines.length).toBeGreaterThan(0);
    expect((await host.outline('z.ts')).symbols).toEqual([]);
    expect(host.calls.at(-1)).toEqual({method: 'outline', args: ['z.ts']});
    const controller = new AbortController();
    controller.abort();
    await expect(host.diff({range: 'wt'}, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
  });
});
