import {act, fireEvent} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {errorDataset} from '../harness.tsx';
import {LONG, chart} from './util.tsx';

const FILES = [
  {path: 'src/auth/service.ts', commits: 51, owner: 'Mira'},
  {path: 'src/api/routes.ts', commits: 33, owner: 'Jon'},
  {path: 'src/ui/app.css', commits: 9, owner: 'Jon'},
];

describe('BarChart', () => {
  it('draws one bar per row with encodings from the dataset roles', async () => {
    const view = await chart(`BarChart('git.authors',title='Authors')`);
    expect(view.svg.getAttribute('aria-label')).toBe('Bar chart, 3 bars, largest Mira 96');
    expect(view.all('path[data-i]')).toHaveLength(3);
    expect(view.all('[data-bar-label]').map(el => el.textContent)).toEqual(['Mira', 'Jon', 'Ade']);
    expect(view.root.textContent).toContain('96');
    expect(view.errors).toEqual([]);
  });

  it('falls back to the first categorical and first numeric field without roles', async () => {
    const view = await chart('BarChart($/d)', {rows: FILES});
    expect(view.all('[data-bar-label]').map(el => el.textContent)).toEqual(['src/auth/service.ts', 'src/api/routes.ts', 'src/ui/app.css']);
    expect(view.svg.getAttribute('aria-label')).toContain('largest src/auth/service.ts 51');
  });

  it('shows drafting while pending, the empty frame for no rows and a redline for a failed source', async () => {
    const pending = await chart(`BarChart('git.authors')`, {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('BarChart($/d)', {rows: []});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart(`BarChart('git.authors')`, {data: {'/ds/git_authors': errorDataset('git.authors', 'E_NO_GIT', 'not a repository')}});
    expect(failed.code()).toBe('E_NO_GIT');
  });

  it('redlines a wrong shape and names what it received', async () => {
    const text = await chart('BarChart($/d)', {rows: 'not rows'});
    expect(text.code()).toBe('E_SHAPE');
    expect(text.root.textContent).toContain('expected an array of row objects, received string');
    text.unmount();
    const scalars = await chart('BarChart($/d)', {rows: [1, 2, 3]});
    expect(scalars.code()).toBe('E_SHAPE');
    scalars.unmount();
    const noNumbers = await chart('BarChart($/d)', {rows: [{a: 'x', b: 'y'}]});
    expect(noNumbers.state()).toBe('empty');
  });

  it('coerces numeric strings, keeps a dash for missing cells and counts what it skipped', async () => {
    const view = await chart(`BarChart($/d,'name','n',title='T')`, {rows: [{name: 'a', n: '12'}, {name: 'b', n: null}, {name: 'c', n: 'oops'}, {name: 'd', n: Number.NaN}, 'junk']});
    expect(view.all('path[data-i]')).toHaveLength(1);
    expect(view.all('[data-bar-label]')).toHaveLength(4);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('1 row skipped · 2 values not numeric');
  });

  it('follows a binding update without redrawing from scratch', async () => {
    const view = await chart(`BarChart($/d,'path','commits')`, {rows: FILES});
    expect(view.all('path[data-i]')).toHaveLength(3);
    view.setData('/d', [...FILES, {path: 'README.md', commits: 4}]);
    expect(view.all('path[data-i]')).toHaveLength(4);
    view.setData('/d', []);
    expect(view.state()).toBe('empty');
    view.setData('/d', FILES.slice(0, 2));
    await view.settle();
    expect(view.all('path[data-i]')).toHaveLength(2);
  });

  it('survives one datum, all zeros, negatives and 500-character labels', async () => {
    const one = await chart('BarChart($/d)', {rows: [{name: 'only', n: 7}]});
    expect(one.all('path[data-i]')).toHaveLength(1);
    one.unmount();
    const zeros = await chart('BarChart($/d)', {rows: [{name: 'a', n: 0}, {name: 'b', n: 0}]});
    expect(zeros.all('path[data-i]')).toHaveLength(2);
    expect(zeros.svg.innerHTML).not.toContain('NaN');
    zeros.unmount();
    const negative = await chart('BarChart($/d)', {rows: [{name: 'gain', n: 5}, {name: 'loss', n: -8}]});
    expect(negative.all('path[data-neg]')).toHaveLength(1);
    expect(negative.root.textContent).toContain('−8');
    expect(negative.svg.innerHTML).not.toContain('NaN');
    negative.unmount();
    const long = await chart('BarChart($/d)', {rows: [{name: LONG, n: 5}, {name: `src/${LONG}/file.ts`, n: 3}]});
    const labels = long.all('[data-bar-label]').map(el => el.textContent ?? '');
    expect(Math.max(...labels.map(text => text.length))).toBeLessThan(80);
    expect(long.svg.getAttribute('aria-label')!.length).toBeLessThan(200);
  });

  it('folds bars beyond the limit into one other bar and more than eight series into other', async () => {
    const many = Array.from({length: 30}, (_, i) => ({name: `item-${i}`, n: 100 - i}));
    const view = await chart(`BarChart($/d,limit=5)`, {rows: many});
    expect(view.all('[data-bar-label]').map(el => el.textContent)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'other (25)']);
    view.unmount();
    const series = Array.from({length: 12}, (_, i) => ({team: 'core', who: `dev-${i}`, n: 12 - i}));
    const stacked = await chart(`BarChart($/d,'team','n','who',mode='stacked')`, {rows: series});
    const legend = stacked.all('[data-chart-legend] [data-series]').map(el => el.getAttribute('data-series'));
    expect(legend).toHaveLength(8);
    expect(legend.at(-1)).toBe('other');
    expect(stacked.svg.getAttribute('aria-label')).toContain('8 series');
  });

  it('gives a series the ink the server assigned to that entity', async () => {
    const rows = [{week: 'w1', module: 'ui', n: 3}, {week: 'w1', module: 'auth', n: 5}, {week: 'w1', module: 'new', n: 1}];
    const view = await chart(`BarChart($/d,'week','n','module')`, {rows});
    const fills = view.all('path[data-i]').map(el => (el as SVGElement).style.fill);
    // FIXTURE_META: auth is slot 1, ui slot 3; the unknown module takes the first free slot
    expect(fills).toEqual(['var(--gl-cat-3)', 'var(--gl-cat-1)', 'var(--gl-cat-2)']);
  });

  it('draws grouped, stacked and normalised series, vertical when asked', async () => {
    const rows = [{q: 'Q1', a: 2, b: 6}, {q: 'Q2', a: 5, b: 5}];
    const grouped = await chart(`BarChart($/d,'q','a b',dir='v')`, {rows});
    expect(grouped.all('path[data-i]')).toHaveLength(4);
    grouped.unmount();
    const pct = await chart(`BarChart($/d,'q','a b',mode='pct')`, {rows});
    fireEvent.pointerMove(pct.all('path[data-i]')[0]!, {clientX: 10, clientY: 10});
    expect(pct.tooltip()).toContain('25%');
  });

  it('draws in once: the draw flag is set on first paint, goes away, and does not come back on refresh', async () => {
    const view = await chart(`BarChart($/d,'path','commits')`, {rows: FILES});
    expect(view.svg.hasAttribute('data-draw')).toBe(true);
    expect(view.all('path[data-i]').every(el => /growX/.test(el.getAttribute('class') ?? ''))).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)); });
    expect(view.svg.hasAttribute('data-draw')).toBe(false);
    view.setData('/d', [...FILES, {path: 'README.md', commits: 4}]);
    expect(view.all('path[data-i]')).toHaveLength(4);
    expect(view.svg.hasAttribute('data-draw')).toBe(false);
  });

  it('selects the entity of a bar on click, dims the rest and clears on Escape', async () => {
    const view = await chart(`BarChart($/d,'path','commits')`, {rows: FILES});
    fireEvent.click(view.all('path[data-i]')[1]!);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'file', id: 'src/api/routes.ts', path: 'src/api/routes.ts'});
    expect(view.getData('/ui/file')).toBe('src/api/routes.ts');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'c'});
    expect(view.all('path[data-i]').map(el => el.hasAttribute('data-dim'))).toEqual([true, false, true]);
    expect(view.all('[data-ring="sel"]')).toHaveLength(1);
    view.key('Escape');
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(view.all('[data-dim]')).toHaveLength(0);
  });

  it('highlights the mark that matches a selection made elsewhere, including a file inside a selected directory', async () => {
    const view = await chart(`BarChart($/d,'path','commits')`, {rows: FILES});
    view.setData('/ui/sel', {type: 'dir', id: 'src/auth', path: 'src/auth'});
    expect(view.all('path[data-i]').map(el => el.hasAttribute('data-dim'))).toEqual([false, true, true]);
    view.setData('/ui/sel', {type: 'symbol', id: 'nothing here'});
    expect(view.all('[data-dim]')).toHaveLength(0);
  });

  it('walks the bars with the keyboard, announces them, opens and copies', async () => {
    const view = await chart(`BarChart($/d,'path','commits')`, {rows: FILES});
    expect(view.svg.getAttribute('tabindex')).toBe('0');
    view.key('ArrowDown');
    expect(view.all('[data-ring="focus"]')).toHaveLength(1);
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('src/auth/service.ts, 51');
    expect(view.tooltip()).toContain('src/auth/service.ts');
    view.key('End');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('src/ui/app.css, 9');
    view.key('ArrowUp');
    view.key('Enter');
    expect(view.getData('/ui/sel')).toMatchObject({id: 'src/api/routes.ts'});
    view.key('o');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/api/routes.ts'}});
    view.key('c');
    expect(view.clipboard).toEqual(['src/api/routes.ts']);
    fireEvent.click(view.all('path[data-i]')[0]!, {metaKey: true});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/auth/service.ts'}});
  });
});
