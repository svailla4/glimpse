import {existsSync} from 'node:fs';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRef, SOURCE_BY_NAME, type DiffFileRow, type DirNode, type GraphData, type Rows, type StatItem} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {SourceResult} from '../../src/contracts.ts';
import type {Change} from '../../src/git/diff.ts';
import {changeTree, createDiffSources, isTestPath} from '../../src/sources/git/diff.ts';
import {git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {fixtureFiles, makeContext, never, type TestContext} from '../git/context.ts';

const DIFF_SOURCES = ['diff.stats', 'diff.files', 'diff.tree', 'diff.impact'];
const sources = new Map(createDiffSources().map(source => [source.meta.name, source]));
const stats = (wanted: number[]): StatItem[] => [
  {label: 'Files changed', value: wanted[0]!},
  {label: 'Added', value: wanted[1]!, tone: 'good'},
  {label: 'Removed', value: wanted[2]!, tone: 'bad'},
  {label: 'Commits', value: wanted[3]!},
  {label: 'Tests touched', value: wanted[4]!},
];
/** Every node of a tree, depth first. */
const walk = (node: DirNode): DirNode[] => [node, ...(node.children ?? []).flatMap(walk)];

describe('diff.* sources on the fixture repository', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  const run = <T = Rows>(text: string, context: TestContext = ctx): Promise<SourceResult<T>> => {
    const ref = parseRef(text);
    return sources.get(ref.source)!.run(context, ref, never) as Promise<SourceResult<T>>;
  };
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    ctx = await makeContext(repo.root);
  });
  afterAll(async () => { await repo.cleanup(); });

  it('are the four diff sources of the catalog', () => {
    expect([...sources.keys()]).toEqual(DIFF_SOURCES);
    for (const [name, source] of sources) expect(source.meta).toBe(SOURCE_BY_NAME.get(name));
  });

  it('diff.stats: the working tree by default, staged, and a commit range', async () => {
    const wt = await run<StatItem[]>('diff.stats');
    expect(wt.data).toEqual(stats([3, 20, 1, 0, 0]));
    expect(wt).toMatchObject({total: 5, summary: 'wt: 3 files +20 -1, 0 commits, 0 test files; fields label value'});
    expect((await run<StatItem[]>('diff.stats wt')).data).toEqual(wt.data);
    expect((await run<StatItem[]>('diff.stats staged')).data).toEqual(stats([0, 0, 0, 0, 0]));
    const range = await run<StatItem[]>('diff.stats main..feature');
    expect(range.data).toEqual(stats([4, 29, 0, 3, 1]));
    expect(range.summary).toBe('main..feature: 4 files +29 -0, 3 commits, 1 test file; fields label value');
    // three dots and a longer way round give the same change
    expect((await run<StatItem[]>('diff.stats main...feature')).data).toEqual(range.data);
    // the last two commits: four files of the UI, then two tests and two auth files
    expect((await run<StatItem[]>('diff.stats main~2..main')).data).toEqual(stats([8, 77, 0, 2, 2]));
  });

  it('diff.files: one row per changed file, largest change first, with delta, language and test flag', async () => {
    const wt = await run<DiffFileRow[]>('diff.files');
    expect(wt.data).toEqual([
      {path: 'src/lib/metrics.ts', status: 'A', add: 9, del: 0, delta: {add: 9, del: 0}, lang: 'TypeScript', isTest: false},
      {path: 'src/auth/service.ts', status: 'M', add: 5, del: 1, delta: {add: 5, del: 1}, lang: 'TypeScript', isTest: false},
      {path: 'tools/stats.py', status: 'M', add: 6, del: 0, delta: {add: 6, del: 0}, lang: 'Python', isTest: false},
    ]);
    expect(wt).toMatchObject({total: 3, fields: SOURCE_BY_NAME.get('diff.files')!.fields, roles: {label: 'path', value: 'add'}});
    expect(wt.summary).toBe('3 rows; fields path status delta lang; wt: 3 files +20 -1; largest src/lib/metrics.ts +9 -0');
    expect(wt.allRows).toBeUndefined();

    const range = await run<DiffFileRow[]>('diff.files main..feature');
    // these files are not in the working tree: language and test flag come from the path
    expect(range.data).toEqual([
      {path: 'src/api/limiter.ts', status: 'A', add: 12, del: 0, delta: {add: 12, del: 0}, lang: 'TypeScript', isTest: false},
      {path: 'test/limiter.test.ts', status: 'A', add: 8, del: 0, delta: {add: 8, del: 0}, lang: 'TypeScript', isTest: true},
      {path: 'src/api/middleware.ts', status: 'M', add: 6, del: 0, delta: {add: 6, del: 0}, lang: 'TypeScript', isTest: false},
      {path: 'src/api/routes.ts', status: 'M', add: 3, del: 0, delta: {add: 3, del: 0}, lang: 'TypeScript', isTest: false},
    ]);
    expect((await run<DiffFileRow[]>('diff.files main~4..main~3')).data.find(row => row.status === 'R')).toEqual({
      path: 'src/lib/logger.ts', from: 'src/lib/log.ts', status: 'R', add: 4, del: 0, delta: {add: 4, del: 0}, lang: 'TypeScript', isTest: false,
    });
    const top = await run<DiffFileRow[]>('diff.files main..feature top=2');
    expect(top.data.map(row => row.path)).toEqual(['src/api/limiter.ts', 'test/limiter.test.ts']);
    expect(top).toMatchObject({total: 2, truncated: {total: 4, returned: 2, strategy: 'topN', by: 'changes'}});
    expect(await run('diff.files staged')).toMatchObject({data: [], total: 0, summary: '0 rows; fields path status delta lang; staged: 0 files +0 -0; no changes'});
  });

  it('diff.tree: the changed files as directories with add and del summed upward', async () => {
    const wt = await run<DirNode>('diff.tree');
    const file = (path: string, lang: string, add: number, del: number, status: 'A' | 'M'): DirNode =>
      ({name: path.slice(path.lastIndexOf('/') + 1), path, dir: false, files: 1, loc: 40, bytes: 1000, lang, add, del, status});
    expect(wt.data).toEqual({
      name: '', path: '', dir: true, files: 3, loc: 120, bytes: 3000, add: 20, del: 1, lang: 'TypeScript',
      children: [
        {
          name: 'src', path: 'src', dir: true, files: 2, loc: 80, bytes: 2000, add: 14, del: 1, lang: 'TypeScript',
          children: [
            {name: 'auth', path: 'src/auth', dir: true, files: 1, loc: 40, bytes: 1000, add: 5, del: 1, lang: 'TypeScript', children: [file('src/auth/service.ts', 'TypeScript', 5, 1, 'M')]},
            {name: 'lib', path: 'src/lib', dir: true, files: 1, loc: 40, bytes: 1000, add: 9, del: 0, lang: 'TypeScript', children: [file('src/lib/metrics.ts', 'TypeScript', 9, 0, 'A')]},
          ],
        },
        {name: 'tools', path: 'tools', dir: true, files: 1, loc: 40, bytes: 1000, add: 6, del: 0, lang: 'Python', children: [file('tools/stats.py', 'Python', 6, 0, 'M')]},
      ],
    });
    expect(wt).toMatchObject({total: 8, summary: 'wt: 3 files +20 -1'});
    expect(wt.truncated).toBeUndefined();

    const range = await run<DirNode>('diff.tree main..feature');
    expect(range.data).toMatchObject({files: 4, add: 29, del: 0});
    expect(walk(range.data).filter(node => !node.dir).map(node => [node.path, node.status, node.add])).toEqual([
      ['src/api/limiter.ts', 'A', 12], ['src/api/middleware.ts', 'M', 6], ['src/api/routes.ts', 'M', 3], ['test/limiter.test.ts', 'A', 8],
    ]);
    expect((await run<DirNode>('diff.tree staged')).data).toEqual({name: '', path: '', dir: true, files: 0, loc: 0, bytes: 0, add: 0, del: 0});
  });

  it('diff.impact: changed files and the files that import them', async () => {
    const wt = await run<GraphData>('diff.impact');
    expect(wt.data.level).toBe('file');
    expect(wt.data.nodes).toEqual([
      {id: 'src/lib/metrics.ts', label: 'metrics.ts', sub: 'src/lib', kind: 'file', slotKey: 'src/lib', status: 'added', file: 'src/lib/metrics.ts'},
      {id: 'src/auth/service.ts', label: 'service.ts', sub: 'src/auth', kind: 'file', slotKey: 'src/auth', status: 'modified', file: 'src/auth/service.ts'},
      {id: 'tools/stats.py', label: 'stats.py', sub: 'tools', kind: 'file', slotKey: 'tools', status: 'modified', file: 'tools/stats.py'},
      {id: 'src/api/routes.ts', label: 'routes.ts', sub: 'src/api', kind: 'file', slotKey: 'src/api', status: 'affected', file: 'src/api/routes.ts'},
      {id: 'src/orders/service.ts', label: 'service.ts', sub: 'src/orders', kind: 'file', slotKey: 'src/orders', status: 'affected', file: 'src/orders/service.ts'},
      {id: 'test/auth.test.ts', label: 'auth.test.ts', sub: 'test', kind: 'file', slotKey: 'test', status: 'affected', file: 'test/auth.test.ts'},
      {id: 'tools/report.py', label: 'report.py', sub: 'tools', kind: 'file', slotKey: 'tools', status: 'affected', file: 'tools/report.py'},
      {id: 'tools/tests/test_stats.py', label: 'test_stats.py', sub: 'tools/tests', kind: 'file', slotKey: 'tools', status: 'affected', file: 'tools/tests/test_stats.py'},
    ]);
    // importer -> changed file; an import from a changed file to an unchanged one is not part of the blast radius
    expect(wt.data.edges).toEqual([
      {from: 'src/api/routes.ts', to: 'src/auth/service.ts'},
      {from: 'src/orders/service.ts', to: 'src/auth/service.ts'},
      {from: 'test/auth.test.ts', to: 'src/auth/service.ts'},
      {from: 'tools/report.py', to: 'tools/stats.py'},
      {from: 'tools/tests/test_stats.py', to: 'tools/stats.py'},
    ]);
    expect(wt).toMatchObject({total: 8, summary: 'wt: 3 changed, 5 affected importers; 8 nodes 5 edges'});
    expect(wt.truncated).toBeUndefined();
    expect(wt.warnings).toBeUndefined();
    const ids = new Set(wt.data.nodes.map(node => node.id));
    expect(wt.data.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true);

    // both ends changed: the edge between them is kept, and neither is "affected"
    await writeFile(join(repo.root, 'src/orders/service.ts'), '// rewritten\n');
    const both = await run<GraphData>('diff.impact');
    await git(repo.root, ['checkout', '-q', '--', 'src/orders/service.ts']);
    expect(both.data.nodes.find(node => node.id === 'src/orders/service.ts')!.status).toBe('modified');
    expect(both.data.edges).toContainEqual({from: 'src/orders/service.ts', to: 'src/auth/service.ts'});
    expect(both.data.edges).toContainEqual({from: 'src/auth/service.ts', to: 'src/orders/service.ts'});
  });

  it('diff.impact: a range that does not end at HEAD says where its importers come from; an empty change is an empty graph', async () => {
    const range = await run<GraphData>('diff.impact main~3..main~1');
    expect(range.data.nodes.filter(node => node.status !== 'affected').map(node => `${node.id} ${node.status}`).sort()).toEqual([
      'package.json modified', 'src/auth/service.ts modified', 'src/auth/session.ts modified', 'src/orders/service.ts modified',
      'src/ui/App.tsx added', 'src/ui/app.css added', 'src/ui/components/Cart.tsx added',
    ]);
    expect(range.data.nodes.find(node => node.id === 'package.json')).toEqual({id: 'package.json', label: 'package.json', kind: 'file', slotKey: '.', status: 'modified', file: 'package.json'});
    expect(range.warnings).toEqual(['importers are read from the working tree, not from the head of the range']);
    const empty = await run<GraphData>('diff.impact staged');
    expect(empty).toMatchObject({data: {level: 'file', nodes: [], edges: []}, total: 0});
    expect(ctx.index.calls.edges).toBeGreaterThan(0);
    const calls = ctx.index.calls.edges;
    await run('diff.impact staged');
    // nothing changed: the import graph is not even asked for
    expect(ctx.index.calls.edges).toBe(calls);
  });

  it('diff.impact: keeps to its budget of 150 nodes and 400 edges', async () => {
    const importers = Array.from({length: 300}, (_, i) => ({from: `gen/importer${String(i).padStart(3, '0')}.ts`, to: 'src/auth/service.ts', kind: 'import'}));
    const crowded = await makeContext(repo.root, {index: {edges: () => Promise.resolve(importers)}});
    const result = await run<GraphData>('diff.impact', crowded);
    expect(result.data.nodes).toHaveLength(150);
    expect(result.data.edges.length).toBeLessThanOrEqual(400);
    expect(result.data.nodes.slice(0, 3).map(node => node.status)).toEqual(['added', 'modified', 'modified']);
    expect(result).toMatchObject({total: 303, truncated: {total: 303, returned: 150, strategy: 'neighborhood'}});
    const ids = new Set(result.data.nodes.map(node => node.id));
    expect(result.data.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
    expect(result.summary).toBe('wt: 3 changed, 300 affected importers; 150 nodes 147 edges');
  });

  it('work without the file index, and diff.impact reports when the import graph is unavailable', async () => {
    const down = () => Promise.reject(new Error('index down'));
    const broken = await makeContext(repo.root, {index: {files: down, edges: down, moduleOf: down}});
    expect((await run<StatItem[]>('diff.stats main..feature', broken)).data).toEqual(stats([4, 29, 0, 3, 1]));
    expect((await run<DiffFileRow[]>('diff.files', broken)).data.map(row => [row.path, row.lang, row.isTest])).toEqual([
      ['src/lib/metrics.ts', 'TypeScript', false], ['src/auth/service.ts', 'TypeScript', false], ['tools/stats.py', 'Python', false],
    ]);
    expect((await run<DirNode>('diff.tree', broken)).data).toMatchObject({files: 3, add: 20, del: 1, loc: 0, bytes: 0});
    expect(broken.logs.length).toBeGreaterThan(0);
    await expect(run('diff.impact', broken)).rejects.toThrow('index down');
  });

  it('reject bad ranges with E_TARGET before git sees them, and bad top= with E_ARGS', async () => {
    ctx.gitCalls.length = 0;
    for (const name of DIFF_SOURCES) {
      for (const range of ['--output=x', '-p', 'main --stat', 'main..--output=x', 'a b..c']) {
        await expect(run(`${name} ${range}`), `${name} ${range}`).rejects.toMatchObject({code: 'E_TARGET'});
      }
    }
    expect(ctx.gitCalls).toEqual([]);
    expect(existsSync(join(repo.root, 'x'))).toBe(false);
    for (const name of DIFF_SOURCES) await expect(run(`${name} nope..main`), name).rejects.toMatchObject({code: 'E_TARGET', message: 'unknown revision "nope"'});
    await expect(run('diff.files top=-1')).rejects.toMatchObject({code: 'E_ARGS'});
    for (const name of DIFF_SOURCES) expect((await run(name)).summary.length, name).toBeLessThanOrEqual(160);
  });
});

describe('diff.* sources in unusual repositories', () => {
  const run = (text: string, ctx: TestContext) => sources.get(parseRef(text).source)!.run(ctx, parseRef(text), never);
  let repo: FixtureRepo;
  let scratch: string;
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-diff-sources-')));
  });
  afterAll(async () => {
    await repo.cleanup();
    await rm(scratch, {recursive: true, force: true});
  });

  it('answer E_NO_GIT outside a repository', async () => {
    const outside = await makeContext(scratch);
    for (const name of DIFF_SOURCES) await expect(run(name, outside), name).rejects.toMatchObject({code: 'E_NO_GIT'});
  });

  it('treat everything as added before the first commit', async () => {
    const dir = join(scratch, 'unborn');
    await git(scratch, ['init', '-q', '-b', 'main', dir]);
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'b.py'), 'b = 2\nc = 3\n');
    await git(dir, ['add', 'b.py']);
    const unborn = await makeContext(dir, {index: {files: () => Promise.resolve([])}});
    expect((await run('diff.stats', unborn)).data).toEqual(stats([2, 3, 0, 0, 0]));
    expect(((await run('diff.files', unborn)).data as DiffFileRow[]).map(row => [row.path, row.status, row.add])).toEqual([['b.py', 'A', 2], ['a.ts', 'A', 1]]);
    expect(((await run('diff.files staged', unborn)).data as DiffFileRow[]).map(row => row.path)).toEqual(['b.py']);
  });

  it('warn in a shallow clone when a range reaches into cut history', async () => {
    const clone = join(scratch, 'shallow');
    await git(repo.root, ['clone', '-q', '--depth', '3', `file://${repo.root}`, clone]);
    const shallow = await makeContext(clone);
    const result = await run('diff.stats HEAD~1..HEAD', shallow);
    expect(result.data).toEqual(stats([4, 30, 0, 1, 2]));
    expect(result.warnings).toEqual(['shallow clone: history is incomplete']);
    // the working tree needs no history: no warning
    expect((await run('diff.stats', shallow)).warnings).toBeUndefined();
  });

  it('work when the project root is a directory inside the repository', async () => {
    const sub = await makeContext(join(repo.root, 'src'), {index: {files: () => Promise.resolve([])}});
    expect(((await run('diff.files', sub)).data as DiffFileRow[]).map(row => row.path)).toEqual(['lib/metrics.ts', 'auth/service.ts']);
    // one of the three commits on feature touches only test/, outside this project
    expect((await run('diff.stats main..feature', sub)).data).toEqual(stats([3, 21, 0, 2, 0]));
  });
});

describe('changeTree', () => {
  const change = (path: string, add: number, del = 0): Change => ({path, status: 'M', add, del, binary: false, untracked: false});

  it('keeps to the node budget and to 40 children per directory, rolling the rest up', () => {
    const files: Change[] = [];
    for (let dir = 0; dir < 100; dir++) for (let file = 0; file < 50; file++) files.push(change(`pkg/d${String(dir).padStart(3, '0')}/f${String(file).padStart(2, '0')}.ts`, dir + file + 1));
    const tree = changeTree(files, new Map(), 1_500);
    const nodes = walk(tree.root);
    expect(nodes).toHaveLength(tree.nodes);
    expect(tree.nodes).toBeLessThanOrEqual(1_500);
    expect(tree.total).toBe(1 + 1 + 100 + 5_000);
    for (const node of nodes) expect((node.children ?? []).length).toBeLessThanOrEqual(40);
    // nothing is lost: what is not drawn is counted in a rollup
    expect(tree.root).toMatchObject({files: 5_000, add: files.reduce((sum, file) => sum + file.add, 0)});
    const drawnFiles = nodes.filter(node => !node.dir).length;
    const rolledUp = nodes.reduce((sum, node) => sum + (node.more?.files ?? 0), 0);
    expect(drawnFiles + rolledUp).toBe(5_000);
    const pkg = tree.root.children![0]!;
    expect(pkg.children).toHaveLength(40);
    expect(pkg.more).toEqual({files: 60 * 50, loc: 0});
    // the heaviest directories and files are the ones that stay
    expect(pkg.children!.map(node => node.name)).toContain('d099');
    expect(pkg.children!.map(node => node.name)).not.toContain('d000');
  });

  it('uses the index for sizes and languages, and the path when the index does not know a file', () => {
    const entries = new Map(fixtureFiles().map(file => [file.path, file]));
    const tree = changeTree([change('src/auth/service.ts', 3, 1), change('gone/old.go', 0, 9), change('notes', 1)], entries, 100);
    expect(tree.root).toMatchObject({files: 3, add: 4, del: 10, loc: 40, bytes: 1000});
    expect(tree.root.children!.map(node => [node.name, node.dir, node.lang])).toEqual([['gone', true, 'Go'], ['src', true, 'TypeScript'], ['notes', false, undefined]]);
    expect(walk(tree.root).find(node => node.path === 'gone/old.go')).toMatchObject({loc: 0, bytes: 0, lang: 'Go', status: 'M'});
  });

  it('is a bare root for no changes and survives a budget of one', () => {
    expect(changeTree([], new Map(), 1_500)).toEqual({root: {name: '', path: '', dir: true, files: 0, loc: 0, bytes: 0, add: 0, del: 0}, nodes: 1, total: 1});
    const tiny = changeTree([change('a/b.ts', 1), change('c.ts', 2)], new Map(), 1);
    expect(tiny.root.children).toBeUndefined();
    expect(tiny.root.more).toEqual({files: 2, loc: 0});
  });
});

describe('isTestPath', () => {
  it('follows the rule of the repository inventory', () => {
    for (const path of ['test/a.ts', 'src/tests/a.py', 'src/__tests__/a.js', 'spec/a.rb', 'src/a.test.ts', 'src/a_spec.rb', 'src/a-test.js', 'pkg/a_test.go', 'tools/test_stats.py']) {
      expect(isTestPath(path), path).toBe(true);
    }
    for (const path of ['src/a.ts', 'src/latest/a.ts', 'src/contest.ts', 'testing.md', 'src/attest_go.go', 'tools/latest_stats.py']) expect(isTestPath(path), path).toBe(false);
  });
});
