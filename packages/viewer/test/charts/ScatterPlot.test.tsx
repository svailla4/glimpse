import {fireEvent} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {errorDataset} from '../harness.tsx';
import {spreadOf} from '../../src/components/charts/ScatterPlot.tsx';
import {LONG, chart} from './util.tsx';

const FILES = [
  {path: 'src/auth/service.ts', commits: 51, complexity: 96, loc: 820, owner: 'Mira'},
  {path: 'src/api/routes.ts', commits: 33, complexity: 70, loc: 900, owner: 'Jon'},
  {path: 'src/auth/cache.ts', commits: 22, complexity: 41, loc: 410, owner: 'Mira'},
  {path: 'src/api/limiter.go', commits: 11, complexity: 20, loc: 400, owner: 'Ade'},
];

afterEach(() => void vi.restoreAllMocks());

describe('ScatterPlot', () => {
  it('plots the dataset roles: x, y, size and label', async () => {
    const view = await chart(`ScatterPlot('git.hotspots',title='Churn x complexity')`);
    // the field labels are the catalog's: the roles decide which field is where
    expect(view.svg.getAttribute('aria-label')).toMatch(/^Scatter plot, 5 points, commits against \w+, sized by \w+$/);
    const circles = view.all('circle[data-i]');
    expect(circles).toHaveLength(5);
    const radii = circles.map(el => Number(el.getAttribute('r')));
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...radii)).toBe(18);
    expect(view.all('[data-point-label]').map(el => el.textContent)).toContain('src/auth/service.ts');
    expect(view.errors).toEqual([]);
  });

  it('uses the first two numeric fields and a fixed radius without roles', async () => {
    const view = await chart('ScatterPlot($/d)', {rows: FILES});
    expect(view.svg.getAttribute('aria-label')).toBe('Scatter plot, 4 points, commits against complexity');
    expect(new Set(view.all('circle[data-i]').map(el => el.getAttribute('r')))).toEqual(new Set(['3.5']));
  });

  it('shows drafting, empty, a source error and a wrong shape', async () => {
    const pending = await chart(`ScatterPlot('git.hotspots')`, {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('ScatterPlot($/d)', {rows: []});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart(`ScatterPlot('git.hotspots')`, {data: {'/ds/git_hotspots': errorDataset('git.hotspots')}});
    expect(failed.code()).toBe('E_INTERNAL');
    failed.unmount();
    const shape = await chart('ScatterPlot($/d)', {rows: 12});
    expect(shape.code()).toBe('E_SHAPE');
    shape.unmount();
    const oneMeasure = await chart('ScatterPlot($/d)', {rows: [{name: 'a', n: 1}]});
    expect(oneMeasure.state()).toBe('empty');
  });

  it('skips rows without numbers, and non-positive values on a log axis, and counts both', async () => {
    const rows = [...FILES, {path: 'x', commits: null, complexity: 3}, {path: 'y', commits: 'n/a', complexity: 3}, {path: 'z', commits: 0, complexity: 5}];
    const view = await chart(`ScatterPlot($/d,'commits','complexity',scale='loglog')`, {rows});
    expect(view.all('circle[data-i]')).toHaveLength(4);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('2 rows without numbers · 1 off the log scale');
    expect(view.svg.innerHTML).not.toContain('NaN');
  });

  it('survives one datum, all zeros, negatives and 500-character labels', async () => {
    const one = await chart('ScatterPlot($/d)', {rows: [{a: 5, b: 9}]});
    expect(one.all('circle[data-i]')).toHaveLength(1);
    expect(one.svg.innerHTML).not.toContain('NaN');
    one.unmount();
    const zeros = await chart(`ScatterPlot($/d,r='c')`, {rows: [{a: 0, b: 0, c: 0}, {a: 0, b: 0, c: 0}]});
    expect(zeros.svg.innerHTML).not.toContain('NaN');
    zeros.unmount();
    const negative = await chart('ScatterPlot($/d)', {rows: [{a: -5, b: -9}, {a: 4, b: 2}]});
    expect(negative.svg.innerHTML).not.toContain('NaN');
    negative.unmount();
    const long = await chart(`ScatterPlot($/d,label='name')`, {rows: [{name: LONG, a: 1, b: 1}, {name: `src/${LONG}.ts`, a: 9, b: 9}]});
    expect(Math.max(...long.all('[data-point-label]').map(el => el.textContent!.length))).toBeLessThan(40);
  });

  it('labels at most the eight most extreme points', async () => {
    const rows = Array.from({length: 40}, (_, i) => ({name: `p${i}`, a: i, b: (i * 37) % 41}));
    const view = await chart(`ScatterPlot($/d,'a','b',label='name')`, {rows});
    const labels = view.all('[data-point-label]');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThanOrEqual(8);
  });

  it('keeps a fractional median on an axis of fractions (V050)', async () => {
    const rows = [{a: 0.5, b: 1.25}, {a: 1, b: 2}, {a: 2, b: 2.5}, {a: 3, b: 4}];
    const view = await chart(`ScatterPlot($/d,'a','b',quadrants=true)`, {rows});
    expect(view.root.querySelector('[data-median="x"]')?.textContent).toBe('median 1.5');
    expect(view.root.querySelector('[data-median="y"]')?.textContent).toBe('median 2.25');
  });

  it('draws dashed median lines for quadrants', async () => {
    const view = await chart(`ScatterPlot($/d,'commits','complexity',quadrants=true)`, {rows: FILES});
    expect(view.all('[data-quadrants] line')).toHaveLength(2);
    // whole-number axes have whole-number medians (V050): the median of 22 and 33 commits is tagged 28, not 27.5
    expect(view.root.querySelector('[data-median="x"]')?.textContent).toBe('median 28');
    // the tags are in the margins (F007), each at the end of its line: the x tag under the plot, the y tag right of it
    const [vertical, horizontal] = view.all('[data-quadrants] line');
    const bottom = Number(vertical!.getAttribute('y2'));
    const right = Number(horizontal!.getAttribute('x2'));
    const xTag = view.root.querySelector('[data-median="x"]')!;
    expect(Number(xTag.getAttribute('y'))).toBeGreaterThan(bottom + 20);
    // (the line is snapped to the pixel grid, the tag is not)
    expect(Math.abs(Number(xTag.getAttribute('x')) - Number(vertical!.getAttribute('x1')))).toBeLessThan(1);
    expect(Number(view.root.querySelector('[data-median="y"]')!.getAttribute('x'))).toBeGreaterThan(right);
    expect(view.root.querySelector('[data-median="y"]')!.textContent).toBe('median 56');
    view.unmount();
    const plain = await chart(`ScatterPlot($/d,'commits','complexity')`, {rows: FILES});
    expect(plain.all('[data-quadrants]')).toHaveLength(0);
  });

  it('colours by a category with the server slots and shows a legend', async () => {
    const view = await chart(`ScatterPlot($/d,'commits','complexity',color='owner')`, {rows: FILES});
    expect(view.all('[data-chart-legend] [data-series]').map(el => el.getAttribute('data-series'))).toEqual(['Mira', 'Jon', 'Ade']);
    const byPath = new Map(view.all('circle[data-i]').map(el => [Number(el.getAttribute('cx')), (el as SVGElement).style.fill]));
    expect(new Set(byPath.values())).toEqual(new Set(['var(--gl-cat-1)', 'var(--gl-cat-2)', 'var(--gl-cat-3)']));
  });

  it('selects a point with a path as a file, dims the rest, and follows outside selections', async () => {
    const view = await chart(`ScatterPlot($/d,'commits','complexity')`, {rows: FILES});
    fireEvent.click(view.all('circle[data-i]')[0]!);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'file', id: 'src/auth/service.ts'});
    expect(view.all('circle[data-dim]')).toHaveLength(3);
    expect(view.all('[data-ring="sel"]')).toHaveLength(1);
    view.setData('/ui/sel', {type: 'dir', id: 'src/api', path: 'src/api'});
    expect(view.all('circle[data-dim]')).toHaveLength(2);
  });

  it('moves between points with the arrow keys and shows the tooltip', async () => {
    const view = await chart(`ScatterPlot($/d,'commits','complexity')`, {rows: FILES});
    view.key('Home');
    const first = view.root.querySelector('[aria-live]')!.textContent;
    view.key('ArrowLeft');
    view.key('ArrowLeft');
    view.key('ArrowLeft');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('src/api/limiter.go, commits 11, complexity 20');
    expect(first).not.toBe('src/api/limiter.go, commits 11, complexity 20');
    expect(view.tooltip()).toContain('src/api/limiter.go');
    view.key('Enter');
    expect(view.getData('/ui/sel')).toMatchObject({id: 'src/api/limiter.go'});
  });

  it('moves the marks to a canvas above 3,000 points and still finds the point under the pointer', async () => {
    const calls = {arc: 0};
    const context = new Proxy({}, {get: (_, key) => (key === 'arc' ? () => void calls.arc++ : () => {}), set: () => true});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const rows = Array.from({length: 3200}, (_, i) => ({name: `p${i}`, a: i % 80, b: Math.floor(i / 80)}));
    const view = await chart(`ScatterPlot($/d,'a','b',label='name')`, {rows});
    expect(view.all('[data-chart-canvas] canvas')).toHaveLength(1);
    expect(view.all('circle[data-i]')).toHaveLength(0);
    expect(calls.arc).toBe(3200);
    expect(view.svg.getAttribute('aria-label')).toContain('3,200 points');
    view.key('Home');
    const ring = view.root.querySelector('[data-ring="focus"]')!;
    fireEvent.pointerMove(view.svg, {clientX: Number(ring.getAttribute('cx')), clientY: Number(ring.getAttribute('cy'))});
    expect(view.tooltip()).toMatch(/^p\d+/);
    fireEvent.click(view.svg, {clientX: Number(ring.getAttribute('cx')), clientY: Number(ring.getAttribute('cy'))});
    expect(view.getData('/ui/sel')).toMatchObject({type: 'row'});
  });

  it('follows a binding update', async () => {
    const view = await chart(`ScatterPlot($/d,'commits','complexity')`, {rows: FILES});
    view.setData('/d', FILES.slice(0, 2));
    expect(view.all('circle[data-i]')).toHaveLength(2);
  });
  // the plot rectangle, read from the grid: horizontal lines run left to right, vertical ones top to bottom
  const frame = (view: {all(selector: string): Element[]}) => {
    const lines = view.all('svg line').map(el => ['x1', 'x2', 'y1', 'y2'].map(name => Number(el.getAttribute(name))) as [number, number, number, number]);
    const across = lines.find(([x1, x2, y1, y2]) => y1 === y2 && x1 !== x2)!;
    const down = lines.find(([x1, x2, y1, y2]) => x1 === x2 && y1 !== y2)!;
    return {left: across[0], right: across[1], top: Math.min(down[2], down[3]), bottom: Math.max(down[2], down[3])};
  };
  const circles = (view: {all(selector: string): Element[]}) =>
    view.all('circle[data-i]').map(el => ({i: Number(el.getAttribute('data-i')), cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')), r: Number(el.getAttribute('r'))}));

  it('keeps every circle inside the plot: none hangs over an axis or the far edge (F007)', async () => {
    // big circles on the baseline, on the y axis and in the far corner
    const rows = [{f: 'a', x: 0, y: 0, n: 900}, {f: 'b', x: 9, y: 0, n: 900}, {f: 'c', x: 0, y: 40, n: 900}, {f: 'd', x: 10, y: 40, n: 900}, {f: 'e', x: 5, y: 20, n: 10}];
    const view = await chart(`ScatterPlot($/d,'x','y',r='n',label='f')`, {rows});
    const box = frame(view);
    for (const dot of circles(view)) {
      expect(dot.cx - dot.r).toBeGreaterThanOrEqual(box.left - 0.5);
      expect(dot.cx + dot.r).toBeLessThanOrEqual(box.right + 0.5);
      expect(dot.cy - dot.r).toBeGreaterThanOrEqual(box.top - 0.5);
      expect(dot.cy + dot.r).toBeLessThanOrEqual(box.bottom + 0.5);
    }
  });

  it('places a label right, left, above or below its circle, clear of the other circles, labels and median lines (F007)', async () => {
    const rows = Array.from({length: 60}, (_, i) => ({name: `file-${i}.ts`, a: (i * 7) % 23, b: (i * 37) % 41, n: 50 + ((i * 13) % 200)}));
    const view = await chart(`ScatterPlot($/d,'a','b',r='n',label='name',quadrants=true)`, {rows});
    const box = frame(view);
    const dots = circles(view);
    const [vertical, horizontal] = view.all('[data-quadrants] line');
    const mx = Number(vertical!.getAttribute('x1'));
    const my = Number(horizontal!.getAttribute('y1'));
    const boxes = view.all('[data-point-label]').map(el => {
      const x = Number(el.getAttribute('x'));
      const y = Number(el.getAttribute('y'));
      const w = (el.textContent ?? '').length * 6.6;
      const place = el.getAttribute('data-place');
      const x0 = place === 'start' ? x : place === 'end' ? x - w : x - w / 2;
      return {i: Number(el.getAttribute('data-i')), x0, x1: x0 + w, y0: y - 7, y1: y + 7};
    });
    expect(boxes.length).toBeGreaterThan(2);
    expect(boxes.length).toBeLessThanOrEqual(8);
    for (const label of boxes) {
      expect(label.x0).toBeGreaterThanOrEqual(box.left);
      expect(label.x1).toBeLessThanOrEqual(box.right);
      expect(label.y1).toBeLessThanOrEqual(box.bottom);
      // no median line through the text
      expect(label.x0 < mx && label.x1 > mx).toBe(false);
      expect(label.y0 < my && label.y1 > my).toBe(false);
      for (const dot of dots) {
        if (dot.i === label.i) continue;
        const dx = dot.cx - Math.max(label.x0, Math.min(dot.cx, label.x1));
        const dy = dot.cy - Math.max(label.y0, Math.min(dot.cy, label.y1));
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(dot.r - 0.01);
      }
      for (const other of boxes) {
        if (other === label) continue;
        expect(label.x0 < other.x1 && label.x1 > other.x0 && label.y0 < other.y1 && label.y1 > other.y0).toBe(false);
      }
    }
  });

  it('draws a crowd lighter so it reads as density (F007)', async () => {
    const few = await chart(`ScatterPlot($/d,'a','b')`, {rows: Array.from({length: 150}, (_, i) => ({a: i, b: (i * 37) % 41}))});
    expect(few.all('[data-dense]')).toHaveLength(0);
    few.unmount();
    const many = await chart(`ScatterPlot($/d,'a','b')`, {rows: Array.from({length: 151}, (_, i) => ({a: i, b: (i * 37) % 41}))});
    expect(many.all('[data-dense]')).toHaveLength(1);
    expect(many.all('[data-dense] circle[data-i]')).toHaveLength(151);
  });

  it('spreads the points of an axis that only takes a few whole values, says so, and ticks it at whole numbers (F007)', async () => {
    expect(spreadOf([1, 1, 1, 1, 2, 2, 2, 2])).toBeCloseTo(0.3);
    expect(spreadOf([1, 1, 1, 1, 3, 3, 3, 3, 9])).toBe(0);
    expect(spreadOf([1, 1.5, 1, 1, 2, 2, 2, 2])).toBe(0);
    expect(spreadOf(Array.from({length: 60}, (_, i) => i % 13))).toBe(0);
    // a young repository: every file has one or two commits
    const rows = Array.from({length: 40}, (_, i) => ({path: `src/f${i}.ts`, commits: i < 34 ? 1 : 2, complexity: 10 + i * 7.5}));
    const view = await chart(`ScatterPlot($/d,'commits','complexity')`, {rows});
    expect(new Set(circles(view).map(dot => Math.round(dot.cx))).size).toBeGreaterThan(10);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('equal commits spread apart');
    const ticks = view.all('svg text').map(el => el.textContent ?? '').filter(text => /^[\d.]+$/.test(text));
    expect(ticks).toEqual(expect.arrayContaining(['0', '1', '2']));
    expect(ticks).not.toContain('0.5');
    expect(ticks).not.toContain('1.5');
    // the same data draws the same picture
    const again = await chart(`ScatterPlot($/d,'commits','complexity')`, {rows});
    expect(circles(again).map(dot => dot.cx)).toEqual(circles(view).map(dot => dot.cx));
    again.unmount();
    view.unmount();
    const spreadOut = await chart(`ScatterPlot($/d,'commits','complexity')`, {rows: FILES});
    expect(spreadOut.all('[data-chart-note]')).toHaveLength(0);
  });
});
