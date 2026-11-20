import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {readGitInfo} from '../../src/git/index.ts';
import {createRunGit, git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';

describe('readGitInfo', () => {
  let repo: FixtureRepo;
  const scratch: string[] = [];
  const tempDir = async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-git-info-')));
    scratch.push(dir);
    return dir;
  };
  beforeAll(async () => { repo = await makeFixtureRepo({dirty: false}); });
  afterAll(async () => {
    await repo.cleanup();
    for (const dir of scratch) await rm(dir, {recursive: true, force: true});
  });

  it('reads branch, abbreviated head and default branch of a repository', async () => {
    const info = await readGitInfo(repo.root, createRunGit(repo.root));
    expect(info).toEqual({shallow: false, head: (await git(repo.root, ['rev-parse', 'HEAD'])).slice(0, 7), branch: 'main', defaultBranch: 'main'});
  });

  it('answers null outside a repository', async () => {
    const dir = await tempDir();
    expect(await readGitInfo(dir, createRunGit(dir))).toBeNull();
  });

  it('answers null when git cannot run at all', async () => {
    expect(await readGitInfo(repo.root, () => Promise.reject(new Error('spawn git ENOENT')))).toBeNull();
  });

  it('flags a shallow clone', async () => {
    const dir = join(await tempDir(), 'clone');
    await git(repo.root, ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${repo.root}`, dir]);
    // a single-branch clone of `feature` knows no main, no master and no origin/HEAD: there is no default branch to name
    expect(await readGitInfo(dir, createRunGit(dir))).toEqual({shallow: true, head: await git(dir, ['rev-parse', '--short', 'HEAD']), branch: 'feature'});
  });

  it('names a default branch that resolves locally, falling back to the remote-tracking ref', async () => {
    const dir = join(await tempDir(), 'clone');
    await git(repo.root, ['clone', '-q', `file://${repo.root}`, dir]);
    expect((await readGitInfo(dir, createRunGit(dir)))!.defaultBranch).toBe('main');
    await git(dir, ['checkout', '-q', 'feature']);
    await git(dir, ['branch', '-q', '-D', 'main']);
    expect(await readGitInfo(dir, createRunGit(dir))).toMatchObject({branch: 'feature', defaultBranch: 'origin/main'});
  });

  it('has no branch on a detached HEAD and no head before the first commit', async () => {
    const detached = join(await tempDir(), 'detached');
    await git(repo.root, ['clone', '-q', `file://${repo.root}`, detached]);
    await git(detached, ['checkout', '-q', '--detach', 'HEAD~2']);
    const info = await readGitInfo(detached, createRunGit(detached));
    expect(info!.branch).toBeUndefined();
    expect(info!.head).toBe(await git(detached, ['rev-parse', '--short', 'HEAD']));
    expect(info!.shallow).toBe(false);

    const unborn = await tempDir();
    await git(unborn, ['init', '-q', '-b', 'trunk']);
    expect(await readGitInfo(unborn, createRunGit(unborn))).toEqual({shallow: false, branch: 'trunk'});
  });
});
