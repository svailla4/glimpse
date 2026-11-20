import {fireEvent} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {errorDataset} from '../harness.tsx';
import {LONG, chart} from './util.tsx';

const WEEKS = [
  {week: '2026-10-05', module: 'auth', commits: 4}, {week: '2026-10-05', module: 'api', commits: 2},
  {week: '2026-10-12', module: 'auth', commits: 7}, {week: '2026-10-12', module: 'api', commits: 5},
  {week: '2026-10-19', module: 'auth', commits: 3}, {week: '2026-10-19', module: 'api', commits: 6},
];
const paths = (view: {all(selector: string): Element[]}) => view.all('[data-series] path[pathLength]').map(el => el.getAttribute('d') ?? '');

describe('LineChart', () => {
  it('draws one line per series with direct labels, from the dataset roles', async () => {
    const view = await chart(`LineChart('git.timeline',title='Activity')`);
    expect(view.svg.getAttribute('aria-label')).toBe('Line chart, 3 series over 6 points, 5 Oct 2026 to 9 Nov 2026, largest auth');
    expect(view.all('[data-series]').map(el => el.getAttribute('data-series'))).toEqual(['auth', 'api', 'ui']);
    expect(view.all('[data-end-label]').map(el => el.textContent)).toEqual(expect.arrayContaining(['auth', 'api', 'ui']));
    expect(view.all('[data-chart-legend]')).toHaveLength(0);
    expect(paths(view).every(d => d.startsWith('M') && !d.includes('NaN'))).toBe(true);
    // the server's module slots: auth 1, api 2, ui 3
    expect(view.all('[data-series] path[pathLength]').map(el => (el as SVGElement).style.stroke)).toEqual(['var(--gl-cat-1)', 'var(--gl-cat-2)', 'var(--gl-cat-3)']);
    expect(view.errors).toEqual([]);
  });

  it('nudges direct labels at least 14 px apart', async () => {
    const rows = ['a', 'b', 'c', 'd'].flatMap(name => [{t: 1, name, v: 10}, {t: 2, name, v: 10.01}]);
    const view = await chart(`LineChart($/d,'t','v','name')`, {rows});
    const ys = view.all('[data-end-label] text').map(el => Number(el.getAttribute('y'))).sort((a, b) => a - b);
    expect(ys).toHaveLength(4);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(14);
  });

  it('shows drafting, empty, a source error and a wrong shape', async () => {
    const pending = await chart(`LineChart('git.timeline')`, {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('LineChart($/d)', {rows: []});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart(`LineChart('git.timeline')`, {data: {'/ds/git_timeline': errorDataset('git.timeline', 'E_SHALLOW', 'shallow clone')}});
    expect(failed.code()).toBe('E_SHALLOW');
    failed.unmount();
    const shape = await chart('LineChart($/d)', {rows: {week: 1}});
    expect(shape.code()).toBe('E_SHAPE');
    shape.unmount();
    const noNumbers = await chart('LineChart($/d)', {rows: [{week: '2026-01-01', note: 'x'}]});
    expect(noNumbers.state()).toBe('empty');
  });

  it('stacks layers, normalises to 100% and fills areas', async () => {
    const stacked = await chart(`LineChart($/d,'week','commits','module',mode='stacked')`, {rows: WEEKS});
    expect(stacked.svg.getAttribute('aria-label')).toMatch(/^Stacked area chart, 2 series/);
    expect(stacked.all('[data-series] path')).toHaveLength(2);
    stacked.key('ArrowRight');
    expect(stacked.tooltip()).toContain('total 6');
    stacked.unmount();
    const pct = await chart(`LineChart($/d,'week','commits','module',mode='pct')`, {rows: WEEKS});
    expect(pct.root.textContent).toContain('100%');
    pct.unmount();
    const area = await chart(`LineChart($/d,'week','commits','module',mode='area')`, {rows: WEEKS});
    expect(area.all('[data-series] path')).toHaveLength(6);
  });

  it('breaks the line at nulls and draws lone points as dots', async () => {
    const rows = [{x: 1, y: 5}, {x: 2, y: 6}, {x: 3, y: null}, {x: 4, y: 2}, {x: 5, y: 'bad'}, {x: 6, y: 4}, {x: 7, y: 3}];
    const view = await chart(`LineChart($/d,'x','y')`, {rows});
    // two runs and, between the gaps, one point on its own (a zero-length subpath plus a dot)
    const d = paths(view)[0]!;
    expect(d.match(/M/g)).toHaveLength(3);
    expect(view.all('[data-series] circle')).toHaveLength(2);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('1 value skipped');
  });

  it('survives one datum, all zeros, negatives and 500-character names', async () => {
    const one = await chart('LineChart($/d)', {rows: [{day: '2026-11-01', n: 3}]});
    expect(one.all('[data-series] circle').length).toBeGreaterThan(0);
    expect(one.svg.innerHTML).not.toContain('NaN');
    one.unmount();
    const zeros = await chart('LineChart($/d)', {rows: [{day: '2026-11-01', n: 0}, {day: '2026-11-02', n: 0}]});
    expect(zeros.svg.innerHTML).not.toContain('NaN');
    zeros.unmount();
    const negative = await chart('LineChart($/d)', {rows: [{day: '2026-11-01', n: -4}, {day: '2026-11-02', n: 6}]});
    expect(negative.svg.innerHTML).not.toContain('NaN');
    expect(negative.root.textContent).toContain('−4');
    negative.unmount();
    const long = await chart(`LineChart($/d,'t','v','name')`, {rows: [{t: 1, name: LONG, v: 1}, {t: 2, name: LONG, v: 2}, {t: 1, name: 'b', v: 2}, {t: 2, name: 'b', v: 1}]});
    expect(Math.max(...long.all('[data-end-label]').map(el => el.textContent!.length))).toBeLessThan(40);
    expect(long.svg.getAttribute('aria-label')!.length).toBeLessThan(200);
  });

  it('keeps non-positive values off a log scale and says so', async () => {
    const view = await chart(`LineChart($/d,'x','y',scale='log')`, {rows: [{x: 1, y: 0}, {x: 2, y: 10}, {x: 3, y: 1000}, {x: 4, y: -5}]});
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('2 off the log scale');
    expect(view.svg.innerHTML).not.toContain('NaN');
    expect(view.root.textContent).toContain('1,000');
  });

  it('folds more than eight series into other and falls back to a legend when labels do not fit', async () => {
    const rows = Array.from({length: 12}, (_, s) => [{t: 1, who: `dev-${s}`, n: 12 - s}, {t: 2, who: `dev-${s}`, n: 13 - s}]).flat();
    const view = await chart(`LineChart($/d,'t','n','who')`, {rows});
    const names = view.all('[data-series]').map(el => el.getAttribute('data-series'));
    expect(names).toHaveLength(8);
    expect(names.at(-1)).toBe('other');
    view.unmount();
    const narrow = await chart(`LineChart($/d,'week','commits','module')`, {rows: WEEKS, size: {width: 280, height: 600}});
    expect(narrow.all('[data-end-label]')).toHaveLength(0);
    expect(narrow.all('[data-chart-legend] [data-series]')).toHaveLength(2);
  });

  it('orders categorical x values as they come and numeric ones by value', async () => {
    const weeks = await chart(`LineChart($/d,'w','n')`, {rows: [{w: 'W40', n: 1}, {w: 'W36', n: 2}, {w: 'W44', n: 3}]});
    expect(weeks.svg.getAttribute('aria-label')).toContain('W40 to W44');
    weeks.unmount();
    const numeric = await chart(`LineChart($/d,'x','n')`, {rows: [{x: 30, n: 1}, {x: 10, n: 2}, {x: 20, n: 3}]});
    expect(numeric.svg.getAttribute('aria-label')).toContain('10 to 30');
  });

  it('snaps a crosshair to the nearest x and lists every series in the tooltip', async () => {
    const view = await chart(`LineChart($/d,'week','commits','module')`, {rows: WEEKS});
    fireEvent.pointerMove(view.svg, {clientX: 20, clientY: 100});
    expect(view.tooltip()).toContain('5 Oct 2026');
    expect(view.tooltip()).toContain('auth');
    expect(view.tooltip()).toContain('api');
    fireEvent.pointerLeave(view.svg);
    expect(view.tooltip()).toBe('');
  });

  it('steps through x with the arrows, picks a series with up and down, and selects it', async () => {
    const view = await chart(`LineChart($/d,'week','commits','module')`, {rows: WEEKS});
    view.key('ArrowRight');
    view.key('ArrowRight');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('12 Oct 2026, auth 7, 2 series');
    view.key('ArrowDown');
    view.key('Enter');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'module', id: 'api'});
    expect(view.all('[data-series]').map(el => el.hasAttribute('data-dim'))).toEqual([true, false]);
    view.key('Escape');
    expect(view.all('[data-dim]')).toHaveLength(0);
  });

  it('selects a series from its label and follows a selection made elsewhere', async () => {
    const view = await chart(`LineChart($/d,'week','commits','module')`, {rows: WEEKS});
    fireEvent.click(view.root.querySelector('[data-end-label="auth"]')!);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'module', id: 'auth'});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select'});
    view.setData('/ui/sel', {type: 'module', id: 'api'});
    expect(view.all('[data-series]').map(el => el.hasAttribute('data-dim'))).toEqual([true, false]);
  });

  it('follows a binding update and draws thousands of points', async () => {
    const view = await chart(`LineChart($/d,'week','commits','module')`, {rows: WEEKS});
    expect(view.svg.getAttribute('aria-label')).toContain('over 3 points');
    view.setData('/d', [...WEEKS, {week: '2026-10-26', module: 'auth', commits: 9}]);
    expect(view.svg.getAttribute('aria-label')).toContain('over 4 points');
    view.unmount();
    const big = await chart('LineChart($/d)', {rows: Array.from({length: 6000}, (_, i) => ({x: i, y: Math.sin(i / 50) * 100}))});
    expect(big.svg.getAttribute('aria-label')).toContain('over 6,000 points');
    expect(big.all('[data-series] path[pathLength]')).toHaveLength(1);
    big.setData('/d', [{week: '2026-10-05', note: 'no numbers any more'}]);
    expect(big.state()).toBe('empty');
    big.setData('/d', WEEKS);
    await big.settle();
    // no props and no roles: the first date, the first numeric field, and the categorical field that repeats per date
    expect(big.svg.getAttribute('aria-label')).toContain('2 series over 3 points');
  });
});
