// Round 5 (decision content-sized-plates and the table polish of the review list): content-sized scrollers, labels that tell rows
// apart, the sign that a table goes on sideways, value-sniffed path columns and a tree that opens on whole rows.
// Invented generic fixtures only.
import type {DataRow} from '@glimpse/catalog';
import {act, fireEvent, render, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, onTestFinished, vi} from 'vitest';
import {revealOffset} from '../../src/components/table/nav.ts';
import {looksLikePath, resolveColumns} from '../../src/components/table/rows.ts';
import {distinctDepths} from '../../src/components/table/widths.ts';
import {DirText, PathText, fitDir} from '../../src/kit/index.ts';
import {renderExpress, type RenderedSpec} from '../harness.tsx';

afterEach(() => vi.restoreAllMocks());

describe('tree and list reveal: the row at the top edge is whole (round 4: the tree preset opened with it sliced)', () => {
  const tree = {rowHeight: 24, offsetTop: 0, pad: 4, viewport: 820, max: 24 * 1500 - 820};

  it('centres the row on a whole-row offset', () => {
    for (const index of [37, 120, 611, 1000]) {
      const offset = revealOffset(index, tree);
      expect((offset - tree.pad) % tree.rowHeight, `row ${index}`).toBe(0);
      // still close to the middle: the row sits within half a row of the centre of the viewport
      const rowMiddle = tree.pad + index * tree.rowHeight + tree.rowHeight / 2;
      expect(Math.abs(rowMiddle - offset - tree.viewport / 2)).toBeLessThanOrEqual(tree.rowHeight / 2);
    }
    // what the centring did before: (24 - 820) / 2 off the row's top, which cuts the top row in half
    const before = 4 + 37 * 24 + (24 - 820) / 2;
    expect((before - 4) % 24).not.toBe(0);
  });

  it('under a sticky header the rows below it start whole; the ends of the list clamp', () => {
    const table = {rowHeight: 28, offsetTop: 28, pad: 0, viewport: 420, max: 28 * 200 + 28 - 420};
    expect(revealOffset(90, table) % 28).toBe(0);
    expect(revealOffset(0, table)).toBe(0);
    expect(revealOffset(199, table)).toBe(table.max);
  });
});

describe('path labels tell the rows of a column apart (round 4: two rows read …/CHANGELOG.md)', () => {
  it('distinctDepths: the directories a name needs to differ from the other files of its column', () => {
    expect(distinctDepths([
      'packages/web_core/CHANGELOG.md',
      'packages/lit_core/CHANGELOG.md',
      'src/index.ts#L12',
      'src/index.ts#L40',
      'samples/mcp/kanban/client/vite.config.ts',
      'samples/mcp/recipe/client/vite.config.ts',
      null,
    ])).toEqual([1, 1, 0, 0, 2, 2, undefined]);
  });

  it('fitDir keeps the directory that differs and drops the shared ones after it when not all fit', () => {
    const dir = 'samples/mcp/kanban/client/';
    // room for everything: unchanged
    expect(fitDir(dir, 40, 2)).toEqual({text: dir, dropped: 0});
    // room for `…/client/` only: without a hint the label is the same for every client/vite.config.ts
    expect(fitDir(dir, 12, 0).text).toBe('…/client/');
    // with the hint, the one that differs stays and the shared `client/` goes
    expect(fitDir(dir, 12, 2).text).toBe('…/kanban/…/');
    // room for both: the plain form, whole directories only
    expect(fitDir(dir, 18, 2).text).toBe('…/kanban/client/');
    // not even that fits: the differing one is all that is shown, and the stylesheet cuts it at its start
    // (always led by `…`, so a label never reads as if it started at that directory, and cut to the room exactly)
    expect(fitDir(dir, 8, 2)).toEqual({text: '…nban/…/', dropped: 3, cut: true});
    expect(fitDir('packages/ledger_core/', 11, 1)).toEqual({text: '…dger_core/', dropped: 1, cut: true});
    expect(fitDir('specification/v1_0/docs/', 8, 2)).toEqual({text: '…v1_0/…/', dropped: 2, cut: true});
    // a name no other row has needs no directory: `…/` and as many trailing directories as fit
    expect(fitDir(dir, 8, 0).text).toBe('…/');
  });

  function mockWidths(room: number) {
    // mono text, 7 px a character; the directory box has `room` characters
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? (this.textContent?.length ?? 0) * 7 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? Math.min(room * 7, (this.textContent?.length ?? 0) * 7) : 0;
    });
  }

  it('PathText with `keep` shows the differing directory in a narrow cell', () => {
    mockWidths(12);
    const {container} = render(
      <>
        <PathText file="samples/mcp/kanban/client/vite.config.ts" keep={2} />
        <PathText file="samples/mcp/recipe/client/vite.config.ts" keep={2} />
      </>,
    );
    const shown = [...container.querySelectorAll('.gl-path')].map(path => path.textContent);
    expect(shown).toEqual(['…/kanban/…/vite.config.tsTS', '…/recipe/…/vite.config.tsTS']);
  });

  it('a directory that would fill its box to the pixel is cut one character shorter, so the name stays whole', () => {
    // 12 px mono is 7.2 px a character. In a 180 px cell, `a2ui_protocol.md` (115.2 px) leaves the directory 64.8 px,
    // which the browser reports as 65; `…/v0_9/…/` is exactly 64.8 px and, snapped to the layout grid, overflowed: the
    // name was drawn `a2u… protocol.md` (hotspots 'Changes together', review round).
    const dir = 'specification/v0_9/docs/';
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? Math.round((this.textContent?.length ?? 0) * 7.2) : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? Math.min(65, Math.round((this.textContent?.length ?? 0) * 7.2)) : 0;
    });
    const {container} = render(<DirText dir={dir} keep={2} />);
    const shown = container.textContent ?? '';
    expect(shown.length * 7.2).toBeLessThan(64.8);
    // still the directory that tells it apart from `v1_0`
    expect(shown).toContain('v0_9/');
  });

  it('DirText without a hint still drops whole directories from the start', () => {
    mockWidths(12);
    const {container} = render(<DirText dir="samples/mcp/kanban/client/" />);
    expect(container.textContent).toBe('…/client/');
  });

  it('a DataTable gives each path cell the hint from its column', async () => {
    const rows: DataRow[] = [
      {path: 'packages/web_core/CHANGELOG.md', commits: 9},
      {path: 'samples/mcp/kanban/client/vite.config.ts', commits: 8},
      {path: 'samples/mcp/recipe/client/vite.config.ts', commits: 7},
    ];
    mockWidths(12);
    // the harness's fake layout would answer for the directory boxes too: this test answers for every box itself
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 600);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({x: 0, y: 0, width: 960, height: 600}));
    const view = renderExpress(`root=Page('T',[t])\nt=DataTable($/rows)`, {data: {'/rows': rows}, size: false});
    await waitFor(() => expect(view.cell('t').querySelectorAll('.gl-path')).toHaveLength(3));
    await view.settle();
    const dirs = [...view.cell('t').querySelectorAll('.gl-path-dir')].map(dir => dir.textContent);
    // 12 characters: `…/web_core/` fits as it is; the two clients keep the directory that differs, not `client/`
    expect(dirs).toEqual(['…/web_core/', '…/kanban/…/', '…/recipe/…/']);
  });
});

describe('a column of paths is a path column whatever its name (round 5: `with` and `where` were cut at the end)', () => {
  it('looksLikePath', () => {
    for (const path of ['src/a.ts', 'docs/guide/intro', 'web/x.tsx#L19', '.github/workflows/release.yml#L83']) expect(looksLikePath(path), path).toBe(true);
    for (const text of ['and/or', '@scope/site', 'km/h', 'https://example.com/a.ts', 'src/domain', 'N/A', 'a b/c.ts']) expect(looksLikePath(text), text).toBe(false);
  });

  it('sniffs the kind from the values when the key says nothing', () => {
    const rows: DataRow[] = [
      {file: 'web/core/a.test.ts', with: 'web/core/a.ts', where: 'tools/x/y.js#L70', pkg: '@scope/site', note: 'and/or'},
      {file: 'web/core/b.test.ts', with: 'web/core/b.ts', where: 'core/lib/z.dart#L17', pkg: 'plain', note: 'text'},
    ];
    const kinds = Object.fromEntries(resolveColumns(undefined, undefined, rows).map(column => [column.key, column.kind]));
    expect(kinds).toEqual({file: 'path', with: 'path', where: 'path', pkg: 'text', note: 'text'});
  });
});

describe('a table that scrolls sideways says so (round 4: TREND, DELTA and OK hid behind a scroll nothing pointed at)', () => {
  const COLS = 6;
  const WIDTH = 150;
  /** A grid 600 px wide whose six columns are 150 px each, scrolled `left` px. */
  function geometry(left: () => number) {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'grid' ? COLS * WIDTH : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'grid' ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'grid') return DOMRect.fromRect({x: 0, y: 0, width: 600, height: 300});
      if (this.getAttribute('role') === 'columnheader') {
        const i = [...(this.parentElement?.children ?? [])].indexOf(this);
        return DOMRect.fromRect({x: i * WIDTH - left(), y: 0, width: WIDTH - 12, height: 28});
      }
      return DOMRect.fromRect({x: 0, y: 0, width: 0, height: 0});
    });
  }
  const rows = [{a: 'one', b: 'two', c: 'three', d: 'four', e: 'five', f: 'six'}];
  const more = (view: RenderedSpec, side: string) => view.cell('t').querySelector<HTMLButtonElement>(`[data-gl-table-more="${side}"]`);

  it('shows how many columns are out of view at each side, and scrolls a page that way', async () => {
    let left = 0;
    geometry(() => left);
    const scrolled: number[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollBy', {configurable: true, writable: true, value(options?: ScrollToOptions) {
      scrolled.push(options?.left ?? 0);
    }});
    onTestFinished(() => void delete (HTMLElement.prototype as {scrollBy?: unknown}).scrollBy);
    const view = renderExpress(`root=Page('T',[t])\nt=DataTable($/rows,title='Wide')`, {data: {'/rows': rows}, size: false});
    await waitFor(() => expect(more(view, 'right')).not.toBeNull());
    // columns 5 and 6 end past 600 px
    expect(more(view, 'right')!.textContent).toBe('+2');
    expect(more(view, 'right')!.getAttribute('aria-label')).toBe('2 columns to the right: scroll right');
    expect(more(view, 'left')).toBeNull();
    fireEvent.click(more(view, 'right')!);
    expect(scrolled).toEqual([600 - 64]);
    // the reader scrolled to the end: the sign moves to the other side
    left = 300;
    const grid = view.cell('t').querySelector<HTMLElement>('[role="grid"]')!;
    act(() => void grid.dispatchEvent(new Event('scroll')));
    expect(more(view, 'right')).toBeNull();
    expect(more(view, 'left')!.textContent).toBe('+2');
  });

  it('shows nothing when every column fits', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => 600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 600);
    const view = renderExpress(`root=Page('T',[t])\nt=DataTable($/rows)`, {data: {'/rows': rows}, size: false});
    await waitFor(() => expect(view.cell('t').querySelector('[role="grid"]')).not.toBeNull());
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-table-more]')).toBeNull();
  });
});

describe('content-sized scrollers (content-sized-plates)', () => {
  it('every table-family view and code view takes its cap from the size step, not a fixed height', async () => {
    const view = renderExpress(
      `root=Page('T',[a,b,c,d])\na=FileTree('files.tree',size='s')\nb=JsonView($/json,size='xl')\nc=CommitList('git.log')\nd=CodeView('src/auth/service.ts',size='l')`,
      {datasets: 'ready', data: {'/json': {name: 'demo'}}},
    );
    await waitFor(() => expect(view.cell('d').querySelector('[data-gl-code="view"]')).not.toBeNull());
    await view.settle();
    const cap = (id: string, selector: string) => {
      const root = view.cell(id).querySelector<HTMLElement>(selector)!;
      return (root.style.getPropertyValue('--gl-cap') || (root.parentElement as HTMLElement).style.getPropertyValue('--gl-cap'));
    };
    expect(cap('a', '[data-gl-tree]')).toBe('160px');
    expect(cap('b', '[data-gl-json]')).toBe('640px');
    expect(cap('c', '[data-gl-commits]')).toBe('420px');
    expect(cap('d', '[data-gl-code="view"]')).toBe('420px');
  });
});
