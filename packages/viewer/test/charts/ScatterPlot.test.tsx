import {fireEvent} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {errorDataset} from '../harness.tsx';
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
    expect(view.svg.getAttribute('aria-label')).toBe('Scatter plot, 5 points, commits against complexity, sized by SLOC');
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

  it('draws dashed median lines for quadrants', async () => {
    const view = await chart(`ScatterPlot($/d,'commits','complexity',quadrants=true)`, {rows: FILES});
    expect(view.all('[data-quadrants] line')).toHaveLength(2);
    expect(view.root.querySelector('[data-quadrants]')?.textContent).toContain('median 27.5');
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
});
