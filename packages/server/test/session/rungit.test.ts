// The production RunGit: an argument vector with no shell, nothing on stdin, an output cap, abort, and children that
// die with the session.
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {delimiter, dirname, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createRunGit, filterOverrides, GIT_MAX_BUFFER, SAFE_CONFIG, withoutSubmoduleTrees} from '../../src/session/rungit.ts';
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

  // Finding V017: a filter driver of the repository's own configuration ran on every `git status` and `git diff`.
  it.skipIf(!posix)('a filter driver set by the repository never runs; git still reads the tree', async () => {
    const repo = await tempRoot();
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', repo.root, ...args], {stdio: 'pipe', env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'}});
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', ['test', 'example.invalid'].join('@'));
      const marker = join(repo.root, 'filter-ran');
      await writeFile(join(repo.root, 'a.txt'), 'one\n');
      await writeFile(join(repo.root, '.gitattributes'), '* filter=evil\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
      git('config', 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`);
      git('config', 'filter.evil.smudge', `sh -c 'touch "${marker}"; cat'`);
      git('config', 'filter.evil.required', 'true');
      await writeFile(join(repo.root, 'a.txt'), 'one\ntwo\n');
      // without the override git does run it, so the test can tell
      git('diff', '--numstat');
      const runs = existsSync(marker);
      await rm(marker, {force: true});
      const {runGit} = createRunGit(repo.root);
      expect((await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])).toString()).toContain('a.txt');
      expect((await runGit(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD'])).toString()).toMatch(/^1\t0\ta\.txt/);
      expect(runs).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  // Finding V017, re-attack b17: the superproject defines no driver; its submodule's own config (.git/modules/sub/config,
  // part of the same untrusted .git directory) does, and `git status` / `git diff` ran it inside the submodule.
  it.skipIf(!posix)('a filter driver of a submodule never runs either: git stays out of the submodules\' working trees', async () => {
    const repo = await tempRoot();
    const source = await tempRoot();
    try {
      const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'};
      const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe', env});
      for (const root of [source.root, repo.root]) {
        git(root, 'init', '-q');
        git(root, 'config', 'user.name', 'Test');
        git(root, 'config', 'user.email', ['test', 'example.invalid'].join('@'));
      }
      await writeFile(join(source.root, 's.txt'), 'one\n');
      await writeFile(join(source.root, '.gitattributes'), '* filter=evil2\n');
      git(source.root, 'add', '-A');
      git(source.root, 'commit', '-q', '-m', 'sub');
      await writeFile(join(repo.root, 'top.txt'), 'top\n');
      git(repo.root, 'add', '-A');
      git(repo.root, 'commit', '-q', '-m', 'top');
      git(repo.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, 'sub');
      git(repo.root, 'commit', '-q', '-m', 'add sub');
      const marker = join(repo.root, 'sub-filter-ran');
      git(join(repo.root, 'sub'), 'config', 'filter.evil2.clean', `sh -c 'touch "${marker}"; cat'`);
      await writeFile(join(repo.root, 'sub', 's.txt'), 'one\ntwo\n');
      await writeFile(join(repo.root, 'top.txt'), 'top\nmore\n');
      // without Glimpse, a plain status runs the submodule's filter, so the test can tell
      git(repo.root, 'status', '--porcelain');
      const runs = existsSync(marker);
      await rm(marker, {force: true});
      const {runGit} = createRunGit(repo.root, env);
      expect((await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])).toString()).toContain('top.txt');
      expect((await runGit(['diff-files', '--name-only', '--relative', '-z'])).toString()).toContain('top.txt');
      expect((await runGit(['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--relative', '--numstat', '-z', 'HEAD'])).toString()).toMatch(/^1\t0\ttop\.txt/);
      expect(runs).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await repo.cleanup();
      await source.cleanup();
    }
  });

  it('withoutSubmoduleTrees adds --ignore-submodules=dirty to the commands that look into submodules, and only to them', () => {
    expect(withoutSubmoduleTrees(['status', '--porcelain', '--', '.'])).toEqual(['status', '--ignore-submodules=dirty', '--porcelain', '--', '.']);
    expect(withoutSubmoduleTrees(['--literal-pathspecs', 'diff', '-U3', 'HEAD'])).toEqual(['--literal-pathspecs', 'diff', '--ignore-submodules=dirty', '-U3', 'HEAD']);
    expect(withoutSubmoduleTrees(['-c', 'a.b=c', 'diff-files', '-z'])).toEqual(['-c', 'a.b=c', 'diff-files', '--ignore-submodules=dirty', '-z']);
    expect(withoutSubmoduleTrees(['diff', '--ignore-submodules=all'])).toEqual(['diff', '--ignore-submodules=all']);
    expect(withoutSubmoduleTrees(['log', '--', 'status'])).toEqual(['log', '--', 'status']);
    expect(withoutSubmoduleTrees(['ls-files', '-o'])).toEqual(['ls-files', '-o']);
  });

  it('filterOverrides empties the drivers of the repository and leaves the user\'s own', () => {
    const listing = ['local', 'filter.evil.clean\nsh -c x', 'global', 'filter.lfs.clean\ngit-lfs clean -- %f', 'worktree', 'filter.wt.process\nrun', 'local', 'filter.a=b.smudge\ncat', ''].join('\0');
    expect(filterOverrides(listing, true)).toEqual([
      'filter.evil.clean=', 'filter.evil.smudge=', 'filter.evil.process=', 'filter.evil.required=false',
      'filter.wt.clean=', 'filter.wt.smudge=', 'filter.wt.process=', 'filter.wt.required=false',
      'filter.a=b.clean=', 'filter.a=b.smudge=', 'filter.a=b.process=', 'filter.a=b.required=false',
    ]);
    expect(filterOverrides(['filter.x.clean\ncat', ''].join('\0'), false)).toEqual(['filter.x.clean=', 'filter.x.smudge=', 'filter.x.process=', 'filter.x.required=false']);
    expect(filterOverrides('', true)).toEqual([]);
  });

  // Finding V019: a repository-committed node_modules/.bin/git ran on the first tool call.
  it.skipIf(!posix)('git is found by its absolute path outside the project, never through a relative PATH entry', async () => {
    const repo = await tempRoot();
    try {
      execFileSync('git', ['init', '-q', repo.root]);
      const marker = join(repo.root, 'repo-git-ran');
      await mkdir(join(repo.root, 'node_modules', '.bin'), {recursive: true});
      await writeFile(join(repo.root, 'node_modules', '.bin', 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, {mode: 0o755});
      const real = dirname(execFileSync('sh', ['-c', 'command -v git']).toString().trim());
      const {runGit} = createRunGit(repo.root, {PATH: ['node_modules/.bin', join(repo.root, 'node_modules', '.bin'), real].join(delimiter)});
      expect((await runGit(['rev-parse', '--is-inside-work-tree'])).toString().trim()).toBe('true');
      expect(existsSync(marker)).toBe(false);
      const only = createRunGit(repo.root, {PATH: 'node_modules/.bin'});
      await expect(only.runGit(['version'])).rejects.toThrow(/git was not found on PATH/);
      expect(existsSync(marker)).toBe(false);
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
