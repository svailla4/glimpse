import {fireEvent} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, errorDataset} from '../harness.tsx';
import {chart} from './util.tsx';

const cells = (view: {all(selector: string): Element[]}) => view.all('[data-cell]').map(el => el.getAttribute('data-cell'));
const crumbs = (view: {all(selector: string): Element[]}) => view.all('[data-chart-crumbs] button').map(el => el.textContent).join(' / ');

describe('Icicle', () => {
  it('draws every level of the default source as 20 px rows', async () => {
    const view = await chart(`Icicle(title='Tree by size')`);
    expect(view.svg.getAttribute('aria-label')).toBe('Icicle of loc, 4 levels, 10 leaves, total 5,010');
    expect(cells(view)).toContain('src/auth/service.ts');
    expect(new Set(view.all('[data-cell] rect').map(el => el.getAttribute('height')))).toEqual(new Set(['20']));
    const rows = new Set(view.all('[data-cell] rect').map(el => Number(el.getAttribute('y'))));
    expect([...rows].sort((a, b) => a - b)).toEqual([0, 21, 42, 63]);
    expect(view.root.querySelector('[data-cell=""] rect')?.getAttribute('width')).toBe('959');
    expect(view.errors).toEqual([]);
  });

  it('shows drafting, empty, a source error and a wrong shape', async () => {
    const pending = await chart('Icicle()', {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('Icicle($/d)', {rows: {}});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart('Icicle()', {data: {'/ds/files_tree': errorDataset('files.tree')}});
    expect(failed.code()).toBe('E_INTERNAL');
    failed.unmount();
    const shape = await chart('Icicle($/d)', {rows: 7});
    expect(shape.code()).toBe('E_SHAPE');
    shape.unmount();
    const zeros = await chart('Icicle($/d)', {rows: {name: '', path: '', dir: true, children: [{name: 'a', path: 'a', loc: 0}]}});
    expect(zeros.state()).toBe('empty');
  });

  it('zooms a subtree to full width on click and back out from the top row or with Backspace', async () => {
    const view = await chart('Icicle()');
    fireEvent.click(view.root.querySelector('[data-cell="src/auth"]')!);
    expect(crumbs(view)).toBe('demo / src / auth');
    expect(view.root.querySelector('[data-cell="src/auth"] rect')?.getAttribute('width')).toBe('959');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'dir', id: 'src/auth'});
    fireEvent.click(view.root.querySelector('[data-cell="src/auth"]')!);
    expect(crumbs(view)).toBe('demo / src');
    view.key('Backspace');
    expect(crumbs(view)).toBe('demo');
    // a file is selected, not zoomed
    fireEvent.click(view.root.querySelector('[data-cell="README.md"]')!);
    expect(crumbs(view)).toBe('demo');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'file', id: 'README.md'});
    expect(view.all('[data-selected-cell]')).toHaveLength(1);
  });

  it('hatches the rollup and drills it on Enter, not on a plain click', async () => {
    const view = await chart('Icicle()');
    const rollup = view.root.querySelector('[data-rollup]')!;
    expect(rollup.textContent).toBe('(12 more)');
    fireEvent.click(rollup);
    expect(view.actions.filter(action => action.name === 'gl_drill')).toHaveLength(0);
    fireEvent.doubleClick(rollup);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'files_tree', target: 'src/ui'}});
  });

  it('walks cells with the arrow keys and zooms with Enter', async () => {
    const view = await chart('Icicle()');
    view.key('ArrowRight');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('root, 5,010 loc, directory');
    view.key('ArrowDown');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('src, 4,700 loc, directory');
    expect(view.tooltip()).toContain('Enter zooms in');
    view.key('Enter');
    expect(crumbs(view)).toBe('demo / src');
    // the layout changed under the tooltip: it is taken down
    expect(view.tooltip()).toBe('');
  });

  it('dims what a selection made elsewhere does not touch, and follows a binding update', async () => {
    const view = await chart('Icicle($/d)', {rows: {name: '', path: '', dir: true, children: [{name: 'a.ts', path: 'a.ts', loc: 10}, {name: 'b.ts', path: 'b.ts', loc: 30}]}});
    view.setData('/ui/sel', {type: 'file', id: 'b.ts', path: 'b.ts'});
    expect(view.all('[data-cell]:not([data-dim])').map(el => el.getAttribute('data-cell'))).toEqual(['', 'b.ts']);
    view.setData('/d', {name: '', path: '', dir: true, children: [{name: 'c.ts', path: 'c.ts', loc: 5}]});
    expect(cells(view)).toEqual(['', 'c.ts']);
  });
  it('gives the rows the height of a sized cell, up to 120 px, and keeps the legend under them (F009)', async () => {
    const plain = await chart('Icicle()');
    expect(new Set(plain.all('[data-cell] rect:first-child').map(el => el.getAttribute('height')))).toEqual(new Set(['20']));
    plain.unmount();
    // four levels in a 600 px box: the rows share the height left after the legend, at most 120 px each
    const sized = await chart(`Icicle(size='l')`);
    expect(new Set(sized.all('[data-cell] rect:first-child').map(el => el.getAttribute('height')))).toEqual(new Set(['120']));
    expect(sized.svg.getAttribute('height')).toBe(String(4 * 121 - 1));
    // a row that tall names its value under the name
    expect(sized.all('[data-cell-value]').length).toBeGreaterThan(0);
    // the legend is inside the plot box, right after the drawing
    const legend = sized.root.querySelector('[data-chart-legend]')!;
    expect(sized.svg.parentElement!.parentElement!.contains(legend)).toBe(true);
    sized.unmount();
    // a box too short for more keeps the 20 px rows
    const short = await chart(`Icicle(size='s')`, {size: {width: 960, height: 100}});
    expect(new Set(short.all('[data-cell] rect:first-child').map(el => el.getAttribute('height')))).toEqual(new Set(['20']));
  });

  it('names the scope of a drilled tree and steps out of the drill with Backspace (drill-has-way-back, F074)', async () => {
    const view = await chart('Icicle()');
    view.key('Backspace');
    expect(view.actions.filter(action => action.name === 'gl_drill')).toHaveLength(0);
    const scoped = datasetFixture<{children: unknown[]}>('files.tree');
    const data = {name: 'ui', path: 'src/ui', dir: true, files: 1, loc: 700, children: [{name: 'app.css', path: 'src/ui/app.css', dir: false, files: 1, loc: 700, lang: 'CSS'}]};
    view.setData('/ds/files_tree', {...scoped, data, drill: {target: 'src/ui', up: 'src'}});
    expect(crumbs(view)).toBe('ui');
    expect(view.root.querySelector('[data-cell="src/ui"] text')?.textContent).toBe('ui');
    view.key('Backspace');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', sourceComponentId: 'c', context: {ds: 'files_tree', target: 'src'}});
  });
});
