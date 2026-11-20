import type {DirNode} from '@glimpse/catalog';
import {act, fireEvent, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, errorDataset, renderExpress, type RenderedSpec} from '../harness.tsx';

const page = (tree: string, data = '') => `${data}\nroot=Page('T',[t])\nt=${tree}`;
const rowsOf = (view: RenderedSpec) => [...view.cell('t').querySelectorAll<HTMLElement>('[role="treeitem"]')];
const names = (view: RenderedSpec) => rowsOf(view).map(row => row.getAttribute('data-path') ?? `more:${row.getAttribute('data-more')}`);
const row = (view: RenderedSpec, path: string) => view.cell('t').querySelector<HTMLElement>(`[data-path="${path}"]`)!;
const key = (name: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement!, {key: name, ...init});

async function ready(view: RenderedSpec): Promise<HTMLElement> {
  const tree = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>('[role="tree"]');
    if (!found) throw new Error('no tree yet');
    return found;
  });
  await view.settle();
  return tree;
}

const file = (path: string, loc: number, extra: Partial<DirNode> = {}): DirNode => ({name: path.slice(path.lastIndexOf('/') + 1), path, dir: false, files: 1, loc, bytes: loc * 30, ...extra});

describe('FileTree: states', () => {
  it('renders the default source two levels deep with bars, values and a rollup', async () => {
    const view = renderExpress(page("FileTree(title='Files')"), {datasets: 'ready'});
    const tree = await ready(view);
    expect(tree.getAttribute('aria-label')).toBe('Files');
    expect(names(view)).toEqual([
      'src', 'src/auth', 'src/auth/service.ts', 'src/auth/cache.ts', 'src/auth/schema.sql', 'src/api', 'src/api/routes.ts', 'src/api/limiter.go',
      'src/ui', 'src/ui/app.css', 'src/ui/App.tsx', 'more:src/ui', 'README.md', 'package.json',
    ]);
    expect(row(view, 'src').getAttribute('aria-expanded')).toBe('true');
    expect(row(view, 'src').getAttribute('aria-level')).toBe('1');
    expect(row(view, 'src/auth/service.ts').getAttribute('aria-level')).toBe('3');
    expect(row(view, 'src/auth/service.ts').hasAttribute('aria-expanded')).toBe(false);
    expect(row(view, 'src/auth/service.ts').textContent).toContain('service.ts');
    expect(row(view, 'src/auth/service.ts').textContent).toContain('820');
    expect(row(view, 'src').textContent).toContain('3,900');
    expect(view.cell('t').querySelector('[data-more]')!.textContent).toContain('(12 more)');
    // truncation is stated in the plate header by the gate
    expect(view.cell('t').querySelector('[data-gl-marginal]')!.textContent).toContain('showing 9 of 21');
    expect(view.errors).toEqual([]);
  });

  it('opens `depth` levels initially', async () => {
    const closed = renderExpress(page('FileTree(depth=0)'), {datasets: 'ready'});
    await ready(closed);
    expect(names(closed)).toEqual(['src', 'README.md', 'package.json']);
    expect(row(closed, 'src').getAttribute('aria-expanded')).toBe('false');
    closed.unmount();
    const one = renderExpress(page('FileTree(depth=1)'), {datasets: 'ready'});
    await ready(one);
    expect(names(one)).toEqual(['src', 'src/auth', 'src/api', 'src/ui', 'README.md', 'package.json']);
  });

  it('shows the chosen metric, relative to the largest sibling', async () => {
    const view = renderExpress(`root=Page('T',[t,u,v])\nt=FileTree(metric='bytes')\nu=FileTree(metric='commits')\nv=FileTree(metric='none')`, {datasets: 'ready'});
    await ready(view);
    const inCell = (id: string, path: string) => view.cell(id).querySelector<HTMLElement>(`[data-path="${path}"]`)!;
    expect(inCell('t', 'src/auth/service.ts').textContent).toContain('30 kB');
    expect(inCell('u', 'src/auth/service.ts').textContent).toContain('51');
    expect(inCell('v', 'src/auth/service.ts').textContent).toBe('service.tsTS');
    // commits among the siblings of src/auth: service 51, cache 22, schema 7
    const fill = (path: string) => inCell('u', path).querySelector<HTMLElement>('[aria-hidden="true"] > span[style*="width"]')!.style.width;
    expect(fill('src/auth/service.ts')).toBe('100%');
    expect(Number.parseFloat(fill('src/auth/cache.ts'))).toBeCloseTo((22 / 51) * 100, 1);
  });

  it('shows changes and status for a diff tree', async () => {
    const view = renderExpress(page("FileTree('diff.tree wt',metric='changes',depth=6)"), {datasets: 'ready'});
    await ready(view);
    expect(names(view)).toEqual(['src', 'src/api', 'src/api/limiter.ts', 'src/auth', 'src/auth/service.ts', 'test', 'test/limiter.test.ts']);
    expect(row(view, 'src/auth/service.ts').textContent).toContain('+9 −4');
    expect(row(view, 'src/api/limiter.ts').querySelector('[data-status="A"]')!.textContent).toContain('added');
    expect(row(view, 'src').textContent).toContain('+127 −4');
  });

  it('draws the heat strip only when asked', async () => {
    const view = renderExpress(`root=Page('T',[t,u,v])\nt=FileTree()\nu=FileTree(heat='churn')\nv=FileTree(heat='age')`, {datasets: 'ready'});
    await ready(view);
    expect(view.cell('t').querySelector('[data-heat]')).toBeNull();
    const heat = (id: string, path: string) => view.cell(id).querySelector(`[data-path="${path}"] [data-heat]`)!.getAttribute('data-heat');
    expect(heat('u', 'src/auth/service.ts')).toBe('7');
    expect(Number(heat('u', 'src/auth/schema.sql'))).toBeLessThan(Number(heat('u', 'src/auth/cache.ts')));
    expect(Number(heat('v', 'src/auth/schema.sql'))).toBeLessThan(Number(heat('v', 'src/auth/service.ts')));
  });

  it('shows drafting, empty and redline states, and follows a dataset update', async () => {
    const view = renderExpress(page('FileTree()'));
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="drafting"]')).not.toBeNull();

    view.setData('/ds/files_tree', errorDataset('files.tree', 'E_TARGET', 'no such directory'));
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="redline"]')!.getAttribute('data-code')).toBe('E_TARGET');

    view.setData('/ds/files_tree', {...datasetFixture('files.tree'), data: {name: '', path: '', dir: true, files: 0, loc: 0, bytes: 0, children: []}, truncated: undefined});
    await view.settle();
    expect(view.cell('t').textContent).toContain('empty directory');

    view.setData('/ds/files_tree', {...datasetFixture('files.tree'), data: {name: '', path: '', dir: true, files: 1, loc: 5, bytes: 9, children: [file('only.ts', 5)]}});
    await ready(view);
    expect(names(view)).toEqual(['only.ts']);

    view.setData('/ds/files_tree', {...datasetFixture('files.tree'), data: undefined});
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="empty"]')).not.toBeNull();
  });

  it('redlines a value that is not a tree', async () => {
    const view = renderExpress(page('FileTree($/tree)', "$/tree=[{name:'a',path:'a'}]"));
    await view.settle();
    const redline = view.cell('t').querySelector('[data-gl-state="redline"]')!;
    expect(redline.getAttribute('data-code')).toBe('E_SHAPE');
    expect(redline.textContent).toContain('received an array');
  });

  it('drops duplicates, cycles and garbage, coerces numbers, and says how many entries it dropped', async () => {
    const tree = {
      name: '', path: '', dir: true, children: [
        {name: 'a.ts', path: 'a.ts', dir: false, loc: '120'},
        {name: 'a.ts', path: 'a.ts', dir: false, loc: 5},
        null,
        'text',
        {dir: false},
        {name: 'lib', dir: true, children: [{name: 'deep.ts', loc: null}, {name: 'kids', children: 'nope'}]},
        {path: 'docs/guide.md'},
      ],
    };
    const view = renderExpress(page('FileTree($/tree,depth=3)'), {data: {'/tree': tree}});
    await ready(view);
    expect(names(view)).toEqual(['a.ts', 'lib', 'lib/deep.ts', 'lib/kids', 'docs/guide.md']);
    expect(row(view, 'a.ts').textContent).toContain('120');
    expect(row(view, 'lib').getAttribute('aria-expanded')).toBe('true');
    expect(view.cell('t').querySelector('[data-gl-tree-note]')!.textContent).toBe('4 malformed entries dropped');
    expect(view.errors).toEqual([]);
  });

  it('keeps only the rows near the viewport in the DOM', async () => {
    const children = Array.from({length: 5000}, (_, i) => file(`gen/f${i}.ts`, i));
    const view = renderExpress(page('FileTree($/tree)'), {data: {'/tree': {name: '', path: '', dir: true, files: 5000, loc: 0, bytes: 0, children: [{name: 'gen', path: 'gen', dir: true, files: 5000, loc: 0, bytes: 0, children}]}}});
    const tree = await ready(view);
    expect(rowsOf(view).length).toBeLessThan(70);
    tree.scrollTop = 24 * 3000;
    fireEvent.scroll(tree);
    await waitFor(() => expect(row(view, 'gen/f2999.ts')).not.toBeNull());
    expect(rowsOf(view).length).toBeLessThan(70);
  });
});

describe('FileTree: keyboard and selection', () => {
  it('walks the tree with the keyboard as one tab stop', async () => {
    const view = renderExpress(page('FileTree()'), {datasets: 'ready'});
    const tree = await ready(view);
    expect([...tree.querySelectorAll('[tabindex="0"]')]).toEqual([row(view, 'src')]);
    expect(tree.querySelector('button, a, input')).toBeNull();

    act(() => row(view, 'src').focus());
    key('ArrowDown');
    expect(document.activeElement).toBe(row(view, 'src/auth'));
    expect([...tree.querySelectorAll('[tabindex="0"]')]).toEqual([row(view, 'src/auth')]);

    key('ArrowLeft');
    expect(row(view, 'src/auth').getAttribute('aria-expanded')).toBe('false');
    expect(view.cell('t').querySelector('[data-path="src/auth/service.ts"]')).toBeNull();
    key('ArrowRight');
    expect(row(view, 'src/auth').getAttribute('aria-expanded')).toBe('true');
    key('ArrowRight');
    expect(document.activeElement).toBe(row(view, 'src/auth/service.ts'));
    key('ArrowRight');
    expect(document.activeElement).toBe(row(view, 'src/auth/service.ts'));
    key('ArrowDown');
    key('ArrowLeft');
    expect(document.activeElement).toBe(row(view, 'src/auth'));
    key('ArrowLeft');
    key('ArrowLeft');
    expect(document.activeElement).toBe(row(view, 'src'));

    key('End');
    expect(document.activeElement).toBe(row(view, 'package.json'));
    key('Home');
    expect(document.activeElement).toBe(row(view, 'src'));
    key('PageDown');
    expect(document.activeElement).not.toBe(row(view, 'src'));
  });

  it('selects with Enter, opens with o, copies with c and clears with Escape', async () => {
    const view = renderExpress(page('FileTree()'), {datasets: 'ready'});
    await ready(view);
    act(() => row(view, 'src/auth/cache.ts').focus());
    key('Enter');
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/cache.ts', path: 'src/auth/cache.ts'});
    expect(view.getData('/ui/file')).toBe('src/auth/cache.ts');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 't', context: {ref: {type: 'file', id: 'src/auth/cache.ts'}}});
    expect(row(view, 'src/auth/cache.ts').getAttribute('data-selected')).toBe('exact');
    expect(row(view, 'src/auth/cache.ts').getAttribute('aria-selected')).toBe('true');

    key('o');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/auth/cache.ts'}});
    key('c');
    expect(view.clipboard).toEqual(['src/auth/cache.ts']);
    key('Escape');
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(view.cell('t').querySelector('[data-selected]')).toBeNull();
  });

  it('selects a directory without touching /ui/file and marks the files inside it', async () => {
    const view = renderExpress(page('FileTree()'), {datasets: 'ready'});
    await ready(view);
    fireEvent.click(row(view, 'src/auth'));
    expect(view.getData('/ui/sel')).toEqual({type: 'dir', id: 'src/auth', path: 'src/auth'});
    expect(view.getData('/ui/file') ?? null).toBeNull();
    // clicking a directory also folds it; open it again to see its files marked
    expect(row(view, 'src/auth').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row(view, 'src/auth').querySelector('[data-twist]')!);
    expect(row(view, 'src/auth').getAttribute('aria-expanded')).toBe('true');
    expect(row(view, 'src/auth').getAttribute('data-selected')).toBe('exact');
    expect(row(view, 'src/auth/cache.ts').getAttribute('data-selected')).toBe('within');
    expect(row(view, 'src/api/routes.ts').hasAttribute('data-selected')).toBe(false);
  });

  it('toggles from the chevron without selecting, and opens the editor on a modified click', async () => {
    const view = renderExpress(page('FileTree()'), {datasets: 'ready'});
    await ready(view);
    fireEvent.click(row(view, 'src/api').querySelector('[data-twist]')!);
    expect(row(view, 'src/api').getAttribute('aria-expanded')).toBe('false');
    expect(view.actions).toEqual([]);
    fireEvent.click(row(view, 'README.md'), {ctrlKey: true});
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]).toMatchObject({name: 'gl_open', context: {file: 'README.md'}});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  it('finds by typing: letters jump to the next match, / starts a find for any name', async () => {
    const view = renderExpress(page('FileTree()'), {datasets: 'ready'});
    await ready(view);
    act(() => row(view, 'src').focus());
    key('r');
    expect(document.activeElement).toBe(row(view, 'src/api/routes.ts'));
    expect(view.cell('t').querySelector('[role="status"]')!.textContent).toBe('find: r');
    key('e');
    expect(document.activeElement).toBe(row(view, 'README.md'));
    key('Escape');
    expect(view.cell('t').querySelector('[role="status"]')).toBeNull();

    // `c` alone copies; after `/` it is part of the name being typed
    key('/');
    key('c');
    key('a');
    expect(document.activeElement).toBe(row(view, 'src/auth/cache.ts'));
    expect(view.clipboard).toEqual([]);
    key('Enter');
    expect(view.getData('/ui/file')).toBe('src/auth/cache.ts');
  });

  it('reveals a selection made elsewhere: ancestors open and the row is marked', async () => {
    const view = renderExpress(page('FileTree(depth=0)'), {datasets: 'ready'});
    await ready(view);
    expect(names(view)).toEqual(['src', 'README.md', 'package.json']);
    view.setData('/ui/sel', {type: 'file', id: 'src/api/limiter.go', path: 'src/api/limiter.go', line: 12});
    await waitFor(() => expect(row(view, 'src/api/limiter.go')).not.toBeNull());
    expect(row(view, 'src/api/limiter.go').getAttribute('data-selected')).toBe('exact');
    expect(row(view, 'src/api/limiter.go').getAttribute('tabindex')).toBe('0');
    expect(names(view)).toEqual(['src', 'src/auth', 'src/api', 'src/api/routes.ts', 'src/api/limiter.go', 'src/ui', 'README.md', 'package.json']);
    // nothing was dispatched: the tree only followed
    expect(view.actions).toEqual([]);
  });
});

describe('FileTree: rollups', () => {
  it('drills into a rollup and offers the way back', async () => {
    const view = renderExpress(page("FileTree(title='Files')"), {datasets: 'ready'});
    await ready(view);
    const more = view.cell('t').querySelector<HTMLElement>('[data-more="src/ui"]')!;
    expect(more.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(more);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', sourceComponentId: 't', context: {ds: 'files_tree', target: 'src/ui'}});

    // the server answers with the subtree under the same key
    const ui: DirNode = {name: 'ui', path: 'src/ui', dir: true, files: 14, loc: 1900, bytes: 50000, children: [file('src/ui/app.css', 700), file('src/ui/App.tsx', 400), file('src/ui/theme.css', 300)]};
    view.setData('/ds/files_tree', {...datasetFixture('files.tree'), source: 'files.tree src/ui', data: ui, truncated: undefined});
    await ready(view);
    expect(names(view)).toEqual(['src/ui/app.css', 'src/ui/App.tsx', 'src/ui/theme.css']);
    expect(view.cell('t').textContent).toContain('src/ui');

    const back = view.cell('t').querySelector<HTMLElement>('[data-gl-tree-back]')!;
    expect(back.textContent).toContain('full tree');
    fireEvent.click(back);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'files_tree', target: ''}});
    expect(view.cell('t').querySelector('[data-gl-tree-back]')).toBeNull();
  });

  it('drills from the keyboard, and leaves a rollup inert when the tree is not a server dataset', async () => {
    const view = renderExpress(page('FileTree()'), {datasets: 'ready'});
    await ready(view);
    act(() => view.cell('t').querySelector<HTMLElement>('[data-more="src/ui"]')!.focus());
    key('Enter');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {target: 'src/ui'}});
    view.unmount();

    const inline = renderExpress(page('FileTree($/tree)'), {data: {'/tree': datasetFixture<DirNode>('files.tree').data}});
    await ready(inline);
    const more = inline.cell('t').querySelector<HTMLElement>('[data-more="src/ui"]')!;
    expect(more.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(more);
    expect(inline.actions).toEqual([]);
  });
});
