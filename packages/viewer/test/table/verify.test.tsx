// Regression tests for the verification round in the table family: text columns get the spare width before numbers
// and short codes do; CommitList columns hold still; FileTree shows the file the view opened on; small virtualised
// lists never draw blank rows (V047).
import type {DataRow} from '@glimpse/catalog';
import {act, fireEvent, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import type {Column} from '../../src/components/table/rows.ts';
import {columnBox, columnWidths, floorWidth, measureColumns, typicalKey} from '../../src/components/table/widths.ts';
import {renderExpress, type RenderedSpec} from '../harness.tsx';

const col = (key: string, kind: Column['kind'], label = key): Column => ({key, label, kind, priority: 2});
/** Width of every column of `rows` in a table `width` px wide, by key. */
function layout(columns: Column[], rows: DataRow[], width: number): Record<string, number> {
  const needs = measureColumns(rows, columns);
  const boxes = columns.map(column => columnBox(column, needs.get(column.key), needs.get(typicalKey(column.key))));
  const widths = columnWidths(boxes, width);
  return Object.fromEntries(columns.map((column, i) => [column.key, Math.round(widths[i]!)]));
}
const boxOf = (column: Column, rows: DataRow[]) => {
  const needs = measureColumns(rows, [column]);
  return columnBox(column, needs.get(column.key), needs.get(typicalKey(column.key)));
};
const wantOf = (column: Column, rows: DataRow[]) => boxOf(column, rows).want;

describe('DataTable: text columns get the spare width first (integrator list: Packages, Scripts, TODO, Cycles)', () => {
  const PACKAGES: Column[] = [col('name', 'text', 'Package'), col('ecosystem', 'chip'), col('version', 'code'), col('dir', 'path'), col('deps', 'num')];
  const PACKAGE_ROWS: DataRow[] = [
    {name: 'A2UISwiftCore', ecosystem: 'swiftpm', version: null, dir: '', deps: 2},
    {name: 'a2ui-repo (requirements.txt)', ecosystem: 'pypi', version: null, dir: '', deps: 2},
    {name: 'a2ui-conformance-tests', ecosystem: 'pypi', version: '0.1.0', dir: 'conformance', deps: 3},
    {name: 'a2ui_flutter_e2e_test_v0_9', ecosystem: 'pub', version: null, dir: 'dart/a2ui_flutter/e2e_test_v0_9', deps: 4},
  ];

  it('a package name is drawn whole while the version column holds only what it prints', () => {
    const widths = layout(PACKAGES, PACKAGE_ROWS, 724);
    expect(widths.name).toBeGreaterThanOrEqual(wantOf(PACKAGES[0]!, PACKAGE_ROWS));
    // "0.1.0" under "VERSION": the header sets the width, not the 140 px floor of a code column
    expect(widths.version).toBeLessThan(80);
    expect(widths.dir).toBeGreaterThanOrEqual(wantOf(PACKAGES[3]!, PACKAGE_ROWS));
  });

  it('a long command gets the width before a short script name grows', () => {
    const columns = [col('package', 'text'), col('script', 'code'), col('command', 'code')];
    const rows: DataRow[] = [
      {package: 'a2ui-workspace', script: 'build:all', command: 'yarn workspaces foreach -Apt --exclude a2ui-workspace run build'},
      {package: '@a2ui/site', script: 'predev', command: 'node scripts/prepare-site.mjs && astro sync'},
    ];
    const widths = layout(columns, rows, 512);
    // the short columns are whole and the long one has everything that is left
    expect(widths.package).toBeGreaterThanOrEqual(wantOf(columns[0]!, rows));
    expect(widths.script).toBeGreaterThanOrEqual(wantOf(columns[1]!, rows));
    expect(widths.command).toBeGreaterThan(widths.package! + widths.script!);
  });

  it('one long package name does not take the width nine commands in ten need', () => {
    const columns = [col('package', 'text'), col('script', 'code'), col('command', 'code')];
    const rows: DataRow[] = [
      ...Array.from({length: 12}, (_, i) => ({package: 'a2ui-workspace', script: `lint:${i}`, command: `yarn workspaces foreach -Apt --exclude a2ui-workspace run lint:${i}`})),
      {package: '@a2ui/angular-renderer-conformance-tests', script: 'test', command: 'node tests/run.mjs'},
    ];
    const widths = layout(columns, rows, 512);
    // the usual package name is whole; the outlier is cut before the commands are
    expect(widths.package).toBeGreaterThanOrEqual(boxOf(columns[0]!, rows).typical);
    expect(widths.package).toBeLessThan(boxOf(columns[0]!, rows).want);
    expect(widths.command).toBeGreaterThan(widths.package! + 60);
    // short script names hold their column at what they need, not at the 140 px floor of a code column
    expect(widths.script).toBeLessThan(100);
    expect(widths.script).toBeGreaterThanOrEqual(boxOf(columns[1]!, rows).typical);
  });

  it('a chip column is never cut: its floor is its want', () => {
    const box = boxOf(col('ecosystem', 'chip'), [{ecosystem: 'swiftpm'}, {ecosystem: 'pypi'}]);
    expect(box.floor).toBe(box.want);
    expect(box.want).toBeGreaterThanOrEqual(24 + 7 * 6.9);
  });

  it('a TODO text is not cut more than its location; the tag chip is as wide as it needs', () => {
    const columns = [col('tag', 'chip'), col('file', 'path', 'Where'), col('text', 'text')];
    const rows: DataRow[] = [
      {tag: 'TODO', file: 'typescript/renderers/lit/src/0.8/ui/root.ts#L208', text: 'Description is currently not used in the Maps. Remove it once the composer is gone.'},
    ];
    const widths = layout(columns, rows, 610);
    expect(widths.tag).toBeLessThan(76);
    // both are longer than the plate allows: they end up equally wide (the path elides its directory, not its name)
    expect(Math.abs(widths.file! - widths.text!)).toBeLessThanOrEqual(1);
    // before this round the path column took twice the text's share of the spare width
    expect(widths.text).toBeGreaterThan(220);
  });

  it('cycle members (text) are served before the numbers beside them grow', () => {
    const columns = [col('id', 'num', '#'), col('size', 'num', 'Files'), col('members', 'text')];
    const rows: DataRow[] = [{id: 1, size: 3, members: 'typescript/renderers/lit/src/a.ts → typescript/renderers/lit/src/b.ts → typescript/renderers/lit/src/c.ts'}];
    const widths = layout(columns, rows, 400);
    expect(widths.id).toBeLessThanOrEqual(44);
    expect(widths.size).toBeLessThan(64);
    expect(widths.members).toBe(400 - 28 - 24 - widths.id! - widths.size!);
  });

  it('extra width past every want still fills the row, by weight', () => {
    const widths = layout(PACKAGES, PACKAGE_ROWS, 2000);
    const sum = Object.values(widths).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - (2000 - 28 - 12 * 4))).toBeLessThanOrEqual(2);
  });

  it('below the floors the table keeps the floors and scrolls sideways', () => {
    const boxes = PACKAGES.map(column => boxOf(column, PACKAGE_ROWS));
    expect(columnWidths(boxes, 200)).toEqual(boxes.map(box => box.floor));
    expect(floorWidth(boxes)).toBeGreaterThan(200);
  });

  it('the rendered grid gives the package name its width', async () => {
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[t])\nt=DataTable($/rows,columns='name:text:Package ecosystem:chip version:code dir:path deps:num')`, {
      data: {'/rows': PACKAGE_ROWS},
      size: {width: 724, height: 600},
    });
    const grid = await waitFor(() => {
      const element = view.cell('t').querySelector<HTMLElement>('[style*="--gl-table-cols"]');
      if (!element) throw new Error('no grid yet');
      return element;
    });
    const tracks = grid.style.getPropertyValue('--gl-table-cols').match(/minmax\([^)]*\)|\S+/g)!;
    const fr = (track: string) => Number(/(\d+)fr/.exec(track)?.[1] ?? Number.NaN);
    const px = (track: string) => Number(/^(\d+)px$/.exec(track)?.[1] ?? Number.NaN);
    expect(fr(tracks[0]!)).toBeGreaterThanOrEqual(wantOf(PACKAGES[0]!, PACKAGE_ROWS));
    expect(fr(tracks[2]!)).toBeLessThan(80);
    expect(px(tracks[4]!)).toBeLessThan(60);
  });
});

describe('DataTable: a field the data lacks (D14, D15 for inline data)', () => {
  const ROWS = [{name: 'auth', loc: 1200, lang: 'TypeScript'}, {name: 'api', loc: 800, lang: 'Go'}];
  const heads = (view: RenderedSpec) => [...view.cell('t').querySelectorAll('[data-head]')].map(head => head.getAttribute('data-head'));

  it('leaves out a named column that is not in the data and says which, with the fields there are', async () => {
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[t])\nt=DataTable($/rows,columns='name churn loc')`, {data: {'/rows': ROWS}});
    await waitFor(() => expect(heads(view)).toEqual(['name', 'loc']));
    await view.settle();
    expect(view.stateOf('t')).toBe('W_FIELD');
    const message = view.reports.at(-1)!.message;
    expect(message).toContain('columns churn not in the data');
    expect(message).toContain('fields: name loc lang');
  });

  it('falls back to every column when none of the named ones exists, and ignores an unknown group and sort', async () => {
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[t])\nt=DataTable($/rows,columns='zzz',group='module',sort='-churn')`, {data: {'/rows': ROWS}});
    await waitFor(() => expect(heads(view)).toEqual(['name', 'loc', 'lang']));
    // no group of everything: the rows are rows
    expect(view.cell('t').querySelector('[data-group]')).toBeNull();
    await view.settle();
    expect(view.stateOf('t')).toBe('W_FIELD');
    expect(view.reports.at(-1)!.message).toContain('columns zzz, sort churn, group module not in the data');
  });

  it('says OK when every named field is there', async () => {
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[t])\nt=DataTable($/rows,columns='name loc',sort='-loc')`, {data: {'/rows': ROWS}});
    await waitFor(() => expect(heads(view)).toEqual(['name', 'loc']));
    await view.settle();
    expect(view.stateOf('t')).toBe('OK');
  });
});

describe('virtualised lists never leave rows on screen unmounted (V047)', () => {
  const LANGS = Array.from({length: 22}, (_, i) => ({lang: `Lang ${i}`, files: 100 - i, loc: 10_000 - i * 100}));
  const indexes = (view: RenderedSpec) => [...view.cell('t').querySelectorAll('[role="row"][data-index]')].map(row => Number(row.getAttribute('data-index')));
  const grid = async (view: RenderedSpec) =>
    waitFor(() => {
      const element = view.cell('t').querySelector<HTMLElement>('[role="grid"]');
      if (!element) throw new Error('no grid yet');
      return element;
    });

  it('a short table mounts every row, whatever the virtual window believes', async () => {
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[t])\nt=DataTable($/rows)`, {data: {'/rows': LANGS}, size: {width: 600, height: 120}});
    const scroller = await grid(view);
    expect(indexes(view)).toEqual(LANGS.map((_, i) => i));
    // the scroller moved and came back without a scroll event (the browser clamping it after a resize)
    scroller.scrollTop = 400;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 0;
    expect(indexes(view)).toEqual(LANGS.map((_, i) => i));
  });

  it('a long table re-reads the scroll position when focus enters it', async () => {
    const rows = Array.from({length: 300}, (_, i) => ({name: `row ${i}`, n: i}));
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[t])\nt=DataTable($/rows,search=false)`, {data: {'/rows': rows}, size: {width: 600, height: 300}});
    const scroller = await grid(view);
    expect(indexes(view)).toContain(0);
    scroller.scrollTop = 28 * 200;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(indexes(view)).toContain(200));
    expect(indexes(view)).not.toContain(5);
    // let the virtualizer's own end-of-scroll read happen: after it, nothing re-reads the position by itself
    await act(() => new Promise(resolve => setTimeout(resolve, 300)));
    // back at the top with no scroll event: the window is stale until something re-reads it
    scroller.scrollTop = 0;
    fireEvent.focusIn(scroller);
    await waitFor(() => expect(indexes(view)).toContain(5), {timeout: 200});
  });
});

describe('CommitList: columns hold still (integrator list)', () => {
  const commit = (sha: string, add?: number, del?: number) => ({sha, subject: `subject ${sha}`, author: 'Mira', date: '2026-11-10T10:00:00Z', ...(add === undefined ? {} : {add, del})});

  it('every row reserves the width of the widest counts, so a wide count cannot push the author and age aside', async () => {
    const view = renderExpress(`$/c=[]\nroot=Page('T',[t])\nt=CommitList($/c)`, {data: {'/c': [commit('aaaaaaa', 86, 7), commit('bbbbbbb', 8798, 1008), commit('ccccccc')]}});
    const root = await waitFor(() => {
      const element = view.cell('t').querySelector<HTMLElement>('[data-gl-commits]');
      if (!element) throw new Error('no list yet');
      return element;
    });
    // '+8,798 −1,008' is 13 characters of 6.6 px
    expect(root.style.getPropertyValue('--gl-commit-counts')).toBe('88px');
    // a row without counts keeps the column too
    const rows = [...root.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.lastElementChild!.className).toMatch(/changes/);
  });

  it('a list of small changes reserves less', async () => {
    const view = renderExpress(`$/c=[]\nroot=Page('T',[t])\nt=CommitList($/c)`, {data: {'/c': [commit('aaaaaaa', 5, 1), commit('bbbbbbb', 12, 30)]}});
    const root = await waitFor(() => view.cell('t').querySelector<HTMLElement>('[data-gl-commits]')!);
    // '+12 −30' is 7 characters
    expect(root.style.getPropertyValue('--gl-commit-counts')).toBe(`${Math.ceil(7 * 6.6) + 2}px`);
  });
});

describe('FileTree: the followed file is shown when the tree opens (integrator list)', () => {
  const rowAt = (view: RenderedSpec, path: string) => view.cell('t').querySelector<HTMLElement>(`[data-path="${path}"]`);
  const ready = async (view: RenderedSpec) => {
    await waitFor(() => {
      if (!view.container.querySelector('[role="tree"]')) throw new Error('no tree yet');
    });
    await view.settle();
  };

  it('marks $/ui/file, opens its folders and makes it the tab stop, without selecting anything', async () => {
    const view = renderExpress(`root=Page('T',[t])\nt=FileTree(depth=0)`, {datasets: 'ready', ui: {file: 'src/api/limiter.go'}});
    await ready(view);
    await waitFor(() => expect(rowAt(view, 'src/api/limiter.go')).not.toBeNull());
    expect(rowAt(view, 'src/api/limiter.go')!.getAttribute('data-selected')).toBe('exact');
    expect(rowAt(view, 'src/api/limiter.go')!.getAttribute('tabindex')).toBe('0');
    // the tree only followed: no selection was written and nothing was dispatched
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(view.actions).toEqual([]);
  });

  it('a top-level README is marked where it is', async () => {
    const view = renderExpress(`root=Page('T',[t])\nt=FileTree()`, {datasets: 'ready', ui: {file: 'README.md'}});
    await ready(view);
    await waitFor(() => expect(rowAt(view, 'README.md')!.getAttribute('data-selected')).toBe('exact'));
  });

  it('an empty directory is a truthful empty (I_EMPTY), not a problem (D14)', async () => {
    const view = renderExpress(`$/tree=[]\nroot=Page('T',[t])\nt=FileTree($/tree)`, {data: {'/tree': {name: 'gen', path: 'gen', dir: true, children: []}}});
    await waitFor(() => expect(view.cell('t').textContent).toContain('gen is an empty directory'));
    await view.settle();
    expect(view.stateOf('t')).toBe('I_EMPTY');
  });

  it('a selection takes over, and Escape clears the mark of the followed file', async () => {
    const view = renderExpress(`root=Page('T',[t])\nt=FileTree()`, {datasets: 'ready', ui: {file: 'README.md'}});
    await ready(view);
    await waitFor(() => expect(rowAt(view, 'README.md')!.getAttribute('data-selected')).toBe('exact'));
    view.setData('/ui/sel', {type: 'file', id: 'package.json', path: 'package.json'});
    await waitFor(() => expect(rowAt(view, 'package.json')!.getAttribute('data-selected')).toBe('exact'));
    expect(rowAt(view, 'README.md')!.hasAttribute('data-selected')).toBe(false);
    view.setData('/ui/sel', null);
    await waitFor(() => expect(view.cell('t').querySelector('[data-selected]')).toBeNull());
  });
});
