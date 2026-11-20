// The production RunGit: an argument vector with no shell, nothing on stdin, an output cap, abort, and children that
// die with the session.
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createRunGit, GIT_MAX_BUFFER, SAFE_CONFIG} from '../../src/session/rungit.ts';
import {tempRoot} from './fakes.ts';

let dir: Awaited<ReturnType<typeof tempRoot>>;
beforeAll(async () => {
  dir = await tempRoot();
  execFileSync('git', ['init', '-q', dir.root]);
  await writeFile(join(dir.root, 'héllo wörld.txt'), 'x\n');
});
afterAll(() => dir.cleanup());

const posix = process.platform !== 'win32';

describe('createRunGit', () => {
  it('runs git in the root and resolves with stdout as a Buffer', async () => {
    const {runGit} = createRunGit(dir.root);
    const top = await runGit(['rev-parse', '--show-toplevel']);
    expect(Buffer.isBuffer(top)).toBe(true);
    expect(top.toString('utf8').trim()).toBe(dir.root);
  });

  it('passes core.quotepath=off, so non-ASCII paths come back as written', async () => {
    const {runGit} = createRunGit(dir.root);
    expect((await runGit(['ls-files', '-o', '--exclude-standard'])).toString('utf8')).toBe('héllo wörld.txt\n');
  });

  it('gives the child no stdin', async () => {
    const {runGit} = createRunGit(dir.root);
    // hash-object --stdin would wait forever on an inherited terminal; with stdin ignored it hashes empty input
    expect((await runGit(['hash-object', '--stdin'])).toString('utf8').trim()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('never goes through a shell: metacharacters are plain argument text', async () => {
    const {runGit} = createRunGit(dir.root);
    const marker = join(dir.root, 'pwned');
    await expect(runGit(['rev-parse', '--verify', `HEAD; touch ${marker}`])).rejects.toThrow(/^git rev-parse --verify HEAD; touch .* failed: /);
    await expect(runGit([`status$(touch ${marker})`])).rejects.toThrow(/failed/);
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects with the command and stderr on a non-zero exit', async () => {
    const {runGit} = createRunGit(dir.root);
    await expect(runGit(['rev-parse', '--verify', 'no-such-ref'])).rejects.toThrow(/^git rev-parse --verify no-such-ref failed: fatal: /);
  });

  it('caps the output: 64 MB by default, less on request', async () => {
    expect(GIT_MAX_BUFFER).toBe(64 * 1024 * 1024);
    const {runGit} = createRunGit(dir.root);
    await expect(runGit(['help', '-a'], {maxBuffer: 16})).rejects.toThrow(/^git help failed: output exceeds/);
    expect((await runGit(['help', '-a'])).length).toBeGreaterThan(16);
  });

  it('reports a missing git binary instead of hanging', async () => {
    const {runGit} = createRunGit(dir.root, {PATH: join(dir.root, 'empty-bin')});
    await expect(runGit(['version'])).rejects.toThrow(/^git version failed: /);
  });

  it.skipIf(!posix)('an abort signal kills the child', async () => {
    const {runGit} = createRunGit(dir.root);
    const controller = new AbortController();
    const started = Date.now();
    const running = runGit(['-c', 'alias.wait=!sleep 20', 'wait'], {signal: controller.signal});
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toThrow('git -c aborted');
    expect(Date.now() - started).toBeLessThan(5000);
    const already = new AbortController();
    already.abort();
    await expect(runGit(['version'], {signal: already.signal})).rejects.toThrow(/aborted/);
  });

  // Finding F052: the repository's .git/config is untrusted. core.fsmonitor names a program git runs for a plain
  // `git status`; Glimpse only reads, so it is switched off on every call (and so are hooks).
  it.skipIf(!posix)('a core.fsmonitor program set by the repository never runs', async () => {
    const repo = await tempRoot();
    try {
      execFileSync('git', ['init', '-q', repo.root]);
      const marker = join(repo.root, 'fsmonitor-ran');
      const hook = join(repo.root, 'monitor.sh');
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, {mode: 0o755});
      execFileSync('git', ['-C', repo.root, 'config', 'core.fsmonitor', hook]);
      // without the override git does run it, so the test can tell
      execFileSync('git', ['-C', repo.root, 'status', '--porcelain'], {stdio: 'ignore'});
      const runs = existsSync(marker);
      await rm(marker, {force: true});
      const {runGit} = createRunGit(repo.root);
      await runGit(['status', '--porcelain', '-z', '--', '.']);
      await runGit(['diff', '--numstat']);
      expect(runs).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(SAFE_CONFIG).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null']));
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(!posix)('killAll ends running children and refuses new work', async () => {
    const runner = createRunGit(dir.root);
    const started = Date.now();
    const running = runner.runGit(['-c', 'alias.wait=!sleep 20', 'wait']).catch(error => String(error));
    await new Promise(resolve => setTimeout(resolve, 50));
    runner.killAll();
    expect(await running).toMatch(/failed/);
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(runner.runGit(['version'])).rejects.toThrow('the session has ended');
  });
});
