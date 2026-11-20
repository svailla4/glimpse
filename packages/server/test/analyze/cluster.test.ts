import {describe, expect, it} from 'vitest';
import {cutModules, findCycles, MAX_MODULES, parseModuleId, restId, type CutFile} from '../../src/analyze/cluster.ts';

const files = (spec: Record<string, number>): CutFile[] => Object.entries(spec).map(([path, weight]) => ({path, weight}));
/** `count` files of `weight` lines each under `dir`. */
const many = (dir: string, count: number, weight = 10): Record<string, number> =>
  Object.fromEntries(Array.from({length: count}, (_, i) => [`${dir}/f${i}.ts`, weight]));

describe('cutModules', () => {
  it('a small flat repository is one module', () => {
    const cut = cutModules(files({'a.ts': 10, 'b.ts': 5, 'README.md': 0}));
    expect(cut.ids).toEqual(['.']);
    expect(cut.moduleOf('a.ts')).toBe('.');
    expect(cut.moduleOf('new/file.ts')).toBe('.');
  });

  it('splits the heaviest directories, keeps a rest cluster for direct files and steps through wrapper directories', () => {
    const cut = cutModules(files({
      ...many('src/api', 4), ...many('src/auth', 4), ...many('src/lib', 3), 'src/index.ts': 8,
      ...many('services/gateway/proxy', 2), 'services/gateway/main.go': 5,
      ...many('tools', 3), 'README.md': 0, 'docs/guide.md': 0,
    }));
    expect(cut.ids).toEqual(['src/api', 'src/auth', 'src/lib', 'tools', 'services/gateway', 'src/*']);
    expect(cut.moduleOf('src/api/f0.ts')).toBe('src/api');
    expect(cut.moduleOf('src/api/deep/er/x.ts')).toBe('src/api');
    expect(cut.moduleOf('src/index.ts')).toBe('src/*');
    expect(cut.moduleOf('services/gateway/proxy/f0.ts')).toBe('services/gateway');
    expect(cut.moduleOfDir('services/gateway/proxy')).toBe('services/gateway');
    // files that are not source belong to the rest of their nearest split directory, which is not a module of its own
    expect(cut.moduleOf('README.md')).toBe('(root)');
    expect(cut.moduleOf('docs/guide.md')).toBe('(root)');
    expect(cut.ids).not.toContain('(root)');
  });

  it('does not split a directory with fewer than eight source files', () => {
    const cut = cutModules(files({...many('pkg/a', 3), ...many('pkg/b', 4), ...many('other', 9)}));
    expect(cut.ids).toEqual(['other', 'pkg']);
  });

  it('never exceeds the cap: the smallest siblings fold into the rest cluster', () => {
    const spec: Record<string, number> = {};
    for (let i = 0; i < 85; i++) Object.assign(spec, many(`packages/p${String(i).padStart(2, '0')}`, 2, 100 - i));
    const cut = cutModules(files(spec));
    expect(cut.ids).toHaveLength(MAX_MODULES);
    expect(cut.ids[0]).toBe('packages/*');
    expect(cut.ids.slice(1, 4)).toEqual(['packages/p00', 'packages/p01', 'packages/p02']);
    expect(cut.moduleOf('packages/p38/f0.ts')).toBe('packages/p38');
    expect(cut.moduleOf('packages/p39/f0.ts')).toBe('packages/*');
    expect(cut.moduleOf('packages/p84/f1.ts')).toBe('packages/*');
    expect(new Set(Object.keys(spec).map(path => cut.moduleOf(path))).size).toBe(MAX_MODULES);
  });

  it.each([1, 2, 5, 12, 40])('honours a cap of %i on a deep, wide tree', max => {
    const spec: Record<string, number> = {};
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 4; c++) Object.assign(spec, many(`l${a}/m${b}/n${c}`, 3, 1 + a + b + c));
    const cut = cutModules(files(spec), {max});
    expect(cut.ids.length).toBeLessThanOrEqual(max);
    expect(cut.ids.length).toBeGreaterThan(0);
    const used = new Set(Object.keys(spec).map(path => cut.moduleOf(path)));
    expect([...used].sort()).toEqual([...cut.ids].sort());
  });

  it('prefers directories that hold a manifest as boundaries: others are split first', () => {
    const spec = {...many('packages/core/src/a', 6, 50), ...many('packages/core/src/b', 6, 50), ...many('scripts/x', 5, 10), ...many('scripts/y', 5, 10), ...many('packages/web/src', 9, 20)};
    const withManifests = cutModules(files(spec), {max: 4, manifestDirs: new Set(['', 'packages/core', 'packages/web'])});
    expect(withManifests.ids).toEqual(['packages/core', 'packages/web', 'scripts/x', 'scripts/y']);
    const without = cutModules(files(spec), {max: 4});
    expect(without.ids).toEqual(['packages/core/src/a', 'packages/core/src/b', 'packages/web/src', 'scripts']);
  });

  it('spends the budget by weight across packages instead of exhausting the first one', () => {
    const pkg = (name: string, weight: number) => ({
      ...many(`packages/${name}/src/x/p`, 5, weight), ...many(`packages/${name}/src/x/q`, 5, weight), ...many(`packages/${name}/src/y`, 10, weight), ...many(`packages/${name}/src/z`, 10, weight),
    });
    const cut = cutModules(files({...pkg('a', 3), ...pkg('b', 2)}), {max: 6, manifestDirs: new Set(['packages/a', 'packages/b'])});
    expect([...cut.ids].sort()).toEqual(['packages/a/src/x', 'packages/a/src/y', 'packages/a/src/z', 'packages/b/src/x', 'packages/b/src/y', 'packages/b/src/z']);
    // a package that only wraps src/ keeps its own name until its content is split
    expect(cutModules(files({...pkg('a', 3), ...pkg('b', 2)}), {max: 2, manifestDirs: new Set(['packages/a', 'packages/b'])}).ids).toEqual(['packages/a', 'packages/b']);
  });

  it('a directory above packages is split however small it is', () => {
    const cut = cutModules(files({'apps/web/src/main.ts': 5, 'apps/api/main.go': 5, 'apps/api/handlers/run.go': 3, 'lib/a.ts': 1, 'lib/sub/b.ts': 1}), {manifestDirs: new Set(['', 'apps/web', 'apps/api'])});
    expect(cut.ids).toEqual(['apps/api', 'apps/web', 'lib']);
  });

  it('cuts beneath a root when asked, with ids that stay repository-relative', () => {
    const cut = cutModules(files({...many('src/api/routes', 5), ...many('src/api/middleware', 5), 'src/api/server.ts': 9, ...many('src/auth', 20)}), {root: 'src/api'});
    expect(cut.ids).toEqual(['src/api/middleware', 'src/api/routes', 'src/api/*']);
    expect(cut.moduleOf('src/api/server.ts')).toBe('src/api/*');
  });

  it('copes with nothing at all', () => {
    const cut = cutModules([]);
    expect(cut.ids).toEqual([]);
    expect(cut.moduleOf('a/b.ts')).toBe('.');
  });

  it('rest ids round-trip', () => {
    expect(restId('')).toBe('(root)');
    expect(restId('src')).toBe('src/*');
    expect(parseModuleId('(root)')).toEqual({dir: '', rest: true});
    expect(parseModuleId('src/*')).toEqual({dir: 'src', rest: true});
    expect(parseModuleId('src/api')).toEqual({dir: 'src/api', rest: false});
    expect(parseModuleId('.')).toEqual({dir: '', rest: false});
  });
});

describe('findCycles', () => {
  it('finds strongly connected components of two or more, largest first, members sorted', () => {
    expect(findCycles([['a', 'b'], ['b', 'a'], ['b', 'c'], ['x', 'y'], ['y', 'z'], ['z', 'x'], ['q', 'q']])).toEqual([['x', 'y', 'z'], ['a', 'b']]);
  });

  it('a chain or a tree has none', () => {
    expect(findCycles([['a', 'b'], ['b', 'c'], ['a', 'c']])).toEqual([]);
    expect(findCycles([])).toEqual([]);
  });

  it('does not overflow the stack on a 200,000-node ring', () => {
    const n = 200_000;
    const ring = Array.from({length: n}, (_, i) => [`n${i}`, `n${(i + 1) % n}`] as const);
    const cycles = findCycles(ring);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(n);
  });
});
