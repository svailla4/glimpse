import {existsSync} from 'node:fs';
import {appendFile, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createRepoIndex, repoModel} from '../../src/analyze/index.ts';
import type {RepoIndex, RunGit} from '../../src/contracts.ts';
import {FIXTURE, createRunGit, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';

const noGit: RunGit = () => Promise.reject(new Error('fatal: not a git repository'));
const sorted = (values: Iterable<string>) => [...values].sort();
const ALL_FILES = sorted([...FIXTURE.tracked, ...FIXTURE.workingTree.untracked]);

describe('createRepoIndex on the fixture repository', () => {
  let repo: FixtureRepo;
  let index: RepoIndex;
  const logged: string[] = [];
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    index = createRepoIndex(repo.root, createRunGit(repo.root), message => void logged.push(message));
  });
  afterAll(async () => { await repo.cleanup(); });

  it('lists every tracked and untracked file with its language, size and flags', async () => {
    const files = await index.files();
    expect(files.map(file => file.path)).toEqual(ALL_FILES);
    const byPath = new Map(files.map(file => [file.path, file]));
    expect(byPath.get('src/auth/service.ts')).toEqual({
      path: 'src/auth/service.ts', lang: 'TypeScript', loc: 53, sloc: 45, bytes: 1432, binary: false, tracked: true, isTest: false, generated: false,
    });
    expect(byPath.get('src/lib/metrics.ts')).toMatchObject({tracked: false, lang: 'TypeScript'});
    expect(files.filter(file => file.isTest).map(file => file.path)).toEqual([
      'services/gateway/limiter/limiter_test.go', 'test/auth.test.ts', 'test/orders.test.ts', 'tools/tests/test_stats.py',
    ]);
    expect(files.some(file => file.binary || file.generated)).toBe(false);
    const langs = new Map<string, number>();
    for (const file of files) langs.set(file.lang ?? '?', (langs.get(file.lang ?? '?') ?? 0) + 1);
    expect(Object.fromEntries(langs)).toMatchObject({TypeScript: 19, Python: 6, Go: 4, CSS: 1, JSON: 2, Markdown: 1, TOML: 1});
  });

  it('extracts facts: the fixture TODO tags, outlines and complexity', async () => {
    const facts = await index.facts();
    const todos = [...facts].flatMap(([path, fact]) => fact.todos.map(todo => [todo.tag, path])).sort((a, b) => (a[1]! < b[1]! ? -1 : 1));
    expect(todos).toEqual([...FIXTURE.todos]);
    expect(facts.get('src/lib/config.ts')?.symbols.map(symbol => `${symbol.kind} ${symbol.name}`)).toEqual(['iface Config', 'fn loadConfig', 'const config']);
    expect(facts.get('services/gateway/limiter/limiter.go')?.symbols.map(symbol => `${symbol.kind} ${symbol.name}`)).toEqual(['class Limiter', 'fn New', 'method Allow']);
    expect(facts.get('tools/report.py')?.symbols.map(symbol => `${symbol.kind} ${symbol.name}`)).toEqual(['class Report', 'method __init__', 'method totals', 'method build', 'fn build_report']);
    // two-space TypeScript: the deepest line of login() is two levels in
    expect(facts.get('src/auth/service.ts')).toMatchObject({maxIndent: 2, complexity: 28});
    expect(facts.get('services/gateway/limiter/limiter.go')?.maxIndent).toBe(3);
    // data has no facts; Markdown has its headings as an outline (F092) and nothing else; a stylesheet has an entry
    // for its TODO scan only
    expect(facts.has('package.json')).toBe(false);
    expect(facts.get('README.md')?.symbols.map(symbol => `${symbol.kind} ${symbol.name} ${symbol.depth}`).slice(0, 2)).toEqual(['heading shop 0', 'heading Layout 1']);
    expect(facts.get('README.md')).toMatchObject({imports: [], complexity: 0, todos: []});
    expect(facts.get('src/ui/app.css')).toEqual({imports: [], symbols: [], complexity: 0, maxIndent: 0, todos: []});
  });

  it('resolves imports to file edges, expands Go package imports and names external packages', async () => {
    const edges = await index.edges();
    const has = (from: string, to: string) => edges.some(edge => edge.from === from && edge.to === to);
    const [a, b] = FIXTURE.cycle;
    expect(has(a, b) && has(b, a)).toBe(true);
    expect(has('src/index.ts', 'src/api/server.ts')).toBe(true);
    expect(has('src/ui/App.tsx', 'src/ui/app.css')).toBe(true);
    expect(has('tools/cli.py', 'tools/util.py') && has('tools/cli.py', 'tools/report.py') && has('tools/stats.py', 'tools/util.py')).toBe(true);
    expect(has('tools/tests/test_stats.py', 'tools/stats.py')).toBe(true);
    // a Go import names a package: every non-test file of it, never the test
    expect(has('services/gateway/main.go', 'services/gateway/limiter/limiter.go') && has('services/gateway/main.go', 'services/gateway/proxy/proxy.go')).toBe(true);
    expect(has('services/gateway/proxy/proxy.go', 'services/gateway/limiter/limiter.go')).toBe(true);
    expect(edges.some(edge => edge.to.endsWith('_test.go'))).toBe(false);
    // every target is a file of the inventory or an external package
    const paths = new Set(ALL_FILES);
    expect(edges.filter(edge => !edge.to.startsWith('ext:') && !paths.has(edge.to))).toEqual([]);
    expect(edges.filter(edge => !paths.has(edge.from))).toEqual([]);
    expect(sorted(new Set(edges.filter(edge => edge.to.startsWith('ext:')).map(edge => edge.to.slice(4))))).toEqual([...FIXTURE.npmImports]);
    expect(edges.find(edge => edge.from === 'src/orders/pricing.ts' && edge.to === 'src/orders/model.ts')?.kind).toBe('type');
  });

  it('finds the one import cycle and clusters into modules', async () => {
    const model = await repoModel({index, root: repo.root, name: 'shop'});
    expect(model.cycles).toEqual([[...FIXTURE.cycle]]);
    expect(model.cut.ids).toEqual(['src/auth', 'services/gateway', 'tools', 'src/lib', 'src/orders', 'src/api', 'src/ui', 'test', 'src/*']);
    expect(await index.moduleOf('src/auth/service.ts')).toBe('src/auth');
    expect(await index.moduleOf('./src/auth/brand-new.ts')).toBe('src/auth');
    expect(await index.moduleOf('services/gateway/limiter/limiter.go')).toBe('services/gateway');
    expect(await index.moduleOf('src/index.ts')).toBe('src/*');
    expect(await index.moduleOf('README.md')).toBe('(root)');
    expect(await index.moduleOf('nowhere/at/all.ts')).toBe('(root)');
    expect(model.manifests.packages.map(pkg => pkg.manifest)).toEqual([...FIXTURE.manifests]);
    expect(model.imports).toBeGreaterThan(40);
    expect(model.unresolved).toBe(0);
  });

  it('memoizes until invalidate(), then rereads only what changed', async () => {
    const before = await index.files();
    expect(await index.files()).toBe(before);
    expect(await index.facts()).toBe(await index.facts());
    expect(await index.edges()).toBe(await index.edges());
    logged.length = 0;

    await appendFile(join(repo.root, 'src/lib/metrics.ts'), "\nimport {log} from './logger';\n// TODO: export to a collector\n");
    await writeFile(join(repo.root, 'src/lib/extra.ts'), "export const extra = 1;\n");
    expect(await index.files()).toBe(before);
    index.invalidate();
    const after = await index.files();
    expect(after).not.toBe(before);
    expect(after.map(file => file.path)).toEqual(sorted([...ALL_FILES, 'src/lib/extra.ts']));
    // unchanged files keep their entry objects
    expect(after.find(file => file.path === 'README.md')).toBe(before.find(file => file.path === 'README.md'));
    expect(after.find(file => file.path === 'src/lib/metrics.ts')?.loc).toBe(12);
    expect((await index.facts()).get('src/lib/metrics.ts')?.todos).toEqual([{tag: 'TODO', line: 12, text: 'export to a collector'}]);
    expect((await index.edges()).some(edge => edge.from === 'src/lib/metrics.ts' && edge.to === 'src/lib/logger.ts')).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^glimpse: indexed 37 files in \d+ ms \(git, 35 unchanged\)$/);
  });

  it('answers concurrent callers from one scan, and survives invalidate() in the middle of one', async () => {
    logged.length = 0;
    index.invalidate();
    const [a, b, c] = await Promise.all([index.files(), index.files(), index.edges().then(() => index.files())]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(logged).toHaveLength(1);
    index.invalidate();
    const stale = index.files();
    index.invalidate();
    const fresh = index.files();
    expect((await stale).map(file => file.path)).toEqual((await fresh).map(file => file.path));
  });
});

describe('createRepoIndex without git', () => {
  let repo: FixtureRepo;
  let copy: string;
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    copy = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-nogit-')));
    await cp(repo.root, copy, {recursive: true, filter: source => !source.endsWith('/.git')});
  });
  afterAll(async () => {
    await repo.cleanup();
    await rm(copy, {recursive: true, force: true});
  });

  it('gives the same inventory, edges and modules from a plain directory', async () => {
    expect(existsSync(join(copy, '.git'))).toBe(false);
    const withGit = createRepoIndex(repo.root, createRunGit(repo.root), () => {});
    const plain = createRepoIndex(copy, noGit, () => {});
    const strip = async (index: RepoIndex) => (await index.files()).map(file => ({...file, tracked: false}));
    expect(await strip(plain)).toEqual(await strip(withGit));
    expect((await plain.files()).every(file => !file.tracked)).toBe(true);
    expect(await plain.edges()).toEqual(await withGit.edges());
    expect(await plain.moduleOf('src/auth/service.ts')).toBe('src/auth');
    expect((await repoModel({index: plain, root: copy, name: 'shop'})).cycles).toEqual([[...FIXTURE.cycle]]);
  });

  it('has(): the inventory rule for one path, without git: ignored files, dependency trees and links are not files of the project', async () => {
    const plain = createRepoIndex(copy, noGit, () => {});
    expect(await plain.has!('src/auth/service.ts')).toBe(true);
    expect(await plain.has!('./src/auth/service.ts')).toBe(true);
    for (const path of ['', 'src', 'src/nope.ts', '../outside.ts', '/etc/hosts', 'src/../package.json']) expect(await plain.has!(path), path).toBe(false);
    // created after the scan: the walk's own rules decide, path by path
    await mkdir(join(copy, 'node_modules/dep'), {recursive: true});
    await mkdir(join(copy, 'dist'), {recursive: true});
    await mkdir(join(copy, '.git'), {recursive: true});
    await writeFile(join(copy, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
    await writeFile(join(copy, 'dist/out.js'), 'var a = 1;\n');
    await writeFile(join(copy, 'trace.log'), 'noise\n');
    await writeFile(join(copy, '.git/config'), '[core]\n');
    await writeFile(join(copy, 'src/lib/later.ts'), 'export const later = 1;\n');
    await symlink(join(copy, '.git/config'), join(copy, 'src/lib/link.ts'));
    try {
      expect(await plain.has!('src/lib/later.ts')).toBe(true);
      for (const path of ['node_modules/dep/index.js', 'dist/out.js', 'trace.log', '.git/config', 'src/lib/link.ts']) expect(await plain.has!(path), path).toBe(false);
      // and the next scan agrees with every answer
      plain.invalidate();
      const listed = new Set((await plain.files()).map(file => file.path));
      expect(listed.has('src/lib/later.ts')).toBe(true);
      for (const path of ['node_modules/dep/index.js', 'dist/out.js', 'trace.log', '.git/config', 'src/lib/link.ts']) expect(listed.has(path), path).toBe(false);
    } finally {
      for (const name of ['node_modules', 'dist', '.git', 'trace.log', 'src/lib/later.ts', 'src/lib/link.ts']) await rm(join(copy, name), {recursive: true, force: true});
    }
  });

  it('derives the same model from any RepoIndex through its contract', async () => {
    const real = createRepoIndex(copy, noGit, () => {});
    const [files, facts, edges] = await Promise.all([real.files(), real.facts(), real.edges()]);
    let calls = 0;
    const fake: RepoIndex = {
      files: async () => {
        calls++;
        return files;
      },
      facts: async () => facts,
      edges: async () => edges,
      moduleOf: async () => 'unused',
      invalidate: () => {},
    };
    const derived = await repoModel({index: fake, root: copy, name: 'shop'});
    const own = await repoModel({index: real, root: copy, name: 'shop'});
    expect(derived.cycles).toEqual(own.cycles);
    expect(derived.cut.ids).toEqual(own.cut.ids);
    expect(derived.manifests.packages.map(pkg => pkg.name)).toEqual(own.manifests.packages.map(pkg => pkg.name));
    // the same file list gives the same model object; nothing is rebuilt
    expect(await repoModel({index: fake, root: copy, name: 'shop'})).toBe(derived);
    expect(calls).toBe(2);
  });
});

// Speed criterion of the work package, on a large polyglot checkout. Point GLIMPSE_BENCH_REPO at one to run it.
const benchRepo = process.env.GLIMPSE_BENCH_REPO;
describe.skipIf(!benchRepo || !existsSync(benchRepo))('speed on a large repository (GLIMPSE_BENCH_REPO)', () => {
  it('inventory, facts and edges take under 1.5 s', async () => {
    const root = await realpath(benchRepo!);
    const runGit = createRunGit(root);
    // one untimed pass so the measurement is of the analysis, not of a cold file cache
    await createRepoIndex(root, runGit, () => {}).files();
    const index = createRepoIndex(root, runGit, () => {});
    const started = performance.now();
    const [files, facts, edges] = [await index.files(), await index.facts(), await index.edges()];
    const elapsed = performance.now() - started;
    expect(files.length).toBeGreaterThan(1000);
    expect(facts.size).toBeGreaterThan(500);
    expect(edges.length).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(1500);
    // and a rescan after invalidate() rereads nothing
    index.invalidate();
    const again = performance.now();
    await index.edges();
    expect(performance.now() - again).toBeLessThan(elapsed);
  });
});
