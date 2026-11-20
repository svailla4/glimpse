import {fireEvent} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {datasetFixture, errorDataset} from '../harness.tsx';
import {LONG, chart} from './util.tsx';

const cells = (view: {all(selector: string): Element[]}) => view.all('[data-cell]').map(el => el.getAttribute('data-cell'));
const crumbs = (view: {all(selector: string): Element[]}) => view.all('[data-chart-crumbs] button').map(el => el.textContent).join(' / ');
const tint = (slot: number | 'other') => {
  const ink = `var(--gl-cat-${slot})`;
  return `light-dark(color-mix(in oklab, ${ink} 32%, var(--gl-surface)), color-mix(in oklab, ${ink} 46%, var(--gl-surface)))`;
};
const fillOf = (view: {root: HTMLElement}, path: string) => (view.root.querySelector(`[data-cell="${path}"] rect`) as SVGElement).style.fill;

afterEach(() => void vi.restoreAllMocks());

describe('Treemap', () => {
  it('draws the default source two levels deep, sized by lines and filled by language', async () => {
    const view = await chart(`Treemap(title='Where the code is')`);
    expect(view.svg.getAttribute('aria-label')).toBe('Treemap of loc, 5 cells, total 4,210, largest src/auth 1,500');
    expect(cells(view).sort()).toEqual(['README.md', 'package.json', 'src/api', 'src/auth', 'src/ui']);
    expect(view.all('[data-dir]').map(el => el.getAttribute('data-dir'))).toEqual(['src']);
    // TypeScript is the server's first language slot, CSS the second
    // (a tint of the ink, stronger on the dark plate: F012)
    expect((view.root.querySelector('[data-cell="src/auth"] rect') as SVGElement).style.fill).toBe(tint(1));
    expect((view.root.querySelector('[data-cell="src/ui"] rect') as SVGElement).style.fill).toBe(tint(2));
    // a legend swatch is a key, not a fill: it shows the ink itself
    expect((view.root.querySelector('[data-chart-legend] [data-series="TypeScript"] span') as HTMLElement).style.background).toBe('var(--gl-cat-1)');
    expect(view.all('[data-chart-legend] [data-series]').map(el => el.getAttribute('data-series'))).toEqual(['TypeScript', 'CSS', 'Markdown', 'JSON']);
    expect(crumbs(view)).toBe('demo');
    expect(view.errors).toEqual([]);
  });

  it('honours value, color and depth', async () => {
    const view = await chart(`Treemap(value='bytes',color='churn',depth=3)`);
    // src/ui lists all of its bytes, so its rollup has no size in this metric and is left out
    expect(view.svg.getAttribute('aria-label')).toBe('Treemap of bytes, 9 cells, total 131 kB, largest src/auth/service.ts 30 kB');
    expect(view.all('[data-rollup]')).toHaveLength(0);
    const fills = new Set(view.all('[data-cell] rect').map(el => (el as SVGElement).style.fill).filter(fill => fill.startsWith('var(--gl-seq-')));
    expect(fills.size).toBeGreaterThan(3);
    expect(view.root.querySelector('[data-chart-ramp]')?.textContent).toContain('commits');
  });

  it('shows drafting, empty, a source error and a wrong shape', async () => {
    const pending = await chart('Treemap()', {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('Treemap($/d)', {rows: {}});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart('Treemap()', {data: {'/ds/files_tree': errorDataset('files.tree', 'E_TARGET', 'no such directory')}});
    expect(failed.code()).toBe('E_TARGET');
    failed.unmount();
    const shape = await chart('Treemap($/d)', {rows: [{name: 'a'}]});
    expect(shape.code()).toBe('E_SHAPE');
    expect(shape.root.textContent).toContain('expected a tree node {name, path, children}, received array of 1');
    shape.unmount();
    const text = await chart('Treemap($/d)', {rows: 'tree'});
    expect(text.code()).toBe('E_SHAPE');
  });

  it('drops repeated paths and junk children, counts them, and survives a single file and 500-character names', async () => {
    const messy = {name: '', path: '', dir: true, children: [
      {name: 'a.ts', path: 'a.ts', dir: false, loc: 10},
      {name: 'a.ts', path: 'a.ts', dir: false, loc: 500},
      'junk', null,
      {name: 'neg.ts', path: 'neg.ts', dir: false, loc: -40},
      {name: 'nan.ts', path: 'nan.ts', dir: false, loc: 'lots'},
      {name: LONG, path: LONG, dir: false, loc: 30},
    ]};
    const view = await chart('Treemap($/d)', {rows: messy});
    expect(cells(view).sort()).toEqual(['a.ts', LONG]);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('3 nodes dropped');
    expect(Math.max(...view.all('[data-cell] text').map(el => el.textContent!.length))).toBeLessThan(160);
    expect(view.svg.getAttribute('aria-label')!.length).toBeLessThan(220);
    expect(view.svg.innerHTML).not.toContain('NaN');
    view.unmount();
    const one = await chart('Treemap($/d)', {rows: {name: 'only.ts', path: 'only.ts', dir: false, loc: 12, bytes: 300, files: 1}});
    expect(cells(one)).toEqual(['only.ts']);
    expect(one.svg.getAttribute('aria-label')).toBe('Treemap of loc in only.ts, 1 cell, total 12, largest only.ts 12');
  });

  it('shows the empty frame when every size is zero, and the toolbar still switches the metric', async () => {
    const tree = {name: '', path: '', dir: true, children: [{name: 'a', path: 'a', dir: false, loc: 0, bytes: 40}, {name: 'b', path: 'b', dir: false, loc: 0, bytes: 60}]};
    const view = await chart(`Treemap($/d,title='T')`, {rows: tree});
    expect(view.state()).toBe('empty');
    expect(view.root.textContent).toContain('no loc to size the tree by');
    fireEvent.click(view.root.querySelector('[data-tool="value"]')!);
    await view.settle();
    expect(view.svg.getAttribute('aria-label')).toBe('Treemap of bytes, 2 cells, total 100 B, largest b 60 B');
  });

  it('zooms into a directory on double-click or Enter, shows the path, and zooms out with Backspace or a crumb', async () => {
    const view = await chart('Treemap()');
    fireEvent.doubleClick(view.root.querySelector('[data-cell="src/auth"]')!);
    expect(crumbs(view)).toBe('demo / src / auth');
    expect(cells(view)).toEqual(['src/auth/service.ts', 'src/auth/cache.ts', 'src/auth/schema.sql']);
    expect(view.svg.getAttribute('aria-label')).toContain('in src/auth');
    // a file does not zoom: Enter selects it
    view.key('Home');
    view.key('Enter');
    expect(crumbs(view)).toBe('demo / src / auth');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'file', id: 'src/auth/service.ts'});
    view.key('Backspace');
    expect(crumbs(view)).toBe('demo / src');
    expect(cells(view)).toContain('src/auth/service.ts');
    fireEvent.click(view.root.querySelector('[data-chart-crumbs] button')!);
    expect(crumbs(view)).toBe('demo');
    view.key('Home');
    view.key('Enter');
    expect(crumbs(view)).toBe('demo / src');
    // Space selects a directory without zooming
    view.key('Home');
    view.key(' ');
    expect(crumbs(view)).toBe('demo / src');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'dir'});
  });

  it('moves the map from the zoomed cell over the layout duration, and not at all under reduced motion', async () => {
    const view = await chart('Treemap()');
    const animate = vi.spyOn(Element.prototype, 'animate');
    fireEvent.doubleClick(view.root.querySelector('[data-cell="src/auth"]')!);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, timing] = animate.mock.calls[0]! as [Array<{transform: string}>, {duration: number}];
    expect(frames[0]!.transform).toMatch(/^translate\(.+\) scale\(.+\)$/);
    expect(frames[1]!.transform).toBe('none');
    expect(timing.duration).toBe(280);
    vi.spyOn(globalThis, 'matchMedia').mockReturnValue({matches: true, addEventListener() {}, removeEventListener() {}} as never);
    view.key('Backspace');
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('hatches rollup cells and drills the dataset when one is activated', async () => {
    const view = await chart('Treemap(depth=3)');
    const rollup = view.root.querySelector('[data-rollup]')!;
    expect(rollup.textContent).toContain('(12 more)');
    expect(rollup.querySelectorAll('rect')).toHaveLength(2);
    fireEvent.doubleClick(rollup);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', sourceComponentId: 'c', context: {ds: 'files_tree', target: 'src/ui'}});
    // the server answers a drill by pushing the scoped tree to the same path
    const scoped = datasetFixture<{children: unknown[]}>('files.tree');
    view.setData('/ds/files_tree', {...scoped, data: {name: 'ui', path: 'src/ui', dir: true, children: [{name: 'app.css', path: 'src/ui/app.css', dir: false, loc: 700, lang: 'CSS'}]}});
    expect(cells(view)).toEqual(['src/ui/app.css']);
  });

  it('switches the size metric and the fill from the toolbar and with v and f', async () => {
    const view = await chart(`Treemap(title='Map')`);
    const tool = (name: string) => view.root.querySelector(`[data-tool="${name}"]`)!;
    expect(tool('value').textContent).toBe('sizeloc');
    fireEvent.click(tool('value'));
    expect(tool('value').textContent).toBe('sizebytes');
    expect(view.svg.getAttribute('aria-label')).toMatch(/^Treemap of bytes/);
    view.key('v');
    expect(view.svg.getAttribute('aria-label')).toMatch(/^Treemap of files/);
    fireEvent.click(tool('color'));
    expect(tool('color').textContent).toBe('fillchurn');
    view.key('f');
    expect(tool('color').textContent).toBe('fillage');
    expect(view.root.querySelector('[data-chart-ramp]')?.textContent).toContain('age');
  });

  it('selects a cell on click, outlines it and dims the rest', async () => {
    const view = await chart('Treemap()');
    fireEvent.click(view.root.querySelector('[data-cell="README.md"]')!);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'file', id: 'README.md', path: 'README.md'});
    expect(view.getData('/ui/file')).toBe('README.md');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select'});
    expect(view.all('[data-selected-cell]')).toHaveLength(1);
    expect(view.all('[data-cell][data-dim]')).toHaveLength(4);
    fireEvent.click(view.root.querySelector('[data-cell="src/auth"]')!);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'dir', id: 'src/auth'});
    expect(view.getData('/ui/file')).toBe('README.md');
    view.key('Escape');
    expect(view.all('[data-dim]')).toHaveLength(0);
  });

  it('highlights the collapsed directory that holds a file selected elsewhere', async () => {
    const view = await chart('Treemap()');
    view.setData('/ui/sel', {type: 'file', id: 'src/api/routes.ts', path: 'src/api/routes.ts'});
    expect(view.all('[data-cell]:not([data-dim])').map(el => el.getAttribute('data-cell'))).toEqual(['src/api']);
    view.setData('/ui/sel', {type: 'dir', id: 'src', path: 'src'});
    expect(view.all('[data-cell]:not([data-dim])').map(el => el.getAttribute('data-cell'))).toEqual(['src/auth', 'src/api', 'src/ui']);
  });

  it('moves between cells spatially with the arrow keys and announces them', async () => {
    const view = await chart('Treemap()');
    view.key('ArrowRight');
    const first = view.root.querySelector('[aria-live]')!.textContent!;
    expect(first).toMatch(/directory$/);
    view.key('ArrowDown');
    expect(view.root.querySelector('[aria-live]')?.textContent).not.toBe(first);
    expect(view.all('[data-ring="focus"]')).toHaveLength(1);
    expect(view.tooltip()).not.toBe('');
  });

  it('lays out a 5,000-node tree', async () => {
    const dirs = Array.from({length: 50}, (_, d) => ({
      name: `d${d}`, path: `d${d}`, dir: true, loc: 100 * 100, files: 100,
      children: Array.from({length: 100}, (_, f) => ({name: `f${f}.ts`, path: `d${d}/f${f}.ts`, dir: false, loc: 1 + ((d * f) % 97), lang: 'TypeScript'})),
    }));
    const view = await chart('Treemap($/d,depth=2)', {rows: {name: '', path: '', dir: true, children: dirs}});
    expect(view.svg.getAttribute('aria-label')).toMatch(/^Treemap of loc, [\d,]+ cells/);
    expect(view.svg.innerHTML).not.toContain('NaN');
  });
  const file = (path: string, lang: string, loc: number, extra: Record<string, unknown> = {}) => ({name: path.split('/').pop(), path, dir: false, files: 1, loc, bytes: loc * 30, lang, ...extra});

  it('gives a language without a session slot the next free ink, and never a hue to Other (D6, F006)', async () => {
    const tree = {name: '', path: '', dir: true, files: 5, loc: 500, children: [
      file('a.ts', 'TypeScript', 100), file('b.zig', 'Zig', 100), file('c.nim', 'Nim', 100), file('d.txt', 'Other', 100), file('e.zig', 'Zig', 100),
    ]};
    const view = await chart('Treemap($/d)', {rows: tree});
    expect(fillOf(view, 'a.ts')).toBe(tint(1));
    const zig = fillOf(view, 'b.zig');
    const nim = fillOf(view, 'c.nim');
    expect(zig).toMatch(/var\(--gl-cat-[2-8]\)/);
    expect(nim).toMatch(/var\(--gl-cat-[2-8]\)/);
    expect(zig).not.toBe(nim);
    expect(fillOf(view, 'e.zig')).toBe(zig);
    expect(fillOf(view, 'd.txt')).toBe(tint('other'));
    expect(view.all('[data-chart-legend] [data-series]').map(el => el.getAttribute('data-series'))).toEqual(['Zig', 'TypeScript', 'Nim', 'other']);
    // zooming or switching the metric repaints nothing: the inks come from the whole tree, not from what is drawn
    view.key('v');
    expect(fillOf(view, 'b.zig')).toBe(zig);
    expect(fillOf(view, 'c.nim')).toBe(nim);
  });

  it('spreads a metric fill over the drawn area and reads directories per file (F012)', async () => {
    // four large directories whose commit totals dwarf every file, and a few small files
    const dir = (name: string, files: number, commits: number) => ({name, path: name, dir: true, files, loc: files * 400, commits, children: [file(`${name}/x.ts`, 'TypeScript', files * 400, {commits})]});
    const tree = {name: '', path: '', dir: true, files: 400, loc: 160_000, children: [
      dir('core', 100, 900), dir('renderers', 120, 240), dir('samples', 90, 90), dir('docs', 80, 800),
      file('a.ts', 'TypeScript', 300, {commits: 2}), file('b.ts', 'TypeScript', 300, {commits: 5}), file('c.ts', 'TypeScript', 300, {commits: 30}),
    ]};
    const view = await chart(`Treemap($/d,color='churn',depth=1)`, {rows: tree});
    const steps = ['core', 'renderers', 'samples', 'docs'].map(name => Number(/seq-(\d)/.exec(fillOf(view, name))![1]));
    // by cell count all four would be the top step (their totals are the four largest values)
    expect(new Set(steps).size).toBe(4);
    expect(Math.min(...steps)).toBeLessThanOrEqual(2);
    // per file: core 9, docs 10, renderers 2, samples 1
    expect(steps[3]).toBeGreaterThan(steps[0]!);
    expect(steps[0]).toBeGreaterThan(steps[1]!);
    expect(steps[1]).toBeGreaterThan(steps[2]!);
    // a file is its own figure: 30 commits in one file is hotter than any directory average here
    expect(fillOf(view, 'c.ts')).toBe('var(--gl-seq-7)');
    expect(view.root.querySelector('[data-chart-ramp]')?.textContent).toBe('commits per file 130');
  });

  it('names the scope of a drilled tree and steps out of the drill with Backspace (D1, F017, F074)', async () => {
    const view = await chart('Treemap()');
    view.key('Backspace');
    expect(view.actions.filter(action => action.name === 'gl_drill')).toHaveLength(0);
    // the server re-scoped the dataset: the envelope says where we are and what is one level out
    const scoped = datasetFixture<{children: unknown[]}>('files.tree');
    const data = {name: 'ui', path: 'src/ui', dir: true, files: 2, loc: 900, children: [file('src/ui/app.css', 'CSS', 700), file('src/ui/theme.css', 'CSS', 200)]};
    view.setData('/ds/files_tree', {...scoped, data, drill: {target: 'src/ui', up: 'src'}});
    expect(cells(view).sort()).toEqual(['src/ui/app.css', 'src/ui/theme.css']);
    // the breadcrumb starts at the drilled directory, not at the repository; the kit's scope row has the full path
    expect(crumbs(view)).toBe('ui');
    expect(view.svg.getAttribute('aria-label')).toContain('in src/ui');
    // this view has no back control of its own (the kit's scope crumb is the one): it only dispatches
    expect(view.all('[data-chart-crumbs] button')).toHaveLength(1);
    view.key('Backspace');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', sourceComponentId: 'c', context: {ds: 'files_tree', target: 'src'}});
    view.setData('/ds/files_tree', {...scoped, data, drill: {target: 'src/ui', up: ''}});
    view.key('Backspace');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'files_tree', target: ''}});
    // a tree the spec itself scoped to a directory has no scope row: its root crumb is the whole path
    view.setData('/ds/files_tree', {...scoped, data});
    expect(crumbs(view)).toBe('src/ui');
  });

  it('holds its height while the dataset is pending in a cell without a size (F016)', async () => {
    const pending = await chart('Treemap()', {datasets: 'pending'});
    expect(pending.root.querySelector<HTMLElement>('[data-chart-reserve]')?.style.height).toBe('328px');
    pending.unmount();
    const sized = await chart(`Treemap(size='l')`, {datasets: 'pending'});
    expect(sized.all('[data-chart-reserve]')).toHaveLength(0);
  });
});
