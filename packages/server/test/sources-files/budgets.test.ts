// Budgets on a generated repository of several thousand files: nothing unbounded leaves a source.
import {mkdirSync, writeFileSync} from 'node:fs';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {DirNode, GraphData} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {DEFAULT_MODULES, MAX_MODULES} from '../../src/analyze/cluster.ts';
import {repoModel} from '../../src/analyze/index.ts';
import type {RepoContext} from '../../src/contracts.ts';
import {checkResult, makeContext, run} from './helpers.ts';

const PACKAGES = 50;
const DIRS_PER_PACKAGE = 4;
const FILES_PER_DIR = 20;
const RING_FILES = PACKAGES * DIRS_PER_PACKAGE * FILES_PER_DIR;
const FLAT_FILES = 600;
const MANIFESTS = 520;
const PAIRS = 60;

function generate(root: string): number {
  let written = 0;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
    written++;
  };
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  // 50 packages x 4 directories x 20 files; each file imports its neighbour, the next package (one long ring) and a package
  for (let p = 0; p < PACKAGES; p++) {
    for (let d = 0; d < DIRS_PER_PACKAGE; d++) {
      for (let f = 0; f < FILES_PER_DIR; f++) {
        const n = (p * DIRS_PER_PACKAGE + d) * FILES_PER_DIR + f;
        const next = `../../pkg${pad((p + 1) % PACKAGES)}/dir${d}/file${pad(f)}`;
        const lines = [
          `import {value as neighbour} from './file${pad((f + 1) % FILES_PER_DIR)}';`,
          `import {value as far} from '${next}';`,
          `import ext from 'ext-${n % 700}';`,
          "import {shared} from '../../flat/hub';",
          `// TODO: tidy ${n}`,
          `export const value = ${n} + Number(neighbour) + Number(far) + Number(ext) + Number(shared);`,
          ...Array.from({length: n % 40}, (_, i) => `export const pad${i} = ${i};`),
        ];
        write(`pkg${pad(p)}/dir${d}/file${pad(f)}.ts`, `${lines.join('\n')}\n`);
      }
    }
  }
  // one flat directory: a hub everything imports, and files that import the hub
  write('flat/hub.ts', `export const shared = 1;\n${Array.from({length: 3000}, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n')}\n`);
  for (let f = 0; f < FLAT_FILES; f++) write(`flat/leaf${pad(f, 3)}.ts`, `import {shared} from './hub';\nexport const leaf${f} = shared;\n`);
  // many manifests with scripts, and many two-file cycles
  for (let m = 0; m < MANIFESTS; m++) write(`many/p${pad(m, 3)}/package.json`, JSON.stringify({name: `p${pad(m, 3)}`, version: '1.0.0', scripts: {build: 'tsc', test: 'vitest'}}));
  for (let c = 0; c < PAIRS; c++) {
    write(`pairs/a${pad(c)}.ts`, `import {b} from './b${pad(c)}';\nexport const a = b;\n`);
    write(`pairs/b${pad(c)}.ts`, `import {a} from './a${pad(c)}';\nexport const b = a;\n`);
  }
  return written;
}

let root: string;
let ctx: RepoContext;
let written: number;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-budget-')));
  written = generate(root);
  ctx = makeContext(root, {git: false});
}, 60_000);
afterAll(async () => { await rm(root, {recursive: true, force: true}); });

describe('a generated repository of more than 5,000 files', () => {
  it('is generated as planned', async () => {
    expect(written).toBe(RING_FILES + 1 + FLAT_FILES + MANIFESTS + 2 * PAIRS);
    expect(written).toBeGreaterThan(5000);
    expect(await ctx.index.files()).toHaveLength(written);
  });

  it('files.tree stays at 1,500 nodes, rolls the rest up and keeps every total exact', async () => {
    const result = await run(ctx, 'files.tree');
    const nodes = checkResult('files.tree', result);
    expect(nodes).toBe(1500);
    const tree = result.data as DirNode;
    expect(tree.files).toBe(written);
    expect(result.truncated).toEqual({total: result.total, returned: 1500, strategy: 'treecut', by: 'loc'});
    expect(result.total).toBeGreaterThan(written);
    let rollups = 0;
    let widest = 0;
    const walk = (node: DirNode) => {
      if (node.more) rollups++;
      if (node !== tree) widest = Math.max(widest, node.children?.length ?? 0);
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    expect(widest).toBeLessThanOrEqual(40);
    // The directory that was asked for (here the root) shows all of its own entries: a rollup row at its level would
    // have nowhere to go, because drilling into the root is the view the reader is already in.
    expect(tree.children).toHaveLength(PACKAGES + 3);
    expect(tree.more).toBeUndefined();
    expect(rollups).toBeGreaterThan(10);
    expect(result.summary).toMatch(/^5,241 files, [\d.]+k loc, \d+ rollups \(1500 of [\d,]+ nodes\)$/);
    // The budget goes to the largest entries wherever they sit (V038): the flat directory's 3,001-line hub is shown,
    // its 600 two-line leaves are what rolls up, and no shown file is smaller than one rolled up beside it.
    const flat = tree.children?.find(child => child.path === 'flat');
    expect(flat?.children?.[0]?.path).toBe('flat/hub.ts');
    expect((flat?.children?.length ?? 0) + (flat?.more?.files ?? 0)).toBe(FLAT_FILES + 1);
    let smallestShown = Number.POSITIVE_INFINITY;
    const below = (node: DirNode) => {
      for (const child of node.children ?? []) {
        smallestShown = Math.min(smallestShown, child.loc);
        below(child);
      }
    };
    for (const top of tree.children ?? []) below(top);
    const leaf = 2;
    // a breadth-first cut listed 40 of the shallow two-line leaves and rolled up the deeper, larger package files
    expect(flat?.children?.length).toBeLessThan(40);
    expect(smallestShown).toBeGreaterThan(leaf);
    expect(flat?.more?.loc).toBe((flat?.more?.files ?? 0) * leaf);
  });

  it('files.tree <dir> shows every entry of the directory asked for, so a rollup can be opened and none sits at the scope root (F026)', async () => {
    // a drill into 'flat' (the rollup under it in the whole tree) reveals all 601 entries, not 200 and a rollup that
    // would only drill into 'flat' again
    const result = await run(ctx, 'files.tree flat');
    checkResult('files.tree', result);
    const flat = result.data as DirNode;
    expect(flat.children).toHaveLength(FLAT_FILES + 1);
    expect(flat.more).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(flat.children?.[0]?.path).toBe('flat/hub.ts');
  });

  it('files.list binds 500 rows and keeps the full set for paging', async () => {
    const result = await run(ctx, 'files.list');
    expect(checkResult('files.list', result)).toBe(500);
    expect(result).toMatchObject({total: written, truncated: {total: written, returned: 500, strategy: 'topN', by: 'loc'}});
    expect(result.allRows).toHaveLength(written);
    expect(result.summary.startsWith(`500/${written} rows; fields path lang loc bytes complexity; top flat/hub.ts 3001 loc`)).toBe(true);
    const capped = await run(ctx, 'files.list top=600');
    expect(capped.data).toHaveLength(500);
    expect(capped.allRows).toHaveLength(600);
  });

  it('clustering stays at a legible number of modules, and every file belongs to one of them', async () => {
    const model = await repoModel(ctx);
    expect(model.cut.ids).toHaveLength(DEFAULT_MODULES);
    const used = new Set<string>();
    for (const file of model.files) if (file.path.endsWith('.ts')) used.add(model.cut.moduleOf(file.path));
    expect([...used].sort()).toEqual([...model.cut.ids].sort());
  });

  it('the Modules KPI is the number of modules the module graph is a cut of, never the cap (D16)', async () => {
    const result = await run(ctx, 'repo.kpis');
    const kpis = result.data as Array<{label: string; value: number}>;
    const modules = kpis.find(stat => stat.label === 'Modules')?.value;
    // The graph draws DEFAULT_MODULES clusters and says of how many: the KPI is that number, not a cap.
    const graph = await run(ctx, 'deps.modules');
    expect(graph.truncated).toEqual({total: modules, returned: DEFAULT_MODULES, strategy: 'treecut', by: 'loc'});
    expect(graph.summary).toContain(`${DEFAULT_MODULES} of ${modules!.toLocaleString('en-US')} modules`);
    expect((await run(ctx, 'deps.matrix')).summary).toContain(`${DEFAULT_MODULES} of ${modules!.toLocaleString('en-US')} modules`);
    expect(modules).toBeGreaterThan(MAX_MODULES);
    expect(result.summary).toContain(`Modules ${modules!.toLocaleString('en-US')},`);
  });

  it('deps.modules is legible by default (about two dozen nodes) and top= raises it to the hard cap', async () => {
    const result = await run(ctx, 'deps.modules');
    checkResult('deps.modules', result);
    const graph = result.data as GraphData;
    expect(graph.level).toBe('module');
    expect(graph.nodes.length).toBeLessThanOrEqual(24);
    expect(graph.nodes.filter(node => node.kind === 'cluster')).toHaveLength(DEFAULT_MODULES);
    expect(graph.nodes.filter(node => node.kind === 'external')).toHaveLength(4);
    // nothing is dropped: the packages that are not drawn are folded into the rest cluster, which says so
    const rest = graph.nodes.find(node => node.id === '(root)');
    expect(rest).toMatchObject({label: '(other)', kind: 'cluster'});
    expect(rest?.sub).toMatch(/^\d+ smaller directories of the repository: [\d,]+ files, /);
    expect(graph.nodes.filter(node => node.kind === 'cluster').reduce((sum, node) => sum + (node.files ?? 0), 0)).toBe(RING_FILES + FLAT_FILES + 1 + 2 * PAIRS);
    // the ring of packages is one cycle at module level
    expect(graph.nodes.filter(node => node.cycle).length).toBeGreaterThan(15);
    expect(result.summary).toMatch(/^24 nodes \d+ edges, 1 module cycle; level module; 20 of [\d,]+ modules, smaller ones folded$/);

    const fine = await run(ctx, 'deps.modules top=48');
    checkResult('deps.modules', fine);
    const finer = fine.data as GraphData;
    expect(finer.nodes.filter(node => node.kind === 'cluster')).toHaveLength(MAX_MODULES);
    expect(finer.nodes.filter(node => node.kind === 'external')).toHaveLength(8);
    expect(finer.edges.length).toBeLessThanOrEqual(400);
    expect(finer.nodes.filter(node => node.cycle).length).toBeGreaterThan(30);
    // asking for more than the hard cap gives the hard cap
    expect(((await run(ctx, 'deps.modules top=500')).data as GraphData).nodes).toHaveLength(48);
    // and a small request is honoured too
    expect(((await run(ctx, 'deps.modules top=10')).data as GraphData).nodes.length).toBeLessThanOrEqual(10);
  });

  it('a flat directory of hundreds of files is drawn as its 150 best connected files', async () => {
    const result = await run(ctx, 'deps.modules flat');
    checkResult('deps.modules', result);
    const graph = result.data as GraphData;
    expect(graph.level).toBe('file');
    expect(graph.nodes).toHaveLength(150);
    expect(graph.nodes.some(node => node.id === 'flat/hub.ts')).toBe(true);
    expect(result.truncated).toMatchObject({strategy: 'topN', by: 'degree', returned: 150});
  });

  it('deps.files of a file imported 4,600 times keeps a neighbourhood of 150', async () => {
    const result = await run(ctx, 'deps.files flat/hub.ts');
    checkResult('deps.files', result);
    const graph = result.data as GraphData;
    expect(graph.nodes[0]?.id).toBe('flat/hub.ts');
    expect(graph.nodes.length).toBeLessThanOrEqual(150);
    expect(graph.nodes.length).toBeGreaterThan(100);
    expect(result.truncated).toMatchObject({strategy: 'neighborhood', by: 'flat/hub.ts', total: RING_FILES + FLAT_FILES + 1});
  });

  it('deps.cycles lists 50 cycles with at most 20 members each', async () => {
    const result = await run(ctx, 'deps.cycles');
    expect(checkResult('deps.cycles', result)).toBe(50);
    // each directory index is one ring through all fifty packages
    expect(result.total).toBe(PAIRS + DIRS_PER_PACKAGE);
    const rows = result.data as Array<{size: number; members: string}>;
    expect(rows[0]?.size).toBe(PACKAGES * FILES_PER_DIR);
    expect(rows[0]?.members.split(', ')).toHaveLength(21);
    expect(rows[0]?.members.endsWith(`, +${PACKAGES * FILES_PER_DIR - 20} more`)).toBe(true);
    expect(result.truncated).toMatchObject({total: result.total, returned: 50, strategy: 'topN', by: 'size'});
  });

  it('deps.external, deps.matrix, code.todos, code.symbols, code.refs, repo.packages and repo.scripts stay within their budgets', async () => {
    const expected: Array<[string, number, number]> = [
      ['deps.external', 500, 700],
      ['code.todos', 500, RING_FILES],
      ['code.symbols flat/hub.ts', 2000, 2000],
      ['code.refs shared', 500, 2 * RING_FILES + 1 + 2 * FLAT_FILES],
      ['repo.packages', 500, MANIFESTS],
      ['repo.scripts', 200, 2 * MANIFESTS],
    ];
    for (const [ref, rows, total] of expected) {
      const result = await run(ctx, ref);
      expect(checkResult(ref.split(' ')[0]!, result), ref).toBe(rows);
      expect(result.total, ref).toBe(total);
      if (total > rows) expect(result.truncated, ref).toMatchObject({total, returned: rows});
    }
    const matrix = await run(ctx, 'deps.matrix');
    expect(checkResult('deps.matrix', matrix)).toBeLessThanOrEqual(1600);
    expect((matrix.data as unknown[]).length).toBeGreaterThan(20);
  });

  it('answers in seconds, not minutes', async () => {
    const fresh = makeContext(root, {git: false});
    const started = performance.now();
    await Promise.all(['files.tree', 'deps.modules', 'deps.cycles', 'repo.kpis', 'files.list'].map(ref => run(fresh, ref)));
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
