import {appendFile, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import type {TreeWatcher} from '../../src/contracts.ts';
import {createTreeWatcher, fingerprint} from '../../src/git/watcher.ts';
import {git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {makeContext, type TestContext} from './context.ts';

const INTERVAL = 40;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

describe('createTreeWatcher', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  let watcher: TreeWatcher | undefined;
  let fired = 0;

  /** Starts a watcher and returns once it has taken its first fingerprint and is polling. */
  const watch = async () => {
    fired = 0;
    ctx.gitCalls.length = 0;
    watcher = createTreeWatcher(ctx, {minIntervalMs: INTERVAL, backoffFactor: 1});
    watcher.start(() => { fired++; });
    // four git calls per look: the reference taken at creation, then the first poll
    await waitFor(() => ctx.gitCalls.length >= 8);
  };
  /** Long enough for several polls. */
  const severalPolls = async () => {
    const polls = ctx.gitCalls.length;
    await waitFor(() => ctx.gitCalls.length >= polls + 12);
  };

  beforeAll(async () => {
    repo = await makeFixtureRepo();
    ctx = await makeContext(repo.root);
  });
  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });
  afterAll(async () => { await repo.cleanup(); });

  it('stays quiet while nothing changes', async () => {
    await watch();
    await severalPolls();
    expect(fired).toBe(0);
  });

  it('fires once after an edit to a clean file, and again after an edit to a file that was already modified', async () => {
    await watch();
    const callsAtEdit = ctx.gitCalls.length;
    await appendFile(join(repo.root, 'README.md'), '\nA new paragraph.\n');
    await waitFor(() => fired === 1);
    // within one interval: seen by the first poll that starts after the edit. This check runs a little later, so a
    // few more polls of four git calls each may have started; many more would mean the change was missed at first.
    expect(ctx.gitCalls.length - callsAtEdit).toBeLessThanOrEqual(16);
    await severalPolls();
    expect(fired).toBe(1);
    await appendFile(join(repo.root, 'README.md'), 'And one more line.\n');
    await waitFor(() => fired === 2);
    await severalPolls();
    expect(fired).toBe(2);
  });

  it('fires for a new untracked file, but not for an ignored one', async () => {
    await watch();
    await writeFile(join(repo.root, 'debug.log'), 'ignored by .gitignore\n');
    await severalPolls();
    expect(fired).toBe(0);
    await writeFile(join(repo.root, 'src/lib/fresh.ts'), 'export const fresh = true;\n');
    await waitFor(() => fired === 1);
    await severalPolls();
    expect(fired).toBe(1);
  });

  it('fires after staging and after a commit', async () => {
    await watch();
    await git(repo.root, ['add', '-A']);
    await waitFor(() => fired >= 1);
    await severalPolls();
    const afterStaging = fired;
    await git(repo.root, ['commit', '-q', '-m', 'Commit everything']);
    await waitFor(() => fired > afterStaging);
    await severalPolls();
    const afterCommit = fired;
    await severalPolls();
    expect(fired).toBe(afterCommit);
  });

  it('stops polling on stop(), and start() replaces the previous callback', async () => {
    await watch();
    watcher!.stop();
    const calls = ctx.gitCalls.length;
    await writeFile(join(repo.root, 'after-stop.txt'), 'nobody is watching\n');
    await sleep(INTERVAL * 6);
    expect(fired).toBe(0);
    expect(ctx.gitCalls.length).toBe(calls);

    let second = 0;
    watcher!.start(() => { fired++; });
    watcher!.start(() => { second++; });
    // the first start's poll was cut short (four calls); the replacement needs its baseline and one more poll
    await waitFor(() => ctx.gitCalls.length >= calls + 12);
    await writeFile(join(repo.root, 'after-restart.txt'), 'watched again\n');
    await waitFor(() => second === 1);
    expect(fired).toBe(0);
    watcher!.stop();
    watcher!.stop();
  });

  it('keeps polling when the change handler throws', async () => {
    fired = 0;
    ctx.gitCalls.length = 0;
    ctx.logs.length = 0;
    watcher = createTreeWatcher(ctx, {minIntervalMs: INTERVAL, backoffFactor: 1});
    watcher.start(() => {
      fired++;
      throw new Error('handler bug');
    });
    await waitFor(() => ctx.gitCalls.length >= 8);
    await writeFile(join(repo.root, 'one.txt'), '1\n');
    await waitFor(() => fired === 1);
    await writeFile(join(repo.root, 'two.txt'), '2\n');
    await waitFor(() => fired === 2);
    expect(ctx.logs.some(line => line.includes('handler bug'))).toBe(true);
  });

  it('reports what changed while nobody was watching: before the first start, and between a stop and the next start', async () => {
    fired = 0;
    watcher = createTreeWatcher(ctx, {minIntervalMs: INTERVAL, backoffFactor: 1});
    // the reference is the state at creation, not the state at the first poll
    expect(await watcher.check!()).toBe(false);
    await writeFile(join(repo.root, 'before-any-tab.txt'), 'written before anybody watched\n');
    watcher.start(() => { fired++; });
    await waitFor(() => fired === 1);
    watcher.stop();
    await writeFile(join(repo.root, 'while-stopped.txt'), 'written while stopped\n');
    await sleep(INTERVAL * 4);
    expect(fired).toBe(1);
    watcher.start(() => { fired++; });
    await waitFor(() => fired === 2);
    await sleep(INTERVAL * 4);
    expect(fired).toBe(2);
  });

  it('check() looks on demand, with no poll running, and reports each change once', async () => {
    const quiet = createTreeWatcher(ctx, {minIntervalMs: INTERVAL});
    expect(await quiet.check!()).toBe(false);
    expect(await quiet.check!()).toBe(false);
    await writeFile(join(repo.root, 'checked.txt'), 'one\n');
    expect(await quiet.check!()).toBe(true);
    expect(await quiet.check!()).toBe(false);
    await appendFile(join(repo.root, 'checked.txt'), 'two\n');
    expect(await quiet.check!()).toBe(true);
    await git(repo.root, ['add', '-A']);
    expect(await quiet.check!()).toBe(true);
    await git(repo.root, ['commit', '-q', '-m', 'Commit what was checked']);
    expect(await quiet.check!()).toBe(true);
    expect(await quiet.check!()).toBe(false);
    // a change a check has reported is not reported again by a poll
    let polled = 0;
    quiet.start(() => { polled++; });
    await sleep(INTERVAL * 4);
    quiet.stop();
    expect(polled).toBe(0);
  });

  it('never rejects from check(): a look that fails is "no change seen"', async () => {
    const broken = createTreeWatcher({...ctx, runGit: () => Promise.reject(new Error('git is gone'))}, {minIntervalMs: INTERVAL});
    expect(await broken.check!()).toBe(false);
  });

  it('watches a directory that is not a repository by the files a walk lists, without running git', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-plain-')));
    try {
      await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
      await writeFile(join(dir, '.gitignore'), 'ignored.log\n');
      const calls: string[][] = [];
      const plain = createTreeWatcher({...ctx, root: dir, git: null, runGit: args => { calls.push(args); return Promise.reject(new Error('fatal: not a git repository')); }}, {minIntervalMs: INTERVAL, backoffFactor: 1});
      expect(await plain.check!()).toBe(false);
      await writeFile(join(dir, 'ignored.log'), 'noise\n');
      expect(await plain.check!()).toBe(false);
      await writeFile(join(dir, 'b.ts'), 'export const b = 1;\n');
      expect(await plain.check!()).toBe(true);
      await appendFile(join(dir, 'a.ts'), 'export const more = 2;\n');
      expect(await plain.check!()).toBe(true);
      await rm(join(dir, 'b.ts'));
      expect(await plain.check!()).toBe(true);
      expect(await plain.check!()).toBe(false);
      let seen = 0;
      plain.start(() => { seen++; });
      await sleep(INTERVAL * 3);
      expect(seen).toBe(0);
      await writeFile(join(dir, 'c.ts'), 'export const c = 1;\n');
      await waitFor(() => seen === 1);
      plain.stop();
      expect(calls).toEqual([]);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe('fingerprint', () => {
  it('is stable for an unchanged tree and names HEAD, the index and every modified or untracked file', async () => {
    const repo = await makeFixtureRepo();
    try {
      const ctx = await makeContext(repo.root);
      const first = await fingerprint(ctx);
      expect(await fingerprint(ctx)).toBe(first);
      const lines = first.split('\n');
      expect(lines[0]).toBe(`${await git(repo.root, ['rev-parse', 'HEAD'])} main`);
      expect(lines[1]).toMatch(/index:[\d.]+:\d+$/);
      expect(lines.slice(2).map(line => line.replace(/:[\d.]+:\d+$/, ''))).toEqual(['src/auth/service.ts', 'src/lib/metrics.ts', 'tools/stats.py']);
      await git(repo.root, ['checkout', '-q', '--', 'tools/stats.py']);
      const reverted = await fingerprint(ctx);
      expect(reverted).not.toBe(first);
      // a new branch at the same commit: HEAD's id is unchanged, its name is not
      await git(repo.root, ['checkout', '-q', '-b', 'same-commit']);
      const switched = await fingerprint(ctx);
      expect(switched).not.toBe(reverted);
      expect(switched.split('\n')[0]).toBe(`${await git(repo.root, ['rev-parse', 'HEAD'])} same-commit`);
    } finally {
      await repo.cleanup();
    }
  });
});
