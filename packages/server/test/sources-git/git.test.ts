import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRef, SOURCE_BY_NAME, SOURCES, type ChurnRow, type CommitRow, type HotspotRow, type Rows} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Source, SourceResult} from '../../src/contracts.ts';
import {createGitSources} from '../../src/sources/git/git.ts';
import {sources as registered} from '../../src/sources/git/index.ts';
import {FIXTURE, git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {FIXTURE_NOW, makeContext, never, type TestContext} from '../git/context.ts';

const GIT_SOURCES = ['git.log', 'git.activity', 'git.timeline', 'git.churn', 'git.hotspots', 'git.authors', 'git.coupling'];
const JON = 'Jon Castell';
const MIRA = 'Mira Okafor';
const ADE = 'Ade Lindqvist';

describe('git.* sources on the fixture repository', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  const sources = new Map(createGitSources({now: () => FIXTURE_NOW}).map(source => [source.meta.name, source]));
  const run = <T = Rows>(text: string, context: TestContext = ctx): Promise<SourceResult<T>> => {
    const ref = parseRef(text);
    return sources.get(ref.source)!.run(context, ref, never) as Promise<SourceResult<T>>;
  };

  beforeAll(async () => {
    repo = await makeFixtureRepo();
    ctx = await makeContext(repo.root);
  });
  afterAll(async () => { await repo.cleanup(); });

  it('registers one source per git.* and diff.* entry of the catalog, with the catalog metadata', () => {
    const expected = SOURCES.filter(source => /^(git|diff)\./.test(source.name)).map(source => source.name);
    expect(registered.map(source => source.meta.name)).toEqual(expected);
    expect(expected).toHaveLength(11);
    for (const source of registered) expect(source.meta).toBe(SOURCE_BY_NAME.get(source.meta.name));
    expect([...sources.keys()]).toEqual(GIT_SOURCES);
  });

  it('git.log: the commits of HEAD, newest first, with files, line counts and ref names', async () => {
    const result = await run<CommitRow[]>('git.log');
    const head = await git(repo.root, ['rev-parse', 'HEAD']);
    expect(result.data).toHaveLength(FIXTURE.commits.main);
    expect(result.data.map(row => row.subject)).toEqual([...FIXTURE.commits.subjects].reverse());
    expect(result.data[0]).toEqual({
      sha: head.slice(0, 10), subject: 'Add tests for auth and orders', author: JON, date: '2026-11-04T12:00:00Z', files: 4, add: 30, del: 0, refs: ['HEAD', 'main'],
    });
    expect(result.data.at(-1)).toEqual({sha: expect.stringMatching(/^[0-9a-f]{10}$/), subject: 'Scaffold the shop service', author: MIRA, date: '2026-08-03T09:00:00Z', files: 7, add: 79, del: 0});
    expect(result.data.map(row => row.files)).toEqual([4, 4, 3, 4, 3, 5, 7, 4, 4, 3, 2, 7]);
    expect(result.data.map(row => [row.add, row.del])).toEqual([[30, 0], [47, 0], [30, 0], [7, 3], [15, 1], [103, 0], [93, 0], [54, 0], [57, 1], [63, 0], [42, 0], [79, 0]]);
    const byAuthor: Record<string, number> = {};
    for (const row of result.data) byAuthor[row.author] = (byAuthor[row.author] ?? 0) + 1;
    expect(byAuthor).toEqual(FIXTURE.commits.byAuthorOnMain);
    expect(result).toMatchObject({total: 12, fields: SOURCE_BY_NAME.get('git.log')!.fields});
    expect(result.allRows).toEqual(result.data);
    expect(result.truncated).toBeUndefined();
    expect(result.summary).toBe(`12 rows; fields sha subject author date files; latest ${head.slice(0, 7)} Add tests for auth and orders`);
  });

  it('git.log: a path, top= and since=', async () => {
    const auth = await run<CommitRow[]>('git.log src/auth');
    expect(auth.data.map(row => row.subject)).toEqual(['Add tests for auth and orders', 'Check order ownership in auth', 'Expire sessions and rotate tokens', 'Add auth service with sessions']);
    expect(auth.data.every(row => row.author === JON)).toBe(true);
    expect(auth.summary).toContain('in src/auth');
    // a file, written as a location; its history follows the rename
    expect((await run<CommitRow[]>('git.log src/lib/logger.ts#L3-9')).data.map(row => row.subject)).toEqual(['Rename log to logger and add warn', 'Scaffold the shop service']);

    const top = await run<CommitRow[]>('git.log top=3');
    expect(top.data.map(row => row.subject)).toEqual(['Add tests for auth and orders', 'Add the storefront UI', 'Check order ownership in auth']);
    expect(top).toMatchObject({total: 3, truncated: {total: 12, returned: 3, strategy: 'topN', by: 'date'}});
    expect(top.allRows).toHaveLength(3);
    expect(top.summary.startsWith('3/12 rows; fields sha subject author date files')).toBe(true);

    // 2026-11-20 minus 30 days is 2026-10-21: only the last commit is newer
    expect((await run<CommitRow[]>('git.log since=30d')).data.map(row => row.subject)).toEqual(['Add tests for auth and orders']);
    expect((await run<CommitRow[]>('git.log src/api since=12w')).data.map(row => row.subject)).toEqual(['Rename log to logger and add warn']);
  });

  it('git.log: a change range instead of a path', async () => {
    const range = await run<CommitRow[]>('git.log main..feature');
    expect(range.data.map(row => [row.subject, row.author, row.date, row.files, row.add, row.del, row.refs])).toEqual([
      ['Test the limiter window', MIRA, '2026-11-11T15:15:00Z', 1, 8, 0, ['feature']],
      ['Apply the limiter to all routes', ADE, '2026-11-10T11:00:00Z', 2, 9, 0, undefined],
      ['Add a sliding-window rate limiter', ADE, '2026-11-09T09:30:00Z', 1, 12, 0, undefined],
    ]);
    expect(range.data).toHaveLength(FIXTURE.commits.featureAhead);
    expect(range.summary).toContain('in main..feature');
    expect((await run<CommitRow[]>('git.log main...feature')).data).toEqual(range.data);
    expect((await run<CommitRow[]>('git.log main..feature top=1')).data.map(row => row.subject)).toEqual(['Test the limiter window']);
    // a bare ref: what HEAD has that the ref has not. main is behind feature, so nothing
    expect(await run('git.log feature')).toMatchObject({data: [], total: 0});
    expect((await run('git.log feature')).summary).toContain('in feature...HEAD; no commits');
    // the working tree and the index hold no commits
    expect((await run('git.log wt')).data).toEqual([]);
    expect((await run('git.log staged')).data).toEqual([]);
    // an existing directory wins over a ref of the same name
    await git(repo.root, ['branch', 'tools', 'feature']);
    expect((await run<CommitRow[]>('git.log tools')).data.map(row => row.subject)).toEqual(['Add reporting tools']);
    await git(repo.root, ['branch', '-D', 'tools']);
  });

  it('git.log: bad targets are E_TARGET and never reach git as options', async () => {
    ctx.gitCalls.length = 0;
    for (const target of ['--output=x', '-p', 'no/such/path.ts', '../outside', 'nope..main', 'main..--all', '--all..main']) {
      await expect(run(`git.log ${target}`), target).rejects.toMatchObject({code: 'E_TARGET'});
    }
    for (const call of ctx.gitCalls) {
      const options = call.filter(arg => arg.startsWith('-'));
      expect(options.every(option => !option.includes('output') && option !== '-p' && option !== '--all'), call.join(' ')).toBe(true);
    }
  });

  it('git.activity: commits per day inside the window', async () => {
    const result = await run('git.activity');
    expect(result.data).toEqual([
      '2026-08-03', '2026-08-05', '2026-08-11', '2026-08-18', '2026-08-25', '2026-09-02', '2026-09-09', '2026-09-16', '2026-09-24', '2026-10-06', '2026-10-20', '2026-11-04',
    ].map(date => ({date, commits: 1})));
    expect(result).toMatchObject({total: 12, roles: {date: 'date', value: 'commits'}});
    expect(result.summary).toBe('12 rows; fields date commits; 12 commits since 2025-11-20; busiest 2026-08-03 1');
    expect((await run('git.activity since=30d')).data).toEqual([{date: '2026-11-04', commits: 1}]);
    expect((await run('git.activity src/auth')).data.map(row => row.date)).toEqual(['2026-08-11', '2026-09-16', '2026-10-06', '2026-11-04']);
    // top= keeps the latest days
    expect((await run('git.activity top=2')).data.map(row => row.date)).toEqual(['2026-10-20', '2026-11-04']);
  });

  it('git.activity and git.timeline default to the last 365 days of the injected clock', async () => {
    const later = new Map(createGitSources({now: () => Date.parse('2028-01-15T00:00:00Z')}).map(source => [source.meta.name, source]));
    const at = (text: string) => later.get(parseRef(text).source)!.run(ctx, parseRef(text), never);
    expect(await at('git.activity')).toMatchObject({data: [], total: 0});
    expect((await at('git.activity')).summary).toContain('0 commits since 2027-01-15');
    expect((await at('git.timeline')).data).toEqual([]);
    expect((await at('git.activity since=2y')).data).toHaveLength(12);
    // sources without a default window are not affected by the clock
    expect((await at('git.churn')).data).toHaveLength(35);
  });

  it('git.timeline: commits per week and module, zero-filled, with the smallest modules folded into "other"', async () => {
    const result = await run<Array<{week: string; module: string; commits: number}>>('git.timeline');
    const weeks = [...new Set(result.data.map(row => row.week))];
    expect(weeks).toEqual([
      '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19',
      '2026-10-26', '2026-11-02',
    ]);
    // ten modules touched: the seven busiest keep their name (ties by name), three fold into "other"
    const series = ['.', 'src/auth', 'src', 'src/api', 'src/lib', 'src/orders', 'services', 'other'];
    expect(result.data).toHaveLength(weeks.length * series.length);
    for (const week of weeks) expect(result.data.filter(row => row.week === week).map(row => row.module)).toEqual(series);
    const total = (module: string) => result.data.filter(row => row.module === module).reduce((sum, row) => sum + row.commits, 0);
    expect(Object.fromEntries(series.map(module => [module, total(module)]))).toEqual({'.': 4, 'src/auth': 4, src: 3, 'src/api': 3, 'src/lib': 3, 'src/orders': 2, services: 1, other: 3});
    const cell = (week: string, module: string) => result.data.find(row => row.week === week && row.module === module)!.commits;
    // the first week holds the commits of Monday 3 and Wednesday 5 August, both in src/lib
    expect([cell('2026-08-03', 'src/lib'), cell('2026-08-03', '.'), cell('2026-08-03', 'src'), cell('2026-08-03', 'src/auth')]).toEqual([2, 1, 1, 0]);
    expect(cell('2026-10-12', 'src/auth')).toBe(0);
    expect(cell('2026-11-02', 'src/auth')).toBe(1);
    expect(cell('2026-11-02', 'other')).toBe(1);
    expect(result).toMatchObject({total: 112, roles: {x: 'week', y: ['commits'], series: 'module'}});
    expect(result.truncated).toBeUndefined();
    expect(result.summary).toBe('112 rows; fields week module commits; 14 weeks x 8 modules; 12 commits since 2025-11-20; busiest . 4');
  });

  it('git.timeline: a scope counts only the modules inside it, and top= keeps whole weeks', async () => {
    const scoped = await run<Array<{week: string; module: string; commits: number}>>('git.timeline src/auth');
    expect([...new Set(scoped.data.map(row => row.module))]).toEqual(['src/auth']);
    expect(scoped.data.filter(row => row.commits > 0).map(row => row.week)).toEqual(['2026-08-10', '2026-09-14', '2026-10-05', '2026-11-02']);
    const cut = await run<Array<{week: string; module: string; commits: number}>>('git.timeline top=20');
    expect([...new Set(cut.data.map(row => row.week))]).toEqual(['2026-10-26', '2026-11-02']);
    expect(cut.data).toHaveLength(16);
    expect(cut.truncated).toEqual({total: 112, returned: 16, strategy: 'bucket', by: 'week'});
    expect(cut.summary.startsWith('16/112 rows; fields week module commits; 2 weeks x 8 modules')).toBe(true);
  });

  it('git.timeline: falls back to top-level directories when the index cannot name modules', async () => {
    const broken = await makeContext(repo.root, {index: {moduleOf: () => Promise.reject(new Error('index down'))}});
    const result = await run<Array<{week: string; module: string; commits: number}>>('git.timeline', broken);
    expect([...new Set(result.data.map(row => row.module))]).toEqual(['src', '(root)', 'services', 'test', 'tools']);
    expect(broken.index.calls.moduleOf).toBe(1);
    expect(broken.logs).toHaveLength(1);
  });

  it('git.churn: commits, authors and ownership per file that exists at HEAD', async () => {
    const result = await run<ChurnRow[]>('git.churn');
    expect(result.data).toHaveLength(FIXTURE.tracked.length);
    expect(result.data.slice(0, 10)).toEqual([
      {path: 'src/auth/service.ts', commits: 4, authors: 1, owner: JON, ownership: 100, first: '2026-08-11', last: '2026-11-04'},
      {path: 'src/auth/session.ts', commits: 4, authors: 1, owner: JON, ownership: 100, first: '2026-08-11', last: '2026-11-04'},
      {path: 'src/index.ts', commits: 3, authors: 2, owner: MIRA, ownership: 66.7, first: '2026-08-03', last: '2026-09-24'},
      {path: 'package.json', commits: 2, authors: 1, owner: MIRA, ownership: 100, first: '2026-08-03', last: '2026-10-20'},
      {path: 'src/api/middleware.ts', commits: 2, authors: 2, owner: JON, ownership: 50, first: '2026-08-18', last: '2026-09-24'},
      {path: 'src/api/routes.ts', commits: 2, authors: 2, owner: JON, ownership: 50, first: '2026-08-18', last: '2026-08-25'},
      {path: 'src/api/server.ts', commits: 2, authors: 2, owner: JON, ownership: 50, first: '2026-08-18', last: '2026-09-24'},
      {path: 'src/auth/tokens.ts', commits: 2, authors: 1, owner: JON, ownership: 100, first: '2026-08-11', last: '2026-09-16'},
      // the renamed file carries the history of its old name
      {path: 'src/lib/logger.ts', commits: 2, authors: 1, owner: MIRA, ownership: 100, first: '2026-08-03', last: '2026-09-24'},
      {path: 'src/orders/service.ts', commits: 2, authors: 2, owner: JON, ownership: 50, first: '2026-08-25', last: '2026-10-06'},
    ]);
    expect(Object.fromEntries(result.data.filter(row => row.commits >= 3).map(row => [row.path, row.commits]))).toEqual(FIXTURE.churn);
    expect(result.data.slice(10).every(row => row.commits === 1 && row.authors === 1 && row.ownership === 100 && row.first === row.last)).toBe(true);
    expect(result.data.some(row => row.path === FIXTURE.rename.from)).toBe(false);
    expect(result.data.filter(row => row.path.startsWith('tools/') || row.path.startsWith('services/') || row.path === 'go.mod' || row.path === 'pyproject.toml').every(row => row.owner === ADE)).toBe(true);
    expect(result.summary).toBe('35 rows; fields path commits authors owner ownership last; top src/auth/service.ts 4 commits');
    expect(result.allRows).toHaveLength(35);
  });

  it('git.churn: scope, window and top', async () => {
    expect((await run<ChurnRow[]>('git.churn src/lib')).data.map(row => [row.path, row.commits])).toEqual([
      ['src/lib/logger.ts', 2], ['src/lib/cache.ts', 1], ['src/lib/config.ts', 1], ['src/lib/db.ts', 1],
    ]);
    expect((await run<ChurnRow[]>('git.churn src/auth/service.ts')).data.map(row => row.path)).toEqual(['src/auth/service.ts']);
    // since 2026-10-01: three commits; ownership is counted inside the window
    expect((await run<ChurnRow[]>('git.churn since=50d')).data.slice(0, 3)).toEqual([
      {path: 'src/auth/service.ts', commits: 2, authors: 1, owner: JON, ownership: 100, first: '2026-10-06', last: '2026-11-04'},
      {path: 'src/auth/session.ts', commits: 2, authors: 1, owner: JON, ownership: 100, first: '2026-10-06', last: '2026-11-04'},
      {path: 'package.json', commits: 1, authors: 1, owner: MIRA, ownership: 100, first: '2026-10-20', last: '2026-10-20'},
    ]);
    const top = await run<ChurnRow[]>('git.churn top=5');
    expect(top.data.map(row => row.path)).toEqual(['src/auth/service.ts', 'src/auth/session.ts', 'src/index.ts', 'package.json', 'src/api/middleware.ts']);
    expect(top).toMatchObject({total: 5, truncated: {total: 35, returned: 5, strategy: 'topN', by: 'commits'}});
    expect(await run('git.churn src/ui since=7d')).toMatchObject({data: [], total: 0});
  });

  it('git.hotspots: churn x complexity over analysed source files, tests flagged', async () => {
    const result = await run<HotspotRow[]>('git.hotspots');
    // 18 TypeScript, 6 Python and 4 Go files have facts; manifests, CSS and the README do not rank
    expect(result.data).toHaveLength(28);
    expect(result.data.slice(0, 10)).toEqual([
      {path: 'src/auth/service.ts', commits: 4, complexity: 40, sloc: 30, score: 1, owner: JON, isTest: false},
      {path: 'src/auth/session.ts', commits: 4, complexity: 20, sloc: 30, score: 0.5, owner: JON, isTest: false},
      {path: 'src/orders/service.ts', commits: 2, complexity: 30, sloc: 30, score: 0.38, owner: JON, isTest: false},
      {path: 'src/api/middleware.ts', commits: 2, complexity: 10, sloc: 30, score: 0.13, owner: JON, isTest: false},
      {path: 'src/api/routes.ts', commits: 2, complexity: 10, sloc: 30, score: 0.13, owner: JON, isTest: false},
      {path: 'src/api/server.ts', commits: 2, complexity: 10, sloc: 30, score: 0.13, owner: JON, isTest: false},
      {path: 'src/auth/tokens.ts', commits: 2, complexity: 10, sloc: 30, score: 0.13, owner: JON, isTest: false},
      {path: 'src/lib/logger.ts', commits: 2, complexity: 10, sloc: 30, score: 0.13, owner: MIRA, isTest: false},
      {path: 'src/index.ts', commits: 3, complexity: 5, sloc: 30, score: 0.09, owner: MIRA, isTest: false},
      {path: 'services/gateway/limiter/limiter.go', commits: 1, complexity: 10, sloc: 30, score: 0.06, owner: ADE, isTest: false},
    ]);
    expect(result.data.filter(row => row.isTest).map(row => row.path).sort()).toEqual([
      'services/gateway/limiter/limiter_test.go', 'test/auth.test.ts', 'test/orders.test.ts', 'tools/tests/test_stats.py',
    ]);
    for (const absent of ['package.json', 'README.md', 'src/ui/app.css', 'src/lib/metrics.ts']) expect(result.data.some(row => row.path === absent), absent).toBe(false);
    expect(result.data.every(row => row.score >= 0 && row.score <= 1)).toBe(true);
    expect(result).toMatchObject({total: 28, roles: {x: 'commits', y: ['complexity'], size: 'sloc'}});
    expect(result.summary).toBe('28 rows; fields path commits complexity sloc score owner; top src/auth/service.ts 4 commits');

    const top = await run<HotspotRow[]>('git.hotspots top=3');
    expect(top.data.map(row => row.path)).toEqual(['src/auth/service.ts', 'src/auth/session.ts', 'src/orders/service.ts']);
    expect(top.truncated).toEqual({total: 28, returned: 3, strategy: 'topN', by: 'score'});
    // inside a scope the scores are relative to the scope
    expect((await run<HotspotRow[]>('git.hotspots src/api')).data.map(row => [row.path, row.score])).toEqual([
      ['src/api/middleware.ts', 1], ['src/api/routes.ts', 1], ['src/api/server.ts', 1],
    ]);
  });

  it('git.hotspots: leaves out generated and binary files and passes index failures on', async () => {
    const files = (await ctx.index.files()).map(file => (file.path === 'src/auth/service.ts' ? {...file, generated: true} : file.path === 'src/auth/session.ts' ? {...file, binary: true} : file));
    const marked = await makeContext(repo.root, {index: {files: () => Promise.resolve(files)}});
    const result = await run<HotspotRow[]>('git.hotspots', marked);
    expect(result.data).toHaveLength(26);
    expect(result.data[0]).toMatchObject({path: 'src/orders/service.ts', score: 0.67});
    const broken = await makeContext(repo.root, {index: {facts: () => Promise.reject(new Error('index down'))}});
    await expect(run('git.hotspots', broken)).rejects.toThrow('index down');
  });

  it('git.authors: names, commits, files touched and last date', async () => {
    const result = await run('git.authors');
    expect(result.data).toEqual([
      {author: JON, commits: 5, files: 10, last: '2026-11-04'},
      {author: MIRA, commits: 5, files: 18, last: '2026-10-20'},
      {author: ADE, commits: 2, files: 12, last: '2026-09-09'},
    ]);
    expect(Object.fromEntries(result.data.map(row => [row.author, row.commits]))).toEqual(FIXTURE.commits.byAuthorOnMain);
    expect(result.summary).toBe('3 rows; fields author commits files last; top Jon Castell 5 commits');
    expect((await run('git.authors tools')).data).toEqual([{author: ADE, commits: 1, files: 6, last: '2026-09-02'}]);
    expect((await run('git.authors src/api')).data).toEqual([
      {author: MIRA, commits: 2, files: 3, last: '2026-09-24'},
      {author: JON, commits: 1, files: 3, last: '2026-08-18'},
    ]);
    expect((await run('git.authors top=1')).data).toEqual([{author: JON, commits: 5, files: 10, last: '2026-11-04'}]);
    expect((await run('git.authors since=30d')).data).toEqual([{author: JON, commits: 1, files: 4, last: '2026-11-04'}]);
    // names only: nothing that looks like an address leaves the server
    expect(JSON.stringify(result)).not.toMatch(/@|example/);
    expect(ctx.gitCalls.flat().some(arg => /%a[eE]|%c[eE]/.test(arg))).toBe(false);
  });

  it('git.coupling: the pairs that change together in at least three commits', async () => {
    const result = await run('git.coupling');
    expect(result.data).toEqual([{a: FIXTURE.coupled.a, b: FIXTURE.coupled.b, shared: FIXTURE.coupled.shared, degree: 100}]);
    expect(result.summary).toBe('1 row; fields a b shared degree; strongest src/auth/service.ts + src/auth/session.ts 4 commits');
    expect((await run('git.coupling src/auth')).data).toEqual(result.data);
    expect((await run('git.coupling src/auth/session.ts')).data).toEqual([{a: FIXTURE.coupled.b, b: FIXTURE.coupled.a, shared: 4, degree: 100}]);
    expect(await run('git.coupling src/api')).toMatchObject({data: [], total: 0});
    expect((await run('git.coupling src/api')).summary).toContain('no pair shares 3 commits');
    expect((await run('git.coupling top=1')).data).toHaveLength(1);
  });

  it('every source honours top=, validates arguments and targets, and keeps its summary short', async () => {
    for (const name of GIT_SOURCES) {
      const one = await run(`${name} top=1`);
      expect(one.data.length, name).toBeLessThanOrEqual(name === 'git.timeline' ? 8 : 1);
      expect(one.summary.length, name).toBeLessThanOrEqual(160);
      expect(one.summary, name).toContain(`fields ${SOURCE_BY_NAME.get(name)!.fields!.map(field => field.key).join(' ')}`);
      await expect(run(`${name} top=0`), name).rejects.toMatchObject({code: 'E_ARGS'});
      await expect(run(`${name} top=many`), name).rejects.toMatchObject({code: 'E_ARGS'});
      await expect(run(`${name} ../outside`), name).rejects.toMatchObject({code: 'E_TARGET'});
      await expect(run(`${name} no/such/dir`), name).rejects.toMatchObject({code: 'E_TARGET', message: 'no such path: no/such/dir'});
      // an argument the source does not know is ignored
      expect((await run(`${name} colour=blue`)).data, name).toEqual((await run(name)).data);
    }
    for (const name of GIT_SOURCES.filter(source => source !== 'git.coupling')) {
      await expect(run(`${name} since=soon`), name).rejects.toMatchObject({code: 'E_ARGS'});
    }
    // a path that exists but has no history yet is not an error
    expect(await run('git.churn src/lib/metrics.ts')).toMatchObject({data: [], total: 0});
  });

  it('reads the history once for all sources', async () => {
    const fresh = await makeContext(repo.root);
    const before = fresh.gitCalls.length;
    await Promise.all(GIT_SOURCES.map(name => run(name, fresh)));
    await Promise.all(['git.churn src', 'git.authors since=30d', 'git.hotspots top=3', 'git.timeline src/auth'].map(text => run(text, fresh)));
    // the stream was read by the first test of this file; nothing here reads it again
    const logs = fresh.gitCalls.slice(before).filter(args => args.includes('--name-status'));
    expect(logs).toEqual([]);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const ref = parseRef('git.churn');
    await expect(sources.get('git.churn')!.run(ctx, ref, controller.signal)).rejects.toThrow();
  });
});

describe('git.* sources in unusual repositories', () => {
  const sources = new Map(createGitSources({now: () => FIXTURE_NOW}).map(source => [source.meta.name, source]));
  const run = <T = Rows>(text: string, ctx: TestContext) => sources.get(parseRef(text).source)!.run(ctx, parseRef(text), never) as Promise<SourceResult<T>>;
  let repo: FixtureRepo;
  let scratch: string;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-git-sources-')));
  });
  afterAll(async () => {
    await repo.cleanup();
    await rm(scratch, {recursive: true, force: true});
  });

  it('answer E_NO_GIT outside a repository', async () => {
    const outside = await makeContext(scratch);
    expect(outside.git).toBeNull();
    for (const name of GIT_SOURCES) await expect(run(name, outside), name).rejects.toMatchObject({code: 'E_NO_GIT', message: 'not a git repository'});
  });

  it('warn about a shallow clone and never deepen it', async () => {
    const clone = join(scratch, 'shallow');
    await git(repo.root, ['clone', '-q', '--depth', '2', `file://${repo.root}`, clone]);
    const shallow = await makeContext(clone);
    expect(shallow.git).toMatchObject({shallow: true});
    for (const name of GIT_SOURCES) {
      const result = await run(name, shallow);
      expect(result.warnings, name).toEqual(['shallow clone: history is incomplete']);
    }
    // ... and its line counts are not the size of the repository
    expect((await run<CommitRow[]>('git.log', shallow)).data.map(row => [row.files, row.add, row.del])).toEqual([[4, 30, 0], [0, 0, 0]]);
    // git shows the commit the clone was cut at as adding all 33 files of its tree; that is not counted as its author's work
    expect((await run('git.authors', shallow)).data).toEqual([{author: JON, commits: 1, files: 4, last: '2026-11-04'}, {author: MIRA, commits: 1, files: 0, last: '2026-10-20'}]);
    const churn = (await run<ChurnRow[]>('git.churn', shallow)).data;
    expect(churn.map(row => row.path).sort()).toEqual(['src/auth/service.ts', 'src/auth/session.ts', 'test/auth.test.ts', 'test/orders.test.ts']);
    expect(churn.every(row => row.commits === 1 && row.owner === JON)).toBe(true);
    expect(shallow.gitCalls.some(args => args.includes('fetch') || args.includes('--unshallow') || args.includes('--deepen'))).toBe(false);
    expect(await git(clone, ['rev-list', '--count', 'HEAD'])).toBe('2');
  });

  it('answer empty results before the first commit', async () => {
    const empty = join(scratch, 'unborn');
    await git(scratch, ['init', '-q', '-b', 'main', empty]);
    const unborn = await makeContext(empty);
    expect(unborn.git).toEqual({shallow: false, branch: 'main'});
    for (const name of GIT_SOURCES) expect(await run(name, unborn), name).toMatchObject({data: [], total: 0});
  });

  it('work when the project root is a directory inside the repository: paths are relative to it', async () => {
    const sub = await makeContext(join(repo.root, 'src'));
    const churn = await run<ChurnRow[]>('git.churn top=3', sub);
    expect(churn.data.map(row => [row.path, row.commits])).toEqual([['auth/service.ts', 4], ['auth/session.ts', 4], ['index.ts', 3]]);
    // commits that touch nothing under src/ (the Python tools, the Go gateway) are not part of this project
    expect((await run('git.log', sub)).data).toHaveLength(10);
    expect((await run('git.authors', sub)).data.map(row => (row as {author: string}).author)).toEqual([JON, MIRA]);
    expect((await run('git.log auth', sub)).data).toHaveLength(4);
  });
});

describe('a source list built without options', () => {
  it('uses the wall clock', async () => {
    const defaults: Source[] = createGitSources();
    expect(defaults.map(source => source.meta.name)).toEqual(GIT_SOURCES);
  });
});
