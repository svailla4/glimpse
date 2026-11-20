// Golden results of the fifteen files.*, repo.*, deps.* and code.* sources on the deterministic fixture repository.
import {SOURCE_BY_NAME, SOURCES, type DirNode, type GraphData} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {RepoContext} from '../../src/contracts.ts';
import {sources} from '../../src/sources/files/index.ts';
import {FIXTURE, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {checkResult, makeContext, MINE, run} from './helpers.ts';

let repo: FixtureRepo;
let ctx: RepoContext;
beforeAll(async () => {
  repo = await makeFixtureRepo();
  ctx = makeContext(repo.root);
});
afterAll(async () => { await repo.cleanup(); });

describe('the source list', () => {
  it('is the fifteen catalog sources of these four families, each with the catalog metadata', () => {
    const expected = SOURCES.filter(meta => /^(files|repo|deps|code)\./.test(meta.name)).map(meta => meta.name);
    expect(sources.map(source => source.meta.name).sort()).toEqual([...expected].sort());
    expect(expected).toHaveLength(15);
    for (const source of sources) expect(source.meta).toBe(SOURCE_BY_NAME.get(source.meta.name));
  });
});

describe('files.*', () => {
  it('files.tree: the whole tree with sizes, languages, commits, age and complexity', async () => {
    const result = await run(ctx, 'files.tree');
    const lines: string[] = [];
    const walk = (node: DirNode, depth: number) => {
      lines.push(`${'  '.repeat(depth)}${node.path || '.'} ${node.files} ${node.loc} ${node.lang ?? '-'} c${node.commits ?? '-'} a${node.age ?? '-'} x${node.complexity ?? '-'}`);
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    walk(result.data as DirNode, 0);
    expect(lines).toEqual([
      '. 36 634 TypeScript c12 a15 x372',
      '  src 18 364 TypeScript c10 a15 x240',
      '    src/auth 3 107 TypeScript c4 a15 x49',
      '      src/auth/service.ts 1 53 TypeScript c4 a15 x28',
      '      src/auth/session.ts 1 36 TypeScript c4 a15 x15',
      '      src/auth/tokens.ts 1 18 TypeScript c2 a64 x6',
      '    src/lib 5 84 TypeScript c3 a56 x47',
      '      src/lib/db.ts 1 23 TypeScript c1 a106 x13',
      '      src/lib/cache.ts 1 19 TypeScript c1 a106 x6',
      '      src/lib/config.ts 1 19 TypeScript c1 a108 x17',
      '      src/lib/logger.ts 1 14 TypeScript c2 a56 x9',
      '      src/lib/metrics.ts 1 9 TypeScript c- a- x2',
      '    src/orders 3 63 TypeScript c2 a44 x39',
      '      src/orders/service.ts 1 29 TypeScript c2 a44 x19',
      '      src/orders/pricing.ts 1 18 TypeScript c1 a86 x13',
      '      src/orders/model.ts 1 16 TypeScript c1 a86 x7',
      '    src/api 3 56 TypeScript c3 a56 x55',
      '      src/api/routes.ts 1 21 TypeScript c2 a86 x15',
      '      src/api/server.ts 1 20 TypeScript c2 a56 x29',
      '      src/api/middleware.ts 1 15 TypeScript c2 a56 x11',
      '    src/ui 3 46 TypeScript c1 a30 x49',
      '      src/ui/components 1 17 TypeScript c1 a30 x29',
      '        src/ui/components/Cart.tsx 1 17 TypeScript c1 a30 x29',
      '      src/ui/App.tsx 1 15 TypeScript c1 a30 x20',
      '      src/ui/app.css 1 14 CSS c1 a30 x0',
      '    src/index.ts 1 8 TypeScript c3 a56 x1',
      '  services 4 98 Go c1 a71 x76',
      '    services/gateway 4 98 Go c1 a71 x76',
      '      services/gateway/limiter 2 53 Go c1 a71 x39',
      '        services/gateway/limiter/limiter.go 1 36 Go c1 a71 x27',
      '        services/gateway/limiter/limiter_test.go 1 17 Go c1 a71 x12',
      '      services/gateway/proxy 1 26 Go c1 a71 x25',
      '        services/gateway/proxy/proxy.go 1 26 Go c1 a71 x25',
      '      services/gateway/main.go 1 19 Go c1 a71 x12',
      '  tools 6 87 Python c1 a78 x47',
      '    tools/stats.py 1 24 Python c1 a78 x16',
      '    tools/report.py 1 22 Python c1 a78 x14',
      '    tools/cli.py 1 20 Python c1 a78 x11',
      '    tools/util.py 1 11 Python c1 a78 x4',
      '    tools/tests 1 9 Python c1 a78 x2',
      '      tools/tests/test_stats.py 1 9 Python c1 a78 x2',
      '    tools/__init__.py 1 1 Python c1 a78 x0',
      '  test 2 21 TypeScript c1 a15 x9',
      '    test/orders.test.ts 1 11 TypeScript c1 a15 x4',
      '    test/auth.test.ts 1 10 TypeScript c1 a15 x5',
      '  package.json 1 21 JSON c2 a30 x0',
      '  pyproject.toml 1 12 TOML c1 a78 x0',
      '  README.md 1 11 Markdown c1 a108 x0',
      '  tsconfig.json 1 11 JSON c1 a108 x0',
      '  go.mod 1 5 Go Module c1 a71 x0',
      '  .gitignore 1 4 Ignore List c1 a108 x0',
    ]);
    expect(result).toMatchObject({total: 51, summary: '36 files, 634 loc'});
    expect(result.truncated).toBeUndefined();
    expect((result.data as DirNode)).toMatchObject({name: '', path: '', dir: true, bytes: 16867});
    expect(checkResult('files.tree', result)).toBe(51);
  });

  it('files.tree <path>: a subtree keeps repository-relative paths; a file is a tree of one', async () => {
    const sub = await run(ctx, 'files.tree src/auth/');
    expect(sub.data).toMatchObject({name: 'auth', path: 'src/auth', dir: true, files: 3, loc: 107, commits: 4});
    expect((sub.data as DirNode).children?.map(child => child.path)).toEqual(['src/auth/service.ts', 'src/auth/session.ts', 'src/auth/tokens.ts']);
    expect(sub.summary).toBe('3 files, 107 loc');
    const file = await run(ctx, 'files.tree ./src/auth/service.ts#L10-20');
    expect(file.data).toEqual({name: 'service.ts', path: 'src/auth/service.ts', dir: false, files: 1, loc: 53, bytes: 1432, lang: 'TypeScript', complexity: 28, commits: 4, age: 15});
  });

  it('files.list: one row per file, largest first, with commit counts that follow renames', async () => {
    const result = await run(ctx, 'files.list');
    const rows = result.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(36);
    expect(rows.slice(0, 4)).toEqual([
      {path: 'src/auth/service.ts', lang: 'TypeScript', loc: 53, bytes: 1432, commits: 4, complexity: 28},
      {path: 'services/gateway/limiter/limiter.go', lang: 'Go', loc: 36, bytes: 723, commits: 1, complexity: 27},
      {path: 'src/auth/session.ts', lang: 'TypeScript', loc: 36, bytes: 1032, commits: 4, complexity: 15},
      {path: 'src/orders/service.ts', lang: 'TypeScript', loc: 29, bytes: 994, commits: 2, complexity: 19},
    ]);
    const commits = Object.fromEntries(rows.map(row => [row.path, row.commits]));
    for (const [path, count] of Object.entries(FIXTURE.churn)) expect(commits[path], path).toBe(count);
    expect(commits[FIXTURE.rename.to]).toBe(2);
    expect(commits['src/lib/metrics.ts']).toBe(0);
    expect(result).toMatchObject({total: 36, summary: '36 rows; fields path lang loc bytes commits complexity; top src/auth/service.ts 53 loc'});
    expect(result.allRows).toEqual(rows);
    checkResult('files.list', result);

    const scoped = await run(ctx, 'files.list tools top=2');
    expect((scoped.data as Array<{path: string}>).map(row => row.path)).toEqual(['tools/stats.py', 'tools/report.py']);
    expect(scoped).toMatchObject({total: 6, truncated: {total: 6, returned: 2, strategy: 'topN', by: 'loc'}});
    expect(scoped.summary).toBe('2/6 rows; fields path lang loc bytes commits complexity; top tools/stats.py 24 loc');
    expect(scoped.allRows).toHaveLength(2);
  });

  it('files.langs: the language mix by lines', async () => {
    const result = await run(ctx, 'files.langs');
    expect(result.data).toEqual([
      {lang: 'TypeScript', files: 19, loc: 371, pct: 58.5},
      {lang: 'Go', files: 4, loc: 98, pct: 15.5},
      {lang: 'Python', files: 6, loc: 87, pct: 13.7},
      {lang: 'JSON', files: 2, loc: 32, pct: 5},
      {lang: 'CSS', files: 1, loc: 14, pct: 2.2},
      {lang: 'TOML', files: 1, loc: 12, pct: 1.9},
      {lang: 'Markdown', files: 1, loc: 11, pct: 1.7},
      {lang: 'Go Module', files: 1, loc: 5, pct: 0.8},
      {lang: 'Ignore List', files: 1, loc: 4, pct: 0.6},
    ]);
    expect(result).toMatchObject({total: 9, roles: {label: 'lang', value: 'loc'}, summary: '9 rows; fields lang files loc pct; TypeScript 59% Go 15% Python 14% JSON 5%'});
    // Rounded from the exact share (98 of 634 lines is 15.46%), as the repo line of a show result rounds it (V032).
    checkResult('files.langs', result);
  });
});

describe('repo.*', () => {
  it('repo.kpis: the seven headline numbers', async () => {
    const result = await run(ctx, 'repo.kpis');
    expect(result.data).toEqual([
      {label: 'Files', value: 36},
      {label: 'Lines', value: 634, format: 'compact'},
      // the rows of files.langs (D16): nine languages, none unclassified
      {label: 'Languages', value: 9},
      // the nine clusters deps.modules draws: the cut folds nothing in a repository this small (D16)
      {label: 'Modules', value: 9},
      {label: 'File cycles', value: 1, tone: 'warn'},
      // one commit in the 30 days before the pinned clock (4 Nov), three in the 30 days before that
      {label: 'Commits (30d)', value: 1, delta: -2},
      {label: 'Contributors', value: 3},
    ]);
    expect(result.summary).toBe('7 rows; fields label value; Files 36, Lines 634, Languages 9, Modules 9, File cycles 1, Commits (30d) 1, Contributors 3');
    expect(result.warnings).toBeUndefined();
    checkResult('repo.kpis', result);
  });

  it('repo.stack: languages with their colour key, then frameworks, data stores and tools', async () => {
    const result = await run(ctx, 'repo.stack');
    expect(result.data).toEqual([
      {label: 'TypeScript', slotKey: 'TypeScript'}, {label: 'Go', slotKey: 'Go'}, {label: 'Python', slotKey: 'Python'}, {label: 'CSS', slotKey: 'CSS'},
      'Click', 'React', 'Zod', {label: 'PostgreSQL', tone: 'info'}, {label: 'Redis', tone: 'info'}, 'Vitest',
    ]);
    expect(result.summary).toBe('10 rows; fields label; TypeScript, Go, Python, CSS, Click, React, Zod, PostgreSQL, Redis, Vitest');
    checkResult('repo.stack', result);
  });

  it('repo.packages: one row per manifest', async () => {
    const result = await run(ctx, 'repo.packages');
    expect(result.data).toEqual([
      {name: FIXTURE.goModule, ecosystem: 'go', version: '', dir: '', deps: 1},
      {name: FIXTURE.packageName, ecosystem: 'npm', version: '0.3.0', dir: '', deps: 6},
      {name: 'shop-tools', ecosystem: 'pypi', version: '0.3.0', dir: '', deps: 2},
    ]);
    expect(result.summary).toBe('3 rows; fields name ecosystem version dir deps; 1 go, 1 npm, 1 pypi');
    checkResult('repo.packages', result);
  });

  it('repo.scripts: what can be run, per package', async () => {
    const result = await run(ctx, 'repo.scripts');
    expect(result.data).toEqual([
      {package: 'shop', script: 'dev', command: 'node --watch src/index.ts'},
      {package: 'shop', script: 'build', command: 'tsc -p tsconfig.json'},
      {package: 'shop', script: 'test', command: 'vitest run'},
      {package: 'shop-tools', script: 'shop-report', command: 'tools.cli:main'},
    ]);
    expect(result.summary).toBe('4 rows; fields package script command; dev build test shop-report');
    checkResult('repo.scripts', result);
  });
});

describe('deps.*', () => {
  const edgeLines = (graph: GraphData) => graph.edges.map(edge => `${edge.from} -> ${edge.to}${edge.weight ? ` ${edge.weight}` : ''}${edge.kind ? ` ${edge.kind}` : ''}${edge.cycle ? ' cycle' : ''}`);

  it('deps.modules: clusters, their imports, the module cycle and the most used packages', async () => {
    const result = await run(ctx, 'deps.modules');
    const graph = result.data as GraphData;
    expect(graph.level).toBe('module');
    expect(graph.nodes.map(node => `${node.id} | ${node.label} | ${node.sub ?? ''} | in ${node.fanIn} out ${node.fanOut}${node.cycle ? ' | cycle' : ''}${node.group ? ` | ${node.group}` : ''}`)).toEqual([
      'services/gateway | gateway | 4 files, 98 loc | in 0 out 0',
      'src/api | api | 3 files, 56 loc | in 1 out 3 | dir:src',
      'src/auth | auth | 3 files, 107 loc | in 3 out 2 | cycle | dir:src',
      'src/* | src/* | 1 file, 8 loc | in 0 out 2 | dir:src',
      'src/lib | lib | 5 files, 84 loc | in 4 out 0 | dir:src',
      'src/orders | orders | 3 files, 63 loc | in 4 out 2 | cycle | dir:src',
      'src/ui | ui | 2 files, 32 loc | in 0 out 1 | dir:src',
      'test | test | 2 files, 21 loc | in 0 out 2',
      'tools | tools | 6 files, 87 loc | in 0 out 0',
      'ext:vitest | vitest |  | in 1 out 0',
      'ext:pg | pg |  | in 1 out 0',
      'ext:react | react |  | in 1 out 0',
      'ext:redis | redis |  | in 1 out 0',
    ]);
    expect(edgeLines(graph)).toEqual([
      'src/api -> src/auth 3',
      'src/api -> src/lib 3',
      'src/auth -> src/lib 3',
      'src/* -> src/lib 2',
      'src/orders -> src/auth 2 cycle',
      'src/ui -> src/orders 2',
      'test -> ext:vitest 2',
      'test -> src/orders 2',
      'src/* -> src/api 1',
      'src/api -> src/orders 1',
      'src/auth -> src/orders 1 cycle',
      'src/lib -> ext:pg 1',
      'src/lib -> ext:redis 1',
      'src/orders -> src/lib 1',
      'src/ui -> ext:react 1',
      'test -> src/auth 1',
    ]);
    expect(graph.groups).toEqual([{id: 'dir:src', label: 'src'}]);
    expect(graph.nodes.find(node => node.id === 'src/auth')).toMatchObject({kind: 'cluster', slotKey: 'src/auth', files: 3, loc: 107, file: 'src/auth/service.ts'});
    expect(graph.nodes.find(node => node.id === 'ext:pg')).toEqual({id: 'ext:pg', label: 'pg', kind: 'external', fanIn: 1, fanOut: 0});
    // the default graph keeps the four most used external packages; top= asks for more
    expect(result).toMatchObject({total: 13, summary: '13 nodes 16 edges, 1 module cycle; level module'});
    const more = await run(ctx, 'deps.modules top=48');
    expect((more.data as GraphData).nodes.filter(node => node.kind === 'external').map(node => node.id)).toEqual(['ext:vitest', 'ext:pg', 'ext:react', 'ext:redis', 'ext:zod']);
    expect(more).toMatchObject({total: 14, summary: '14 nodes 17 edges, 1 module cycle; level module'});
    checkResult('deps.modules', result);
  });

  it('deps.modules <dir>: a small scope is drawn file by file, with the rest of the repository as clusters around it', async () => {
    const result = await run(ctx, 'deps.modules src/auth');
    const graph = result.data as GraphData;
    expect(graph.level).toBe('file');
    expect(graph.nodes.map(node => `${node.id} ${node.kind}${node.group ? ` ${node.group}` : ''}${node.cycle ? ' cycle' : ''}`)).toEqual([
      'src/auth/service.ts file scope cycle', 'src/auth/session.ts file scope', 'src/auth/tokens.ts file scope',
      'src/api cluster', 'src/lib cluster', 'src/orders cluster', 'test cluster',
    ]);
    expect(edgeLines(graph)).toEqual([
      'src/api -> src/auth/session.ts 2',
      'src/api -> src/auth/service.ts',
      'src/auth/service.ts -> src/auth/session.ts',
      'src/auth/service.ts -> src/auth/tokens.ts',
      'src/auth/service.ts -> src/lib',
      'src/auth/service.ts -> src/orders',
      'src/auth/session.ts -> src/auth/tokens.ts',
      'src/auth/session.ts -> src/lib',
      'src/auth/tokens.ts -> src/lib',
      'src/orders -> src/auth/service.ts',
      'src/orders -> src/auth/session.ts dashed',
      'test -> src/auth/service.ts',
    ]);
    expect(graph.groups).toEqual([{id: 'scope', label: 'src/auth'}]);
    expect(result.summary).toBe('7 nodes 12 edges, 1 file cycle; level file; 4 imports out of src/auth');
    checkResult('deps.modules', result);
  });

  it('deps.modules focus= depth=: the neighbourhood of one cluster, found by id or by label', async () => {
    const byLabel = await run(ctx, 'deps.modules focus=ui');
    const graph = byLabel.data as GraphData;
    expect(graph.nodes.map(node => node.id)).toEqual(['src/orders', 'src/ui', 'ext:react']);
    expect(edgeLines(graph)).toEqual(['src/ui -> src/orders 2', 'src/ui -> ext:react 1']);
    // the numbers of a node are those of the whole graph, not of the cut-out
    expect(graph.nodes.find(node => node.id === 'src/orders')).toMatchObject({fanIn: 4, fanOut: 2, cycle: true});
    expect(byLabel.truncated).toEqual({total: 13, returned: 3, strategy: 'neighborhood', by: 'src/ui'});
    const wider = await run(ctx, 'deps.modules focus=src/ui depth=2');
    expect((wider.data as GraphData).nodes.map(node => node.id).sort()).toEqual(['ext:react', 'src/api', 'src/auth', 'src/lib', 'src/orders', 'src/ui', 'test']);
    checkResult('deps.modules', wider);
  });

  it('deps.files: imports and importers of one file, with its external packages', async () => {
    const result = await run(ctx, 'deps.files src/auth/service.ts');
    const graph = result.data as GraphData;
    expect(graph.nodes.map(node => `${node.id} ${node.kind}${node.cycle ? ' cycle' : ''}`)).toEqual([
      'src/auth/service.ts file cycle', 'src/api/routes.ts file', 'src/auth/session.ts file', 'src/auth/tokens.ts file', 'src/lib/db.ts file',
      'src/orders/service.ts file cycle', 'test/auth.test.ts file',
    ]);
    expect(edgeLines(graph)).toEqual([
      'src/api/routes.ts -> src/auth/service.ts',
      'src/api/routes.ts -> src/auth/session.ts dashed',
      'src/api/routes.ts -> src/orders/service.ts',
      'src/auth/service.ts -> src/auth/session.ts',
      'src/auth/service.ts -> src/auth/tokens.ts',
      'src/auth/service.ts -> src/lib/db.ts',
      'src/auth/service.ts -> src/orders/service.ts cycle',
      'src/auth/session.ts -> src/auth/tokens.ts',
      'src/orders/service.ts -> src/auth/service.ts cycle',
      'src/orders/service.ts -> src/auth/session.ts dashed',
      'src/orders/service.ts -> src/lib/db.ts',
      'test/auth.test.ts -> src/auth/service.ts',
    ]);
    expect(graph.nodes[0]).toEqual({
      id: 'src/auth/service.ts', label: 'service.ts', sub: 'src/auth', kind: 'file', slotKey: 'src/auth', loc: 53, fanIn: 3, fanOut: 4, file: 'src/auth/service.ts', cycle: true,
    });
    expect(result.summary).toBe('7 nodes 12 edges, 1 file cycle; level file; service.ts imports 4, imported by 3');
    checkResult('deps.files', result);

    const withPackages = await run(ctx, 'deps.files src/lib/db.ts');
    expect((withPackages.data as GraphData).nodes.map(node => node.id)).toEqual(['src/lib/db.ts', 'src/auth/service.ts', 'src/lib/config.ts', 'src/orders/service.ts', 'ext:pg']);
    const twoHops = await run(ctx, 'deps.files src/lib/db.ts depth=2');
    expect((twoHops.data as GraphData).nodes.length).toBeGreaterThan(5);
    checkResult('deps.files', twoHops);
  });

  it('deps.files on a Go file: importers of its package import the file', async () => {
    const result = await run(ctx, 'deps.files services/gateway/limiter/limiter.go');
    expect(edgeLines(result.data as GraphData)).toEqual([
      'services/gateway/main.go -> services/gateway/limiter/limiter.go',
      'services/gateway/proxy/proxy.go -> services/gateway/limiter/limiter.go',
    ]);
    const importer = await run(ctx, 'deps.files services/gateway/main.go');
    expect((importer.data as GraphData).nodes.map(node => `${node.id} ${node.kind}`)).toEqual([
      'services/gateway/main.go file', 'services/gateway/limiter package', 'services/gateway/proxy package',
    ]);
    expect(importer.warnings).toEqual(['imports of a whole package are drawn to the package directory']);
    checkResult('deps.files', importer);
  });

  it('deps.cycles: the one cycle of the fixture', async () => {
    const result = await run(ctx, 'deps.cycles');
    expect(result.data).toEqual([{id: 1, size: 2, members: FIXTURE.cycle.join(', ')}]);
    expect(result.summary).toBe('1 row; fields id size members; largest 2 files: src/auth/service.ts, src/orders/service.ts');
    checkResult('deps.cycles', result);
  });

  it('deps.external: packages by the number of files importing them', async () => {
    const result = await run(ctx, 'deps.external');
    expect(result.data).toEqual([
      {package: 'vitest', importers: 2, ecosystem: 'npm'},
      {package: 'pg', importers: 1, ecosystem: 'npm'},
      {package: 'react', importers: 1, ecosystem: 'npm'},
      {package: 'redis', importers: 1, ecosystem: 'npm'},
      {package: 'zod', importers: 1, ecosystem: 'npm'},
    ]);
    expect((result.data as Array<{package: string}>).map(row => row.package).sort()).toEqual([...FIXTURE.npmImports]);
    expect(result.summary).toBe('5 rows; fields package importers ecosystem; top vitest 2 importers');
    checkResult('deps.external', result);
  });

  it('deps.matrix: imports between modules', async () => {
    const result = await run(ctx, 'deps.matrix');
    expect(result.data).toEqual([
      {from: 'src/api', to: 'src/auth', weight: 3},
      {from: 'src/api', to: 'src/lib', weight: 3},
      {from: 'src/auth', to: 'src/lib', weight: 3},
      {from: 'src/*', to: 'src/lib', weight: 2},
      {from: 'src/orders', to: 'src/auth', weight: 2},
      {from: 'src/ui', to: 'src/orders', weight: 2},
      {from: 'test', to: 'src/orders', weight: 2},
      {from: 'src/*', to: 'src/api', weight: 1},
      {from: 'src/api', to: 'src/orders', weight: 1},
      {from: 'src/auth', to: 'src/orders', weight: 1},
      {from: 'src/orders', to: 'src/lib', weight: 1},
      {from: 'test', to: 'src/auth', weight: 1},
    ]);
    expect(result.summary).toBe('12 rows; fields from to weight; 9 modules; heaviest src/api -> src/auth 3');
    expect(result.roles).toEqual({x: 'to', y: ['from'], value: 'weight'});
    checkResult('deps.matrix', result);
  });
});

describe('code.*', () => {
  it('code.symbols: the outline of a file', async () => {
    const result = await run(ctx, 'code.symbols src/auth/service.ts');
    expect(result.data).toEqual([
      {name: 'UserRow', kind: 'iface', line: 6, endLine: 11, depth: 0, exported: false},
      {name: 'MAX_ATTEMPTS', kind: 'const', line: 13, depth: 0, exported: false},
      {name: 'attempts', kind: 'const', line: 14, depth: 0, exported: false},
      {name: 'AuthError', kind: 'class', line: 16, endLine: 18, depth: 0, exported: true},
      {name: 'status', kind: 'var', line: 17, depth: 1, exported: true},
      {name: 'login', kind: 'fn', line: 20, endLine: 32, depth: 0, exported: true},
      {name: 'logout', kind: 'fn', line: 34, endLine: 36, depth: 0, exported: true},
      {name: 'canSeeOrder', kind: 'fn', line: 38, endLine: 44, depth: 0, exported: true},
      {name: 'resetAttempts', kind: 'fn', line: 47, endLine: 49, depth: 0, exported: true},
      {name: 'isLockedOut', kind: 'fn', line: 51, endLine: 53, depth: 0, exported: true},
    ]);
    expect(result.summary).toBe('10 rows; fields name kind line; UserRow MAX_ATTEMPTS attempts AuthError login logout');
    checkResult('code.symbols', result);
  });

  it('code.refs: word-boundary matches, the defining file first', async () => {
    const result = await run(ctx, 'code.refs login');
    expect(result.data).toEqual([
      {file: 'src/auth/service.ts#L20', text: 'export async function login(email: string, password: string): Promise<Session> {'},
      {file: 'src/api/routes.ts#L1', text: "import {login} from '../auth/service';"},
      {file: 'src/api/routes.ts#L11', text: "  if (method === 'POST' && url === '/login') {"},
      {file: 'src/api/routes.ts#L12', text: "    return {status: 200, body: await login('demo', 'demo')};"},
      {file: 'test/auth.test.ts#L2', text: "import {AuthError, login, resetAttempts} from '../src/auth/service';"},
      {file: 'test/auth.test.ts#L4', text: "describe('login', () => {"},
      {file: 'test/auth.test.ts#L8', text: "    await expect(login('nobody', 'x')).rejects.toBeInstanceOf(AuthError);"},
    ]);
    expect(result.summary).toBe('7 rows; fields file text; 7 matches in 3 files; defined in src/auth/service.ts');
    checkResult('code.refs', result);
    // an untracked file is searched too
    const untracked = await run(ctx, 'code.refs snapshot');
    expect(untracked.data).toEqual([{file: 'src/lib/metrics.ts#L7', text: 'export function snapshot(): Record<string, number> {'}]);
  });

  it('code.todos: the three tags of the fixture, optionally under a path', async () => {
    const result = await run(ctx, 'code.todos');
    expect(result.data).toEqual([
      {tag: 'TODO', file: 'services/gateway/proxy/proxy.go#L12', text: 'retry idempotent requests'},
      {tag: 'TODO', file: 'src/auth/tokens.ts#L4', text: 'rotate the signing key'},
      {tag: 'FIXME', file: 'tools/stats.py#L7', text: 'median of an empty list'},
    ]);
    expect((result.data as Array<{tag: string; file: string}>).map(row => [row.tag, row.file.replace(/#L\d+$/, '')])).toEqual([...FIXTURE.todos]);
    expect(result.summary).toBe('3 rows; fields tag file text; 2 TODO, 1 FIXME');
    checkResult('code.todos', result);
    expect((await run(ctx, 'code.todos tools')).data).toEqual([{tag: 'FIXME', file: 'tools/stats.py#L7', text: 'median of an empty list'}]);
  });
});

describe('every source', () => {
  it('ran above with the working tree untouched', async () => {
    expect(MINE).toHaveLength(15);
    const {git} = await import('../fixtures/repo.ts');
    expect((await git(repo.root, ['status', '--porcelain', '--untracked-files=all'])).split('\n').sort()).toEqual([' M src/auth/service.ts', ' M tools/stats.py', '?? src/lib/metrics.ts']);
  });
});
