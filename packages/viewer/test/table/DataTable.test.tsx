import type {Dataset, RowsPage, RowsQuery} from '@glimpse/catalog';
import {act, fireEvent, screen, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {buildPatch, buildSurface, datasetFixture, errorDataset, renderExpress, renderSpec, type RenderedSpec} from '../harness.tsx';

const page = (table: string, data = '') => `${data}\nroot=Page('T',[t])\nt=${table}`;
const rowsOf = (view: RenderedSpec, id = 't') => [...view.cell(id).querySelectorAll<HTMLElement>('[role="row"][data-index]')];
const rowAt = (view: RenderedSpec, index: number, id = 't') => view.cell(id).querySelector<HTMLElement>(`[data-index="${index}"]`)!;
const cellsOf = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>('[role="gridcell"]')];
const firstCells = (view: RenderedSpec) => rowsOf(view).map(row => cellsOf(row)[0]?.textContent ?? '');
const headers = (view: RenderedSpec) => [...view.cell('t').querySelectorAll<HTMLElement>('[role="columnheader"]')];

/** The fixture as a complete dataset (nothing more in the server), so the table sorts and filters locally. */
function complete(source: string): Record<string, unknown> {
  const ds = datasetFixture(source);
  return {[`/ds/${ds.$ds}`]: {...ds, total: (ds.data as unknown[]).length, truncated: undefined}};
}

async function ready(view: RenderedSpec): Promise<HTMLElement> {
  // Role queries walk the whole accessibility tree; a selector is enough to wait for the lazy chunk.
  const grid = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>('[role="grid"]');
    if (!found) throw new Error('no grid yet');
    return found;
  });
  await view.settle();
  return grid;
}

describe('DataTable: states', () => {
  it('renders the dataset fields as columns and one row per item', async () => {
    const view = renderExpress(page("DataTable('git.churn',title='Churn')"), {datasets: 'ready'});
    const grid = await ready(view);
    expect(headers(view).map(h => h.textContent)).toEqual(['File', 'commits', 'authors', 'owner', 'ownership', 'last']);
    expect(rowsOf(view)).toHaveLength(6);
    expect(grid.getAttribute('aria-rowcount')).toBe('7');
    expect(grid.getAttribute('aria-label')).toBe('Churn');
    const first = cellsOf(rowAt(view, 0));
    expect(first[0]!.querySelector('[data-entity-type="file"]')?.getAttribute('data-entity-id')).toBe('src/auth/service.ts');
    expect(first[1]!.getAttribute('data-kind')).toBe('bar');
    expect(first[4]!.textContent).toBe('62.7%');
    expect(view.errors).toEqual([]);
  });

  it('shows drafting while pending, then the rows when the dataset arrives', async () => {
    const view = renderExpress(page("DataTable('git.churn')"));
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="drafting"]')).not.toBeNull();
    expect(view.cell('t').querySelector('[role="grid"]')).toBeNull();
    view.setData('/ds/git_churn', datasetFixture('git.churn'));
    await ready(view);
    expect(rowsOf(view)).toHaveLength(6);
    expect(view.cell('t').querySelector('[data-gl-state]')).toBeNull();
  });

  it('shows the empty state for no rows and a redline for a failed source', async () => {
    const view = renderExpress(page("DataTable('git.churn')"), {data: {'/ds/git_churn': {...datasetFixture('git.churn'), data: [], total: 0}}});
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="empty"]')).not.toBeNull();
    view.setData('/ds/git_churn', errorDataset('git.churn', 'E_NO_GIT', 'not a git repository'));
    await view.settle();
    const redline = view.cell('t').querySelector('[data-gl-state="redline"]')!;
    expect(redline.getAttribute('data-code')).toBe('E_NO_GIT');
    expect(redline.textContent).toContain('not a git repository');
  });

  it('redlines a value that is not a list of rows', async () => {
    const view = renderExpress(page('DataTable($/rows)', "$/rows={path:'a.ts',loc:3}"));
    await view.settle();
    const redline = view.cell('t').querySelector('[data-gl-state="redline"]')!;
    expect(redline.getAttribute('data-code')).toBe('E_SHAPE');
    expect(redline.textContent).toContain('received an object');
  });

  it('coerces, dashes out and counts malformed rows instead of failing', async () => {
    const view = renderExpress(page("DataTable($/rows,'name n:num size:bytes when:date flag:bool d:delta t:spark',title='Odd')"), {
      data: {'/rows': [
        {name: 'numeric strings', n: '1200', size: '2048', when: 'not a date', flag: 'true', d: 5, t: [1, 'x', 3]},
        {name: null, n: Number.NaN, size: null, when: null, flag: null, d: null, t: []},
        null,
        ['nested'],
        'scalar',
        {name: {deep: true}, n: 'abc', size: {}, when: 12, flag: 0, d: 'text', t: 'nope'},
      ]},
    });
    await ready(view);
    expect(rowsOf(view)).toHaveLength(4);
    const first = cellsOf(rowAt(view, 0)).map(cell => cell.textContent);
    expect(first.slice(0, 5)).toEqual(['numeric strings', '1,200', '2 kB', 'not a date', '']);
    expect(rowAt(view, 0).querySelector('[data-kind="bool"] [aria-label="yes"]')).not.toBeNull();
    expect(cellsOf(rowAt(view, 0))[5]!.textContent).toBe('+5');
    expect(cellsOf(rowAt(view, 1)).map(cell => cell.textContent)).toEqual(['—', '—', '—', '—', '—', '—', '—']);
    expect(view.cell('t').querySelector('[data-gl-table-note]')?.textContent).toContain('2 malformed rows skipped');
    expect(view.errors).toEqual([]);
  });
});

describe('DataTable: columns and cells', () => {
  const ALL = "p:path s:symbol m:module a:author c:commit l:lang t:text n:num b:bytes pc:pct du:duration d:date ba:bar h:heat sp:spark ch:chip de:delta co:code bo:bool";
  const ROW = {p: 'src/a.ts#L3', s: 'login', m: 'auth', a: 'Mira', c: '4f2a91c0d1e2', l: 'TypeScript', t: 'plain', n: 12840, b: 131072, pc: 60.12, du: 1500,
    d: '2026-11-12T00:00:00Z', ba: 50, h: 8, sp: [1, 4, 2], ch: 'A', de: {add: 12, del: 4}, co: '  return x;', bo: true};

  it('renders every FieldKind', async () => {
    const view = renderExpress(page(`DataTable($/rows,'${ALL}')`), {data: {'/rows': [ROW, {...ROW, p: 'src/b.ts', m: 'typescript/renderers', ba: 100, h: 16, bo: false}]}});
    await ready(view);
    const cell = (kind: string, row = 0) => rowAt(view, row).querySelector<HTMLElement>(`[data-kind="${kind}"]`)!;
    expect(new Set(cellsOf(rowAt(view, 0)).map(c => c.getAttribute('data-kind'))).size).toBe(19);

    expect(cell('path').querySelector('[data-entity-type="file"]')!.getAttribute('data-entity-id')).toBe('src/a.ts');
    expect(cell('path').querySelector('.gl-path')!.textContent).toContain('a.ts:3');
    expect(cell('symbol').querySelector('[data-entity-type="symbol"]')!.textContent).toBe('login');
    expect(cell('module').querySelector('[data-entity-type="module"]')!.getAttribute('data-entity-id')).toBe('auth');
    // a module that is a directory keeps its last segment on screen (D12), like a path
    expect(cell('module').querySelector('.gl-path')).toBeNull();
    expect(cell('author').querySelector('[data-entity-type="author"]')!.textContent).toBe('Mira');
    expect(cell('commit').querySelector('[data-entity-type="commit"]')!.textContent).toBe('4f2a91c');
    expect(cell('module', 1).querySelector('.gl-path-base')!.textContent).toBe('renderers');
    expect(cell('module', 1).querySelector('[data-entity-type="module"]')!.getAttribute('data-entity-id')).toBe('typescript/renderers');
    expect(cell('lang').textContent).toBe('TypeScript');
    expect(cell('lang').querySelector('button')).toBeNull();
    expect(cell('text').textContent).toBe('plain');
    expect(cell('num').textContent).toBe('12,840');
    expect(cell('num').getAttribute('data-align')).toBe('end');
    expect(cell('bytes').textContent).toBe('131 kB');
    expect(cell('pct').textContent).toBe('60.1%');
    expect(cell('duration').textContent).toBe('1.5 s');
    expect(cell('date').querySelector('time')!.getAttribute('datetime')).toBe('2026-11-12T00:00:00Z');
    expect(cell('date').textContent).toContain('12 Nov 2026');
    // bars and heat scale to the column maximum (100 and 16)
    expect(cell('bar').querySelector<HTMLElement>('[aria-hidden] > span')!.style.width).toBe('50%');
    expect(cell('bar', 1).querySelector<HTMLElement>('[aria-hidden] > span')!.style.width).toBe('100%');
    expect(cell('bar').textContent).toBe('50');
    expect(cell('heat').querySelector<HTMLElement>('[aria-hidden]')!.style.background).toBe('var(--gl-seq-4)');
    expect(cell('heat', 1).querySelector<HTMLElement>('[aria-hidden]')!.style.background).toBe('var(--gl-seq-7)');
    expect(cell('spark').querySelector('svg polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3);
    expect(cell('chip').textContent).toBe('A');
    expect(cell('chip').querySelector('[data-tone="good"]')).not.toBeNull();
    expect(cell('delta').textContent).toBe('+12 −4');
    expect(cell('code').querySelector('code')!.textContent).toBe('return x;');
    expect(cell('bool').querySelector('[aria-label="yes"]')).not.toBeNull();
    expect(cell('bool', 1).querySelector('[aria-label="no"]')).not.toBeNull();
    expect(view.errors).toEqual([]);
  });

  it('parses the columns shorthand and falls back to the dataset kind and label', async () => {
    const view = renderExpress(page("DataTable('git.churn','path commits:num last:date=Last_change owner')"), {datasets: 'ready'});
    await ready(view);
    expect(headers(view).map(h => h.textContent)).toEqual(['File', 'commits', 'Last change', 'owner']);
    const kinds = cellsOf(rowAt(view, 0)).map(c => c.getAttribute('data-kind'));
    expect(kinds).toEqual(['path', 'num', 'date', 'author']);
  });

  it('sniffs columns and kinds from the rows when nothing declares them', async () => {
    const view = renderExpress(page('DataTable($/rows)'), {
      data: {'/rows': [{path: 'src/a.ts', loc: 10, ok: true, when: '2026-11-01', trend: [1, 2], isTest: false}, {path: 'src/b.ts', loc: 4, extra: 'x'}]},
    });
    await ready(view);
    expect(headers(view).map(h => h.textContent)).toEqual(['path', 'loc', 'ok', 'when', 'trend', 'is Test', 'extra']);
    expect(cellsOf(rowAt(view, 0)).map(c => c.getAttribute('data-kind'))).toEqual(['path', 'num', 'bool', 'date', 'spark', 'bool', 'text']);
  });

  it('follows a binding update and a patched columns prop', async () => {
    const spec = page("DataTable($/rows,'name n:num')", "$/rows=[{name:'one',n:1}]");
    const base = buildSurface('test', spec);
    const view = renderSpec(base);
    await ready(view);
    expect(firstCells(view)).toEqual(['one']);
    view.setData('/rows', [{name: 'two', n: 2}, {name: 'three', n: 3}]);
    expect(firstCells(view)).toEqual(['two', 'three']);
    view.send(buildPatch('test', base, "t=DataTable($/rows,'n:bar=Count name')"));
    await view.settle();
    expect(headers(view).map(h => h.textContent)).toEqual(['Count', 'name']);
    expect(cellsOf(rowAt(view, 1)).map(c => c.getAttribute('data-kind'))).toEqual(['bar', 'text']);
    expect(view.errors).toEqual([]);
  });

  it('spells out diff statuses and renders the diff.files columns', async () => {
    const view = renderExpress(page("DataTable('diff.files wt')"), {datasets: 'ready'});
    await ready(view);
    expect(headers(view).map(h => h.textContent)).toEqual(['File', 'status', '+/-', 'lang']);
    expect(cellsOf(rowAt(view, 0)).map(c => c.textContent)).toEqual(['src/api/limiter.tsTS', 'added', '+118 −0', 'TypeScript']);
    expect(cellsOf(rowAt(view, 1))[1]!.textContent).toBe('modified');
  });

  it('shows the absolute date in the tooltip of a date cell', async () => {
    const view = renderExpress(page("DataTable($/rows,'when:date')"), {data: {'/rows': [{when: '2026-11-12T08:00:00Z'}]}});
    await ready(view);
    const time = rowAt(view, 0).querySelector('time')!;
    fireEvent.pointerEnter(time, {clientX: 10, clientY: 10});
    expect(screen.getByRole('tooltip').textContent).toBe('12 Nov 2026');
    fireEvent.pointerLeave(time);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('fills a sized cell, and keeps its toolbar in place when there is no plate', async () => {
    const many = Array.from({length: 30}, (_, i) => ({name: `n${i}`}));
    const view = renderExpress(`root=Page('T',[t,u])\nt=DataTable($/many,size='m')\nu=DataTable($/many,title='Framed')`, {data: {'/many': many}});
    await ready(view);
    expect(view.cell('t').querySelector('[data-gl-table]')!.hasAttribute('data-sized')).toBe(true);
    expect(view.cell('u').querySelector('[data-gl-table]')!.hasAttribute('data-sized')).toBe(false);
    // unframed: the search box sits above the rows, inside the view; framed: in the plate header
    expect(view.cell('t').querySelector('[data-gl-table] .gl-aside input[type="search"]')).not.toBeNull();
    expect(view.cell('u').querySelector('.gl-frame-head input[type="search"]')).not.toBeNull();
    expect(view.cell('u').querySelector('[data-gl-table] input')).toBeNull();
  });

  it('says so when the rows have no fields at all', async () => {
    const view = renderExpress(page('DataTable($/rows)'), {data: {'/rows': [{}, {}]}});
    await view.settle();
    await waitFor(() => expect(view.cell('t').querySelector('[data-gl-state="empty"]')!.textContent).toContain('no fields'));
  });

  it('drops priority 3 columns on a narrow plate', async () => {
    const wide = renderExpress(page("DataTable('files.list')"), {datasets: 'ready', data: {'/ds/files_list': {...datasetFixture('files.list'), pageable: false}}});
    await ready(wide);
    const keys = (view: RenderedSpec) => [...view.cell('t').querySelectorAll<HTMLElement>('[data-head]')].map(h => h.getAttribute('data-head'));
    expect(keys(wide)).toEqual(['path', 'lang', 'loc', 'bytes', 'commits', 'complexity']);
    wide.unmount();
    const narrow = renderExpress(page("DataTable('files.list')"), {datasets: 'ready', size: {width: 440, height: 600}, data: {'/ds/files_list': {...datasetFixture('files.list'), pageable: false}}});
    await ready(narrow);
    expect(keys(narrow)).toEqual(['path', 'lang', 'loc', 'commits']);
  });
});

describe('DataTable: sort, search, group', () => {
  it('sorts by the prop, then by header clicks, and follows a patched prop', async () => {
    const spec = page("DataTable('git.churn',sort='commits')");
    const base = buildSurface('test', spec, {datasets: 'ready'});
    const view = renderSpec(base, {data: complete('git.churn')});
    await ready(view);
    expect(firstCells(view)[0]).toContain('limiter.go');
    expect(headers(view)[1]!.getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(within(headers(view)[3]!).getByRole('button'));
    expect(headers(view)[3]!.getAttribute('aria-sort')).toBe('ascending');
    expect(rowsOf(view).map(row => cellsOf(row)[3]!.textContent)).toEqual(['Ade', 'Ade', 'Jon', 'Jon', 'Mira', 'Mira']);
    fireEvent.click(within(headers(view)[3]!).getByRole('button'));
    expect(headers(view)[3]!.getAttribute('aria-sort')).toBe('descending');
    expect(cellsOf(rowAt(view, 0))[3]!.textContent).toBe('Mira');
    fireEvent.click(within(headers(view)[3]!).getByRole('button'));
    expect(headers(view).every(h => h.getAttribute('aria-sort') === 'none')).toBe(true);
    expect(firstCells(view)[0]).toContain('service.ts');

    view.send(buildPatch('test', base, "t=DataTable('git.churn',sort='-ownership')"));
    await view.settle();
    expect(headers(view)[4]!.getAttribute('aria-sort')).toBe('descending');
    expect(firstCells(view)[0]).toContain('limiter.go');
  });

  // Finding V049: sorting the 15-row 'top by score' table by commits reordered those 15 rows under 'top by score'.
  it('says a sort of a cut dataset by another field reorders only the rows shown', async () => {
    const ds = datasetFixture('git.churn');
    const cut = {[`/ds/${ds.$ds}`]: {...ds, pageable: false, total: 40, truncated: {total: 40, returned: 6, strategy: 'topN', by: 'commits'}}};
    const view = renderExpress(page("DataTable('git.churn')"), {datasets: 'ready', data: cut});
    await ready(view);
    const note = () => view.cell('t').querySelector('[data-gl-table-note]')?.textContent ?? '';
    expect(note()).toBe('');
    fireEvent.click(within(headers(view)[3]!).getByRole('button'));
    expect(note()).toBe('sorted: owner (6 shown)');
    // sorted by the field the cut ranks by, the rows shown are the top ones: nothing to add
    fireEvent.click(within(headers(view)[1]!).getByRole('button'));
    expect(note()).toBe('');
  });

  it('sorts by a field that is not a column, numbers numerically, missing values last', async () => {
    const view = renderExpress(page("DataTable($/rows,'name',sort='-n')"), {data: {'/rows': [{name: 'two', n: 2}, {name: 'none'}, {name: 'ten', n: '10'}, {name: 'nine', n: 9}]}});
    await ready(view);
    expect(firstCells(view)).toEqual(['ten', 'nine', 'two', 'none']);
  });

  it('filters with the search box and says how many rows match', async () => {
    const view = renderExpress(page("DataTable('git.churn',search=true,title='Churn')"), {datasets: 'ready', data: complete('git.churn')});
    await ready(view);
    const input = screen.getByRole('searchbox', {name: 'Filter Churn'});
    fireEvent.change(input, {target: {value: 'AUTH'}});
    await waitFor(() => expect(rowsOf(view)).toHaveLength(2));
    expect(view.cell('t').querySelector('[data-gl-table-note]')!.textContent).toBe('2 of 6 match');
    fireEvent.change(input, {target: {value: 'zzz'}});
    await waitFor(() => expect(view.cell('t').querySelector('[data-gl-table-none]')?.textContent).toContain('no rows match'));
    fireEvent.keyDown(input, {key: 'Escape'});
    await waitFor(() => expect(rowsOf(view)).toHaveLength(6));
  });

  it('shows the search box by default only above 20 rows', async () => {
    const many = Array.from({length: 21}, (_, i) => ({name: `n${i}`}));
    const view = renderExpress(`root=Page('T',[t,u,v])\nt=DataTable($/many)\nu=DataTable($/few)\nv=DataTable($/many,search=false)`, {data: {'/many': many, '/few': many.slice(0, 20)}});
    await ready(view);
    expect(view.cell('t').querySelector('input[type="search"]')).not.toBeNull();
    expect(view.cell('u').querySelector('input[type="search"]')).toBeNull();
    expect(view.cell('v').querySelector('input[type="search"]')).toBeNull();
  });

  it('groups rows under collapsible headers with counts', async () => {
    const view = renderExpress(page("DataTable('code.refs issueToken',group='file')"), {datasets: 'ready'});
    await ready(view);
    const groups = () => [...view.cell('t').querySelectorAll<HTMLElement>('[data-group]')];
    expect(groups().map(g => [g.getAttribute('data-group'), g.textContent])).toEqual([
      ['src/auth/service.ts', expect.stringMatching(/service\.ts.*2$/)],
      ['src/api/routes.ts', expect.stringMatching(/routes\.ts.*1$/)],
    ]);
    expect(rowsOf(view)).toHaveLength(5);
    // the file is in the header, so a row only shows its line
    expect(headers(view).map(h => h.textContent)).toEqual(['Line', 'text']);
    expect(cellsOf(rowAt(view, 1))[0]!.textContent).toBe(':13');

    fireEvent.click(groups()[0]!);
    expect(groups()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(rowsOf(view)).toHaveLength(3);
    act(() => groups()[0]!.focus());
    fireEvent.keyDown(groups()[0]!, {key: 'ArrowRight'});
    expect(groups()[0]!.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(groups()[0]!, {key: 'ArrowLeft'});
    expect(rowsOf(view)).toHaveLength(3);
    fireEvent.keyDown(groups()[0]!, {key: 'Enter'});
    expect(rowsOf(view)).toHaveLength(5);
  });
});

describe('DataTable: selection, entities, keyboard', () => {
  it('round-trips a row click: /ui/sel, /ui/file and a gl_select action', async () => {
    const view = renderExpress(page("DataTable('git.churn')"), {datasets: 'ready'});
    await ready(view);
    fireEvent.click(cellsOf(rowAt(view, 1))[2]!);
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/api/routes.ts', path: 'src/api/routes.ts'});
    expect(view.getData('/ui/file')).toBe('src/api/routes.ts');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 't', context: {ref: {type: 'file', id: 'src/api/routes.ts'}}});
    expect(rowAt(view, 1).getAttribute('data-selected')).toBe('exact');
    expect(rowAt(view, 1).getAttribute('aria-selected')).toBe('true');
    expect(view.cell('t').querySelectorAll('[data-selected="exact"][role="row"]')).toHaveLength(1);

    fireEvent.keyDown(rowAt(view, 1), {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', context: {ref: null}});
    expect(view.cell('t').querySelector('[data-selected]')).toBeNull();
  });

  it('marks rows for a selection made elsewhere, including files inside a selected directory', async () => {
    const view = renderExpress(page("DataTable('git.churn')"), {datasets: 'ready'});
    await ready(view);
    view.setData('/ui/sel', {type: 'file', id: 'src/auth/cache.ts', path: 'src/auth/cache.ts'});
    expect(rowsOf(view).map(row => row.getAttribute('data-selected'))).toEqual([null, null, null, 'exact', null, null]);
    view.setData('/ui/sel', {type: 'dir', id: 'src/auth', path: 'src/auth'});
    expect(rowsOf(view).map(row => row.getAttribute('data-selected'))).toEqual(['within', null, null, 'within', null, null]);
  });

  it('selects a file location with its line, and rows without a file as row entities', async () => {
    const view = renderExpress(`root=Page('T',[t,u])\nt=DataTable('code.todos')\nu=DataTable('deps.cycles')`, {datasets: 'ready'});
    await ready(view);
    fireEvent.click(cellsOf(rowAt(view, 0))[2]!);
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/service.ts', path: 'src/auth/service.ts', line: 23});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts#L23');
    fireEvent.click(cellsOf(rowAt(view, 0, 'u'))[1]!);
    expect(view.getData('/ui/sel')).toEqual({type: 'row', id: 'deps_cycles:1', label: '1'});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts#L23');
    expect(rowAt(view, 0, 'u').getAttribute('data-selected')).toBe('exact');
  });

  it('opens and copies the row file from the keyboard and with a modified click', async () => {
    const view = renderExpress(page("DataTable('code.todos')"), {datasets: 'ready'});
    await ready(view);
    act(() => rowAt(view, 1).focus());
    fireEvent.keyDown(rowAt(view, 1), {key: 'o'});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', sourceComponentId: 't', context: {file: 'src/api/routes.ts#L88'}});
    fireEvent.keyDown(rowAt(view, 1), {key: 'c'});
    expect(view.clipboard).toEqual(['src/api/routes.ts:88']);
    fireEvent.click(cellsOf(rowAt(view, 2))[2]!, {metaKey: true});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/ui/App.tsx#L12'}});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  it('lets an entity cell select its own entity', async () => {
    const view = renderExpress(page("DataTable('git.churn')"), {datasets: 'ready'});
    await ready(view);
    fireEvent.click(rowAt(view, 0).querySelector('[data-entity-type="author"]')!);
    expect(view.getData('/ui/sel')).toEqual({type: 'author', id: 'Mira'});
  });

  it('is one tab stop with roving focus over rows, cells and the header', async () => {
    const view = renderExpress(page("DataTable('git.churn')"), {datasets: 'ready', data: complete('git.churn')});
    const grid = await ready(view);
    const tabStops = () => [...grid.querySelectorAll<HTMLElement>('[tabindex="0"], button:not([tabindex="-1"])')];
    expect(tabStops()).toEqual([rowAt(view, 0)]);

    act(() => rowAt(view, 0).focus());
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowDown'});
    expect(document.activeElement).toBe(rowAt(view, 1));
    expect(tabStops()).toEqual([rowAt(view, 1)]);
    fireEvent.keyDown(document.activeElement!, {key: 'End'});
    expect(document.activeElement).toBe(rowAt(view, 5));
    fireEvent.keyDown(document.activeElement!, {key: 'PageUp'});
    expect(document.activeElement).toBe(rowAt(view, 0));
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowDown'});
    fireEvent.keyDown(document.activeElement!, {key: 'Home'});
    expect(document.activeElement).toBe(rowAt(view, 0));

    // into the cells of a row and back
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowRight'});
    expect(document.activeElement!.getAttribute('data-entity-type')).toBe('file');
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowRight'});
    expect(document.activeElement!.getAttribute('data-entity-type')).toBe('author');
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowLeft'});
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowLeft'});
    expect(document.activeElement).toBe(rowAt(view, 0));

    // up into the header: arrows move between columns, Enter sorts, down returns to the rows
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowUp'});
    expect(document.activeElement!.getAttribute('data-head')).toBe('path');
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowRight'});
    expect(document.activeElement!.getAttribute('data-head')).toBe('commits');
    fireEvent.click(document.activeElement!);
    expect(headers(view)[1]!.getAttribute('aria-sort')).toBe('descending');
    fireEvent.keyDown(document.activeElement!, {key: 'ArrowDown'});
    expect(document.activeElement).toBe(rowAt(view, 0));

    fireEvent.keyDown(document.activeElement!, {key: 'Enter'});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts');
  });
});

describe('DataTable: remote paging', () => {
  const TOTAL = 100_000;
  /** A server holding 100k rows: answers any window, sorted or filtered, without materialising the set. */
  function bigHost() {
    const queries: RowsQuery[] = [];
    const rows = (q: RowsQuery): Promise<RowsPage> => {
      queries.push(q);
      const total = q.q ? 1234 : TOTAL;
      const offset = q.offset ?? 0;
      const limit = Math.min(500, q.limit ?? 200);
      const desc = q.sort?.startsWith('-') ?? false;
      const length = Math.max(0, Math.min(limit, total - offset));
      return Promise.resolve({
        total,
        offset,
        rows: Array.from({length}, (_, i) => {
          const n = desc ? total - 1 - (offset + i) : offset + i;
          return {path: `src/gen/file-${n}${q.q ? `-${q.q}` : ''}.ts`, lang: 'TypeScript', loc: n, bytes: n * 30, commits: n % 97, complexity: n % 13};
        }),
      });
    };
    return {queries, rows};
  }
  const bigDataset = (): Dataset => ({...datasetFixture('files.list'), total: TOTAL, truncated: {total: TOTAL, returned: 9, strategy: 'topN', by: 'loc'}});

  it('pages a 100k-row dataset through the host with only the visible rows mounted', async () => {
    const host = bigHost();
    const view = renderExpress(page("DataTable('files.list',title='Files')"), {datasets: 'ready', host, data: {'/ds/files_list': bigDataset()}});
    const grid = await ready(view);
    expect(grid.getAttribute('aria-rowcount')).toBe(String(TOTAL + 1));
    expect(rowsOf(view).length).toBeGreaterThan(10);
    expect(rowsOf(view).length).toBeLessThan(60);
    expect(host.queries[0]).toMatchObject({surfaceId: 'test', key: 'files_list', offset: 0, limit: 200});
    expect(firstCells(view)[0]).toContain('file-0.ts');
    // the table reaches every row, so the gate's "showing 9 of 100,000" note is replaced by the row count
    expect(view.cell('t').querySelector('[data-gl-marginal]')).toBeNull();
    expect(view.cell('t').querySelector('[data-gl-table-note]')!.textContent).toBe('100,000 rows');

    // scroll to the middle: one window around the viewport is fetched, nothing in between
    grid.scrollTop = 28 * 50_010;
    fireEvent.scroll(grid);
    await waitFor(() => expect(view.cell('t').textContent).toContain('file-50010.ts'));
    expect(rowsOf(view).length).toBeLessThan(60);
    const offsets = new Set(host.queries.map(q => q.offset));
    expect(offsets.has(50_000)).toBe(true);
    expect([...offsets].every(offset => offset === 0 || (offset! >= 49_800 && offset! <= 50_200))).toBe(true);
    expect(host.queries.every(q => q.limit === 200)).toBe(true);
    expect(view.errors).toEqual([]);
  });

  it('sorts and searches in the server', async () => {
    const host = bigHost();
    const view = renderExpress(page("DataTable('files.list',title='Files')"), {datasets: 'ready', host, data: {'/ds/files_list': bigDataset()}});
    await ready(view);
    fireEvent.click(within(headers(view)[2]!).getByRole('button'));
    await waitFor(() => expect(firstCells(view)[0]).toContain(`file-${TOTAL - 1}.ts`));
    expect(host.queries.at(-1)).toMatchObject({sort: '-loc', offset: 0});

    fireEvent.change(screen.getByRole('searchbox'), {target: {value: 'auth'}});
    await waitFor(() => expect(firstCells(view)[0]).toContain('-auth.ts'));
    expect(host.queries.at(-1)).toMatchObject({sort: '-loc', q: 'auth', offset: 0});
    expect(view.cell('t').querySelector('[data-gl-table-note]')!.textContent).toBe('1,234 of 100,000 match');
    expect(view.cell('t').querySelector('[role="grid"]')!.getAttribute('aria-rowcount')).toBe('1235');
  });

  it('refetches when the working tree revision changes', async () => {
    const host = bigHost();
    const view = renderExpress(page("DataTable('files.list')"), {datasets: 'ready', host, data: {'/ds/files_list': bigDataset()}});
    await ready(view);
    const before = host.queries.length;
    view.setData('/meta/rev', 2);
    await waitFor(() => expect(host.queries.length).toBeGreaterThan(before));
    expect(host.queries.at(-1)).toMatchObject({offset: 0, limit: 200});
  });

  it('refetches when the source is re-run under the same key, and not when something else changes', async () => {
    const host = bigHost();
    const view = renderExpress(page("DataTable('files.list')"), {datasets: 'ready', host, data: {'/ds/files_list': bigDataset()}});
    await ready(view);
    const settled = host.queries.length;
    fireEvent.click(cellsOf(rowAt(view, 3))[2]!);
    view.setData('/notes', 'unrelated');
    await view.settle();
    expect(host.queries.length).toBe(settled);

    view.setData('/ds/files_list', {...bigDataset(), elapsedMs: 99});
    await waitFor(() => expect(host.queries.length).toBeGreaterThan(settled));
    expect(host.queries.at(-1)).toMatchObject({offset: 0, limit: 200});
    expect(firstCells(view)[0]).toContain('file-0.ts');
  });

  it('keeps the rows of the old run up while a re-run under the same key loads, and then shows only the new run', async () => {
    const pending: Array<() => void> = [];
    let run = 'old';
    const rows = (q: RowsQuery) => {
      const tag = run;
      return new Promise<RowsPage>(resolve => {
        pending.push(() => resolve({total: TOTAL, offset: q.offset ?? 0, rows: Array.from({length: 200}, (_, i) => ({path: `${tag}-${(q.offset ?? 0) + i}.ts`, loc: i}))}));
      });
    };
    const view = renderExpress(page("DataTable('files.list')"), {datasets: 'ready', host: {rows}, data: {'/ds/files_list': bigDataset()}});
    await ready(view);
    await act(async () => pending.shift()!());
    expect(firstCells(view)[0]).toContain('old-0.ts');
    // a refresh: the server re-runs the source and publishes a new envelope under the same key
    run = 'new';
    view.setData('/ds/files_list', {...bigDataset(), elapsedMs: 7});
    await view.settle();
    expect(firstCells(view)[0]).toContain('old-0.ts');
    expect(view.cell('t').querySelector('[role="grid"]')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.at(-1)!());
    expect(firstCells(view)[0]).toContain('new-0.ts');
    expect(rowsOf(view).some(row => row.textContent?.includes('old-'))).toBe(false);
  });

  it('keeps the rows it shows while a new sort order loads', async () => {
    const pending: Array<(page: RowsPage) => void> = [];
    const rows = (q: RowsQuery) => new Promise<RowsPage>(resolve => {
      pending.push(() => resolve({total: TOTAL, offset: q.offset ?? 0, rows: Array.from({length: 200}, (_, i) => ({path: `${q.sort ?? 'plain'}-${i}.ts`, loc: i}))}));
    });
    const view = renderExpress(page("DataTable('files.list')"), {datasets: 'ready', host: {rows}, data: {'/ds/files_list': bigDataset()}});
    await ready(view);
    await act(async () => pending.shift()!(undefined as never));
    expect(firstCells(view)[0]).toContain('plain-0.ts');
    fireEvent.click(within(headers(view)[2]!).getByRole('button'));
    await view.settle();
    expect(firstCells(view)[0]).toContain('plain-0.ts');
    expect(view.cell('t').querySelector('[role="grid"]')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.at(-1)!(undefined as never));
    expect(firstCells(view)[0]).toContain('-loc-0.ts');
    expect(view.cell('t').querySelector('[role="grid"]')!.hasAttribute('aria-busy')).toBe(false);
  });

  it('stays local when the dataset is complete, and reports a failed page', async () => {
    const local = renderExpress(page("DataTable('files.list')"), {datasets: 'ready'});
    await ready(local);
    expect(local.host.calls.filter(call => call.method === 'rows')).toHaveLength(0);
    expect(rowsOf(local)).toHaveLength(9);
    local.unmount();

    const failing = renderExpress(page("DataTable('files.list',sort='loc')"), {datasets: 'ready', host: {rows: () => Promise.reject(new Error('offline'))}, data: {'/ds/files_list': bigDataset()}});
    await ready(failing);
    await waitFor(() => expect(within(failing.cell('t')).getByRole('alert').textContent).toContain('offline'));
    expect(failing.cell('t').querySelectorAll('[data-loading]').length).toBeGreaterThan(0);
  });

  it('shows the first rows the dataset came with while the first window loads', async () => {
    let release: (page: RowsPage) => void = () => {};
    const rows = () => new Promise<RowsPage>(resolve => { release = resolve; });
    const view = renderExpress(page("DataTable('files.list')"), {datasets: 'ready', host: {rows}, data: {'/ds/files_list': bigDataset()}});
    await ready(view);
    expect(firstCells(view)[0]).toContain('routes.ts');
    expect(rowAt(view, 12).hasAttribute('data-loading')).toBe(true);
    await act(async () => release({total: TOTAL, offset: 0, rows: Array.from({length: 200}, (_, i) => ({path: `fresh-${i}.ts`}))}));
    expect(firstCells(view)[0]).toContain('fresh-0.ts');
    expect(rowAt(view, 12).hasAttribute('data-loading')).toBe(false);
  });
});
