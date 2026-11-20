import {describe, expect, it} from 'vitest';
import {
  assignSlots, barPath, cleanRows, cleanTree, clip, clipPath, count, createSizer, entityOf, foldSeries, inspect, label, linearAxis, logAxis,
  matches, num, pick, received, slotKind, spatialStep, textWidth, time, timeAxis, viewTree, words, type Mark,
} from '../../src/components/charts/chartkit/index.ts';

describe('chartkit data', () => {
  it('coerces numbers and rejects everything that is not finite', () => {
    expect([12, '12', ' 3.5 ', '1e3', -0.5].map(num)).toEqual([12, 12, 3.5, 1000, -0.5]);
    expect([null, undefined, '', '  ', 'abc', Number.NaN, Infinity, {}, [], true].map(num)).toEqual(new Array(10).fill(undefined));
  });

  it('reads ISO dates in UTC and epoch numbers only when asked', () => {
    expect(time('2026-11-12')).toBe(Date.UTC(2026, 10, 12));
    expect(time('2026-11-12T10:30:00Z')).toBe(Date.UTC(2026, 10, 12, 10, 30));
    expect(time('2026-11-12 10:30')).toBe(new Date('2026-11-12T10:30').getTime());
    expect(time('yesterday')).toBeUndefined();
    expect(time('12')).toBeUndefined();
    expect(time(1_800_000_000)).toBeUndefined();
    expect(time(1_800_000_000, true)).toBe(1_800_000_000_000);
    expect(time(1_800_000_000_000, true)).toBe(1_800_000_000_000);
  });

  it('labels any value', () => {
    expect([null, undefined, '', 'a', 3, Number.NaN, true, {a: 1}].map(label)).toEqual(['—', '—', '—', 'a', '3', '—', 'true', '{"a":1}']);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(label(loop)).toBe('—');
    expect([null, [1, 2], 'x', 4].map(received)).toEqual(['null', 'array of 2', 'string', 'number']);
    expect(count(1, 'row')).toBe('1 row');
    expect(count(12840, 'row')).toBe('12,840 rows');
  });

  it('keeps the object rows of an array and counts the rest', () => {
    expect(cleanRows('x')).toBeUndefined();
    expect(cleanRows([{a: 1}, null, 3, [4], {b: 2}])).toEqual({rows: [{a: 1}, {b: 2}], skipped: 3});
  });

  it('describes fields from the dataset, else sniffs them from the rows', () => {
    const rows = [{path: 'a.ts', n: '4', when: '2026-01-01', mixed: 1}, {path: 'b.ts', n: 5, when: '2026-01-02', mixed: 'x'}];
    const sniffed = inspect(rows);
    expect(sniffed.list.map(f => [f.key, f.cls])).toEqual([['path', 'cat'], ['n', 'num'], ['when', 'date'], ['mixed', 'cat']]);
    expect(sniffed.first('num')?.key).toBe('n');
    expect(sniffed.first('cat', ['path'])?.key).toBe('mixed');
    expect(sniffed.get('missing')).toMatchObject({key: 'missing', cls: 'cat'});
    const declared = inspect(rows, [{key: 'n', kind: 'bar', label: 'Count'}, {key: 'path', kind: 'path'}]);
    expect(declared.list).toEqual([{key: 'n', label: 'Count', kind: 'bar', unit: undefined, cls: 'num'}, {key: 'path', label: 'path', kind: 'path', unit: undefined, cls: 'cat'}]);
    expect(declared.get('when').cls).toBe('date');
  });

  it('picks the first usable candidate and splits field lists', () => {
    expect(pick(undefined, '', '  ', ' y ', 'z')).toBe('y');
    expect(pick()).toBeUndefined();
    expect(words('a  b,c')).toEqual(['a', 'b', 'c']);
    expect(words(undefined)).toEqual([]);
  });

  it('derives entities from field kinds and row paths', () => {
    expect(entityOf({key: 'path', label: 'path', cls: 'cat'}, 'src/a.ts#L10-20')).toEqual({type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 10, endLine: 20});
    expect(entityOf({key: 'm', label: 'm', cls: 'cat', kind: 'module'}, 'auth')).toEqual({type: 'module', id: 'auth', label: 'auth'});
    expect(entityOf({key: 'name', label: 'name', cls: 'cat'}, 'x', {path: 'src/b.ts'})).toMatchObject({type: 'file', id: 'src/b.ts'});
    expect(entityOf({key: 'name', label: 'name', cls: 'cat'}, 'x')).toEqual({type: 'row', id: 'x', label: 'x'});
    expect(entityOf(undefined, undefined)).toBeUndefined();
  });

  it('matches the selection by identity, by path and by containing directory', () => {
    const file = {type: 'file' as const, id: 'src/a/b.ts', path: 'src/a/b.ts'};
    expect(matches({type: 'file', id: 'src/a/b.ts'}, file)).toBe(true);
    expect(matches({type: 'row', id: 'r1', path: 'src/a/b.ts'}, file)).toBe(true);
    expect(matches({type: 'dir', id: 'src/a', path: 'src/a'}, file)).toBe(true);
    expect(matches({type: 'dir', id: '', path: ''}, file)).toBe(true);
    expect(matches({type: 'dir', id: 'src/ab', path: 'src/ab'}, file)).toBe(false);
    expect(matches({type: 'file', id: 'src/a', path: 'src/a'}, file)).toBe(false);
    expect(matches(null, file)).toBe(false);
    expect(matches({type: 'module', id: 'x'}, undefined)).toBe(false);
  });

  it('keeps server slots, fills the free ones in order and never cycles', () => {
    expect([...assignSlots(['ui', 'auth', 'new'], {auth: 1, ui: 3})]).toEqual([['ui', 3], ['auth', 1], ['new', 2]]);
    const many = assignSlots(Array.from({length: 10}, (_, i) => `s${i}`));
    expect([...many.values()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0, 0]);
    expect(assignSlots(['a', 'other']).get('other')).toBe(0);
    expect(assignSlots(['a', 'b'], {a: 2, b: 2}).get('b')).toBe(1);
    expect([slotKind({key: 'owner'}), slotKind({key: 'x', kind: 'lang'}), slotKind({key: 'module', kind: 'text'}), slotKind(undefined)]).toEqual(['author', 'lang', undefined, undefined]);
  });

  it('folds a ninth series into other, keeping the seven largest in their order', () => {
    const eight = new Map(Array.from({length: 8}, (_, i) => [`s${i}`, i]));
    expect(foldSeries(eight).folded.size).toBe(0);
    const ten = new Map(Array.from({length: 10}, (_, i) => [`s${i}`, i]));
    const folded = foldSeries(ten);
    expect(folded.keep).toEqual(['s3', 's4', 's5', 's6', 's7', 's8', 's9']);
    expect([...folded.folded]).toEqual(['s0', 's1', 's2']);
  });

  it('fits text by arithmetic', () => {
    expect(textWidth('abcd')).toBeCloseTo(26.4);
    expect(clip('short', 100)).toBe('short');
    expect(clip('a-very-long-label', 66)).toBe('a-very-lo…');
    expect(clip('abc', 5)).toBe('');
    expect(clipPath('src/auth/service.ts', 200)).toEqual({dir: 'src/auth/', base: 'service.ts'});
    expect(clipPath('packages/viewer/src/auth/service.ts', 132)).toEqual({dir: '…src/auth/', base: 'service.ts'});
    expect(clipPath('dir/a-very-long-file-name.ts', 66)).toEqual({dir: '', base: 'a-very-lo…'});
  });
});

describe('chartkit scales', () => {
  it('builds a zero-based nice axis and widens flat domains', () => {
    const axis = linearAxis([3, 84], [0, 100]);
    expect(axis.scale.domain()).toEqual([0, 100]);
    expect(axis.ticks).toEqual([0, 20, 40, 60, 80, 100]);
    expect(linearAxis([0, 0], [0, 100]).scale.domain()).toEqual([0, 1]);
    expect(linearAxis([], [0, 100]).scale.domain()).toEqual([0, 1]);
    expect(linearAxis([-8, 5], [0, 100]).scale.domain()).toEqual([-8, 6]);
    const single = linearAxis([42], [0, 100], {zero: false}).scale.domain() as [number, number];
    expect(single[0]).toBeLessThan(42);
    expect(single[1]).toBeGreaterThan(42);
  });

  it('builds a log axis over the positive values and falls back to linear without any', () => {
    const axis = logAxis([0, -3, 1, 10, 1000], [100, 0]);
    expect(axis.log).toBe(true);
    expect(axis.scale.domain()).toEqual([1, 1000]);
    expect(axis.scale(0)).toBe(100);
    expect(logAxis([0, -1], [100, 0]).log).toBe(false);
    expect(logAxis([5], [100, 0]).scale.domain()[0]).toBeLessThan(5);
  });

  it('labels time ticks by the span they cover', () => {
    const year = timeAxis([Date.UTC(2020, 0, 1), Date.UTC(2026, 0, 1)], [0, 600], 6);
    expect(year.ticks[0]!.label).toMatch(/^\d{4}$/);
    const months = timeAxis([Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 1)], [0, 600], 6);
    expect(months.ticks.map(t => t.label)).toEqual(['Jan 2026', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul']);
    const days = timeAxis([Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 9)], [0, 600], 7);
    expect(days.ticks[0]!.label).toBe('2 Nov');
    const one = timeAxis([Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 2)], [0, 600], 4);
    expect(one.scale(Date.UTC(2026, 10, 2))).toBe(300);
  });

  it('rounds only the data end of a bar', () => {
    expect(barPath(0, 0, 10, 4, 'right')).toBe('M0,0H8Q10,0 10,2V2Q10,4 8,4H0Z');
    expect(barPath(0, 0, 0, 14, 'right')).toBe('M0,0H0Q0,0 0,0V14Q0,14 0,14H0Z');
    expect(barPath(0, 0, 10, 10, 'top', 0)).not.toContain('NaN');
  });

  it('steps to the nearest mark in a direction', () => {
    const at = (x: number, y: number): Mark => ({x, y, w: 10, h: 10, title: '', say: ''});
    const marks = [at(0, 0), at(100, 0), at(0, 100), at(110, 90)];
    expect(spatialStep(marks, 0, 'ArrowRight')).toBe(1);
    expect(spatialStep(marks, 0, 'ArrowDown')).toBe(2);
    expect(spatialStep(marks, 1, 'ArrowDown')).toBe(3);
    expect(spatialStep(marks, 0, 'ArrowLeft')).toBe(0);
  });
});

describe('chartkit tree', () => {
  it('rejects values that are not a node', () => {
    expect(cleanTree('x')).toBeUndefined();
    expect(cleanTree([1])).toBeUndefined();
    expect(cleanTree(null)).toBeUndefined();
  });

  it('drops repeated paths, cycles and junk children and counts them', () => {
    const child: Record<string, unknown> = {name: 'a.ts', path: 'a.ts', dir: false, loc: 10};
    const root: Record<string, unknown> = {name: '', path: '', dir: true, children: [child, {name: 'a.ts', path: 'a.ts', loc: 99}, 'junk', null]};
    (child as {children?: unknown[]}).children = [root];
    const tree = cleanTree(root)!;
    expect(tree.root.children.map(node => node.path)).toEqual(['a.ts']);
    expect(tree.dropped).toBe(4);
    expect(tree.byPath.get('a.ts')?.loc).toBe(10);
  });

  it('fills in names, paths and sizes that are missing or wrong', () => {
    const tree = cleanTree({children: [{name: 'x', loc: '12', bytes: -4, children: [{name: 'y.ts', loc: 3}]}]})!;
    const x = tree.root.children[0]!;
    expect(x).toMatchObject({name: 'x', path: 'x', dir: true, loc: 12, bytes: 0});
    expect(x.children[0]).toMatchObject({path: 'x/y.ts', dir: false, loc: 3});
  });

  it('sizes rollups from `more`, or from what the directory has beyond its listed children', () => {
    const tree = cleanTree({name: '', path: '', dir: true, loc: 1000, bytes: 5000, files: 14, more: {files: 12, loc: 800}, children: [{name: 'a', path: 'a', dir: false, loc: 200, bytes: 1000, files: 1}]})!;
    const rollup = tree.root.children[1]!;
    expect(rollup.name).toBe('(12 more)');
    expect(createSizer('loc')(rollup)).toBe(800);
    expect(createSizer('files')(rollup)).toBe(12);
    expect(createSizer('bytes')(rollup)).toBe(4000);
    expect(createSizer('commits')(rollup)).toBe(0);
  });

  it('collapses directories below the level cut and leaves out what has no size', () => {
    const tree = cleanTree({name: '', path: '', dir: true, children: [
      {name: 'src', path: 'src', dir: true, loc: 30, children: [{name: 'deep', path: 'src/deep', dir: true, loc: 30, children: [{name: 'f.ts', path: 'src/deep/f.ts', loc: 30}]}]},
      {name: 'empty.txt', path: 'empty.txt', loc: 0},
    ]})!;
    const view = viewTree(tree.root, 'loc', 2);
    expect(view.value).toBe(30);
    expect(view.leaves().map(leaf => leaf.data.path)).toEqual(['src/deep']);
    expect(viewTree(tree.root, 'loc', Infinity).leaves().map(leaf => leaf.data.path)).toEqual(['src/deep/f.ts']);
  });
});
