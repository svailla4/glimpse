import {fireEvent} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {errorDataset} from '../harness.tsx';
import {LONG, chart} from './util.tsx';

const LOAD = [
  {day: 'Mon', hour: 'am', n: 4}, {day: 'Mon', hour: 'pm', n: 9},
  {day: 'Tue', hour: 'am', n: 1}, {day: 'Wed', hour: 'pm', n: 16},
];
const steps = (view: {all(selector: string): Element[]}) => view.all('g[data-i]').map(el => Number(el.getAttribute('data-step')));

afterEach(() => void vi.restoreAllMocks());

describe('Heatmap', () => {
  it('draws the dependency matrix: one order on both axes and a hatched diagonal', async () => {
    const view = await chart(`Heatmap('deps.matrix',title='Who imports whom')`);
    expect(view.svg.getAttribute('aria-label')).toBe('Dependency matrix, 3 rows by 3 columns, weight 1 to 9, highest api to auth');
    expect(view.all('[data-row-label]').map(el => el.textContent)).toEqual(['api', 'auth', 'ui']);
    expect(view.all('[data-col-label]').map(el => el.textContent)).toEqual(['api', 'auth', 'ui']);
    expect(view.all('[data-diagonal]')).toHaveLength(3);
    expect(view.all('g[data-i]')).toHaveLength(4);
    expect(view.all('[data-chart-ramp] span')).toHaveLength(9);
    expect(view.errors).toEqual([]);
  });

  it('quantises values into seven steps and prints them in cells that are wide enough', async () => {
    const view = await chart(`Heatmap($/d,'hour','day','n')`, {rows: LOAD});
    expect(view.svg.getAttribute('aria-label')).toBe('Heatmap, 3 rows by 2 columns, n 1 to 16, highest Wed and pm');
    expect(view.all('[data-diagonal]')).toHaveLength(0);
    expect(steps(view)).toEqual([2, 4, 1, 7]);
    expect(view.all('g[data-i] text').map(el => el.textContent)).toEqual(['4', '9', '1', '16']);
    expect(view.all('g[data-i] rect').map(el => (el as SVGElement).style.fill)).toEqual(['var(--gl-seq-2)', 'var(--gl-seq-4)', 'var(--gl-seq-1)', 'var(--gl-seq-7)']);
  });

  it('centres a diverging ramp on zero', async () => {
    const rows = [{a: 'x', b: 'p', v: -10}, {a: 'x', b: 'q', v: 0}, {a: 'y', b: 'p', v: 5}, {a: 'y', b: 'q', v: 10}];
    const view = await chart(`Heatmap($/d,'b','a','v',mode='div')`, {rows});
    expect(steps(view)).toEqual([1, 4, 6, 7]);
    expect((view.all('g[data-i] rect')[0] as SVGElement).style.fill).toBe('var(--gl-div-n3)');
    expect(view.root.querySelector('[data-chart-ramp]')?.textContent).toBe('−1010');
  });

  it('shows drafting, empty, a source error and a wrong shape', async () => {
    const pending = await chart(`Heatmap('deps.matrix')`, {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('Heatmap($/d)', {rows: []});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart(`Heatmap('deps.matrix')`, {data: {'/ds/deps_matrix': errorDataset('deps.matrix')}});
    expect(failed.code()).toBe('E_INTERNAL');
    failed.unmount();
    const shape = await chart('Heatmap($/d)', {rows: 'x'});
    expect(shape.code()).toBe('E_SHAPE');
    shape.unmount();
    const oneAxis = await chart('Heatmap($/d)', {rows: [{a: 'x', v: 1}]});
    expect(oneAxis.state()).toBe('empty');
  });

  it('survives one cell, all zeros, missing values and 500-character labels', async () => {
    const one = await chart('Heatmap($/d)', {rows: [{a: 'x', b: 'y', v: 3}]});
    expect(one.all('g[data-i]')).toHaveLength(1);
    expect(one.svg.innerHTML).not.toContain('NaN');
    one.unmount();
    const zeros = await chart('Heatmap($/d)', {rows: [{a: 'x', b: 'p', v: 0}, {a: 'y', b: 'q', v: 0}]});
    expect(zeros.svg.innerHTML).not.toContain('NaN');
    zeros.unmount();
    const gaps = await chart('Heatmap($/d)', {rows: [{a: 'x', b: 'p', v: 1}, {a: 'y', b: 'q', v: null}, {a: 'z', b: 'q', v: 'n/a'}, {a: null, b: 'q', v: 4}]});
    expect(gaps.all('g[data-i]')).toHaveLength(1);
    expect(gaps.root.querySelector('[data-chart-note]')?.textContent).toBe('3 rows without a value');
    gaps.unmount();
    const long = await chart('Heatmap($/d)', {rows: [{a: LONG, b: `${LONG}b`, v: 1}, {a: 'x', b: 'y', v: 2}]});
    expect(Math.max(...long.all('[data-row-label], [data-col-label]').map(el => el.textContent!.length))).toBeLessThan(40);
    expect(long.svg.getAttribute('aria-label')!.length).toBeLessThan(260);
  });

  it('selects the row entity from a cell or a label and lights its row and column', async () => {
    const view = await chart(`Heatmap('deps.matrix')`);
    fireEvent.click(view.all('g[data-i]')[0]!);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'module', id: 'api'});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select'});
    expect(view.all('[data-selected-row]')).toHaveLength(1);
    expect(view.all('[data-selected-col]')).toHaveLength(1);
    // api -> auth, auth -> api and ui -> api touch the api row or column; ui -> auth does not
    expect(view.all('g[data-i]').map(el => el.hasAttribute('data-dim'))).toEqual([false, false, false, true]);
    fireEvent.click(view.root.querySelector('[data-col-label="2"]')!);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'module', id: 'ui'});
    view.setData('/ui/sel', {type: 'file', id: 'README.md', path: 'README.md'});
    expect(view.all('[data-dim]')).toHaveLength(0);
  });

  it('moves over the grid with the arrow keys, skipping blank cells', async () => {
    const view = await chart(`Heatmap($/d,'hour','day','n')`, {rows: LOAD});
    view.key('ArrowRight');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('Mon, am, 4');
    view.key('ArrowRight');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('Mon, pm, 9');
    view.key('ArrowDown');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('Wed, pm, 16');
    view.key('ArrowLeft');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('Wed, pm, 16');
    expect(view.tooltip()).toContain('Wed · pm');
  });

  it('moves the cells to a canvas above 60 by 60', async () => {
    const calls = {fillRect: 0};
    const context = new Proxy({}, {get: (_, key) => (key === 'fillRect' ? () => void calls.fillRect++ : () => {}), set: () => true});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const rows = [];
    for (let r = 0; r < 70; r++) for (let c = 0; c < 70; c++) rows.push({from: `m${r}`, to: `m${c}`, weight: (r * c) % 13});
    const view = await chart(`Heatmap($/d,'to','from','weight')`, {rows});
    expect(view.all('[data-chart-canvas] canvas')).toHaveLength(1);
    expect(view.all('g[data-i]')).toHaveLength(0);
    expect(calls.fillRect).toBe(4900);
    expect(view.svg.getAttribute('aria-label')).toContain('70 rows by 70 columns');
    view.key('ArrowRight');
    const ring = view.root.querySelector('[data-ring="focus"]')!;
    fireEvent.pointerMove(view.svg, {clientX: Number(ring.getAttribute('x')) + 6, clientY: Number(ring.getAttribute('y')) + 6});
    expect(view.tooltip()).toContain('m0 → m0');
  });

  it('keeps at most 400 rows and columns and says what it left out', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const rows = Array.from({length: 450}, (_, i) => ({a: `row-${i}`, b: `col-${i % 3}`, v: i}));
    const view = await chart(`Heatmap($/d,'b','a','v')`, {rows});
    expect(view.svg.getAttribute('aria-label')).toContain('400 rows by 3 columns');
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('50 cells beyond 400 × 400');
  });

  it('follows a binding update', async () => {
    const view = await chart(`Heatmap($/d,'hour','day','n')`, {rows: LOAD});
    view.setData('/d', [...LOAD, {day: 'Thu', hour: 'am', n: 2}]);
    expect(view.all('[data-row-label]').map(el => el.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu']);
  });
});
