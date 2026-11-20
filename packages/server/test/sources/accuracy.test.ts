// Numbers that must agree: every source is run on the real index and the real history, and what one source says is
// checked against another source and against git itself. These are the regressions of the accuracy review: two log
// parsers that disagreed, a stacked chart twice too tall, a KPI that was a display cap, importers that were not found.
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {devNull, tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {parseRef, type ChurnRow, type CommitRow, type DirNode, type GraphData, type Rows, type StatItem} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createRepoIndex} from '../../src/analyze/index.ts';
import type {RepoContext, Source, SourceResult} from '../../src/contracts.ts';
import {readGitInfo} from '../../src/git/index.ts';
import {LIMIT_WARNING, LOG_LIMIT, SHALLOW_WARNING} from '../../src/git/log.ts';
import {createFilesSources} from '../../src/sources/files/index.ts';
import {createDiffSources} from '../../src/sources/git/diff.ts';
import {createGitSources} from '../../src/sources/git/git.ts';
import {createRunGit, FIXTURE, git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const SOURCES: ReadonlyMap<string, Source> = new Map(
  [...createFilesSources({now: () => NOW}), ...createGitSources({now: () => NOW}), ...createDiffSources()].map(source => [source.meta.name, source]),
);
const never = new AbortController().signal;

/** A context as the server builds it: the real index, git information read from the repository. */
async function context(root: string): Promise<RepoContext> {
  const runGit = createRunGit(root);
  return {root, name: basename(root), git: await readGitInfo(root, runGit), runGit, index: createRepoIndex(root, runGit, () => {}), rev: () => 1, log: () => {}};
}
function run<T = Rows>(ctx: RepoContext, text: string): Promise<SourceResult<T>> {
  const ref = parseRef(text);
  return SOURCES.get(ref.source)!.run(ctx, ref, never) as Promise<SourceResult<T>>;
}
const stat = (result: SourceResult<StatItem[]>, label: string): StatItem['value'] | undefined => result.data.find(item => item.label === label)?.value;

const address = (name: string): string => [name.toLowerCase().replace(/\s+/g, '.'), ['example', 'test'].join('.')].join('@');
const as = (name: string, date: string): Record<string, string> => ({
  GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: address(name), GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: address(name), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
});
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), text);
  }
}
async function commit(root: string, author: string, date: string, subject: string, files: Record<string, string> = {}): Promise<void> {
  await write(root, files);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', subject], as(author, date));
}
async function scratchRepo(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `glimpse-${prefix}-`)));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

/** Every number about history that two sources both state must be the same number. */
async function expectOneHistory(ctx: RepoContext, truth: {commits: number; authors: number}): Promise<void> {
  const [kpis, authors, log, tree, list, churn] = await Promise.all([
    run<StatItem[]>(ctx, 'repo.kpis'), run(ctx, 'git.authors'), run<CommitRow[]>(ctx, 'git.log'), run<DirNode>(ctx, 'files.tree'), run(ctx, 'files.list'), run<ChurnRow[]>(ctx, 'git.churn'),
  ]);
  expect(stat(kpis, 'Contributors'), 'repo.kpis Contributors is the number of git.authors rows').toBe(authors.total);
  expect(authors.total).toBe(truth.authors);
  expect((authors.data as Array<{commits: number}>).reduce((sum, row) => sum + row.commits, 0), 'the authors account for every commit').toBe(truth.commits);
  expect(log.total, 'git.log lists every commit').toBe(truth.commits);
  expect(tree.data.commits, 'the root of files.tree is touched by every commit').toBe(truth.commits);
  const churned = new Map((churn.allRows as unknown as ChurnRow[]).map(row => [row.path, row.commits]));
  const listed = (list.allRows as Array<{path: string; commits: number}>).filter(row => churned.has(row.path));
  expect(listed.length).toBe(churned.size);
  for (const row of listed) expect(row.commits, `${row.path}: files.list and git.churn count the same commits`).toBe(churned.get(row.path));
}

describe('one parsed history for files.*, repo.kpis and git.*', () => {
  let repo: FixtureRepo;
  let merged: string;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    // A history git simplifies when it is asked with a pathspec: the side branch and main add the same file, so the
    // merge equals its first parent and `git log -- .` follows only that parent, losing the side commit and its author.
    merged = await scratchRepo('merged');
    await commit(merged, 'Ana Lima', '2026-10-01T10:00:00Z', 'base', {'app/a.ts': 'export const a = 1;\n', 'lib/b.ts': 'export const b = 1;\n'});
    await git(merged, ['checkout', '-q', '-b', 'side']);
    await commit(merged, 'Ben Okoye', '2026-10-02T10:00:00Z', 'side adds shared', {'app/shared.ts': 'export const shared = 1;\n'});
    await git(merged, ['checkout', '-q', 'main']);
    await commit(merged, 'Cy Tran', '2026-10-03T10:00:00Z', 'main adds shared too', {'app/shared.ts': 'export const shared = 1;\n'});
    await git(merged, ['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'Merge side', 'side'], as('Ana Lima', '2026-10-04T10:00:00Z'));
  });
  afterAll(async () => {
    await repo.cleanup();
    await rm(merged, {recursive: true, force: true});
  });

  it('agrees with itself and with git on the fixture repository', async () => {
    await expectOneHistory(await context(repo.root), {commits: FIXTURE.commits.main, authors: 3});
  });

  it('counts the commits git drops when it simplifies history for a pathspec', async () => {
    // the trap: the same question, with and without a pathspec, has two answers
    expect(await git(merged, ['rev-list', '--count', '--no-merges', 'HEAD'])).toBe('3');
    expect(await git(merged, ['rev-list', '--count', '--no-merges', 'HEAD', '--', '.'])).toBe('2');
    const ctx = await context(merged);
    await expectOneHistory(ctx, {commits: 3, authors: 3});
    const kpis = await run<StatItem[]>(ctx, 'repo.kpis');
    expect(stat(kpis, 'Contributors')).toBe(3);
    expect((await run(ctx, 'git.authors')).data.map(row => row.author).sort()).toEqual(['Ana Lima', 'Ben Okoye', 'Cy Tran']);
    // both commits that added the file count for it, in the list and in the churn alike
    expect((await run(ctx, 'files.list app')).data.find(row => row.path === 'app/shared.ts')).toMatchObject({commits: 2});
    expect((await run<ChurnRow[]>(ctx, 'git.churn app')).data.find(row => row.path === 'app/shared.ts')).toMatchObject({commits: 2, authors: 2});
  });

  it('keeps every commit of the project when its root is a directory inside the repository', async () => {
    // here a pathspec is needed, and history must not be simplified because of it
    const ctx = await context(join(merged, 'app'));
    await expectOneHistory(ctx, {commits: 3, authors: 3});
    expect((await run<CommitRow[]>(ctx, 'git.log')).data.map(row => row.subject)).toEqual(['main adds shared too', 'side adds shared', 'base']);
    expect((await run(ctx, 'files.list')).data.map(row => `${String(row.path)} ${String(row.commits)}`).sort()).toEqual(['a.ts 1', 'shared.ts 2']);
    // a range is counted by the same rule as the log that lists it
    const range = await git(merged, ['rev-list', '--max-parents=0', 'HEAD']);
    const stats = await run<StatItem[]>(ctx, `diff.stats ${range}..HEAD`);
    expect(stat(stats, 'Commits')).toBe((await run<CommitRow[]>(ctx, `git.log ${range}..HEAD`)).total);
    expect(stat(stats, 'Commits')).toBe(2);
  });
});

describe('a history longer than the parsed window', () => {
  const EXTRA = 150;
  const TOTAL = LOG_LIMIT + EXTRA;
  let root: string;
  let ctx: RepoContext;
  beforeAll(async () => {
    root = await scratchRepo('long');
    // The oldest commits are by an author who wrote nothing since, in a directory nobody touched since: exactly what
    // a window of the latest commits cannot see.
    const lines: string[] = [];
    const start = Date.parse('2026-01-01T00:00:00Z') / 1000;
    for (let n = 1; n <= TOTAL; n++) {
      const old = n <= EXTRA;
      const author = old ? 'Old Hand' : ['Ana Lima', 'Ben Okoye', 'Cy Tran'][n % 3]!;
      const who = `${author} <${address(author)}> ${start + n * 600} +0000`;
      const message = `commit ${n}`;
      const path = old ? `old/o${n % 10}.ts` : `src/s${n % 20}.ts`;
      const content = `export const v = ${n};\n`;
      lines.push('commit refs/heads/main', `mark :${n}`, `author ${who}`, `committer ${who}`, `data ${message.length}`, message);
      if (n > 1) lines.push(`from :${n - 1}`);
      lines.push(`M 100644 inline ${path}`, `data ${content.length}`, content);
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['fast-import', '--quiet'], {cwd: root, env: {PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1'}, stdio: ['pipe', 'ignore', 'pipe']});
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git fast-import failed: ${stderr}`))));
      child.stdin.end(lines.join('\n'));
    });
    await git(root, ['reset', '-q', '--hard', 'main']);
    ctx = await context(root);
  }, 120_000);
  afterAll(async () => { await rm(root, {recursive: true, force: true}); });

  it('counts commits and contributors over the whole history, in the KPIs and in git.authors alike', async () => {
    expect(await git(root, ['rev-list', '--count', '--no-merges', 'HEAD'])).toBe(String(TOTAL));
    const kpis = await run<StatItem[]>(ctx, 'repo.kpis');
    const authors = await run(ctx, 'git.authors');
    expect(stat(kpis, 'Contributors')).toBe(4);
    expect(authors.total).toBe(4);
    expect(authors.data.find(row => row.author === 'Old Hand')).toMatchObject({commits: EXTRA});
    expect((authors.data as Array<{commits: number}>).reduce((sum, row) => sum + row.commits, 0)).toBe(TOTAL);
    expect(((await run<DirNode>(ctx, 'files.tree')).data).commits).toBe(TOTAL);
    // nothing about the totals is limited, so nothing says so; the files an author touched are, and that is said
    expect(kpis.warnings).toBeUndefined();
    expect(authors.warnings).toEqual([`files counted over the latest ${LOG_LIMIT.toLocaleString('en-US')} commits`]);
    // commits per day need no file lists either
    const activity = await run<Array<{date: string; commits: number}>>(ctx, 'git.activity since=5y');
    expect(activity.data.reduce((sum, row) => sum + row.commits, 0)).toBe(TOTAL);
    expect(activity.warnings).toBeUndefined();
  });

  it('says so wherever a per-file number covers only the latest commits', async () => {
    const list = await run(ctx, 'files.list');
    const tree = await run<DirNode>(ctx, 'files.tree');
    expect(list.warnings).toEqual([LIMIT_WARNING]);
    expect(tree.warnings).toEqual([LIMIT_WARNING]);
    expect((await run<ChurnRow[]>(ctx, 'git.churn')).warnings).toEqual([LIMIT_WARNING]);
    expect((await run<CommitRow[]>(ctx, 'git.log')).warnings).toEqual([LIMIT_WARNING]);
    // inside the window the two sides still agree file by file
    const churned = new Map(((await run<ChurnRow[]>(ctx, 'git.churn')).allRows as unknown as ChurnRow[]).map(row => [row.path, row.commits]));
    for (const row of list.allRows as Array<{path: string; commits: number}>) expect(row.commits, row.path).toBe(churned.get(row.path) ?? 0);
    // a path asked for by name is read from git again, past the window
    expect((await run(ctx, 'git.authors old')).data).toEqual([{author: 'Old Hand', commits: EXTRA, files: 10, last: expect.stringMatching(/^2026-01-0\dT/)}]);
    expect((await run<CommitRow[]>(ctx, 'git.log old')).total).toBe(EXTRA);
  });
});

describe('a shallow clone', () => {
  let repo: FixtureRepo;
  let clone: string;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    clone = join(await realpath(await mkdtemp(join(tmpdir(), 'glimpse-shallow-'))), 'clone');
    await git(repo.root, ['clone', '-q', '--depth', '2', `file://${repo.root}`, clone]);
  });
  afterAll(async () => {
    await repo.cleanup();
    await rm(dirname(clone), {recursive: true, force: true});
  });

  it('does not count the commit the clone was cut at as a change to every file, and says the history is incomplete', async () => {
    const ctx = await context(clone);
    expect(ctx.git).toMatchObject({shallow: true});
    const list = await run(ctx, 'files.list');
    const rows = list.allRows as Array<{path: string; commits: number}>;
    // git shows the boundary commit as adding all 33 files of its tree; only the four files of the newest commit changed
    expect(rows.filter(row => row.commits > 0).map(row => row.path).sort()).toEqual(['src/auth/service.ts', 'src/auth/session.ts', 'test/auth.test.ts', 'test/orders.test.ts']);
    expect(rows.filter(row => row.commits > 0).map(row => row.path).sort()).toEqual((await run<ChurnRow[]>(ctx, 'git.churn')).data.map(row => row.path).sort());
    expect(list.warnings).toEqual([SHALLOW_WARNING]);
    expect((await run<DirNode>(ctx, 'files.tree')).warnings).toEqual([SHALLOW_WARNING]);
    expect((await run<StatItem[]>(ctx, 'repo.kpis')).warnings).toEqual([SHALLOW_WARNING]);
    await expectOneHistory(ctx, {commits: 2, authors: 2});
  });
});

describe('git.timeline on real history', () => {
  let root: string;
  beforeAll(async () => {
    root = await scratchRepo('timeline');
    await commit(root, 'Ana Lima', '2026-10-05T10:00:00Z', 'start', {
      'README.md': '# demo\n', 'src/core/a.ts': 'export const a = 1;\n', 'src/core/b.ts': 'export const b = 1;\n', 'legacy/old1.ts': 'export const o = 1;\n', 'legacy/old2.ts': 'export const p = 1;\n',
    });
    await commit(root, 'Ben Okoye', '2026-10-06T10:00:00Z', 'touch legacy', {'legacy/old1.ts': 'export const o = 2;\n', 'legacy/old2.ts': 'export const p = 2;\n', 'README.md': '# demo\n\nmore\n'});
    await git(root, ['rm', '-q', '-r', 'legacy']);
    await commit(root, 'Ana Lima', '2026-10-13T10:00:00Z', 'drop legacy');
    await commit(root, 'Cy Tran', '2026-10-14T10:00:00Z', 'readme', {'README.md': '# demo\n\nmore still\n'});
    await commit(root, 'Ana Lima', '2026-10-20T10:00:00Z', 'code and readme', {'src/core/a.ts': 'export const a = 2;\n', 'README.md': '# demo\n\ndone\n'});
    await commit(root, 'Ana Lima', '2026-10-21T10:00:00Z', 'nothing at all');
  });
  afterAll(async () => { await rm(root, {recursive: true, force: true}); });

  it('adds up to the commits of each week, and names what the catch-all used to swallow', async () => {
    const ctx = await context(root);
    const result = await run<Array<{week: string; module: string; commits: number}>>(ctx, 'git.timeline');
    const totals: Record<string, number> = {};
    for (const row of result.data) totals[row.module] = (totals[row.module] ?? 0) + row.commits;
    // paths whose directory is gone are '(removed)', files at the top are '(root)', a tie goes to the real module
    expect(totals).toEqual({'src/core': 2, '(removed)': 2, '(root)': 1});
    const perWeek: Record<string, number> = {};
    for (const row of result.data) perWeek[row.week] = (perWeek[row.week] ?? 0) + row.commits;
    // five commits changed files (the sixth is empty and belongs to no module): never more than the week really had
    expect(perWeek).toEqual({'2026-10-05': 2, '2026-10-12': 2, '2026-10-19': 1});
    expect(result.summary).toContain('5 commits since');
    expect(result.summary).toContain('each under its main module');
    expect((await run<Array<{commits: number}>>(ctx, 'git.activity')).data.reduce((sum, row) => sum + row.commits, 0)).toBe(6);
  });
});

describe('git.coupling', () => {
  let root: string;
  beforeAll(async () => {
    root = await scratchRepo('coupling');
    const sweep: Record<string, string> = {'a.ts': 'export const a = 0;\n', 'b.ts': 'export const b = 0;\n'};
    for (let n = 0; n < 31; n++) sweep[`gen/f${n}.ts`] = `export const f${n} = 0;\n`;
    await commit(root, 'Ana Lima', '2026-10-01T10:00:00Z', 'import everything', sweep);
    for (let n = 1; n <= 3; n++) await commit(root, 'Ana Lima', `2026-10-0${n + 1}T10:00:00Z`, `pair ${n}`, {'a.ts': `export const a = ${n};\n`, 'b.ts': `export const b = ${n};\n`});
  });
  afterAll(async () => { await rm(root, {recursive: true, force: true}); });

  it('divides by the commits it counted: a sweeping commit is left out of both sides of the degree, and that is said', async () => {
    const result = await run(await context(root), 'git.coupling');
    // a.ts and b.ts changed together in all three commits that count; the 33-file import is no evidence either way
    expect(result.data).toEqual([{a: 'a.ts', b: 'b.ts', shared: 3, degree: 100}]);
    expect(result.summary).toBe('1 row; fields a b shared degree; 1 commit over 30 files ignored; strongest a.ts + b.ts 3 commits');
    expect(result.warnings).toBeUndefined();
  });
});

describe('the import graph', () => {
  const SWIFT_PACKAGE = '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Kit", targets: [.target(name: "Core"), .target(name: "App", dependencies: ["Core"])])\n';
  let swift: string;
  let lazy: string;
  beforeAll(async () => {
    // A Swift module keeps its files in nested folders, and `import Core` names all of them at once.
    swift = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-swift-')));
    await write(swift, {
      'Package.swift': SWIFT_PACKAGE,
      'Sources/Core/Models/Node.swift': 'import Foundation\n\npublic struct Node {\n  public let id: String\n}\n',
      'Sources/Core/Processing/Resolver.swift': 'import Foundation\n\npublic struct Resolver {\n  public func resolve(_ node: Node) -> Node { node }\n}\n',
      'Sources/App/Views/NodeView.swift': 'import Core\n\nstruct NodeView {\n  let node: Node\n}\n',
      'Sources/App/Main.swift': 'import Core\n\nlet resolver = Resolver()\n',
      'Tests/CoreTests/NodeTests.swift': 'import XCTest\nimport Core\n\nfinal class NodeTests: XCTestCase {}\n',
    });
    // Code split on purpose: the loop a -> b -> a closes only through a lazy import().
    lazy = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-lazy-')));
    await write(lazy, {
      'package.json': '{"name": "lazy", "version": "1.0.0"}\n',
      'src/view.ts': "import {format} from './format.ts';\nexport const view = () => format('x');\n",
      'src/format.ts': "export const format = (text: string) => text.trim();\nexport const open = () => import('./view.ts');\n",
      'src/tight/a.ts': "import {b} from './b.ts';\nexport const a = () => b();\n",
      'src/tight/b.ts': "import {a} from './a.ts';\nexport const b = (): unknown => a;\n",
    });
  });
  afterAll(async () => {
    await rm(swift, {recursive: true, force: true});
    await rm(lazy, {recursive: true, force: true});
  });

  it('deps.files finds the importers of a file that is imported through its module, wherever it sits in the module', async () => {
    const ctx = await context(swift);
    const result = await run<GraphData>(ctx, 'deps.files Sources/Core/Models/Node.swift');
    const importers = result.data.edges.filter(edge => edge.to === 'Sources/Core/Models/Node.swift').map(edge => edge.from).sort();
    expect(importers).toEqual(['Sources/App/Main.swift', 'Sources/App/Views/NodeView.swift', 'Tests/CoreTests/NodeTests.swift']);
    expect(result.summary).toContain('Node.swift imports 0, imported by 3');
    // the importers name the module, not the file, and the reader is told
    expect(result.warnings).toContain('3 of 3 importers import the whole package or module Node.swift belongs to, not this file by name');
    // the same importers the blast radius of a change to the file is built from
    const edges = (await ctx.index.edges()).filter(edge => edge.to === 'Sources/Core/Models/Node.swift');
    expect(edges.map(edge => edge.from).sort()).toEqual(importers);
    expect(new Set(edges.map(edge => edge.kind))).toEqual(new Set(['module']));
  });

  it('does not call a loop that closes through a lazy import() a cycle, in the KPI, the list or the graph', async () => {
    const ctx = await context(lazy);
    const cycles = await run(ctx, 'deps.cycles');
    expect(cycles.data).toEqual([{id: 1, size: 2, members: 'src/tight/a.ts, src/tight/b.ts'}]);
    const kpis = await run<StatItem[]>(ctx, 'repo.kpis');
    expect(stat(kpis, 'Cycles')).toBe(1);
    expect(kpis.summary).toContain('File cycles 1');
    const graph = (await run<GraphData>(ctx, 'deps.modules')).data;
    expect(graph.nodes.filter(node => node.cycle).map(node => node.id).sort()).toEqual(['src/tight/a.ts', 'src/tight/b.ts']);
    // the lazy edge is still drawn: it is an import, just not one that can deadlock a load
    expect(graph.edges.find(edge => edge.from === 'src/format.ts' && edge.to === 'src/view.ts')).toEqual({from: 'src/format.ts', to: 'src/view.ts'});
    expect(graph.edges.find(edge => edge.from === 'src/tight/a.ts' && edge.to === 'src/tight/b.ts')).toMatchObject({cycle: true});
  });
});

describe('sources follow the working tree, committed or not', () => {
  let repo: FixtureRepo;
  beforeAll(async () => { repo = await makeFixtureRepo({dirty: false}); });
  afterAll(async () => { await repo.cleanup(); });

  it('deps.*, repo.* and code.* answer for the edited files once the index is invalidated, with nothing committed', async () => {
    const ctx = await context(repo.root);
    const before = {
      external: (await run(ctx, 'deps.external')).data.map(row => row.package),
      packages: (await run(ctx, 'repo.packages')).data.find(row => row.name === 'shop'),
      files: (await run<GraphData>(ctx, 'deps.files src/lib/cache.ts')).summary,
      scripts: (await run(ctx, 'repo.scripts')).total,
      cycles: (await run(ctx, 'deps.cycles')).total,
      kpiFiles: stat(await run<StatItem[]>(ctx, 'repo.kpis'), 'Files'),
    };
    expect(before.external).not.toContain('lodash');
    await write(repo.root, {
      'src/lib/cache.ts': "import {merge} from 'lodash';\nimport {log} from './logger';\nimport {config} from './config';\nexport const cache = merge({}, {log, config});\n",
      'src/lib/config.ts': "import {cache} from './cache';\nexport const config = {cache: () => cache};\n",
      'src/lib/brand-new.ts': "import {cache} from './cache';\nexport const fresh = cache;\n",
      'package.json': JSON.stringify({name: 'shop', version: '0.3.0', scripts: {dev: 'node src/index.ts', lint: 'biome check'}, dependencies: {pg: '^8.13.0', lodash: '^4.17.0'}}, null, 2),
    });
    // what the session does when the working tree changed
    ctx.index.invalidate();
    expect((await run(ctx, 'deps.external')).data.map(row => row.package)).toContain('lodash');
    expect((await run(ctx, 'repo.packages')).data.find(row => row.name === 'shop')).not.toEqual(before.packages);
    expect((await run(ctx, 'repo.packages')).data.find(row => row.name === 'shop')).toMatchObject({deps: 2});
    expect((await run(ctx, 'repo.scripts')).data.map(row => row.script)).toContain('lint');
    const files = await run<GraphData>(ctx, 'deps.files src/lib/cache.ts');
    expect(files.summary).not.toBe(before.files);
    expect(files.data.edges.some(edge => edge.from === 'src/lib/brand-new.ts' && edge.to === 'src/lib/cache.ts')).toBe(true);
    expect((await run(ctx, 'deps.cycles')).total).toBe((before.cycles ?? 0) + 1);
    expect(stat(await run<StatItem[]>(ctx, 'repo.kpis'), 'Files')).toBe(Number(before.kpiFiles) + 1);
    expect((await run(ctx, 'code.symbols src/lib/brand-new.ts')).data).toEqual([{name: 'fresh', kind: 'const', line: 2, depth: 0, exported: true}]);
    expect(((await run<GraphData>(ctx, 'deps.modules src/lib')).data).nodes.some(node => node.id === 'src/lib/brand-new.ts')).toBe(true);
    await git(repo.root, ['status', '--porcelain']).then(status => expect(status).toContain('brand-new.ts'));
  });
});

describe('diff.impact', () => {
  let repo: FixtureRepo;
  beforeAll(async () => { repo = await makeFixtureRepo({dirty: false}); });
  afterAll(async () => { await repo.cleanup(); });

  it('shows the importers a deletion or a rename breaks: imports of a path that is gone', async () => {
    // src/auth/tokens.ts is imported by service.ts and session.ts; src/lib/config.ts by several files
    await git(repo.root, ['rm', '-q', 'src/auth/tokens.ts']);
    await git(repo.root, ['mv', 'src/lib/config.ts', 'src/lib/settings.ts']);
    const ctx = await context(repo.root);
    const result = await run<GraphData>(ctx, 'diff.impact');
    const graph = result.data;
    expect(graph.nodes.find(node => node.id === 'src/auth/tokens.ts')).toMatchObject({status: 'deleted'});
    const breaks = (target: string) => graph.edges.filter(edge => edge.to === target).map(edge => edge.from).sort();
    // the working-tree index alone has no edge to either path: these importers used to be missing altogether
    const current = await ctx.index.edges();
    expect(current.some(edge => edge.to === 'src/auth/tokens.ts' || edge.to === 'src/lib/config.ts' || edge.to === 'src/lib/settings.ts')).toBe(false);
    expect(breaks('src/auth/tokens.ts')).toEqual(['src/auth/service.ts', 'src/auth/session.ts']);
    expect(breaks('src/lib/settings.ts').length).toBeGreaterThanOrEqual(2);
    expect(breaks('src/lib/settings.ts')).toContain('src/lib/db.ts');
    for (const importer of [...breaks('src/auth/tokens.ts'), ...breaks('src/lib/settings.ts')]) {
      expect(graph.nodes.find(node => node.id === importer), importer).toMatchObject({status: 'affected'});
    }
    const broken = new Set([...breaks('src/auth/tokens.ts'), ...breaks('src/lib/settings.ts')]).size;
    expect(result.warnings).toContain(`${broken} importers still import a file this change deletes or renames`);
    expect(result.summary).toContain(`2 changed, ${broken} affected importers`);
  });
});
