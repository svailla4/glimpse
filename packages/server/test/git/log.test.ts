import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {RepoContext, RunGit} from '../../src/contracts.ts';
import {commitStats, getHeaders, getLog, LOG_LIMIT, parseLog, rangeLog, refNames} from '../../src/git/log.ts';
import {resolveRange} from '../../src/git/range.ts';
import {FIXTURE, git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {fakeIndex, makeContext, type TestContext} from './context.ts';

const sha = (n: number): string => n.toString(16).padStart(40, '0');
/** One record of the stream `git log --name-status -z --format=%x01%H%x1f%aN%x1f%at%x1f%s` writes. */
const record = (n: number, author: string, time: number, subject: string, changes: string[][]): string =>
  `\x01${sha(n)}\x1f${author}\x1f${time}\x1f${subject}\0${changes.length > 0 ? '\n' : ''}${changes.map(change => `${change.join('\0')}\0`).join('')}`;

describe('parseLog', () => {
  it('reads headers and name-status entries', () => {
    const commits = parseLog(record(2, 'Mira Okafor', 200, 'Second', [['M', 'a.ts'], ['A', 'dir/b c.ts']]) + record(1, 'Jon Castell', 100, 'First', [['A', 'a.ts']]));
    expect(commits).toEqual([
      {sha: sha(2), author: 'Mira Okafor', time: 200, subject: 'Second', files: ['a.ts', 'dir/b c.ts']},
      {sha: sha(1), author: 'Jon Castell', time: 100, subject: 'First', files: ['a.ts']},
    ]);
  });

  it('counts a renamed file under the name it has today, through a chain of renames', () => {
    const commits = parseLog(
      record(5, 'A', 500, 'new a', [['A', 'a.ts']])
      + record(4, 'A', 400, 'b to c', [['R100', 'b.ts', 'c.ts'], ['M', 'x.ts']])
      + record(3, 'A', 300, 'a to b', [['R087', 'a.ts', 'b.ts']])
      + record(2, 'A', 200, 'edit', [['M', 'a.ts']])
      + record(1, 'A', 100, 'add', [['A', 'a.ts'], ['A', 'x.ts']]),
    );
    // the a.ts added last is a new file; the old a.ts lives on as c.ts
    expect(commits.map(commit => commit.files)).toEqual([['a.ts'], ['c.ts', 'x.ts'], ['c.ts'], ['c.ts'], ['c.ts', 'x.ts']]);
  });

  it('keeps commits without files, subjects with separators, and lists a path once per commit', () => {
    const commits = parseLog(
      record(3, 'A', 300, 'empty', [])
      + record(2, 'A', 200, 'odd \x1f subject', [['M', 'a.ts'], ['M', 'a.ts'], ['C075', 'a.ts', 'copy.ts']])
      + `\x01${sha(1)}\x1fA\x1f100\x1ftrailing newline\0\n`,
    );
    expect(commits.map(commit => [commit.subject, commit.files])).toEqual([['empty', []], ['odd \x1f subject', ['a.ts', 'copy.ts']], ['trailing newline', []]]);
  });

  it('survives damaged input', () => {
    expect(parseLog('')).toEqual([]);
    expect(parseLog('garbage\0more')).toEqual([]);
    expect(parseLog(`\x01not-a-sha\x1fA\x1f1\x1fs\0`)).toEqual([]);
    expect(parseLog(`\x01${sha(1)}\x1fA\x1fnot-a-number\x1fs\0\nM\0`)).toEqual([{sha: sha(1), author: 'A', time: 0, subject: 's', files: []}]);
    expect(parseLog(`\x01${sha(1)}\x1fA\x1f5\x1fs\0\nR100\0only-one\0`)).toEqual([{sha: sha(1), author: 'A', time: 5, subject: 's', files: []}]);
  });
});

describe('getLog on the fixture repository', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  const logRuns = () => ctx.gitCalls.filter(args => args.includes('log')).length;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    ctx = await makeContext(repo.root);
  });
  afterAll(async () => { await repo.cleanup(); });

  it('reads the history of HEAD once and shares it between concurrent and later callers', async () => {
    const logs = await Promise.all([getLog(ctx), getLog(ctx), getLog(ctx, {path: 'src'}), getLog(ctx, {since: 0}), getLog(ctx)]);
    expect(logRuns()).toBe(1);
    expect(logs[0]).toBe(logs[1]);
    const log = logs[0]!;
    expect(log.truncated).toBe(false);
    expect(log.commits).toHaveLength(FIXTURE.commits.main);
    expect(log.commits.map(commit => commit.subject)).toEqual([...FIXTURE.commits.subjects].reverse());
    expect(log.commits[0]).toMatchObject({author: 'Jon Castell', time: Date.parse(FIXTURE.commits.last) / 1000});
    expect(log.commits[0]!.sha).toBe(await git(repo.root, ['rev-parse', 'HEAD']));
    expect([...log.alive].sort()).toEqual([...FIXTURE.tracked].sort());
    await getLog(ctx);
    expect(logRuns()).toBe(1);
  });

  it('follows the rename of commit 9 back to the first commit', async () => {
    const {commits} = await getLog(ctx);
    const touching = (path: string) => commits.filter(commit => commit.files.includes(path)).map(commit => commit.subject);
    expect(touching(FIXTURE.rename.to)).toEqual(['Rename log to logger and add warn', 'Scaffold the shop service']);
    expect(touching(FIXTURE.rename.from)).toEqual([]);
  });

  it('answers who and when for every commit from the same parse, without another git run', async () => {
    const log = await getLog(ctx);
    const before = ctx.gitCalls.length;
    const all = await getHeaders(ctx);
    expect(all.truncated).toBe(false);
    // not a copy and not a second stream: the commits themselves
    expect(all.headers).toBe(log.commits);
    expect(ctx.gitCalls.slice(before).some(args => args.includes('log'))).toBe(false);
  });

  it('asks git for history with a pathspec only with history simplification switched off', async () => {
    // at the top of the repository there is no pathspec at all: `-- .` there silently drops commits
    const top = ctx.gitCalls.filter(args => args.includes('--name-status'));
    expect(top.length).toBeGreaterThan(0);
    for (const args of top) expect(args.includes('--')).toBe(false);
    // inside a directory the pathspec is needed, and --full-history keeps every commit that touched the directory
    const sub = await makeContext(join(repo.root, 'src'));
    await getLog(sub);
    const logs = sub.gitCalls.filter(args => args.includes('--name-status'));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.slice(-2)).toEqual(['--', '.']);
    expect(logs[0]).toContain('--full-history');
  });

  it('narrows by path and by time without asking git again', async () => {
    const before = logRuns();
    const auth = await getLog(ctx, {path: 'src/auth'});
    expect(auth.commits.map(commit => commit.subject)).toEqual([
      'Add tests for auth and orders', 'Check order ownership in auth', 'Expire sessions and rotate tokens', 'Add auth service with sessions',
    ]);
    // matching commits keep the files outside the scope too
    expect(auth.commits[0]!.files).toContain('test/auth.test.ts');
    const file = await getLog(ctx, {path: 'src/index.ts'});
    expect(file.commits).toHaveLength(FIXTURE.churn['src/index.ts']!);
    // a path that is a prefix of a name, but not a directory of it, matches nothing
    expect((await getLog(ctx, {path: 'src/ind'})).commits).toEqual([]);
    const october = Date.parse('2026-10-01T00:00:00Z') / 1000;
    expect((await getLog(ctx, {since: october})).commits.map(commit => commit.subject)).toEqual(['Add tests for auth and orders', 'Add the storefront UI', 'Check order ownership in auth']);
    expect((await getLog(ctx, {path: 'src/ui', since: october})).commits.map(commit => commit.subject)).toEqual(['Add the storefront UI']);
    expect(logRuns()).toBe(before);
  });

  it('reads again when HEAD moves', async () => {
    await getLog(ctx);
    const before = logRuns();
    await writeFile(join(repo.root, 'NOTES.md'), 'notes\n');
    await git(repo.root, ['add', 'NOTES.md']);
    await git(repo.root, ['commit', '-q', '-m', 'Add notes'], {GIT_AUTHOR_DATE: '2026-11-18T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-18T10:00:00Z'});
    const log = await getLog(ctx);
    expect(logRuns()).toBe(before + 1);
    expect(log.commits).toHaveLength(FIXTURE.commits.main + 1);
    expect(log.commits[0]).toMatchObject({subject: 'Add notes', author: 'Fixture Committer', files: ['NOTES.md']});
    expect(log.alive.has('NOTES.md')).toBe(true);
  });

  it('lists the commits of a range with rangeLog, and their line counts with commitStats', async () => {
    const range = await resolveRange(ctx, 'main..feature');
    const {commits, truncated} = await rangeLog(ctx, range.logArgs!);
    expect(truncated).toBe(false);
    expect(commits.map(commit => [commit.subject, commit.author, commit.files])).toEqual([
      ['Test the limiter window', 'Mira Okafor', ['test/limiter.test.ts']],
      ['Apply the limiter to all routes', 'Ade Lindqvist', ['src/api/middleware.ts', 'src/api/routes.ts']],
      ['Add a sliding-window rate limiter', 'Ade Lindqvist', ['src/api/limiter.ts']],
    ]);
    const stats = await commitStats(ctx, commits.map(commit => commit.sha));
    expect(commits.map(commit => stats.get(commit.sha))).toEqual([{add: 8, del: 0}, {add: 9, del: 0}, {add: 12, del: 0}]);
    expect(await commitStats(ctx, [])).toEqual(new Map());
  });

  it('maps commits to branch and tag names', async () => {
    await git(repo.root, ['tag', 'v0.3.0', 'main~1']);
    await git(repo.root, ['tag', '-a', 'v0.2.0', '-m', 'annotated', 'main~2']);
    const names = await refNames(ctx);
    expect(names.get(await git(repo.root, ['rev-parse', 'feature']))).toEqual(['feature']);
    expect(names.get(await git(repo.root, ['rev-parse', 'main~1']))).toEqual(['v0.3.0']);
    // an annotated tag names the commit it points at, not the tag object
    expect(names.get(await git(repo.root, ['rev-parse', 'main~2']))).toEqual(['v0.2.0']);
  });

  it('answers E_NO_GIT without a repository and an empty history before the first commit', async () => {
    await expect(getLog({...ctx, git: null})).rejects.toMatchObject({code: 'E_NO_GIT'});
    const unborn: RepoContext = {...ctx, root: `${repo.root}-unborn`, runGit: () => Promise.reject(new Error('unknown revision HEAD'))};
    expect(await getLog(unborn)).toEqual({commits: [], truncated: false, alive: new Set()});
  });
});

describe('getLog on a history longer than the limit', () => {
  // A scripted git: the newest LOG_LIMIT commits touch only app/, and docs/ changed long before them.
  const head = sha(99_999);
  const full = Array.from({length: LOG_LIMIT}, (_, i) => record(LOG_LIMIT - i, 'A', 1_000_000 + LOG_LIMIT - i, `commit ${LOG_LIMIT - i}`, [['M', 'app/main.ts']])).join('');
  const docsOnly = record(7, 'B', 500, 'old docs', [['M', 'docs/guide.md'], ['M', 'app/main.ts']]);
  const calls: string[][] = [];
  let failNext = false;
  const runGit: RunGit = async args => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args.includes('--show-prefix')) return Buffer.from('\n');
    if (args[0] === 'rev-parse') return Buffer.from(`${head}\n`);
    if (args[0] === 'ls-tree') return Buffer.from(`100644 blob ${sha(1)}\tapp/main.ts\x00100644 blob ${sha(2)}\tdocs/guide.md\x00`);
    if (args.includes('log')) {
      if (failNext) {
        failNext = false;
        throw new Error('git log failed');
      }
      return Buffer.from(args.includes('--') ? docsOnly : args.some(arg => arg.startsWith('--since=')) ? record(9, 'A', 900, 'windowed', [['M', 'app/main.ts']]) : full);
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const ctx: RepoContext = {root: 'scripted-long-history', name: 'long', git: {shallow: false}, runGit, index: fakeIndex(), rev: () => 1, log: () => {}};
  const logCalls = () => calls.filter(args => args.includes('log'));

  it('does not remember a failed read', async () => {
    failNext = true;
    await expect(getLog(ctx)).rejects.toThrow('git log failed');
    expect((await getLog(ctx)).commits).toHaveLength(LOG_LIMIT);
  });

  it('marks the shared history as truncated', async () => {
    const log = await getLog(ctx);
    expect(log.truncated).toBe(true);
    expect(log.commits).toHaveLength(LOG_LIMIT);
  });

  it('asks git for a path the shared history may not reach, literally and after "--", and remembers the answer', async () => {
    const before = logCalls().length;
    const docs = await getLog(ctx, {path: 'docs'});
    expect(docs.commits.map(commit => commit.subject)).toEqual(['old docs']);
    expect(docs.commits[0]!.files).toEqual(['docs/guide.md', 'app/main.ts']);
    const call = logCalls().at(-1)!;
    expect(call[0]).toBe('--literal-pathspecs');
    expect(call).toContain('--full-diff');
    expect(call.slice(-3)).toEqual([head, '--', 'docs']);
    await getLog(ctx, {path: 'docs'});
    expect(logCalls().length).toBe(before + 1);
  });

  it('filters a time window in memory when the shared history reaches back that far, and asks git when it does not', async () => {
    const before = logCalls().length;
    const recent = await getLog(ctx, {since: 1_000_000 + LOG_LIMIT - 9});
    expect(recent.commits).toHaveLength(10);
    expect(recent.truncated).toBe(false);
    expect(logCalls().length).toBe(before);
    const old = await getLog(ctx, {since: 800});
    expect(old.commits.map(commit => commit.subject)).toEqual(['windowed']);
    expect(logCalls().at(-1)).toContain('--since=1970-01-01T00:13:20.000Z');
    expect(logCalls().length).toBe(before + 1);
  });
});
