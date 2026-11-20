import {chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {listFiles, MAX_READ_BYTES, scanFiles, walkFiles, type ScanRecord} from '../../src/analyze/inventory.ts';
import type {RunGit} from '../../src/contracts.ts';
import {FIXTURE, createRunGit, git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';

const noGit: RunGit = () => Promise.reject(new Error('fatal: not a git repository (or any of the parent directories): .git'));
const quiet = () => {};

async function write(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), {recursive: true});
    await writeFile(join(root, path), content);
  }
}

describe('listing', () => {
  let repo: FixtureRepo;
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    // Things git ignores or that an inventory must not pick up.
    await write(repo.root, {
      'node_modules/pg/index.js': 'module.exports = {};\n',
      'dist/bundle.js': 'var a;\n',
      'debug.log': 'noise\n',
      'tools/__pycache__/cli.cpython-311.pyc': 'x',
      'src/ui/.gitignore': '*.tmp\n!keep.tmp\n/local/\n',
      'src/ui/scratch.tmp': 'x\n',
      'src/ui/keep.tmp': 'x\n',
      'src/ui/local/notes.ts': 'export {};\n',
      'src/ui/components/local/kept.ts': 'export {};\n',
    });
  });
  afterAll(async () => { await repo.cleanup(); });

  it('lists tracked and untracked files from git, flagged, sorted, without ignored files', async () => {
    const listing = await listFiles(repo.root, createRunGit(repo.root), quiet);
    expect(listing.source).toBe('git');
    expect(listing.files.filter(file => file.tracked).map(file => file.path)).toEqual([...FIXTURE.tracked].sort());
    expect(listing.files.filter(file => !file.tracked).map(file => file.path)).toEqual(['src/lib/metrics.ts', 'src/ui/.gitignore', 'src/ui/components/local/kept.ts', 'src/ui/keep.tmp']);
    expect(listing.files.map(file => file.path)).toEqual(listing.files.map(file => file.path).sort());
  });

  it('the walker matches git ls-files on the fixture, nested .gitignore files included', async () => {
    const fromGit = (await git(repo.root, ['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').filter(Boolean).sort();
    const walked = await walkFiles(repo.root);
    expect(walked.paths).toEqual(fromGit);
    expect(walked.warnings).toEqual([]);
  });

  it('falls back to the walker when git fails, and says so once', async () => {
    const logged: string[] = [];
    const listing = await listFiles(repo.root, noGit, message => void logged.push(message));
    expect(listing.source).toBe('walk');
    expect(listing.files.every(file => !file.tracked)).toBe(true);
    expect(listing.files.map(file => file.path)).toContain('src/auth/service.ts');
    expect(listing.files.map(file => file.path)).not.toContain('node_modules/pg/index.js');
    expect(logged).toEqual(['glimpse: listing files without git (fatal: not a git repository (or any of the parent directories): .git)']);
  });

  it('skips submodules, repeats of a path during a merge and untracked node_modules', async () => {
    const staged = ['100644 1111111111111111111111111111111111111111 0\ta.ts', '160000 2222222222222222222222222222222222222222 0\tvendor/sub',
      '100644 3333333333333333333333333333333333333333 1\tconflict.ts', '100644 4444444444444444444444444444444444444444 2\tconflict.ts',
      '100644 5555555555555555555555555555555555555555 0\tsp ace/é.ts', ''].join('\0');
    const others = ['new.ts', 'node_modules/x/index.js', 'web/node_modules/y/index.js', '.venv/lib/site.py', 'app/__pycache__/a.pyc', 'venv', ''].join('\0');
    const fake: RunGit = args => Promise.resolve(Buffer.from(args.includes('-o') ? others : staged));
    const listing = await listFiles(repo.root, fake, quiet);
    expect(listing.files).toEqual([
      {path: 'a.ts', tracked: true}, {path: 'conflict.ts', tracked: true}, {path: 'new.ts', tracked: false}, {path: 'sp ace/é.ts', tracked: true},
      {path: 'venv', tracked: false},
    ]);
    // a tracked file is the repository's choice, wherever it lives
    const tracked: RunGit = args => Promise.resolve(Buffer.from(args.includes('-o') ? '' : '100644 1111111111111111111111111111111111111111 0\tnode_modules/patched/index.js\0'));
    expect((await listFiles(repo.root, tracked, quiet)).files).toEqual([{path: 'node_modules/patched/index.js', tracked: true}]);
  });

  it('the walker stops at its limit and reports it', async () => {
    const walked = await walkFiles(repo.root, 10);
    expect(walked.paths).toHaveLength(10);
    expect(walked.warnings).toEqual(['file listing stopped at 10 files']);
  });
});

describe('scanning', () => {
  let root: string;
  let outside: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-inventory-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-outside-')));
    await write(outside, {'secret.ts': 'export const secret = 1;\n'});
    await write(root, {
      'src/a.ts': "import {b} from './b';\n\nexport function a() {\n  return b;\n}\n",
      'src/b.ts': 'export const b = 1;',
      'src/empty.ts': '',
      'src/blank.ts': '\n\n   \n',
      'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
      'data/blob.dat2': Buffer.from([1, 2, 0, 3, 4]),
      'web/app.bundle.js': `var a=1;${'x=x+1;'.repeat(2000)}\n`,
      'api/service.ts': '// Code generated by tool. DO NOT EDIT.\nexport const generated = 1;\n',
      'package-lock.json': '{\n  "lockfileVersion": 3\n}\n',
      'big/huge.ts': Buffer.alloc(MAX_READ_BYTES + 1, 'a'),
      'notes.xyz': 'plain text\nof an unknown kind\n',
      'lib/app.ex': 'defmodule App do\n  # TODO: supervise\n  def run do\n    :ok\n  end\nend\n',
    });
    await symlink(join(outside, 'secret.ts'), join(root, 'src/link-out.ts'));
    await symlink(join(root, 'src/a.ts'), join(root, 'src/link-in.ts'));
    await symlink(outside, join(root, 'linked-dir'));
    await writeFile(join(root, 'src/locked.ts'), 'export const locked = 1;\n');
    await chmod(join(root, 'src/locked.ts'), 0o000);
  });
  afterAll(async () => {
    await chmod(join(root, 'src/locked.ts'), 0o644).catch(() => {});
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  });

  it('never follows symbolic links, to files or to directories', async () => {
    const walked = await walkFiles(root);
    expect(walked.paths.filter(path => path.includes('link'))).toEqual([]);
    // git lists a link as a path; the scan still refuses to read through it
    const scan = await scanFiles(root, {files: [{path: 'src/link-out.ts', tracked: true}, {path: 'linked-dir/secret.ts', tracked: true}, {path: 'src/a.ts', tracked: true}], source: 'git', warnings: []}, new Map());
    expect(scan.entries.map(entry => entry.path)).toEqual(['src/a.ts']);
  });

  it('classifies every kind of file without failing on any of them', async () => {
    const walked = await walkFiles(root);
    const scan = await scanFiles(root, {files: walked.paths.map(path => ({path, tracked: false})), source: 'walk', warnings: []}, new Map());
    const byPath = new Map(scan.entries.map(entry => [entry.path, entry]));
    expect(byPath.get('src/a.ts')).toEqual({path: 'src/a.ts', lang: 'TypeScript', loc: 5, sloc: 4, bytes: 60, binary: false, tracked: false, isTest: false, generated: false});
    expect(byPath.get('src/b.ts')).toMatchObject({loc: 1, sloc: 1});
    expect(byPath.get('src/empty.ts')).toMatchObject({loc: 0, sloc: 0, bytes: 0, binary: false});
    expect(byPath.get('src/blank.ts')).toMatchObject({loc: 3, sloc: 0});
    expect(byPath.get('assets/logo.png')).toMatchObject({binary: true, loc: 0});
    expect(byPath.get('data/blob.dat2')).toMatchObject({binary: true, loc: 0});
    expect(byPath.get('data/blob.dat2')?.lang).toBeUndefined();
    expect(byPath.get('web/app.bundle.js')).toMatchObject({generated: true, binary: false, loc: 1});
    expect(byPath.get('api/service.ts')).toMatchObject({generated: true, loc: 2});
    expect(byPath.get('package-lock.json')).toMatchObject({generated: true, lang: 'JSON', loc: 3});
    expect(byPath.get('big/huge.ts')).toMatchObject({loc: 0, bytes: MAX_READ_BYTES + 1, binary: false});
    expect(byPath.get('notes.xyz')).toMatchObject({loc: 2, binary: false});
    expect(byPath.get('lib/app.ex')).toMatchObject({lang: 'Elixir', loc: 6});

    // facts exist for what was scanned: code and commented formats, never generated, binary or oversized files
    expect([...scan.facts.keys()].sort()).toEqual(process.getuid?.() === 0
      ? ['lib/app.ex', 'src/a.ts', 'src/b.ts', 'src/blank.ts', 'src/locked.ts']
      : ['lib/app.ex', 'src/a.ts', 'src/b.ts', 'src/blank.ts']);
    expect(scan.facts.get('src/a.ts')).toMatchObject({imports: [{spec: './b', kind: 'static', line: 1}], symbols: [{name: 'a', kind: 'fn', line: 3, endLine: 5, depth: 0, exported: true}]});
    // a language without patterns still yields complexity and TODO tags, and no symbols
    expect(scan.facts.get('lib/app.ex')).toEqual({imports: [], symbols: [], complexity: 4, maxIndent: 2, todos: [{tag: 'TODO', line: 2, text: 'supervise'}]});
    expect(scan.warnings).toContain('1 file over 2 MB counted by size only');
  });

  it.skipIf(process.getuid?.() === 0)('keeps an unreadable file in the inventory and reports it', async () => {
    const scan = await scanFiles(root, {files: [{path: 'src/locked.ts', tracked: true}, {path: 'src/gone.ts', tracked: true}], source: 'git', warnings: ['from the listing']}, new Map());
    expect(scan.entries).toEqual([{path: 'src/locked.ts', lang: 'TypeScript', loc: 0, sloc: 0, bytes: 25, binary: false, tracked: true, isTest: false, generated: false}]);
    expect(scan.warnings).toEqual(['from the listing', '1 file could not be read']);
  });

  it('reuses the record of every file whose size and times did not change', async () => {
    const listing = {files: [{path: 'src/a.ts', tracked: true}, {path: 'src/b.ts', tracked: true}, {path: 'lib/app.ex', tracked: true}], source: 'git' as const, warnings: []};
    const cache = new Map<string, ScanRecord>();
    const first = await scanFiles(root, listing, cache);
    expect(first.reused).toBe(0);
    const second = await scanFiles(root, listing, cache);
    expect(second.reused).toBe(3);
    expect(second.entries[0]).toBe(first.entries[0]);
    await writeFile(join(root, 'src/b.ts'), 'export const b = 2;\nexport const c = 3;\n');
    const third = await scanFiles(root, listing, cache);
    expect(third.reused).toBe(2);
    expect(third.entries.find(entry => entry.path === 'src/b.ts')).toMatchObject({loc: 2});
    expect(third.facts.get('src/b.ts')?.symbols.map(symbol => symbol.name)).toEqual(['b', 'c']);
    // a file that left the listing leaves the cache
    await scanFiles(root, {...listing, files: listing.files.slice(0, 1)}, cache);
    expect([...cache.keys()]).toEqual(['src/a.ts']);
  });

  it('the walker never enters dependency and cache directories, ignored or not', async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-caches-')));
    try {
      await write(plain, {
        'app/main.py': 'print(1)\n', '.venv/lib/python3.12/site-packages/x/__init__.py': '', 'app/__pycache__/main.cpython-312.pyc': 'x',
        'web/node_modules/react/index.js': '', 'web/.next/cache/a.js': '', '.idea/workspace.xml': '', 'ios/Pods/A/a.m': '', 'web/src/index.ts': '', '.github/workflows/ci.yml': '',
      });
      expect((await walkFiles(plain)).paths).toEqual(['.github/workflows/ci.yml', 'app/main.py', 'web/src/index.ts']);
    } finally {
      await rm(plain, {recursive: true, force: true});
    }
  });

  it('an empty or missing directory is an empty inventory', async () => {
    const empty = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-empty-')));
    try {
      expect(await walkFiles(empty)).toEqual({paths: [], warnings: []});
      expect(await walkFiles(join(empty, 'missing'))).toEqual({paths: [], warnings: ['1 directory could not be read']});
    } finally {
      await rm(empty, {recursive: true, force: true});
    }
  });
});
