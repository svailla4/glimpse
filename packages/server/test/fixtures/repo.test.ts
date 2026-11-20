import {existsSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURE, createRunGit, git, makeFixtureRepo, type FixtureRepo} from './repo.ts';

describe('makeFixtureRepo', () => {
  let repo: FixtureRepo;
  beforeAll(async () => { repo = await makeFixtureRepo(); });
  afterAll(async () => { await repo.cleanup(); });
  const lines = async (args: string[]) => (await git(repo.root, args)).split('\n').filter(Boolean);

  it('builds under the temp directory, on main, with the tracked files of the manifest', async () => {
    expect(repo.root.includes('glimpse-fixture-')).toBe(true);
    expect(existsSync(join(repo.root, '.git'))).toBe(true);
    expect(tmpdir().length).toBeGreaterThan(0);
    expect(await git(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(FIXTURE.branches.main);
    const tracked = (await lines(['ls-files'])).sort();
    expect(tracked).toEqual([...FIXTURE.tracked].sort());
    expect(tracked).toHaveLength(35);
    for (const manifest of FIXTURE.manifests) expect(tracked).toContain(manifest);
    expect(JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).name).toBe(FIXTURE.packageName);
  });

  it('has TypeScript, Python and Go sources', async () => {
    const tracked = await lines(['ls-files']);
    const count = (ext: RegExp) => tracked.filter(path => ext.test(path)).length;
    expect({ts: count(/\.tsx?$/), py: count(/\.py$/), go: count(/\.go$/)}).toEqual({ts: 18, py: 6, go: 4});
  });

  it('has 12 commits on main by three authors with the scripted dates', async () => {
    const log = await lines(['log', '--reverse', '--format=%aN|%at|%s', FIXTURE.branches.main]);
    expect(log).toHaveLength(FIXTURE.commits.main);
    expect(log.map(l => l.split('|')[2])).toEqual(FIXTURE.commits.subjects);
    const at = (iso: string) => String(Date.parse(iso) / 1000);
    expect(log[0]).toBe(`Mira Okafor|${at(FIXTURE.commits.first)}|Scaffold the shop service`);
    expect(log.at(-1)).toBe(`Jon Castell|${at(FIXTURE.commits.last)}|Add tests for auth and orders`);
    expect([FIXTURE.commits.first, FIXTURE.commits.last]).toEqual(['2026-08-03T09:00:00Z', '2026-11-04T12:00:00Z']);
    const byAuthor: Record<string, number> = {};
    for (const l of log) byAuthor[l.split('|')[0]!] = (byAuthor[l.split('|')[0]!] ?? 0) + 1;
    expect(byAuthor).toEqual(FIXTURE.commits.byAuthorOnMain);
    expect(Object.keys(byAuthor).sort()).toEqual([...FIXTURE.authors].sort());
    // committer date is fixed too, so commit ids are reproducible
    expect(await git(repo.root, ['log', '-1', '--format=%ct', FIXTURE.branches.main])).toBe(at(FIXTURE.commits.last));
  });

  it('has a feature branch three commits ahead of main', async () => {
    expect(await git(repo.root, ['rev-list', '--count', 'main..feature'])).toBe(String(FIXTURE.commits.featureAhead));
    expect(await git(repo.root, ['rev-list', '--count', 'feature..main'])).toBe('0');
    const status = await lines(['diff', '--name-status', 'main..feature']);
    expect(status.filter(l => l.startsWith('A')).map(l => l.split('\t')[1])).toEqual([...FIXTURE.feature.added]);
    expect(status.filter(l => l.startsWith('M')).map(l => l.split('\t')[1])).toEqual([...FIXTURE.feature.modified]);
  });

  it('leaves two unstaged edits and one untracked file on main', async () => {
    const status = await lines(['status', '--porcelain', '--untracked-files=all']);
    expect(status.sort()).toEqual([' M src/auth/service.ts', ' M tools/stats.py', '?? src/lib/metrics.ts']);
    expect(await lines(['diff', '--name-only'])).toEqual([...FIXTURE.workingTree.modified]);
    expect(await lines(['ls-files', '-o', '--exclude-standard'])).toEqual([...FIXTURE.workingTree.untracked]);
    expect(await lines(['diff', '--cached', '--name-only'])).toEqual([]);
    expect(await git(repo.root, ['diff', '--shortstat'])).toBe(' 2 files changed, 11 insertions(+), 1 deletion(-)');
  });

  it('records the rename of commit 9 and the churn and coupling the manifest states', async () => {
    const raw = await git(repo.root, ['log', '--reverse', '--no-merges', '-M', '--name-status', '--format=%x01%s', FIXTURE.branches.main]);
    const commits = raw.split('\x01').filter(Boolean).map(block => block.trim().split('\n').slice(1).filter(Boolean).map(l => l.split('\t')));
    expect(commits).toHaveLength(12);
    const renames = commits[FIXTURE.rename.commit - 1]!.filter(change => change[0]!.startsWith('R'));
    expect(renames.map(change => change.slice(1))).toEqual([[FIXTURE.rename.from, FIXTURE.rename.to]]);

    const touched = new Map<string, number>();
    const pairs = new Map<string, number>();
    for (const changes of commits) {
      const paths = changes.map(change => change.at(-1)!).sort();
      for (const path of paths) touched.set(path, (touched.get(path) ?? 0) + 1);
      for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) pairs.set(`${paths[i]}|${paths[j]}`, (pairs.get(`${paths[i]}|${paths[j]}`) ?? 0) + 1);
    }
    expect(Object.fromEntries([...touched].filter(([, n]) => n >= 3).sort())).toEqual(FIXTURE.churn);
    expect([...pairs].filter(([, n]) => n >= 3)).toEqual([[`${FIXTURE.coupled.a}|${FIXTURE.coupled.b}`, FIXTURE.coupled.shared]]);
  });

  it('contains the import cycle, the TODO comments and the npm imports of the manifest', async () => {
    const read = (path: string) => readFile(join(repo.root, path), 'utf8');
    const [a, b] = FIXTURE.cycle;
    expect(await git(repo.root, ['show', `main:${a}`])).toContain("from '../orders/service'");
    expect(await git(repo.root, ['show', `main:${b}`])).toContain("from '../auth/service'");

    const todos = (await lines(['grep', '-n', '-E', '(TODO|FIXME|HACK):', 'main', '--'])).map(l => {
      const [, path, , text] = /^main:([^:]+):(\d+):(.*)$/.exec(l)!;
      return [/(TODO|FIXME|HACK)/.exec(text!)![1], path];
    });
    expect(todos.sort()).toEqual([...FIXTURE.todos].map(t => [...t]).sort());

    const imported = new Set<string>();
    for (const path of FIXTURE.tracked.filter(p => /\.tsx?$/.test(p))) {
      for (const m of (await read(path)).matchAll(/from '([^'.][^']*)'/g)) if (!m[1]!.startsWith('node:')) imported.add(m[1]!);
    }
    expect([...imported].sort()).toEqual([...FIXTURE.npmImports]);
    expect(await read('go.mod')).toContain(`module ${FIXTURE.goModule}`);
  });

  it('createRunGit returns raw bytes, does not quote paths and rejects on failure', async () => {
    const runGit = createRunGit(repo.root);
    const out = await runGit(['ls-files', '-z']);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString('utf8').split('\0').filter(Boolean)).toHaveLength(35);
    await expect(runGit(['rev-parse', '--verify', 'no-such-ref'])).rejects.toThrow(/git rev-parse/);
    const controller = new AbortController();
    controller.abort();
    await expect(runGit(['log'], {signal: controller.signal})).rejects.toThrow();
  });
});

describe('makeFixtureRepo determinism and cleanup', () => {
  it('two builds have identical history; a clean build has no changes; cleanup removes the directory', async () => {
    const [a, b] = await Promise.all([makeFixtureRepo(), makeFixtureRepo({dirty: false})]);
    try {
      expect(a.root).not.toBe(b.root);
      for (const ref of ['main', 'feature']) expect(await git(a.root, ['rev-parse', ref])).toBe(await git(b.root, ['rev-parse', ref]));
      expect(await git(b.root, ['status', '--porcelain'])).toBe('');
      // the repository is usable: a plain commit works with the local identity
      await writeFile(join(b.root, 'NOTES.md'), 'scratch\n');
      await git(b.root, ['add', 'NOTES.md']);
      await git(b.root, ['commit', '-q', '-m', 'Scratch']);
      expect(await git(b.root, ['rev-list', '--count', 'HEAD'])).toBe('13');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
    expect(existsSync(a.root)).toBe(false);
    expect(existsSync(b.root)).toBe(false);
    await a.cleanup(); // safe to call twice
  });
});
