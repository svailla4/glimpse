// Regression tests for the review findings in the table family: path cells that keep the file name, columns sized
// to their content, categories without a session colour, dates without a time, focus in paged tables, commit rows
// and the scroll cue. FileTree's drill and rollup findings are in FileTree.test.tsx.
import type {Dataset, RowsPage, RowsQuery} from '@glimpse/catalog';
import {act, fireEvent, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {ageText} from '../../src/components/table/cells.tsx';
import {datasetFixture, renderExpress, type RenderedSpec} from '../harness.tsx';

const page = (view: string, data = '') => `${data}\nroot=Page('T',[t])\nt=${view}`;
const rowAt = (view: RenderedSpec, index: number) => view.cell('t').querySelector<HTMLElement>(`[data-index="${index}"]`)!;
const cellsOf = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>('[role="gridcell"]')];
const key = (name: string) => fireEvent.keyDown(document.activeElement!, {key: name});
/** The grid tracks of the table, one per column. */
const tracks = (view: RenderedSpec) =>
  view.cell('t').querySelector<HTMLElement>('[style*="--gl-table-cols"]')!.style.getPropertyValue('--gl-table-cols').match(/minmax\([^)]*\)|\S+/g) ?? [];

async function ready(view: RenderedSpec, role = 'grid'): Promise<HTMLElement> {
  const found = await waitFor(() => {
    const element = view.container.querySelector<HTMLElement>(`[role="${role}"]`);
    if (!element) throw new Error(`no ${role} yet`);
    return element;
  });
  await view.settle();
  return found;
}

describe('DataTable: path cells and column widths (F004, F019, F088, paths-keep-file-name)', () => {
  const ROWS = [
    {path: 'typescript/core/web_core/tests/conformance/conformance_test.mjs', commits: 41, loc: 1280, last: '2026-11-01T10:00:00Z'},
    {path: 'typescript/core/web_core/src/processing/message-processor.ts', commits: 7, loc: 96, last: '2026-10-01T10:00:00Z'},
  ];

  it('renders a path as a directory that can give way and a file name that stays, with the full path as the tooltip', async () => {
    const view = renderExpress(page('DataTable($/rows)'), {data: {'/rows': ROWS}});
    await ready(view);
    const path = cellsOf(rowAt(view, 0))[0]!.querySelector<HTMLElement>('.gl-path')!;
    // the kit elides `.gl-path-dir` and never `.gl-path-base`; the cell only has to hand it a box that can shrink
    expect(path.querySelector('.gl-path-dir')!.textContent).toBe('typescript/core/web_core/tests/conformance/');
    expect(path.querySelector('.gl-path-base')!.textContent).toBe('conformance_test.mjs');
    expect(path.getAttribute('title')).toBe(ROWS[0]!.path);
    expect(path.closest('button')!.getAttribute('data-entity-id')).toBe(ROWS[0]!.path);
  });

  it('gives short numeric columns the width of their text and the spare width to the path column', async () => {
    const view = renderExpress(page('DataTable($/rows)'), {data: {'/rows': ROWS}});
    await ready(view);
    const [path, commits, loc, last] = tracks(view);
    // the path column is the flexible one: it takes all the spare width
    expect(path).toMatch(/^minmax\(168px, \d+fr\)$/);
    // numbers and ages are a fixed width in px: no share of the spare width, so none is taken from the path
    for (const track of [commits, loc, last]) expect(track).toMatch(/^\d+px$/);
    // "commits" is wider than "41": the header sets the width; "1,280" is wider than "loc"
    expect(Number.parseInt(commits!, 10)).toBeGreaterThanOrEqual(56);
    expect(Number.parseInt(loc!, 10)).toBeLessThan(60);
  });

  it('lets numeric columns share the width when the table has no column that could use it', async () => {
    const view = renderExpress(page('DataTable($/rows)'), {data: {'/rows': [{a: 1, b: 22}, {a: 333, b: 4}]}});
    await ready(view);
    expect(tracks(view)).toHaveLength(2);
    const [a, b] = tracks(view);
    for (const track of [a, b]) expect(track).toMatch(/^minmax\(\d+px, \d+fr\)$/);
    // equal weights: the two columns split the width evenly
    expect(a!.match(/(\d+)fr/)![1]).toBe(b!.match(/(\d+)fr/)![1]);
  });
});

describe('DataTable: values (F013, F072)', () => {
  it('prints a zero count in the dim ink, not in green or red', async () => {
    const view = renderExpress(page("DataTable($/rows,columns='file d:delta')"), {data: {'/rows': [{file: 'a.ts', d: {add: 12, del: 0}}, {file: 'b.ts', d: {add: 0, del: 4}}]}});
    await ready(view);
    const spans = (index: number) => [...cellsOf(rowAt(view, index))[1]!.querySelectorAll<HTMLElement>('span > span')];
    const [add, zeroDel] = spans(0);
    expect(add!.textContent).toBe('+12');
    expect(add!.className).toMatch(/add/);
    expect(zeroDel!.textContent).toBe('−0');
    expect(zeroDel!.className).toMatch(/zero/);
    expect(zeroDel!.className).not.toMatch(/del/);
    const [zeroAdd, del] = spans(1);
    expect(zeroAdd!.className).toMatch(/zero/);
    expect(del!.className).toMatch(/del/);
  });

  it('counts a day-only date in days, never in hours', async () => {
    const now = Date.parse('2026-11-20T07:05:00Z');
    // a commit made minutes ago, reported as its UTC day: not "7 h"
    expect(ageText('2026-11-20', now)).toBe('today');
    expect(ageText('2026-11-19', now)).toBe('1 d');
    expect(ageText('2026-11-06', now)).toBe('2 wk');
    expect(ageText('2025-11-01', now)).toBe('1 y');
    // a value with a time keeps its resolution
    expect(ageText(new Date(Date.now() - 20 * 60_000).toISOString())).toBe('20 min');

    const today = new Date().toISOString().slice(0, 10);
    const view = renderExpress(page('DataTable($/rows)'), {data: {'/rows': [{file: 'a.ts', last: today}]}});
    await ready(view);
    const cell = cellsOf(rowAt(view, 0))[1]!;
    expect(cell.getAttribute('data-kind')).toBe('date');
    expect(cell.querySelector('time')!.firstChild!.textContent).toBe('today');
  });
});

describe('DataTable: category colours (F006, stable-category-colours)', () => {
  const inkOf = (element: Element | null | undefined) => (element as HTMLElement).style.background;

  it('gives languages without a session slot the free inks in order of first appearance, never one shared grey', async () => {
    const rows = [{lang: 'TypeScript', loc: 9}, {lang: 'Astro', loc: 5}, {lang: 'Kotlin', loc: 4}, {lang: 'HTML', loc: 3}, {lang: 'Astro', loc: 1}];
    const view = renderExpress(page("DataTable($/rows,columns='lang:lang loc')"), {data: {'/rows': rows, '/meta/slots': {lang: {TypeScript: 1}, module: {}, author: {}}}});
    await ready(view);
    const inks = rows.map((_, i) => inkOf(cellsOf(rowAt(view, i))[0]!.querySelector('[aria-hidden="true"]')));
    // the session's ink for TypeScript, then the lowest free ones; the same language is the same ink
    expect(inks).toEqual(['var(--gl-cat-1)', 'var(--gl-cat-2)', 'var(--gl-cat-3)', 'var(--gl-cat-4)', 'var(--gl-cat-2)']);
    // colours do not move when the rows are re-sorted
    fireEvent.click(view.cell('t').querySelector<HTMLElement>('[data-head="loc"]')!);
    fireEvent.click(view.cell('t').querySelector<HTMLElement>('[data-head="loc"]')!);
    await view.settle();
    const first = cellsOf(rowAt(view, 0))[0]!;
    expect(first.textContent).toBe('Astro');
    expect(inkOf(first.querySelector('[aria-hidden="true"]'))).toBe('var(--gl-cat-2)');
  });

  it('colours chips of a category the session has no slots for, and leaves status chips their tone', async () => {
    const rows = [{name: 'a', eco: 'swiftpm', status: 'A'}, {name: 'b', eco: 'pypi', status: 'M'}, {name: 'c', eco: 'npm', status: 'D'}, {name: 'd', eco: 'pypi', status: 'A'}];
    const view = renderExpress(page("DataTable($/rows,columns='name eco:chip status:chip')"), {data: {'/rows': rows}});
    await ready(view);
    const dot = (index: number, column: number) => cellsOf(rowAt(view, index))[column]!.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    expect([0, 1, 2, 3].map(i => inkOf(dot(i, 1)))).toEqual(['var(--gl-cat-1)', 'var(--gl-cat-2)', 'var(--gl-cat-3)', 'var(--gl-cat-2)']);
    // a status chip is toned by the stylesheet (data-tone), not given a category colour
    expect(inkOf(dot(0, 2))).toBe('');
    expect(dot(0, 2).parentElement!.getAttribute('data-tone')).toBe('good');
  });
});

describe('DataTable: paged rows keep the keyboard (F021)', () => {
  const TOTAL = 4690;
  function host() {
    const pending: Array<() => void> = [];
    const rows = (q: RowsQuery): Promise<RowsPage> => {
      const offset = q.offset ?? 0;
      const length = Math.max(0, Math.min(q.limit ?? 200, TOTAL - offset));
      const page: RowsPage = {total: TOTAL, offset, rows: Array.from({length}, (_, i) => ({path: `src/gen/file-${offset + i}.ts`, lang: 'TypeScript', loc: offset + i}))};
      // every window after the first is held until the test lets it through, like a slow host
      if (offset === 0) return Promise.resolve(page);
      return new Promise(resolve => pending.push(() => resolve(page)));
    };
    const release = () => {
      for (const run of pending.splice(0)) run();
    };
    return {rows, release};
  }
  const dataset = (): Dataset => ({...datasetFixture('files.list'), total: TOTAL, truncated: {total: TOTAL, returned: 9, strategy: 'topN', by: 'loc'}});

  it('keeps focus on the row End jumps to while its window loads, and Home, arrows and Enter go on working', async () => {
    const slow = host();
    const view = renderExpress(page("DataTable('files.list',title='Files')"), {datasets: 'ready', host: {rows: slow.rows}, data: {'/ds/files_list': dataset()}});
    const grid = await ready(view);
    act(() => rowAt(view, 0).focus());
    key('End');
    // the last row is on screen as a placeholder, and it has the focus
    await waitFor(() => expect(document.activeElement?.getAttribute('data-index')).toBe(String(TOTAL - 1)));
    const placeholder = document.activeElement as HTMLElement;
    expect(placeholder.hasAttribute('data-loading')).toBe(true);
    // jsdom does not scroll: put the viewport where End took it, as a browser does
    grid.scrollTop = 28 * (TOTAL + 1) - grid.clientHeight;
    fireEvent.scroll(grid);
    await view.settle();

    // its rows arrive: the same element fills in, so focus is not dropped to <body>
    await act(async () => slow.release());
    await waitFor(() => expect(rowAt(view, TOTAL - 1).textContent).toContain(`file-${TOTAL - 1}.ts`));
    expect(rowAt(view, TOTAL - 1)).toBe(placeholder);
    expect(document.activeElement).toBe(placeholder);
    expect(placeholder.hasAttribute('data-loading')).toBe(false);

    key('ArrowUp');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-index')).toBe(String(TOTAL - 2)));
    key('Enter');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'file', id: `src/gen/file-${TOTAL - 2}.ts`});
    key('Home');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-index')).toBe('0'));
    expect(view.errors).toEqual([]);
  });
});

describe('table family: the scroll cue (F014, F016)', () => {
  it('marks a scroller that has more rows below or more columns to the right, and clears the mark at the end', async () => {
    const view = renderExpress(page("DataTable('git.churn')"), {datasets: 'ready'});
    const grid = await ready(view);
    // the harness layout gives every element the same box; say the content is larger than it
    Object.defineProperty(grid, 'scrollHeight', {configurable: true, value: 2000});
    Object.defineProperty(grid, 'scrollWidth', {configurable: true, value: 1400});
    fireEvent.scroll(grid);
    expect(grid.hasAttribute('data-more-y')).toBe(true);
    expect(grid.hasAttribute('data-more-x')).toBe(true);
    grid.scrollTop = 2000 - grid.clientHeight;
    grid.scrollLeft = 1400 - grid.clientWidth;
    fireEvent.scroll(grid);
    expect(grid.hasAttribute('data-more-y')).toBe(false);
    expect(grid.hasAttribute('data-more-x')).toBe(false);
  });

  it('does the same for the file tree', async () => {
    const view = renderExpress(page('FileTree()'), {datasets: 'ready'});
    const tree = await ready(view, 'tree');
    expect(tree.hasAttribute('data-more-y')).toBe(false);
    Object.defineProperty(tree, 'scrollHeight', {configurable: true, value: 5000});
    fireEvent.scroll(tree);
    expect(tree.hasAttribute('data-more-y')).toBe(true);
  });
});

describe('CommitList: refs, change counts and authors (F013, stable-category-colours)', () => {
  const commit = (sha: string, extra: Record<string, unknown> = {}) => ({sha, subject: `Subject of ${sha}`, author: 'Mira Okafor', date: '2026-11-01T00:00:00Z', ...extra});

  it('draws two ref chips at most, each with its full name as the tooltip, and counts the rest', async () => {
    const view = renderExpress(page('CommitList($/c)'), {data: {'/c': [commit('aaaaaaa1', {refs: ['HEAD', 'feat/initial-build-of-everything', 'origin/main', 'v1.0.0']}), commit('bbbbbbb2', {refs: ['main']})]}});
    await ready(view, 'listbox');
    const chips = (index: number) => [...rowAt(view, index).querySelectorAll<HTMLElement>('[class*="ref"]:not([class*="refs"])')];
    expect(chips(0).map(chip => chip.textContent)).toEqual(['HEAD', 'feat/initial-build-of-everything', '+2']);
    // a long name is elided inside its own chip (the stylesheet caps it); the whole name is one hover away
    expect(chips(0)[1]!.getAttribute('title')).toBe('feat/initial-build-of-everything');
    expect(chips(0)[2]!.getAttribute('title')).toBe('origin/main, v1.0.0');
    expect(chips(1).map(chip => chip.textContent)).toEqual(['main']);
  });

  it('reserves no change column when no commit has line counts, and prints zero counts dim', async () => {
    const bare = renderExpress(page('CommitList($/c)'), {data: {'/c': [commit('aaaaaaa1'), commit('bbbbbbb2')]}});
    await ready(bare, 'listbox');
    expect(rowAt(bare, 0).querySelector('[class*="changes"]')).toBeNull();
    bare.unmount();

    const counted = renderExpress(page('CommitList($/c)'), {data: {'/c': [commit('aaaaaaa1', {add: 114, del: 0}), commit('bbbbbbb2')]}});
    await ready(counted, 'listbox');
    // one commit has counts: every row keeps the column, so the dates line up
    expect(rowAt(counted, 1).querySelector('[class*="changes"]')).not.toBeNull();
    const [add, del] = [...rowAt(counted, 0).querySelectorAll<HTMLElement>('[class*="counts"] > span')];
    expect(add!.textContent).toBe('+114');
    expect(add!.className).toMatch(/add/);
    expect(del!.textContent).toBe('−0');
    expect(del!.className).toMatch(/zero/);
  });

  it('colours authors without a session slot in order of first appearance', async () => {
    const view = renderExpress(page('CommitList($/c)'), {
      data: {'/c': [commit('aaaaaaa1', {author: 'Ada'}), commit('bbbbbbb2', {author: 'Grace'}), commit('ccccccc3', {author: 'Ada'})], '/meta/slots': {lang: {}, module: {}, author: {}}},
    });
    await ready(view, 'listbox');
    const ink = (index: number) => rowAt(view, index).querySelector<HTMLElement>('[title]:not([class*="subject"])[style]')!.style.getPropertyValue('--gl-commit-ink');
    expect([0, 1, 2].map(ink)).toEqual(['var(--gl-cat-1)', 'var(--gl-cat-2)', 'var(--gl-cat-1)']);
  });
});
