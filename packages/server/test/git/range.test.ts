import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {devNull, tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {SourceError} from '../../src/contracts.ts';
import {parseRange, RANGE_PATTERN, resolveRange} from '../../src/git/range.ts';
import {git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {makeContext, type TestContext} from './context.ts';

describe('parseRange', () => {
  it('accepts the documented forms', () => {
    expect(parseRange(undefined)).toEqual({kind: 'wt'});
    expect(parseRange('')).toEqual({kind: 'wt'});
    expect(parseRange(' wt ')).toEqual({kind: 'wt'});
    expect(parseRange('staged')).toEqual({kind: 'staged'});
    expect(parseRange('main..HEAD')).toEqual({kind: 'commits', left: 'main', right: 'HEAD', dots: '..', label: 'main..HEAD'});
    expect(parseRange('origin/main...feature/x-1')).toEqual({kind: 'commits', left: 'origin/main', right: 'feature/x-1', dots: '...', label: 'origin/main...feature/x-1'});
    expect(parseRange('v1.2.0..HEAD~3')).toMatchObject({left: 'v1.2.0', right: 'HEAD~3', dots: '..'});
    expect(parseRange('HEAD@{1}..HEAD^')).toMatchObject({left: 'HEAD@{1}', right: 'HEAD^'});
    // a bare ref means "what HEAD adds since it left that ref"
    expect(parseRange('main')).toEqual({kind: 'commits', left: 'main', right: 'HEAD', dots: '...', label: 'main...HEAD'});
  });

  it.each([
    '--output=x', '-p', '--', 'main..--output=x', 'main...-x', 'main..', '..main', 'a..b..c', 'a....b', '.hidden', 'main HEAD', 'main;rm', 'main$(x)',
    'a:b', 'main\n--output=x', '`x`', 'ma|in', 'x=1',
  ])('rejects %j with E_TARGET', text => {
    let error: unknown;
    try { parseRange(text); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).code).toBe('E_TARGET');
  });

  it('does not echo long input back', () => {
    const error = (() => { try { parseRange(`${'a'.repeat(500)} b`); } catch (e) { return e as SourceError; } })();
    expect(error!.message.length).toBeLessThan(160);
  });

  it('uses the pattern of the design', () => {
    expect(RANGE_PATTERN.source).toBe(String.raw`^[\w./~^@{}-]+(\.\.\.?[\w./~^@{}-]+)?$`);
  });
});

describe('resolveRange', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  let main: string;
  let feature: string;
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    ctx = await makeContext(repo.root);
    main = await git(repo.root, ['rev-parse', 'main']);
    feature = await git(repo.root, ['rev-parse', 'feature']);
  });
  afterAll(async () => { await repo.cleanup(); });

  it('compares the working tree and the index with HEAD', async () => {
    expect(await resolveRange(ctx, undefined)).toEqual({kind: 'wt', label: 'wt', base: main, repoHead: main, diffArgs: [main]});
    expect(await resolveRange(ctx, 'staged')).toEqual({kind: 'staged', label: 'staged', base: main, repoHead: main, diffArgs: ['--cached', main]});
  });

  it('resolves both sides of a range to commit ids, and only those reach git', async () => {
    expect(await resolveRange(ctx, 'main..feature')).toEqual({
      kind: 'commits', label: 'main..feature', base: main, head: feature, repoHead: main, diffArgs: [main, feature], logArgs: [`${main}..${feature}`],
    });
    const older = await git(repo.root, ['rev-parse', 'main~3']);
    // three dots: the diff starts at the merge base, the log still lists what the right side adds
    expect(await resolveRange(ctx, 'main~3...feature')).toMatchObject({base: older, head: feature, logArgs: [`${older}..${feature}`]});
    expect(await resolveRange(ctx, 'feature...main~3')).toMatchObject({base: older, head: older, diffArgs: [older, older]});
    expect(await resolveRange(ctx, 'feature')).toMatchObject({label: 'feature...HEAD', base: main, head: main});
  });

  it('answers E_TARGET for a revision that does not exist and E_NO_GIT outside a repository', async () => {
    await expect(resolveRange(ctx, 'nope..main')).rejects.toMatchObject({code: 'E_TARGET', message: 'unknown revision "nope"'});
    await expect(resolveRange(ctx, 'main..nope')).rejects.toMatchObject({code: 'E_TARGET', message: 'unknown revision "nope"'});
    await expect(resolveRange(ctx, 'HEAD^{tree}')).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(resolveRange({...ctx, git: null}, 'wt')).rejects.toMatchObject({code: 'E_NO_GIT'});
  });

  it('never passes range text to git as an option', async () => {
    ctx.gitCalls.length = 0;
    await expect(resolveRange(ctx, '--output=x')).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(resolveRange(ctx, 'main..--output=x')).rejects.toMatchObject({code: 'E_TARGET'});
    expect(ctx.gitCalls).toEqual([]);
    await resolveRange(ctx, 'main..feature');
    // user text appears only behind --end-of-options, as a revision to verify
    for (const call of ctx.gitCalls.filter(args => args.some(arg => arg.includes('feature')))) {
      expect(call.slice(0, 4)).toEqual(['rev-parse', '--verify', '--quiet', '--end-of-options']);
    }
  });

  it('compares with the empty tree before the first commit', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-range-')));
    try {
      await git(dir, ['init', '-q', '-b', 'main']);
      const unborn = await makeContext(dir);
      const range = await resolveRange(unborn, 'wt');
      expect(range).toEqual({kind: 'wt', label: 'wt', base: undefined, repoHead: undefined, diffArgs: [await git(dir, ['hash-object', '-t', 'tree', devNull])]});
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('reports a missing merge base as E_SHALLOW in a shallow clone', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-range-')));
    try {
      const clone = join(dir, 'clone');
      await git(repo.root, ['clone', '-q', '--depth', '1', '--no-single-branch', `file://${repo.root}`, clone]);
      const shallow = await makeContext(clone);
      expect(shallow.git).toMatchObject({shallow: true});
      await expect(resolveRange(shallow, 'origin/main...origin/feature')).rejects.toMatchObject({code: 'E_SHALLOW'});
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
