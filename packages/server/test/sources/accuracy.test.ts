// Numbers that must agree: every source is run on the real index and the real history, and what one source says is
// checked against another source and against git itself. These are the regressions of the accuracy review: two log
// parsers that disagreed, a stacked chart twice too tall, a KPI that was a display cap, importers that were not found.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
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

  it('a path spelled in another case reads the file under the name it has on disk (V071)', async () => {
    const ctx = await context(repo.root);
    // macOS and Windows file systems usually ignore case, Linux ones do not: there the variant names nothing
    const insensitive = existsSync(join(repo.root, 'readme.md'));
    const pairs: Array<[string, string]> = [
      ['code.symbols readme.md', 'code.symbols README.md'],
      ['git.log readme.md top=10', 'git.log README.md top=10'],
      ['git.authors Readme.MD', 'git.authors README.md'],
      ['git.churn SRC/Auth', 'git.churn src/auth'],
      ['files.list SRC/AUTH', 'files.list src/auth'],
      ['code.todos Src', 'code.todos src'],
      ['deps.files SRC/auth/Service.ts', 'deps.files src/auth/service.ts'],
      ['code.symbols src/auth/SERVICE.ts#L3', 'code.symbols src/auth/service.ts'],
    ];
    for (const [variant, named] of pairs) {
      const truth = await run(ctx, named);
      expect(truth.data, named).not.toEqual([]);
      if (!insensitive) {
        await expect(run(ctx, variant), variant).rejects.toMatchObject({code: 'E_TARGET'});
        continue;
      }
      const asked = await run(ctx, variant);
      expect(asked.data, variant).toEqual(truth.data);
      expect(asked.total, variant).toBe(truth.total);
      // and the summary names the file as the repository does
      expect(asked.summary, variant).toBe(truth.summary);
    }
    // a case variant of a skipped tree is still nothing of the project
    for (const variant of ['code.symbols .GIT/config', 'code.symbols NODE_MODULES/x/index.js']) {
      await expect(run(ctx, variant), variant).rejects.toMatchObject({code: 'E_TARGET'});
    }
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
  const RENAMED_COMMITS = 40;
  /** Commits of a different file that takes the old name mid/before.ts after the rename. */
  const REUSED_COMMITS = 7;
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
      // Inside the window: RENAMED_COMMITS commits of mid/before.ts, then its rename to keep/after.ts, then a different
      // file that reuses the name mid/before.ts (V067).
      const renamed = n > EXTRA && n <= EXTRA + RENAMED_COMMITS;
      const reused = n > EXTRA + RENAMED_COMMITS + 1 && n <= EXTRA + RENAMED_COMMITS + 1 + REUSED_COMMITS;
      const path = old ? `old/o${n % 10}.ts` : renamed || reused ? 'mid/before.ts' : `src/s${n % 20}.ts`;
      const content = reused ? `// another file under the old name\nexport const reused = '${'z'.repeat(60)}${n}';\n` : `export const v = ${n};\n`;
      lines.push('commit refs/heads/main', `mark :${n}`, `author ${who}`, `committer ${who}`, `data ${message.length}`, message);
      if (n > 1) lines.push(`from :${n - 1}`);
      if (n === EXTRA + RENAMED_COMMITS + 1) lines.push('R mid/before.ts keep/after.ts');
      else lines.push(`M 100644 inline ${path}`, `data ${content.length}`, content);
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

  it('a path asked for by name keeps the commits from before its rename (V067)', async () => {
    // every commit of the file lies inside the window: the whole-repository numbers count them under its new name
    const commits = RENAMED_COMMITS + 1;
    const listed = (await run(ctx, 'files.list keep')).allRows as Array<{path: string; commits: number}>;
    expect(listed.find(row => row.path === 'keep/after.ts')?.commits).toBe(commits);
    const churnAll = (await run<ChurnRow[]>(ctx, 'git.churn')).allRows as unknown as ChurnRow[];
    expect(churnAll.find(row => row.path === 'keep/after.ts')?.commits).toBe(commits);
    // and so do the sources scoped to the file, read from git again past the window
    for (const target of ['keep/after.ts', 'keep']) {
      expect((await run<CommitRow[]>(ctx, `git.log ${target}`)).total, `git.log ${target}`).toBe(commits);
      expect(((await run<ChurnRow[]>(ctx, `git.churn ${target}`)).data).find(row => row.path === 'keep/after.ts')?.commits, `git.churn ${target}`).toBe(commits);
      const authors = (await run(ctx, `git.authors ${target}`)).data as Array<{author: string; commits: number}>;
      expect(authors.reduce((sum, row) => sum + row.commits, 0), `git.authors ${target}`).toBe(commits);
      expect(authors.map(row => row.author).sort()).toEqual(['Ana Lima', 'Ben Okoye', 'Cy Tran']);
    }
  });

  it('a renamed file does not take the commits of a later file that reuses its old name (V067)', async () => {
    // the scoped read names mid/before.ts too, and that name now belongs to another file: its commits are not ours
    const commits = RENAMED_COMMITS + 1;
    for (const target of ['keep/after.ts', 'keep']) {
      const log = await run<CommitRow[]>(ctx, `git.log ${target} top=${commits + REUSED_COMMITS + 5}`);
      expect(log.total, `git.log ${target}`).toBe(commits);
      expect(log.data.map(row => row.subject), `git.log ${target}`).not.toContain(`commit ${EXTRA + RENAMED_COMMITS + 2}`);
      const authors = (await run(ctx, `git.authors ${target}`)).data as Array<{commits: number}>;
      expect(authors.reduce((sum, row) => sum + row.commits, 0), `git.authors ${target}`).toBe(commits);
    }
    // the file that has the name today has only its own commits, by every source alike
    expect((await run(ctx, 'files.list mid')).data.find(row => row.path === 'mid/before.ts')?.commits).toBe(REUSED_COMMITS);
    expect((await run<CommitRow[]>(ctx, 'git.log mid/before.ts')).total).toBe(REUSED_COMMITS);
    expect(((await run<ChurnRow[]>(ctx, 'git.churn mid/before.ts')).data).find(row => row.path === 'mid/before.ts')?.commits).toBe(REUSED_COMMITS);
    const authors = (await run(ctx, 'git.authors mid/before.ts')).data as Array<{commits: number}>;
    expect(authors.reduce((sum, row) => sum + row.commits, 0)).toBe(REUSED_COMMITS);
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

  it('draws no rise of commits that is only the depth of the clone, and marks the counts as lower bounds (V033)', async () => {
    const kpis = await run<StatItem[]>(await context(clone), 'repo.kpis');
    const commits = kpis.data.find(item => item.label === 'Commits (30d)');
    expect(commits?.delta).toBeUndefined();
    expect(commits?.unit).toBe('or more');
    expect(kpis.data.find(item => item.label === 'Contributors')?.unit).toBe('or more');
    expect(kpis.summary).toMatch(/Contributors \d+ or more/);
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
    // and the empty commit is a commit too, in a series of its own, so the weeks add up to git.activity (V030)
    expect(totals).toEqual({'src/core': 2, '(removed)': 2, '(root)': 1, '(no files)': 1});
    const perWeek: Record<string, number> = {};
    for (const row of result.data) perWeek[row.week] = (perWeek[row.week] ?? 0) + row.commits;
    // never more than the week really had, and never less
    expect(perWeek).toEqual({'2026-10-05': 2, '2026-10-12': 2, '2026-10-19': 2});
    expect(result.summary).toContain('6 commits since');
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

  it('deps.files counts every importer before the node budget cuts the graph, and says the graph is cut (V024)', async () => {
    const many = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-importers-')));
    try {
      const files: Record<string, string> = {'Package.swift': SWIFT_PACKAGE, 'Sources/Core/Models/Node.swift': 'public struct Node {}\n'};
      for (let i = 0; i < 200; i++) files[`Sources/App${String(i % 4)}/File${String(i).padStart(3, '0')}.swift`] = 'import Core\n';
      await write(many, files);
      const ctx = await context(many);
      const result = await run<GraphData>(ctx, 'deps.files Sources/Core/Models/Node.swift');
      const drawn = result.data.edges.filter(edge => edge.to === 'Sources/Core/Models/Node.swift').length;
      expect(drawn).toBeLessThan(200);
      // the file's numbers, not the cut graph's: the same importers RepoIndex.edges (and so diff.impact) counts
      const truth = new Set((await ctx.index.edges()).filter(edge => edge.to === 'Sources/Core/Models/Node.swift').map(edge => edge.from));
      expect(truth.size).toBe(200);
      expect(result.summary).toContain(`imported by 200 (${drawn} drawn)`);
      expect(result.truncated).toEqual({total: 201, returned: result.data.nodes.length, strategy: 'neighborhood', by: 'Sources/Core/Models/Node.swift'});
      expect(result.warnings).toContain(`graph cut to ${result.data.nodes.length} of 201 nodes, importers by name first`);
      expect(result.warnings).toContain('200 of 200 importers import the whole package or module Node.swift belongs to, not this file by name');
    } finally {
      await rm(many, {recursive: true, force: true});
    }
  });

  it('does not call a loop that closes through a lazy import() a cycle, in the KPI, the list or the graph', async () => {
    const ctx = await context(lazy);
    const cycles = await run(ctx, 'deps.cycles');
    expect(cycles.data).toEqual([{id: 1, size: 2, members: 'src/tight/a.ts, src/tight/b.ts'}]);
    const kpis = await run<StatItem[]>(ctx, 'repo.kpis');
    expect(stat(kpis, 'File cycles')).toBe(1);
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

describe('history counted the same way in every git.* source', () => {
  let root: string;
  beforeAll(async () => {
    root = await scratchRepo('counted');
    const ts = (n: number) => `export function f${n}() {\n  if (${n}) {\n    return ${n};\n  }\n}\n`;
    await commit(root, 'Ana Lima', '2026-10-01T10:00:00Z', 'start', {
      'packages/a/package.json': '{"name": "a"}\n', 'packages/b/package.json': '{"name": "b"}\n', 'packages/server/package.json': '{"name": "server"}\n',
      'packages/a/src/x.ts': ts(1), 'packages/a/src/y.ts': ts(2), 'packages/b/src/z.ts': ts(3),
      'README.md': '# Shop\n\n## Usage\n\nRun it.\n', 'CHANGELOG.md': '# Changes\n\n## 1.0\n', 'ci.yaml': '# CI\non: push\n',
      'packages/server/src/spec/guard.ts': ts(4), 'packages/server/test/guard.test.ts': "import '../src/spec/guard.ts';\n",
    });
    await git(root, ['commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'empty'], as('Ben Okoye', '2026-10-02T10:00:00Z'));
    for (let n = 0; n < 4; n++) {
      await commit(root, 'Ben Okoye', `2026-10-0${3 + n}T10:00:00Z`, `edit ${n}`, {
        'README.md': `# Shop\n\n## Usage\n\nRun it ${n}.\n`, 'CHANGELOG.md': `# Changes\n\n## 1.${n}\n`, 'ci.yaml': `# CI ${n}\non: push\n`, 'packages/a/src/x.ts': ts(10 + n),
      });
    }
    await commit(root, 'Cy Tran', '2026-10-08T10:00:00Z', 'b', {'packages/b/src/z.ts': ts(20)});
    // a tracked symbolic link: a path of git, not a file of the inventory
    await git(root, ['config', 'core.symlinks', 'true']);
    const {symlink} = await import('node:fs/promises');
    await symlink('packages/a', join(root, 'link'));
    await commit(root, 'Cy Tran', '2026-10-09T10:00:00Z', 'link');
  });
  afterAll(async () => {
    await rm(root, {recursive: true, force: true});
  });

  it('git.timeline counts a commit that changes no file, so its weeks add up to git.activity (V030)', async () => {
    const ctx = await context(root);
    const [timeline, activity] = await Promise.all([run<Array<{module: string; commits: number}>>(ctx, 'git.timeline since=5y'), run<Array<{commits: number}>>(ctx, 'git.activity since=5y')]);
    const total = (rows: Array<{commits: number}>) => rows.reduce((sum, row) => sum + row.commits, 0);
    expect(total(activity.data)).toBe(8);
    expect(total(timeline.data)).toBe(8);
    expect(timeline.data.filter(row => row.module === '(no files)').reduce((sum, row) => sum + row.commits, 0)).toBe(1);
  });

  it('git.churn and git.hotspots count files of the inventory, and hotspots rank code only (V031, V072)', async () => {
    const ctx = await context(root);
    const churn = (await run<ChurnRow[]>(ctx, 'git.churn')).data;
    const inventory = new Set((await ctx.index.files()).map(file => file.path));
    expect(churn.map(row => row.path).filter(path => !inventory.has(path))).toEqual([]);
    expect(churn.some(row => row.path === 'link')).toBe(false);
    // the README, the changelog and the YAML change most often; none of them says anything about risk
    const hot = (await run<Array<{path: string}>>(ctx, 'git.hotspots')).data.map(row => row.path);
    expect(hot[0]).toBe('packages/a/src/x.ts');
    for (const prose of ['README.md', 'CHANGELOG.md', 'ci.yaml']) expect(hot, prose).not.toContain(prose);
  });

  it('git.churn by=module: one row per module of the module graph, counted from the same commits (V008)', async () => {
    const ctx = await context(root);
    const result = await run<Array<{module: string; commits: number; authors: number; files: number}>>(ctx, 'git.churn by=module');
    expect(result.fields?.map(field => field.key)).toEqual(['module', 'commits', 'authors', 'files']);
    expect(result.roles).toMatchObject({label: 'module', value: 'commits'});
    const graph = (await run<GraphData>(ctx, 'deps.modules')).data;
    const clusters = new Set(graph.nodes.map(node => node.id));
    const a = result.data.find(row => row.module === 'packages/a');
    expect(clusters.has('packages/a')).toBe(true);
    // the start commit and the four edits touch packages/a; Ana and Ben; x.ts, y.ts and its package.json
    expect(a).toEqual({module: 'packages/a', commits: 5, authors: 2, files: 3});
    expect(result.data.find(row => row.module === 'packages/b')).toEqual({module: 'packages/b', commits: 2, authors: 2, files: 2});
    // every changed file is in exactly one row: those per-file churn ranks, and the changelog it leaves out
    const perFile = await run<ChurnRow[]>(ctx, 'git.churn');
    expect(perFile.summary).toContain('1 changelog left out');
    expect(result.data.reduce((sum, row) => sum + row.files, 0)).toBe(perFile.data.length + 1);
    await expect(run(ctx, 'git.churn by=author')).rejects.toMatchObject({code: 'E_ARGS'});
  });

  it('diff.stats counts the test files a change edits, not the tests that import what it edits (V010)', async () => {
    const ctx = await context(root);
    await write(root, {'packages/server/src/spec/guard.ts': 'export const changed = 1;\n'});
    try {
      const stats = await run<StatItem[]>(ctx, 'diff.stats');
      expect(stat(stats, 'Files changed')).toBe(1);
      expect(stat(stats, 'Tests touched')).toBe(0);
      expect(stats.summary).toContain('0 test files changed');
    } finally {
      await git(root, ['checkout', '-q', '--', 'packages/server/src/spec/guard.ts']);
    }
  });
});

describe('code.refs', () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-refs-')));
    await write(root, {
      // a design note that names the class in a heading and in a fenced example, sorted first by path
      'blueprints/core.md': '# Core\n\n## MessageProcessor\n\n```ts\nclass MessageProcessor {}\n```\n',
      'dart/lib/processor.dart': 'class MessageProcessor {\n  void run() {}\n}\n',
      'ts/src/processor.ts': 'export class MessageProcessor {\n  run(): void {}\n}\n',
      'ts/src/use.ts': "import {MessageProcessor} from './processor.ts';\nexport const p = new MessageProcessor();\n",
      'ts/src/more.ts': `${'export const filler = 1;\n'.repeat(40)}`,
    });
  });
  afterAll(async () => {
    await rm(root, {recursive: true, force: true});
  });

  it('a definition is code in the main language first, never a Markdown heading; docs come last; a path scopes it (V035)', async () => {
    const ctx = await context(root);
    const result = await run(ctx, 'code.refs MessageProcessor');
    const files = result.data.map(row => String(row.file).replace(/#L\d+$/, ''));
    expect([...new Set(files)]).toEqual(['ts/src/processor.ts', 'dart/lib/processor.dart', 'ts/src/use.ts', 'blueprints/core.md']);
    expect(result.summary).toContain('defined in 2 files (.ts .dart), first ts/src/processor.ts');
    expect(result.summary).not.toContain('blueprints');
    const scoped = await run(ctx, 'code.refs MessageProcessor dart');
    expect(scoped.data.map(row => row.file)).toEqual(['dart/lib/processor.dart#L1']);
    expect(scoped.summary).toContain('under dart; defined in dart/lib/processor.dart');
    await expect(run(ctx, 'code.refs MessageProcessor nowhere')).rejects.toMatchObject({code: 'E_TARGET'});
  });
});

describe('module graphs and the numbers beside them (D16, V059)', () => {
  let root: string;
  beforeAll(async () => {
    // 24 heavy top-level directories keep the repository cut at its 20 clusters, so `lib` stays one of them; the
    // graph of `lib` alone cuts it finer, into clusters such as the rest cluster 'lib/a/*' the repository cut never has.
    root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-scoped-')));
    const files: Record<string, string> = {};
    const body = (n: number) => `export const v${n} = ${n};\n${'export const pad = 1;\n'.repeat(5)}`;
    for (let t = 0; t < 24; t++) for (let f = 0; f < 9; f++) files[`top${String(t).padStart(2, '0')}/f${f}.ts`] = body(f);
    for (const part of ['a', 'b']) {
      for (let f = 0; f < 12; f++) files[`lib/${part}/x${f}.ts`] = `import {v1} from './sub1/s1.ts';\n${body(f).repeat(4)}`;
      for (let s = 1; s <= 3; s++) for (let f = 0; f < 9; f++) files[`lib/${part}/sub${s}/s${f}.ts`] = body(f).repeat(4);
    }
    await write(root, files);
  });
  afterAll(async () => {
    await rm(root, {recursive: true, force: true});
  });

  it('every cluster a scoped module graph draws is a target the graph accepts, rest clusters included (V059)', async () => {
    const ctx = await context(root);
    const top = (await run<GraphData>(ctx, 'deps.modules')).data;
    expect(top.nodes.map(node => node.id)).toContain('lib');
    const scoped = (await run<GraphData>(ctx, 'deps.modules lib')).data;
    const clusters = scoped.nodes.filter(node => node.kind === 'cluster');
    expect(clusters.map(node => node.id)).toContain('lib/a/*');
    for (const node of clusters) {
      const drilled = await run<GraphData>(ctx, `deps.modules ${node.id}`);
      expect(drilled.data.nodes.length, node.id).toBeGreaterThan(0);
    }
    // the rest cluster is what the cut of `lib` left in lib/a: its twelve own files, not the whole directory
    const rest = await run<GraphData>(ctx, 'deps.modules lib/a/*');
    expect(rest.data.level).toBe('file');
    expect(rest.data.nodes.filter(node => node.kind === 'file' && node.id.startsWith('lib/a/x')).map(node => node.id).sort())
      .toEqual(Array.from({length: 12}, (_, f) => `lib/a/x${f}.ts`).sort());
    expect(rest.data.nodes.some(node => node.kind === 'file' && node.id.startsWith('lib/a/sub'))).toBe(false);
    // deps.files of a cluster or a directory is its module graph (a drill of a deps.files plate lands here too)
    expect((await run<GraphData>(ctx, 'deps.files lib/a/*')).data).toEqual(rest.data);
  });

  it('the KPIs count what the plates beside them show (D16)', async () => {
    const ctx = await context(root);
    const [kpis, langs, graph, matrix] = await Promise.all([run<StatItem[]>(ctx, 'repo.kpis'), run(ctx, 'files.langs'), run<GraphData>(ctx, 'deps.modules'), run(ctx, 'deps.matrix')]);
    expect(stat(kpis, 'Languages')).toBe(langs.data.filter(row => row.lang !== 'Unclassified').length);
    const modules = Number(stat(kpis, 'Modules'));
    expect(modules).toBeGreaterThan(20);
    expect(graph.truncated).toEqual({total: modules, returned: graph.data.nodes.filter(node => node.kind === 'cluster').length, strategy: 'treecut', by: 'loc'});
    expect(graph.summary).toContain(`20 of ${modules} modules`);
    expect(matrix.summary).toContain(`20 of ${modules} modules`);
    expect(kpis.data.map(item => item.label)).toContain('File cycles');
  });
});
