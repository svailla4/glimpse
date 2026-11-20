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

  it('folds bars of a measure that adds up beyond the limit into one other bar and more than eight stacked series into other', async () => {
    const many = Array.from({length: 30}, (_, i) => ({name: `item-${i}`, loc: 100 - i}));
    const view = await chart(`BarChart($/d,limit=5)`, {rows: many});
    expect(view.all('[data-bar-label]').map(el => el.textContent)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'other (25)']);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('25 folded into other');
    view.unmount();
    const series = Array.from({length: 12}, (_, i) => ({team: 'core', who: `dev-${i}`, n: 12 - i}));
    const stacked = await chart(`BarChart($/d,'team','n','who',mode='stacked')`, {rows: series});
    const legend = stacked.all('[data-chart-legend] [data-series]').map(el => el.getAttribute('data-series'));
    expect(legend).toHaveLength(8);
    expect(legend.at(-1)).toBe('other');
    expect(stacked.svg.getAttribute('aria-label')).toContain('8 series');
  });

  it('never sums a measure that does not add up into an other bar: per-file commits keep their top bars (V004)', async () => {
    // 433 files of a 6-commit repository: each has 1 to 4 commits, and their sum (676) is no count any row has
    const files = Array.from({length: 453}, (_, i) => ({path: `src/f${i}.ts`, commits: i < 20 ? 4 - (i % 3) : 1 + (i % 2)}));
    const view = await chart(`BarChart($/d,'path','commits')`, {rows: files});
    const labels = view.all('[data-bar-label]').map(el => el.textContent ?? '');
    expect(labels).toHaveLength(20);
    expect(labels.some(text => text.startsWith('other'))).toBe(false);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('top 20 of 453 files');
    // the axis is the scale of the real bars, not of a 676-commit remainder
    const ticks = view.all('svg text').map(el => el.textContent ?? '').filter(text => /^\d+$/.test(text)).map(Number);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(5);
    view.unmount();
    // grouped series of such a measure: the eight largest, the rest counted, no `other` series
    const rows = Array.from({length: 12}, (_, s) => ({file: 'a.ts', who: `dev-${s}`, commits: 12 - s}));
    const grouped = await chart(`BarChart($/d,'file','commits','who')`, {rows});
    const legend = grouped.all('[data-chart-legend] [data-series]').map(el => el.getAttribute('data-series'));
    expect(legend).toEqual(['dev-0', 'dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5', 'dev-6', 'dev-7']);
    expect(grouped.root.querySelector('[data-chart-note]')?.textContent).toBe('4 more series not drawn');
  });

  it('does not claim the rows a source cut away: a cut dataset keeps its top bars even for a measure that adds up (V004)', async () => {
    const rows = Array.from({length: 30}, (_, i) => ({path: `src/f${i}.ts`, loc: 300 - i}));
    const cut = {$ds: 'files_list', kind: 'rows', status: 'ready', source: 'files.list', data: rows, total: 4696, truncated: {total: 4696, returned: 30, strategy: 'topN', by: 'loc'}};
    const view = await chart(`BarChart($/d,'path','loc',limit=5)`, {rows: cut});
    const labels = view.all('[data-bar-label]').map(el => el.textContent ?? '');
    expect(labels).toHaveLength(5);
    expect(labels.some(text => text.startsWith('other'))).toBe(false);
    const header = view.all('[data-chart-note], [data-gl-marginal]').map(el => el.textContent).join(' | ');
    expect(header).toContain('showing 30 of 4,696');
    expect(header).toContain('top 5 of 30 files');
  });

  it('draws a catch-all category of the data as a bar of its own, apart from the fold (D16)', async () => {
    const langs = [{lang: 'TypeScript', loc: 900}, {lang: 'Unclassified', loc: 40}, ...Array.from({length: 6}, (_, i) => ({lang: `L${i}`, loc: 10 - i}))];
    const view = await chart(`BarChart($/d,'lang','loc',limit=3)`, {rows: langs});
    expect(view.all('[data-bar-label]').map(el => el.textContent)).toEqual(['TypeScript', 'Unclassified', 'L0', 'other (5)']);
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
  it('uses the height of a sized cell: horizontal bars grow before the plate stays blank (F009)', async () => {
    const bars = (view: {all(selector: string): Element[]}) => view.all('path[data-i]').map(el => /V([\d.]+)/.exec(el.getAttribute('d') ?? ''));
    const plain = await chart(`BarChart($/d,dir='h')`, {rows: FILES});
    expect(plain.svg.getAttribute('height')).toBe(String(4 + 3 * 20 + 34));
    expect(bars(plain)).toHaveLength(3);
    plain.unmount();
    // three bars in a 600 px box: the band grows to 1.7 times, the bar to 20 px
    const sized = await chart(`BarChart($/d,dir='h',size='l')`, {rows: FILES});
    const ys = sized.all('path[data-i]').map(el => Number(/^M[\d.]+,([\d.]+)/.exec(el.getAttribute('d') ?? '')![1]));
    expect(ys[1]! - ys[0]!).toBe(34);
    const heights = sized.all('path[data-i]').map(el => {
      const numbers = (el.getAttribute('d') ?? '').match(/V([\d.]+)/g)!.map(text => Number(text.slice(1)));
      return Math.max(...numbers) - Number(/^M[\d.]+,([\d.]+)/.exec(el.getAttribute('d') ?? '')![1]);
    });
    // (measured to where the 2 px corner starts: a 20 px bar, against 14 px without a size)
    expect(new Set(heights)).toEqual(new Set([18]));
    sized.unmount();
    // thirty bars already fill the box: they keep the 14 px bar on a 20 px band
    const rows = Array.from({length: 30}, (_, i) => ({name: `n${i}`, v: i + 1}));
    const full = await chart(`BarChart($/d,dir='h',size='l',limit=30)`, {rows});
    const tops = full.all('path[data-i]').map(el => Number(/^M[\d.]+,([\d.]+)/.exec(el.getAttribute('d') ?? '')![1]));
    expect(tops[1]! - tops[0]!).toBe(20);
  });

  it('draws a few vertical bars wider on a wide plate, and never ticks a count at a fraction (F009, F007)', async () => {
    const view = await chart(`BarChart($/d,'name','n',dir='v')`, {rows: [{name: 'a', n: 1}, {name: 'b', n: 2}, {name: 'c', n: 3}]});
    const widths = view.all('path[data-i]').map(el => {
      const d = el.getAttribute('d') ?? '';
      const xs = [...d.matchAll(/[MH]([\d.]+)/g)].map(match => Number(match[1]));
      return Math.round(Math.max(...xs) - Math.min(...xs));
    });
    // (measured to where the 2 px corner starts: 44 px bars, against the 28 px of a crowded axis)
    expect(new Set(widths)).toEqual(new Set([42]));
    const ticks = view.all('svg text').map(el => el.textContent ?? '').filter(text => /^[\d.]+$/.test(text));
    expect(ticks).toEqual(expect.arrayContaining(['0', '1', '2', '3']));
    expect(ticks.every(text => !text.includes('.'))).toBe(true);
  });

  it('draws the folded other series in the light neutral and keeps the last segment of a module name (F005, D12)', async () => {
    const rows = Array.from({length: 10}, (_, s) => ({q: 'Q1', team: `team-${s}`, n: 10 - s}));
    const stacked = await chart(`BarChart($/d,'q','n','team',mode='stacked')`, {rows});
    const fills = stacked.all('path[data-i]').map(el => (el as SVGElement).style.fill);
    expect(fills.at(-1)).toBe('color-mix(in oklab, var(--gl-cat-other) 38%, var(--gl-surface))');
    expect(fills.slice(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 7].map(slot => `var(--gl-cat-${slot})`));
    stacked.unmount();
    const modules = [{module: 'typescript/renderers/angular', n: 3}, {module: 'typescript/renderers/lit', n: 2}, {module: 'swift/core/Tests/*', n: 1}];
    const view = await chart(`BarChart($/d,'module','n')`, {rows: modules, size: {width: 300, height: 600}});
    expect(view.all('[data-bar-label]').map(el => el.textContent)).toEqual(['…/angular', 'typescript/…/lit', 'swift/core/Tests/*']);
  });
  it('keeps the ink a series took when the rows change under it (D6)', async () => {
    const rows = ['x', 'y', 'z'].map((team, i) => ({q: 'Q1', team, n: i + 1}));
    const view = await chart(`BarChart($/d,'q','n','team',mode='stacked')`, {rows});
    const inks = () => Object.fromEntries(view.all('[data-chart-legend] [data-series]').map(el => [el.getAttribute('data-series'), (el.querySelector('span') as HTMLElement).style.background]));
    expect(inks()).toEqual({x: 'var(--gl-cat-1)', y: 'var(--gl-cat-2)', z: 'var(--gl-cat-3)'});
    // x leaves, a new series arrives and the order changes: y and z are not repainted (in order of appearance they
    // would now be 3 and 1), and the newcomer takes the ink that is free
    view.setData('/d', [rows[2], {q: 'Q1', team: 'w', n: 9}, rows[1]]);
    expect(inks()).toEqual({z: 'var(--gl-cat-3)', w: 'var(--gl-cat-1)', y: 'var(--gl-cat-2)'});
  });
});
