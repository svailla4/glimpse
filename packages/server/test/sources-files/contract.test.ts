// Rules every source follows whatever it computes: shapes, budgets, summaries, top=, and how bad refs fail.
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCE_BY_NAME, type DirNode, type GraphData} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {SourceError, type RepoContext} from '../../src/contracts.ts';
import {createFilesSources, sources as production} from '../../src/sources/files/index.ts';
import {clampSummary, compact} from '../../src/sources/files/shared.ts';
import {git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {checkResult, failure, makeContext, MINE, NOW, run} from './helpers.ts';

/** A ref that runs for each source on the fixture. */
const SAMPLE: Record<string, string> = {
  'deps.files': 'deps.files src/auth/service.ts',
  'code.symbols': 'code.symbols src/auth/service.ts',
  'code.refs': 'code.refs config',
};
const sample = (name: string) => SAMPLE[name] ?? name;
const ROWS = MINE.filter(name => SOURCE_BY_NAME.get(name)!.kind === 'rows');

let repo: FixtureRepo;
let ctx: RepoContext;
beforeAll(async () => {
  repo = await makeFixtureRepo();
  ctx = makeContext(repo.root);
});
afterAll(async () => { await repo.cleanup(); });

describe('with git', () => {
  it.each(MINE)('%s returns its shape within its budget, with a summary of at most 160 characters', async name => {
    checkResult(name, await run(ctx, sample(name)));
  });

  it.each(ROWS)('%s honours top=', async name => {
    const all = await run(ctx, sample(name));
    const one = await run(ctx, `${sample(name)} top=1`);
    expect(one.data).toEqual((all.data as unknown[]).slice(0, 1));
    expect(one.total).toBe(all.total);
    if ((all.data as unknown[]).length > 1) {
      expect(one.truncated).toMatchObject({total: all.total, returned: 1, strategy: 'topN'});
      expect(one.summary).toMatch(new RegExp(`^1(/${all.total})? rows?;`));
    }
    checkResult(name, one);
    // a top above the budget is capped by the budget, never an error
    const huge = await run(ctx, `${sample(name)} top=999999`);
    expect(huge.data).toEqual(all.data);
  });

  it.each(ROWS)('%s rejects a top that is not a positive integer', async name => {
    for (const bad of ['0', '-1', 'ten', '1.5', '', '1e3']) {
      expect(await failure(ctx, `${sample(name)} top=${bad}`), `top=${bad}`).toMatchObject({code: 'E_ARGS'});
    }
  });

  it.each(MINE)('%s ignores argument names it does not know', async name => {
    const plain = await run(ctx, sample(name));
    const extra = await run(ctx, `${sample(name)} colour=blue since=90d`);
    expect(extra.data).toEqual(plain.data);
  });

  it('refuses targets outside the repository and targets that name nothing', async () => {
    for (const ref of ['files.tree ../elsewhere', 'files.list /etc', 'files.tree src/../../x', 'code.todos C:\\Users', 'deps.modules ..', 'deps.files ../x.ts', 'code.symbols /etc/passwd']) {
      const error = await failure(ctx, ref);
      expect(error, ref).toMatchObject({code: 'E_TARGET'});
      expect(error.message, ref).toMatch(/not a path inside the repository/);
    }
    expect(await failure(ctx, 'files.tree nowhere')).toEqual({code: 'E_TARGET', message: 'files.tree: no files under "nowhere"'});
    expect(await failure(ctx, 'files.list src/aut')).toEqual({code: 'E_TARGET', message: 'files.list: no files under "src/aut"'});
    expect(await failure(ctx, 'code.todos nowhere')).toMatchObject({code: 'E_TARGET'});
    expect(await failure(ctx, 'deps.modules nowhere')).toEqual({code: 'E_TARGET', message: 'deps.modules: no files under "nowhere"'});
    expect(await failure(ctx, 'deps.modules src/index.ts')).toEqual({code: 'E_TARGET', message: 'deps.modules: "src/index.ts" is a file; use deps.files src/index.ts'});
    expect(await failure(ctx, 'deps.files')).toMatchObject({code: 'E_TARGET', message: 'deps.files needs a file path, e.g. deps.files src/index.ts'});
    expect(await failure(ctx, 'deps.files src')).toEqual({code: 'E_TARGET', message: 'deps.files: "src" is a directory; use deps.modules src'});
    expect(await failure(ctx, 'deps.files src/nope.ts')).toEqual({code: 'E_TARGET', message: 'deps.files: no such file "src/nope.ts"'});
    expect(await failure(ctx, 'code.symbols')).toMatchObject({code: 'E_TARGET'});
    expect(await failure(ctx, 'code.symbols src')).toEqual({code: 'E_TARGET', message: 'code.symbols: no such file "src"'});
    expect(await failure(ctx, 'code.refs')).toMatchObject({code: 'E_TARGET'});
    expect(await failure(ctx, 'code.refs noSuchIdentifierAnywhere')).toEqual({code: 'E_TARGET', message: 'code.refs: no matches for "noSuchIdentifierAnywhere"'});
    expect(await failure(ctx, `code.refs ${'x'.repeat(201)}`)).toMatchObject({code: 'E_TARGET'});
  });

  it('every failure is a SourceError', async () => {
    const error = await run(ctx, 'deps.modules focus=nothing').catch(e => e as unknown);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({code: 'E_ARGS', message: expect.stringMatching(/^deps\.modules: focus "nothing" is not a node\. Nodes: services\/gateway, /)});
    expect(await failure(ctx, 'deps.modules focus=ui depth=0')).toMatchObject({code: 'E_ARGS'});
    expect(await failure(ctx, 'deps.files src/index.ts depth=9')).toEqual({code: 'E_ARGS', message: 'deps.files: depth must be an integer from 1 to 5, got "9"'});
  });

  it('treats a target as text, never as an option or a pattern', async () => {
    expect(await failure(ctx, 'code.refs --help')).toMatchObject({code: 'E_TARGET', message: 'code.refs: no matches for "--help"'});
    expect(await failure(ctx, 'code.refs -e')).toMatchObject({code: 'E_TARGET'});
    expect(await failure(ctx, 'code.refs .*')).toMatchObject({code: 'E_TARGET'});
    // a match needs word boundaries on both sides
    expect(await failure(ctx, 'code.refs logi')).toMatchObject({code: 'E_TARGET'});
    const dotted = await run(ctx, 'code.refs config.port');
    expect((dotted.data as Array<{file: string}>).map(row => row.file.replace(/#L\d+$/, ''))).toEqual(['src/api/server.ts', 'src/index.ts', 'src/index.ts']);
  });

  it('accepts ./, a trailing slash, back slashes and a line suffix in a path', async () => {
    const plain = await run(ctx, 'files.list src/auth');
    for (const spelling of ['./src/auth', 'src/auth/', 'src\\auth', './src/auth/']) expect((await run(ctx, `files.list ${spelling}`)).data, spelling).toEqual(plain.data);
    expect((await run(ctx, 'code.symbols src/lib/config.ts#L3-9')).data).toEqual((await run(ctx, 'code.symbols src/lib/config.ts')).data);
    expect((await run(ctx, 'files.tree .')).data).toEqual((await run(ctx, 'files.tree')).data);
  });

  it('stops when the caller has gone away', async () => {
    const controller = new AbortController();
    controller.abort();
    for (const name of MINE) await expect(run(ctx, sample(name), controller.signal), name).rejects.toMatchObject({name: 'AbortError'});
  });

  it('the exported production sources use the wall clock; a pinned clock changes only ages and windows', async () => {
    const pinned = createFilesSources({now: () => NOW + 10 * 86_400_000}).find(source => source.meta.name === 'files.tree')!;
    const later = (await pinned.run(ctx, {source: 'files.tree', args: {}}, new AbortController().signal)).data as DirNode;
    expect(later.age).toBe(25);
    const live = production.find(source => source.meta.name === 'repo.kpis')!;
    const stats = (await live.run(ctx, {source: 'repo.kpis', args: {}}, new AbortController().signal)).data as Array<{label: string; value: number}>;
    expect(stats.map(stat => stat.label)).toEqual(['Files', 'Lines', 'Languages', 'Modules', 'Cycles', 'Commits (30d)', 'Contributors']);
  });

  it('a shallow clone says its history is incomplete', async () => {
    const shallow = makeContext(repo.root, {shallow: true});
    expect((await run(shallow, 'repo.kpis')).warnings).toEqual(['shallow clone: history is incomplete']);
  });
});

describe('without git', () => {
  let plain: RepoContext;
  beforeAll(() => {
    plain = makeContext(repo.root, {git: false});
  });

  it.each(MINE)('%s works on a plain directory', async name => {
    checkResult(name, await run(plain, sample(name)));
  });

  it('gives the same structure as with git, minus what only history can tell', async () => {
    for (const name of ['files.langs', 'repo.stack', 'repo.packages', 'repo.scripts', 'deps.modules', 'deps.cycles', 'deps.external', 'deps.matrix', 'code.todos', 'code.symbols', 'code.refs', 'deps.files']) {
      expect((await run(plain, sample(name))).data, name).toEqual((await run(ctx, sample(name))).data);
    }
    const tree = (await run(plain, 'files.tree')).data as DirNode;
    expect(tree).toMatchObject({files: 36, loc: 634});
    expect(tree.commits).toBeUndefined();
    expect(tree.age).toBeUndefined();
    const list = await run(plain, 'files.list');
    expect(list.fields?.map(field => field.key)).toEqual(['path', 'lang', 'loc', 'bytes', 'complexity']);
    expect((list.data as Array<Record<string, unknown>>)[0]).toEqual({path: 'src/auth/service.ts', lang: 'TypeScript', loc: 53, bytes: 1432, complexity: 28});
    const kpis = await run(plain, 'repo.kpis');
    expect((kpis.data as Array<{label: string}>).map(stat => stat.label)).toEqual(['Files', 'Lines', 'Languages', 'Modules', 'Cycles']);
    expect(kpis.warnings).toEqual(['no git history: commit and contributor counts are omitted']);
  });
});

describe('a project that is a subdirectory of a repository', () => {
  it('lists, counts commits and searches relative to the project root', async () => {
    const sub = makeContext(join(repo.root, 'src'));
    const tree = (await run(sub, 'files.tree')).data as DirNode;
    expect(tree).toMatchObject({path: '', files: 18, commits: 10});
    expect(tree.children?.map(child => child.path)).toEqual(['auth', 'lib', 'orders', 'api', 'ui', 'index.ts']);
    const rows = (await run(sub, 'files.list auth')).data as Array<{path: string; commits: number}>;
    expect(rows.map(row => `${row.path} ${row.commits}`)).toEqual(['auth/service.ts 4', 'auth/session.ts 4', 'auth/tokens.ts 2']);
    expect((await run(sub, 'code.refs login')).data).toHaveLength(4);
    expect((await run(sub, 'deps.cycles')).data).toEqual([{id: 1, size: 2, members: 'auth/service.ts, orders/service.ts'}]);
    const kpis = (await run(sub, 'repo.kpis')).data as Array<{label: string; value: number}>;
    expect(kpis.find(stat => stat.label === 'Contributors')?.value).toBe(2);
  });
});

describe('an empty directory and a repository without commits', () => {
  let empty: string;
  beforeAll(async () => {
    empty = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-empty-')));
  });
  afterAll(async () => { await rm(empty, {recursive: true, force: true}); });

  it('every source answers with nothing, or says what is missing', async () => {
    const none = makeContext(empty, {git: false});
    expect((await run(none, 'files.tree')).data).toEqual({name: '', path: '', dir: true, files: 0, loc: 0, bytes: 0, complexity: 0});
    for (const name of ['files.list', 'files.langs', 'repo.stack', 'repo.packages', 'repo.scripts', 'deps.cycles', 'deps.external', 'deps.matrix', 'code.todos']) {
      const result = await run(none, name);
      expect(result.data, name).toEqual([]);
      checkResult(name, result);
    }
    expect((await run(none, 'deps.modules')).data).toEqual({nodes: [], edges: [], level: 'file'});
    expect((await run(none, 'repo.kpis')).data).toEqual([
      {label: 'Files', value: 0}, {label: 'Lines', value: 0, format: 'compact'}, {label: 'Languages', value: 0}, {label: 'Modules', value: 0}, {label: 'Cycles', value: 0},
    ]);
    expect(await failure(none, 'code.refs anything')).toMatchObject({code: 'E_TARGET'});
    expect(await failure(none, 'code.symbols a.ts')).toMatchObject({code: 'E_TARGET'});
  });

  it('a repository with files but no commit yet has no history, and still an inventory', async () => {
    await git(empty, ['init', '-q', '-b', 'main']);
    await mkdir(join(empty, 'src'));
    await writeFile(join(empty, 'src/a.ts'), 'export const a = 1;\n');
    const fresh = makeContext(empty);
    const tree = (await run(fresh, 'files.tree')).data as DirNode;
    expect(tree).toMatchObject({files: 1, loc: 1});
    expect(tree.commits).toBeUndefined();
    expect((await run(fresh, 'repo.kpis')).warnings).toEqual(['no git history: commit and contributor counts are omitted']);
    expect((await run(fresh, 'code.refs a')).data).toEqual([{file: 'src/a.ts#L1', text: 'export const a = 1;'}]);
    expect(((await run(fresh, 'deps.modules')).data as GraphData).nodes.map(node => node.id)).toEqual(['src/a.ts']);
  });
});

describe('summary helpers', () => {
  it('compact rounds to three significant figures', () => {
    expect([0, 999, 1000, 1234, 48_200, 999_949, 999_950, 1_115_681, 23_400_000].map(compact)).toEqual(['0', '999', '1k', '1.2k', '48.2k', '1000k', '1M', '1.1M', '23.4M']);
  });

  it('clampSummary flattens whitespace and cuts on a word', () => {
    expect(clampSummary('a\n  b\tc')).toBe('a b c');
    const long = clampSummary(`12 rows; fields a b c; ${'word '.repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('word…')).toBe(true);
    expect(clampSummary('x'.repeat(400))).toHaveLength(160);
  });
});
