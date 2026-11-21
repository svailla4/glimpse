// packages/viewer/test/shell/kit-review.test.tsx - regression tests for the kit defects the review found. Each
// block names the finding (Fnnn) or the cross-area decision (Dn) it pins down. Stub views only: nothing here depends
// on a component package.
import {SOURCES, datasetKey, parseRef, type Dataset, type DatasetKind, type EntityRef, type RowsPage, type RowsQuery} from '@glimpse/catalog';
import {act, fireEvent, render, within} from '@testing-library/react';
import {useEffect, useRef, useState} from 'react';
import {describe, expect, it, vi} from 'vitest';
import {
  DataGate, Drafting, Empty, Frame, KitProvider, PathText, PlateAside, Redline, Subpart, assignSlots, borrowView, catVar, dropDirs, elidePath, fileEntity, nameTail,
  hubOf, isFrameable, isOtherKey, linkedEntity, marksSelection, matchSelection, reportCode, splitPath, useCatSlots, useDataset, useHostActions, useLinkStatus, useReportState, useRows,
  useSelection, useSize, useTooltip, widthBoxOf, type GlView,
} from '../../src/kit/index.ts';
import {COMPONENT_BY_NAME, hasFrame} from '@glimpse/catalog';
import {buildPatch, buildSurface, createFixtureHost, datasetFixture, installLayout, pendingDataset} from '../harness.tsx';
import {Crumbs} from '../../src/components/code/codekit/lines.tsx';
import {flushReports, renderStub} from './stub.tsx';

const CHURN = `/ds/${datasetKey(parseRef('git.churn'))}`;
const page = (body: string) => `root=Page('T',[a])\na=${body}`;
/** A stub view written the way a data-bound component is: dataset state through the gate. */
const Gated: GlView<any> = ({id, props}) => {
  const state = useDataset<unknown>(props.data);
  return <DataGate state={state} id={`DataTable#${id}`}>{() => <p data-body="">rows</p>}</DataGate>;
};
const drilled = (extra: Partial<Dataset> = {}): Dataset => ({...datasetFixture('git.churn'), drill: {target: 'src/auth/session', up: 'src/auth'}, ...extra});

describe('PathText keeps the file name (D12, F083)', () => {
  it('splits the directory from the name so the stylesheet can cut the directory first, at its start', () => {
    const {container} = render(<PathText file="typescript/renderers/react/src/resolution/generic-binder.ts#L12" />);
    const path = container.querySelector<HTMLElement>('.gl-path')!;
    // the whole location is always the tooltip
    expect(path.title).toBe('typescript/renderers/react/src/resolution/generic-binder.ts#L12');
    const dir = path.querySelector('.gl-path-dir')!;
    // ltr text inside the rtl box that puts the ellipsis on the left
    expect(dir.querySelector('bdi')?.textContent).toBe('typescript/renderers/react/src/resolution/');
    expect(path.querySelector('.gl-path-base')?.textContent).toBe('generic-binder.ts');
    expect([...path.children].map(child => child.className)).toEqual(['gl-path-dir', 'gl-path-base', 'gl-path-line', 'gl-path-ext']);
  });

  it('drops whole leading directories before it cuts inside one (D17)', () => {
    const dir = 'typescript/renderers/react/src/resolution/';
    expect(dropDirs(dir, 60)).toBe(0);
    // room for `…/` and the last three directories: src/resolution/ needs 15, react/ 6 more
    expect(dropDirs(dir, 23)).toBe(2);
    expect(dropDirs(dir, 22)).toBe(3);
    // not even the last directory fits beside `…/`: all of them go (`…/generic-binder.ts`), none is cut inside
    expect(dropDirs(dir, 13)).toBe(4);
    expect(dropDirs(dir, 12)).toBe(5);
    // no room even for `…/`: the stylesheet cuts what is there
    expect(dropDirs(dir, 1)).toBe(0);
    // in a box with room for 23 characters of the 42 the directory has, it shows `…/react/src/resolution/` (the box
    // has a pixel to spare: an exact fit counts one character less, see fit.test.tsx)
    const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? (this.textContent?.length ?? 0) * 7 : 0;
    });
    const room = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? Math.min(23 * 7 + 1, (this.textContent?.length ?? 0) * 7) : 0;
    });
    const {container} = render(<PathText file={`${dir}generic-binder.ts#L12`} />);
    widths.mockRestore();
    room.mockRestore();
    const path = container.querySelector<HTMLElement>('.gl-path')!;
    expect(path.querySelector('.gl-path-dir')?.textContent).toBe('…/react/src/resolution/');
    expect(path.querySelector('.gl-path-dir')?.getAttribute('data-dropped')).toBe('2');
    expect(path.querySelector('.gl-path-base')?.textContent).toBe('generic-binder.ts');
    // the whole location stays the tooltip
    expect(path.title).toBe(`${dir}generic-binder.ts#L12`);
  });

  // Decision D17: in a table, a path measured before the table knew its width was never measured again when its
  // column narrowed (the plate kept its width), so 'dart/a2ui_core/…' was cut inside 'dart/'. It follows its cell.
  it('a path re-measures when its table cell changes width, not only its plate', () => {
    const plate = document.createElement('div');
    plate.className = 'gl-cell';
    plate.innerHTML = '<div role="grid"><div role="row"><div role="gridcell"><span class="gl-path"><span class="gl-path-dir">a/</span></span></div></div></div><p><span class="gl-path-dir">b/</span></p>';
    document.body.append(plate);
    expect(widthBoxOf(plate.querySelector('[role="gridcell"] .gl-path-dir'))).toBe(plate.querySelector('[role="gridcell"]'));
    expect(widthBoxOf(plate.querySelector('p .gl-path-dir'))).toBe(plate);
    expect(widthBoxOf(null)).toBe(document.documentElement);
    plate.remove();
  });

  // Decision D17: 'dart/a2ui_core/lib/src/core/' measured 202 px in a 201 px box, was taken as fitting, and the
  // stylesheet's ellipsis then cut it inside 'dart/'. One pixel over is over.
  it('drops a directory when the path is one pixel too wide', () => {
    const dir = 'dart/a2ui_core/lib/src/core/';
    const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? (this.textContent === dir ? 202 : (this.textContent?.length ?? 0) * 7) : 0;
    });
    const room = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? Math.min(201, (this.textContent?.length ?? 0) * 7) : 0;
    });
    const {container} = render(<PathText file={`${dir}catalog.dart`} />);
    widths.mockRestore();
    room.mockRestore();
    expect(container.querySelector('.gl-path-dir')?.textContent).toBe('…/a2ui_core/lib/src/core/');
  });

  // Decision D17: the code views' header (CodeView, SymbolOutline, DiffView) cut 'typescript/core/web_…' inside a
  // directory; it now gives way the same way as PathText.
  it('the code header crumbs drop whole leading directories before cutting one', () => {
    const dir = 'typescript/core/web_core/src/processing/';
    const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? (this.textContent?.length ?? 0) * 7 : 0;
    });
    const room = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? Math.min(20 * 7, (this.textContent?.length ?? 0) * 7) : 0;
    });
    const {container} = render(<Crumbs path={`${dir}message-processor.ts`} />);
    widths.mockRestore();
    room.mockRestore();
    const crumbs = container.querySelector<HTMLElement>('[data-gl-path]')!;
    expect(crumbs.querySelector('.gl-path-dir')?.textContent).toBe('…/src/processing/');
    expect(crumbs.textContent).toBe('…/src/processing/message-processor.ts');
    expect(crumbs.title).toBe(`${dir}message-processor.ts`);
  });

  // Round 4 (integrator list): with every directory dropped, the `…/` box could still shrink to nothing, so a cell
  // showed './generic-binder.test.ts' or 'message-processor.test…' with no lead at all. A long name now keeps its end.
  it('a long file name is cut in its middle, keeping the word before its extension and the extension', () => {
    expect(nameTail('message-processor.test.ts')).toBe('message-processor.'.length);
    expect(nameTail('contact_form_example_test.json')).toBe('contact_form_example_'.length);
    expect(nameTail('AccountsPanelReport.tsx')).toBe('AccountsPanelRep'.length);
    expect(nameTail('Makefile.in.longer_than')).toBeGreaterThan(3);
    // short names are never split
    expect(nameTail('CHANGELOG.md')).toBe(-1);
    const {container} = render(<PathText file="web/core/src/processing/message-processor.test.ts" />);
    const base = container.querySelector('.gl-path-base')!;
    expect(base.textContent).toBe('message-processor.test.ts');
    expect(base.hasAttribute('data-split')).toBe(true);
    expect(base.querySelector('.gl-path-head')?.textContent).toBe('message-processor.');
    expect(base.querySelector('.gl-path-tail')?.textContent).toBe('test.ts');
    // a label (a tree node's name) is never split
    const {container: label} = render(<PathText file="src/a/very_long_name_of_a_node.ts" label="very_long_name_of_a_node.ts" />);
    expect(label.querySelector('.gl-path-base')?.hasAttribute('data-split')).toBe(false);
  });

  it('keeps `…/` once every directory is dropped, however narrow the cell', () => {
    const dir = 'web/core/src/resolution/';
    const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? (this.textContent?.length ?? 0) * 7 : 0;
    });
    // the name leaves the directory the 2.5ch minimum: room for `…/` and nothing more
    const room = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gl-path-dir') ? Math.min(18, (this.textContent?.length ?? 0) * 7) : 0;
    });
    const {container} = render(<PathText file={`${dir}generic-binder.test.ts`} />);
    widths.mockRestore();
    room.mockRestore();
    const lead = container.querySelector('.gl-path-dir')!;
    expect(lead.textContent).toBe('…/');
    expect(lead.getAttribute('data-dropped')).toBe('4');
  });

  it('splitPath and elidePath never give up the basename', () => {
    expect(splitPath('src/a/b.ts')).toEqual({dir: 'src/a/', base: 'b.ts'});
    expect(splitPath('Makefile')).toEqual({dir: '', base: 'Makefile'});
    expect(splitPath('src/auth/')).toEqual({dir: 'src/', base: 'auth/'});
    expect(splitPath('')).toEqual({dir: '', base: ''});
    const long = 'typescript/core/web_core/src/resolution/generic-binder.ts';
    expect(elidePath(long, 80)).toBe(long);
    // cut on a segment boundary when one fits
    expect(elidePath(long, 30)).toBe('…/resolution/generic-binder.ts');
    expect(elidePath(long, 30).length).toBeLessThanOrEqual(30);
    expect(elidePath(long, 22)).toBe('…/generic-binder.ts');
    // no room for any directory: the name alone
    expect(elidePath(long, 18)).toBe('generic-binder.ts');
    // a name longer than the room is cut in the middle, so its extension survives
    expect(elidePath('a/very-long-generated-component-name.module.css', 20)).toBe('very-long-gen…le.css');
    expect(elidePath('a/very-long-generated-component-name.module.css', 20).length).toBeLessThanOrEqual(20);
    for (const max of [8, 12, 16, 24, 40]) expect(elidePath(long, max).length).toBeLessThanOrEqual(max);
  });
});

describe('plate header (D11, F002)', () => {
  const Table: GlView<any> = () => (
    <>
      <PlateAside><input aria-label="Filter" /><span data-note="">27 files · 76 edges · 3 in cycles</span></PlateAside>
      <p>body</p>
    </>
  );

  it('keeps the frame to header, body and caption, with the aside inside the header', () => {
    const view = renderStub(page("DataTable('git.churn',title='Imports and importers',note='Caption.')"), {DataTable: Table});
    const frame = view.cell('a').querySelector<HTMLElement>(':scope > .gl-frame')!;
    expect([...frame.children].map(child => child.className.split(' ')[0])).toEqual(['gl-frame-head', 'gl-frame-body', 'gl-frame-note']);
    const head = frame.querySelector<HTMLElement>('.gl-frame-head')!;
    // title first, then the aside: the stylesheet wraps the aside to a second row when the two do not fit
    expect([...head.children].map(child => child.className.split(' ')[0]).slice(0, 2)).toEqual(['gl-frame-title', 'gl-frame-aside']);
    expect(head.querySelector('.gl-frame-aside input')).not.toBeNull();
  });

  it('gives header text that is cut its full text as a tooltip, and takes it back when it fits again', () => {
    const view = renderStub(page("DataTable('git.churn',title='Imports and importers')"), {DataTable: Table});
    const head = view.cell('a').querySelector<HTMLElement>('.gl-frame-head')!;
    const note = head.querySelector<HTMLElement>('[data-note]')!;
    const title = head.querySelector<HTMLElement>('.gl-frame-title')!;
    const cut = (element: HTMLElement, scrollWidth: number, clientWidth: number) => {
      Object.defineProperty(element, 'scrollWidth', {configurable: true, value: scrollWidth});
      Object.defineProperty(element, 'clientWidth', {configurable: true, value: clientWidth});
    };
    cut(note, 240, 90);
    fireEvent.pointerOver(note);
    expect(note.title).toBe('27 files · 76 edges · 3 in cycles');
    cut(note, 240, 240);
    fireEvent.pointerOver(note);
    expect(note.hasAttribute('title')).toBe(false);
    cut(title, 180, 60);
    fireEvent.pointerOver(title);
    expect(title.title).toBe('Imports and importers');
    // a tooltip the view set itself is left alone
    note.title = 'mine';
    cut(note, 240, 90);
    fireEvent.pointerOver(note);
    expect(note.title).toBe('mine');
  });

  it('the marginal note always carries its full text as the tooltip', () => {
    const cutData = {...datasetFixture('git.churn'), truncated: {total: 419, returned: 50, strategy: 'topN' as const, by: 'score'}};
    const view = renderStub(page("DataTable('git.churn',title='Hotspots')"), {DataTable: Gated}, {datasets: 'ready'});
    view.setData(CHURN, cutData);
    const note = view.cell('a').querySelector<HTMLElement>('.gl-frame-head [data-gl-marginal]')!;
    expect(note.title).toBe('showing 50 of 419 · top by score');
  });

  it('every titled plate collapses from its header: double-click, Enter or Space; the body stays mounted (F029)', () => {
    const view = renderStub(page("DataTable('git.churn',title='Churn',size='m')"), {DataTable: Table});
    const frame = view.cell('a').querySelector<HTMLElement>('.gl-frame')!;
    const head = frame.querySelector<HTMLElement>('.gl-frame-head')!;
    // an open component plate holds nothing in its header that the view did not put there
    expect(head.querySelector('.gl-frame-toggle')).toBeNull();
    expect(head.tabIndex).toBe(0);
    fireEvent.doubleClick(head);
    expect(frame.hasAttribute('data-collapsed')).toBe(true);
    const toggle = head.querySelector<HTMLElement>('.gl-frame-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(frame.querySelector('.gl-frame-body')!.id);
    // one tab stop per plate: the header takes the keys, the button is for the pointer
    expect(toggle.tabIndex).toBe(-1);
    expect(within(frame).getByText('body')).toBeTruthy();
    fireEvent.click(toggle);
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
    fireEvent.keyDown(head, {key: 'Enter'});
    expect(frame.hasAttribute('data-collapsed')).toBe(true);
    fireEvent.keyDown(head, {key: ' '});
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
    // keys typed in a header control, and a double-click on one, are not the plate's
    const input = head.querySelector('input')!;
    fireEvent.keyDown(input, {key: 'Enter'});
    fireEvent.doubleClick(input);
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
  });
});

describe('scope crumb: the way back from a drill (D1, F074, F017, F018)', () => {
  it('shows nothing while the dataset is not drilled', () => {
    const view = renderStub(page("DataTable('git.churn',title='Churn')"), {DataTable: Gated}, {datasets: 'ready'});
    expect(view.cell('a').querySelector('[data-gl-scope]')).toBeNull();
    expect(view.cell('a').querySelector('.gl-frame-scope')?.childElementCount).toBe(0);
  });

  it('shows the scope, one level up and back to the whole view, in the header of the plate', () => {
    const view = renderStub(page("DataTable('git.churn',title='Churn')"), {DataTable: Gated}, {datasets: 'ready'});
    view.setData(CHURN, drilled());
    const row = view.cell('a').querySelector<HTMLElement>('.gl-frame-head > .gl-frame-scope')!;
    expect(row.querySelector('[data-gl-scope]')?.textContent).toBe('src/auth/session');
    expect(row.querySelector('[data-gl-scope]')?.getAttribute('title')).toBe('src/auth/session');
    const up = row.querySelector<HTMLButtonElement>('[data-gl-scope-up]')!;
    const reset = row.querySelector<HTMLButtonElement>('[data-gl-scope-reset]')!;
    // real buttons, in the tab order
    expect([up.tagName, up.type, up.tabIndex, reset.tagName, reset.tabIndex]).toEqual(['BUTTON', 'button', 0, 'BUTTON', 0]);
    expect(up.getAttribute('aria-label')).toBe('Up one level, to src/auth');
    fireEvent.click(up);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', sourceComponentId: 'a', context: {ds: datasetKey(parseRef('git.churn')), target: 'src/auth'}});
    fireEvent.click(reset);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', sourceComponentId: 'a', context: {ds: datasetKey(parseRef('git.churn')), target: ''}});
    // the content is still there
    expect(view.cell('a').querySelector('[data-body]')).not.toBeNull();
  });

  it('offers only "full view" when one level up is the scope the spec asked for', () => {
    const view = renderStub(page("DataTable('git.churn',title='Churn')"), {DataTable: Gated}, {datasets: 'ready'});
    view.setData(CHURN, drilled({drill: {target: 'src/auth', up: ''}}));
    const row = view.cell('a').querySelector<HTMLElement>('.gl-frame-scope')!;
    expect(row.querySelector('[data-gl-scope-up]')).toBeNull();
    expect(row.querySelector('[data-gl-scope-reset]')).not.toBeNull();
  });

  it('stays while the drilled dataset is pending, empty or failed, so there is always a way out', () => {
    const view = renderStub(page("DataTable('git.churn',title='Churn')"), {DataTable: Gated}, {datasets: 'ready'});
    const scope = () => view.cell('a').querySelector('[data-gl-scope]')?.textContent;
    const state = () => view.cell('a').querySelector('[data-gl-state]')?.getAttribute('data-gl-state');
    view.setData(CHURN, {...pendingDataset('git.churn'), drill: {target: 'src/empty', up: 'src'}});
    expect([state(), scope()]).toEqual(['drafting', 'src/empty']);
    view.setData(CHURN, drilled({data: [], drill: {target: 'src/empty', up: 'src'}}));
    expect([state(), scope()]).toEqual(['empty', 'src/empty']);
    view.setData(CHURN, {$ds: datasetKey(parseRef('git.churn')), kind: 'rows' as DatasetKind, status: 'error', source: 'git.churn', error: {code: 'E_TARGET', message: 'no such directory'}, drill: {target: 'nope', up: ''}});
    expect([state(), scope()]).toEqual(['redline', 'nope']);
    fireEvent.click(view.cell('a').querySelector('[data-gl-scope-reset]')!);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {target: ''}});
  });

  it('hands the keyboard focus on when the control that had it goes away: Up -> Full view -> plate header, or the cell (V063)', () => {
    const view = renderStub(`root=Page('T',[a,b])\na=DataTable('git.churn',title='Churn')\nb=DataTable('git.churn')`, {DataTable: Gated}, {datasets: 'ready'});
    view.setData(CHURN, drilled({drill: {target: '.agents/skills/x', up: '.agents/skills'}}));
    const row = () => view.cell('a').querySelector<HTMLElement>('.gl-frame-scope')!;
    // Up, and there is still a level above: the focus stays on Up
    row().querySelector<HTMLButtonElement>('[data-gl-scope-up]')!.focus();
    fireEvent.click(row().querySelector('[data-gl-scope-up]')!);
    view.setData(CHURN, drilled({drill: {target: '.agents/skills', up: '.agents'}}));
    expect(document.activeElement?.hasAttribute('data-gl-scope-up')).toBe(true);
    // Up to the last level: Up goes away, Full view takes the focus
    fireEvent.click(row().querySelector('[data-gl-scope-up]')!);
    view.setData(CHURN, drilled({drill: {target: '.agents', up: ''}}));
    expect(row().querySelector('[data-gl-scope-up]')).toBeNull();
    expect(document.activeElement).toBe(row().querySelector('[data-gl-scope-reset]'));
    // Full view: the plate header
    fireEvent.click(row().querySelector('[data-gl-scope-reset]')!);
    view.setData(CHURN, datasetFixture('git.churn'));
    expect(document.activeElement).toBe(view.cell('a').querySelector(':scope > .gl-frame > .gl-frame-head'));
    // without a plate there is no header: the cell itself takes the focus instead of <body>
    view.setData(CHURN, drilled({drill: {target: 'src/auth', up: 'src'}}));
    const bare = view.cell('b');
    bare.querySelector<HTMLButtonElement>('[data-gl-scope-up]')!.focus();
    fireEvent.click(bare.querySelector('[data-gl-scope-up]')!);
    view.setData(CHURN, datasetFixture('git.churn'));
    expect(document.activeElement).toBe(bare);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('renders in place, above the content, for a component without a plate, and for every component bound to the dataset', () => {
    const view = renderStub(`root=Page('T',[a,b])\na=DataTable('git.churn')\nb=DataTable('git.churn',title='Same data')`, {DataTable: Gated}, {datasets: 'ready'});
    view.setData(CHURN, drilled());
    const bare = view.cell('a').querySelector<HTMLElement>(':scope > .gl-body')!;
    // first the scope row, then whatever the view itself renders
    expect([...bare.children].map(child => child.className || child.tagName).filter(name => name !== 'gl-aside')).toEqual(['gl-scope', 'P']);
    expect(bare.querySelector('.gl-scope [data-gl-scope]')?.textContent).toBe('src/auth/session');
    // the plate bound to the same dataset says so too: a drill never re-scopes a component silently
    expect(view.cell('b').querySelector('.gl-frame-scope [data-gl-scope]')?.textContent).toBe('src/auth/session');
    fireEvent.click(view.cell('b').querySelector('[data-gl-scope-reset]')!);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', sourceComponentId: 'b'});
  });
});

describe('what a component draws is its state for the host (D3, D14, F032, V060-V062)', () => {
  /** A Gated view that also follows the selection, so writing /ui/sel really renders it again (V066). */
  let gatedRenders = 0;
  const Following: GlView<any> = ({id, props}) => {
    gatedRenders++;
    useSelection(id);
    const state = useDataset<unknown>(props.data);
    return <DataGate state={state} id={`DataTable#${id}`}>{() => <p data-body="">rows</p>}</DataGate>;
  };
  const codes = (view: ReturnType<typeof renderStub>, id: string) => view.states.filter(state => state.componentId === id).map(state => state.code);

  it('classifies: W_EMPTY for nothing to show and no reason, I_EMPTY for a truthful empty answer, the redline code, nothing while pending', async () => {
    const view = renderStub(`root=Page('T',[a,b,c])\na=DataTable('git.churn',title='Churn')\nb=DataTable('git.log')\nc=DataTable('git.authors')`, {DataTable: Gated}, {datasets: 'ready'});
    await flushReports();
    // every component says it draws
    expect(view.reports).toEqual([]);
    expect(codes(view, 'a')).toEqual(['OK']);
    expect(codes(view, 'root')).toEqual(['OK']);
    view.setData(CHURN, {...datasetFixture('git.churn'), data: []});
    await flushReports();
    expect(view.reports).toEqual([{code: 'W_EMPTY', message: 'DataTable#a: no data from git.churn', surfaceId: 'test', componentId: 'a'}]);
    // the source says why it is empty: a truthful answer, not something for the model to fix
    view.setData(CHURN, {...datasetFixture('git.churn'), data: [], note: 'no import cycles'});
    await flushReports();
    expect(view.reports.at(-1)).toEqual({code: 'I_EMPTY', message: 'DataTable#a: no import cycles (git.churn)', surfaceId: 'test', componentId: 'a'});
    view.setData(`/ds/${datasetKey(parseRef('git.log'))}`, {$ds: datasetKey(parseRef('git.log')), kind: 'rows', status: 'error', source: 'git.log', error: {code: 'E_NO_GIT', message: 'not a git repository'}});
    await flushReports();
    expect(view.reports.at(-1)).toEqual({code: 'E_NO_GIT', message: 'DataTable#b: not a git repository', surfaceId: 'test', componentId: 'b'});
    // a pending dataset is not a state worth telling, and it does not withdraw anything either
    const before = view.states.length;
    view.setData(`/ds/${datasetKey(parseRef('git.authors'))}`, pendingDataset('git.authors'));
    await flushReports();
    expect(view.states).toHaveLength(before);
    // inline data that is empty is the spec's own: W_EMPTY
    const inline = renderStub(`$/rows=[]\n${page('DataTable($/rows)')}`, {DataTable: Gated});
    await flushReports();
    expect(inline.reports).toEqual([{code: 'W_EMPTY', message: 'DataTable#a: no items', surfaceId: 'test', componentId: 'a'}]);
  });

  it('reports again when the state changes, withdraws it with OK, and says nothing for the same state rendered again', async () => {
    const view = renderStub(page("DataTable('git.churn')"), {DataTable: Following}, {datasets: 'ready'});
    view.setData(CHURN, {...datasetFixture('git.churn'), data: []});
    await flushReports();
    expect(codes(view, 'a')).toEqual(['W_EMPTY']);
    // a real re-render with the same state: the view follows the selection
    const renders = gatedRenders;
    view.setData('/ui/sel', {type: 'file', id: 'x', path: 'x'});
    await flushReports();
    expect(gatedRenders).toBeGreaterThan(renders);
    expect(codes(view, 'a')).toEqual(['W_EMPTY']);
    view.setData(CHURN, {...datasetFixture('git.churn'), data: [], warnings: ['no file changed in the last 90 days']});
    await flushReports();
    expect(view.reports.map(report => report.message)).toEqual(['DataTable#a: no data from git.churn', 'DataTable#a: no file changed in the last 90 days (git.churn)']);
    // the data arrives: the component draws, and says so
    view.setData(CHURN, datasetFixture('git.churn'));
    await flushReports();
    expect(codes(view, 'a')).toEqual(['W_EMPTY', 'I_EMPTY', 'OK']);
  });

  it('says its state again, OK included, each time an update names the component, changed or not (V051, V061)', async () => {
    const spec = `$/rows=[]\nroot=Page('T',[a,b])\na=DataTable($/rows,title='First')\nb=Text('fine')`;
    const view = renderStub(spec, {DataTable: Gated});
    await flushReports();
    expect(codes(view, 'a')).toEqual(['W_EMPTY']);
    // an in-place "fix" that leaves it empty
    view.send(buildPatch('test', buildSurface('test', spec), `a=DataTable($/rows,title='Second')`));
    await flushReports();
    expect(codes(view, 'a')).toEqual(['W_EMPTY', 'W_EMPTY']);
    // the same definition again
    view.send(buildPatch('test', buildSurface('test', spec), `a=DataTable($/rows,title='Second')`));
    await flushReports();
    expect(codes(view, 'a')).toEqual(['W_EMPTY', 'W_EMPTY', 'W_EMPTY']);
    // a component that draws says OK when it is named again; one that is not named says nothing
    view.send(buildPatch('test', buildSurface('test', spec), `b=Text('still fine')`));
    await flushReports();
    expect(codes(view, 'b')).toEqual(['OK', 'OK']);
    expect(codes(view, 'a')).toHaveLength(3);
  });

  it('a view that throws is reported as E_RENDER, and a state a view renders itself is reported for its component: the most severe one', async () => {
    const Boom: GlView<any> = () => { throw new Error('view bug'); };
    const Own: GlView<any> = ({id}) => <><Empty message="no file selected" /><Redline code="E_SHAPE" id={`CodeView#${id}`} message="expected text" /></>;
    const Waiting: GlView<any> = () => <Empty message="no file selected" code="I_WAITING" />;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = renderStub(`root=Page('T',[a,b,c])\na=DataTable('git.churn')\nb=CodeView()\nc=SymbolOutline()`, {DataTable: Boom, CodeView: Own, SymbolOutline: Waiting});
    spy.mockRestore();
    await flushReports();
    expect(view.reports).toContainEqual({code: 'E_RENDER', message: 'DataTable#a: view bug', surfaceId: 'test', componentId: 'a'});
    // one state per component: the redline wins over the empty line beside it
    expect(view.reports.filter(report => report.componentId === 'b')).toEqual([{code: 'E_SHAPE', message: 'CodeView#b: expected text', surfaceId: 'test', componentId: 'b'}]);
    // a view that waits for a selection says so with an I_ code
    expect(view.reports).toContainEqual({code: 'I_WAITING', message: 'SymbolOutline#c: no file selected', surfaceId: 'test', componentId: 'c'});
  });

  it('a part of a component never speaks for it: <Subpart>, part, and every borrowed view (V062)', async () => {
    const Rich: GlView<any> = () => <Empty message="no code" />;
    const Borrowed = borrowView(async () => ({views: {CodeBlock: Rich}}), 'CodeBlock', () => null);
    const Prose: GlView<any> = ({id}) => <><p>Run the generator first.</p><Borrowed id={id} props={{}} child={() => null} /></>;
    const Diff: GlView<any> = () => (
      <>
        <ul><li>a.ts</li><li>logo.png</li></ul>
        <Empty message="logo.png is a binary file" part />
        <Subpart><Redline code="E_DIFF" id="DiffView#d" message="logo.png: unreadable" /><Drafting label="reading a.ts" /></Subpart>
      </>
    );
    const view = renderStub(`root=Page('T',[m,d])\nm=Markdown('x')\nd=DiffView()`, {Markdown: Prose, DiffView: Diff});
    await view.settle();
    expect(view.cell('m').querySelector('[data-gl-state="empty"]')?.textContent).toBe('no code');
    expect(view.reports).toEqual([]);
    expect(codes(view, 'm')).toEqual(['OK']);
    expect(codes(view, 'd')).toEqual(['OK']);
  });

  it('a view that draws but could not do what the spec asked names it with useReportState, and withdraws it', async () => {
    const Focus: GlView<any> = ({props}) => {
      useReportState(props.data === 'zzz' ? 'W_FOCUS' : undefined, `focus "${String(props.data)}" matches no node`);
      return <svg data-drawn="" />;
    };
    const view = renderStub(`$/f='zzz'\n${page('Graph($/f)')}`, {Graph: Focus});
    await flushReports();
    expect(view.reports).toEqual([{code: 'W_FOCUS', message: 'Graph#a: focus "zzz" matches no node', surfaceId: 'test', componentId: 'a'}]);
    view.setData('/f', 'src');
    await flushReports();
    expect(codes(view, 'a')).toEqual(['W_FOCUS', 'OK']);
  });

  it('reportCode keeps a code the host accepts and gives an unclassed one the redline class', () => {
    expect(['OK', 'W_EMPTY', 'I_WAITING', 'E_SHAPE', 'E', 'ENOENT', 'e_shape', 'E-BAD code'].map(reportCode)).toEqual(['OK', 'W_EMPTY', 'I_WAITING', 'E_SHAPE', 'E_E', 'E_ENOENT', 'E_SHAPE', 'E_BAD_CODE']);
    expect(reportCode(`W_${'X'.repeat(60)}`)).toHaveLength(32);
  });

  it('says nothing outside a component and where nobody listens', async () => {
    const reports: unknown[] = [];
    const {unmount} = render(<KitProvider host={createFixtureHost()} report={report => void reports.push(report)}><Empty message="no views yet" /><Redline code="E" id="Surface#x" message="m" /></KitProvider>);
    await flushReports();
    expect(reports).toEqual([]);
    unmount();
    expect(() => render(<Empty message="alone" />)).not.toThrow();
  });
});

describe('empty states say why (F008)', () => {
  const Probe: GlView<any> = ({props}) => {
    const state = useDataset<unknown>(props.data);
    return <DataGate state={state} id="DataTable#a">{() => null}</DataGate>;
  };
  it('uses the reason the dataset gives (its note, else its first warning) and names the source on a second line', () => {
    const view = renderStub(page("DataTable('git.coupling',title='Changes together')"), {DataTable: Probe}, {datasets: 'ready'});
    const path = `/ds/${datasetKey(parseRef('git.coupling'))}`;
    const lines = () => [...view.cell('a').querySelectorAll('[data-gl-state="empty"] > span')].map(span => [span.className, span.textContent]);
    view.setData(path, {...datasetFixture('git.coupling'), data: []});
    expect(lines()).toEqual([['gl-state-line', 'no data from git.coupling']]);
    view.setData(path, {...datasetFixture('git.coupling'), data: [], warnings: ['', 'no pair shares 3 commits\nsecond line']});
    expect(lines()).toEqual([['gl-state-line', 'no pair shares 3 commits'], ['gl-state-detail', 'git.coupling']]);
    view.setData(path, {...datasetFixture('git.coupling'), data: [], note: '3 commits since 2025-11-20', warnings: ['ignored']});
    expect(lines()[0]).toEqual(['gl-state-line', '3 commits since 2025-11-20']);
  });

  it('knows a source ref the server did not expand without carrying the source table', () => {
    const {result} = (() => {
      const seen: Array<{input: string; code: string | undefined}> = [];
      const Refs = () => {
        for (const input of [...SOURCES.map(source => source.name), ...SOURCES.map(source => `${source.name} src top=3`), 'example.com', 'v1.2', 'hello world', 'a.b']) {
          // biome-ignore lint/correctness/useHookAtTopLevel: a fixed list, rendered once
          seen.push({input, code: useDataset(input).code});
        }
        return null;
      };
      render(<Refs />);
      return {result: seen};
    })();
    for (const {input, code} of result) {
      const isRef = SOURCES.some(source => input === source.name || input.startsWith(`${source.name} `));
      expect([input, code]).toEqual([input, isRef ? 'E_UNEXPANDED_REF' : undefined]);
    }
  });
});

describe('category colours without a session slot (D6, F006)', () => {
  it('assignSlots: session slots first, then the lowest free ink in order of first appearance, grey only beyond eight', () => {
    const slots = assignSlots(['Go', 'TypeScript', 'SQL', 'CSS'], {TypeScript: 1, CSS: 4});
    expect(Object.fromEntries(slots)).toEqual({TypeScript: 1, CSS: 4, Go: 2, SQL: 3});
    // no table at all (package ecosystems): every category gets its own ink
    expect([...assignSlots(['swiftpm', 'pypi', 'npm', 'pub']).values()]).toEqual([1, 2, 3, 4]);
    // a ninth category is "other", and so is anything called other
    const many = assignSlots(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'Other', 'other (7)']);
    expect(Object.fromEntries(many)).toEqual({a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 0, Other: 0, 'other (7)': 0});
    expect(['other', 'Other', '(other)', 'other (12)', 'another', 'others'].map(isOtherKey)).toEqual([true, true, true, true, false, false]);
    // garbage in the table is ignored, duplicates are one category
    expect(Object.fromEntries(assignSlots(['x', 'y', 'x'], {x: 9, y: 2.5, __proto__: 1} as never))).toEqual({x: 1, y: 2});
    expect(catVar(many.get('i')!)).toBe('var(--gl-cat-other)');
  });

  it('assignSlots: a key keeps the fallback ink it was given while that ink is free', () => {
    const first = assignSlots(['b', 'c']);
    expect(Object.fromEntries(first)).toEqual({b: 1, c: 2});
    // `a` arrives in front: it takes the next free ink instead of pushing the others along
    expect(Object.fromEntries(assignSlots(['a', 'b', 'c'], undefined, first))).toEqual({b: 1, c: 2, a: 3});
    // a session slot wins over what was held
    expect(Object.fromEntries(assignSlots(['a', 'b', 'c'], {a: 1}, first))).toEqual({a: 1, c: 2, b: 3});
  });

  it('useCatSlots: stable for the life of the component, across re-renders, re-sorts and new rows', () => {
    const colors: Record<string, string>[] = [];
    const Legend: GlView<any> = ({props}) => {
      const keys: string[] = Array.isArray(props.data) ? props.data : [];
      const cat = useCatSlots(['lang', 'module'], keys);
      colors.push(Object.fromEntries(keys.map(key => [key, cat.color(key)])));
      return <ul>{keys.map(key => <li key={key} style={{color: cat.color(key)}}>{key}</li>)}</ul>;
    };
    const view = renderStub(`$/k=['Go','TypeScript','SQL']\n${page('Chips($/k)')}`, {Chips: Legend});
    view.setData('/meta/slots', {lang: {TypeScript: 1}, module: {}, author: {}});
    expect(colors.at(-1)).toEqual({TypeScript: 'var(--gl-cat-1)', Go: 'var(--gl-cat-2)', SQL: 'var(--gl-cat-3)'});
    view.setData('/k', ['SQL', 'Rust', 'TypeScript', 'Go']);
    expect(colors.at(-1)).toEqual({TypeScript: 'var(--gl-cat-1)', Go: 'var(--gl-cat-2)', SQL: 'var(--gl-cat-3)', Rust: 'var(--gl-cat-4)'});
    // Go scrolls out of sight and comes back: same ink
    view.setData('/k', ['SQL', 'Rust']);
    view.setData('/k', ['Kotlin', 'SQL', 'Rust', 'Go']);
    expect(colors.at(-1)).toEqual({SQL: 'var(--gl-cat-3)', Rust: 'var(--gl-cat-4)', Go: 'var(--gl-cat-2)', Kotlin: 'var(--gl-cat-1)'});
  });
});

describe('useRows (F079)', () => {
  const envelope = (extra: Partial<Dataset> = {}): Dataset => ({$ds: 'k', kind: 'rows', status: 'ready', source: 'git.churn', data: [{a: 1}], total: 1000, pageable: true, ...extra});
  function mount(rows: (q: RowsQuery, signal?: AbortSignal) => Promise<RowsPage>) {
    const renders: Array<{ds: string | undefined; page: unknown; loading: boolean; error: string | undefined}> = [];
    const Probe: GlView<any> = ({id, props}) => {
      // follows the selection, so a write to /ui/sel really renders it again (V066)
      useSelection(id);
      const state = useRows(props.data, {offset: 0, limit: 10});
      renders.push({ds: props.data?.$ds, page: state.page?.rows[0]?.v ?? null, loading: state.loading, error: state.error});
      return null;
    };
    const view = renderStub(page("DataTable('git.churn')"), {DataTable: Probe}, {}, {rows});
    view.setData(CHURN, envelope());
    return {view, renders, last: () => renders.at(-1)!};
  }
  const answer = (v: string): RowsPage => ({rows: [{v}], total: 1, offset: 0});

  it('fetches again when the envelope is replaced under the same key, and keeps the old page up meanwhile', async () => {
    let calls = 0;
    const {view, renders, last} = mount(async () => answer(`fetch#${++calls}`));
    await view.settle();
    expect([calls, last().page, last().loading]).toEqual([1, 'fetch#1', false]);
    // what the server publishes after a refresh or a drill: a new envelope, same key, same revision
    view.setData(CHURN, envelope({source: 'git.churn src', total: 20}));
    expect(last()).toMatchObject({page: 'fetch#1', loading: true});
    await view.settle();
    expect([calls, last().page, last().loading]).toEqual([2, 'fetch#2', false]);
    // something unrelated changing renders the view again but does not fetch
    const before = renders.length;
    view.setData('/ui/sel', {type: 'file', id: 'x', path: 'x'});
    await view.settle();
    expect(renders.length).toBeGreaterThan(before);
    expect(calls).toBe(2);
  });

  it('drops the answer to a superseded request even when the host ignored the abort signal', async () => {
    const pending: Array<(page: RowsPage) => void> = [];
    const {view, last} = mount(() => new Promise(resolve => void pending.push(resolve)));
    await view.settle();
    view.setData('/meta/rev', 2);
    await view.settle();
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!(answer('NEW')); });
    await act(async () => { pending[0]!(answer('STALE')); });
    await view.settle();
    expect(last()).toMatchObject({page: 'NEW', loading: false});
  });

  it('never returns the page of another dataset, and forgets the page when paging is turned off', async () => {
    const pending: Array<(page: RowsPage) => void> = [];
    const {view, renders, last} = mount(() => new Promise(resolve => void pending.push(resolve)));
    await view.settle();
    await act(async () => { pending[0]!(answer('rows of k')); });
    expect(last()).toMatchObject({ds: 'k', page: 'rows of k', loading: false});
    const before = renders.length;
    view.setData(CHURN, envelope({$ds: 'other', source: 'git.log'}));
    await view.settle();
    for (const seen of renders.slice(before)) expect(seen).toMatchObject({ds: 'other', page: null, loading: true});
    await act(async () => { pending[1]!(answer('rows of other')); });
    expect(last()).toMatchObject({ds: 'other', page: 'rows of other', loading: false});
    view.setData(CHURN, envelope({$ds: 'other', pageable: false}));
    await view.settle();
    expect(last()).toMatchObject({page: null, loading: false});
  });

  it('keeps the page and says what went wrong when a refetch fails', async () => {
    let fail = false;
    const {view, last} = mount(async () => { if (fail) throw new Error('host answered 503'); return answer('ok'); });
    await view.settle();
    fail = true;
    view.setData('/meta/rev', 2);
    await view.settle();
    expect(last()).toEqual({ds: 'k', page: 'ok', loading: false, error: 'host answered 503'});
  });
});

describe('useSize (F080)', () => {
  it('measures an element that mounts after the hook, and goes back to zero when it is gone', async () => {
    installLayout({width: 960, height: 600});
    const seen: number[] = [];
    let show: (value: boolean) => void = () => {};
    function Late() {
      const ref = useRef<HTMLDivElement>(null);
      const [shown, setShown] = useState(false);
      show = setShown;
      const size = useSize(ref);
      seen.push(size.width);
      // the early return every data-bound view has
      if (!shown) return <span>empty</span>;
      return <div ref={ref}>w={size.width}</div>;
    }
    const view = render(<Late />);
    expect(view.container.textContent).toBe('empty');
    act(() => show(true));
    expect(view.container.textContent).toBe('w=960');
    act(() => show(false));
    expect(seen.at(-1)).toBe(0);
  });
});

describe('the error boundary of a component (F078)', () => {
  it('lets go of the error when the props change, so a view comes back once the data that broke it is replaced', async () => {
    let attempts = 0;
    const Fragile: GlView<any> = ({props}) => {
      attempts++;
      if (props.text === 'boom') throw new Error('view bug on this value');
      return <span data-ok="">{String(props.text)}</span>;
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spec = `$/msg='fine'\n${page('Text($/msg)')}`;
    const view = renderStub(spec, {Text: Fragile});
    expect(view.cell('a').querySelector('[data-ok]')?.textContent).toBe('fine');
    view.setData('/msg', 'boom');
    await flushReports();
    expect(view.cell('a').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_RENDER');
    expect(view.reports).toEqual([{code: 'E_RENDER', message: 'Text#a: view bug on this value', surfaceId: 'test', componentId: 'a'}]);
    // something else rendering the cell again does not retry a view whose props are the same (V066: a real re-render,
    // the update names the component and its cell renders once more, which the report again proves)
    const tried = attempts;
    view.send(buildPatch('test', buildSurface('test', spec), page('Text($/msg)').split('\n')[1]!));
    await flushReports();
    expect(view.reports).toHaveLength(2);
    expect(attempts).toBe(tried);
    expect(view.cell('a').querySelector('[data-gl-state="redline"]')).not.toBeNull();
    view.setData('/msg', 'fixed');
    spy.mockRestore();
    await flushReports();
    expect(view.cell('a').querySelector('[data-gl-state="redline"]')).toBeNull();
    expect(view.cell('a').querySelector('[data-ok]')?.textContent).toBe('fixed');
    expect(view.states.at(-1)).toMatchObject({code: 'OK', componentId: 'a'});
  });
});

describe('which components get a plate (F081)', () => {
  it('every non-layout component with a title prop, except the two that draw their own title', () => {
    const framed = [...COMPONENT_BY_NAME.values()].filter(isFrameable).map(def => def.name);
    for (const name of ['KeyValue', 'Steps', 'List', 'DataTable', 'BarChart', 'Graph', 'CodeView', 'SegmentedBar']) expect(framed, name).toContain(name);
    for (const name of ['Callout', 'CodeBlock', 'Plate', 'Page', 'Section', 'FileRef', 'Button', 'Sparkline']) expect(framed, name).not.toContain(name);
    // one rule: the components the docs list with the frame group are the ones the viewer frames
    expect(framed).toEqual([...COMPONENT_BY_NAME.values()].filter(def => hasFrame(def)).map(def => def.name));
  });

  it('KeyValue, Steps and List are framed by the cell: data-framed, the frame as the direct child, no second plate', () => {
    // content/shared/Plate.tsx frames these inside the view through the kit Frame: that call must not draw again
    const Selfframing = (name: string): GlView<any> => ({id, props}) => {
      const def = COMPONENT_BY_NAME.get(name)!;
      return (
        <Frame id={id} def={def as never} title={String(props.title ?? '')} aside={<div className="gl-frame-aside"><span data-count="">2 / 3 done</span></div>}>
          <p data-inner="">{name}</p>
        </Frame>
      );
    };
    const view = renderStub(
      `$/kv={a:1}\n$/steps=[{title:'x'}]\n$/list=[{title:'y'}]\nroot=Page('T',[k,s,l,u])\nk=KeyValue($/kv,title='Facts')\ns=Steps($/steps,title='Plan')\nl=List($/list,title='Todo',note='A note.')\nu=Steps($/steps)`,
      {KeyValue: Selfframing('KeyValue'), Steps: Selfframing('Steps'), List: Selfframing('List')},
    );
    for (const id of ['k', 's', 'l']) {
      const cell = view.cell(id);
      expect(cell.getAttribute('data-framed'), id).toBe('true');
      expect(cell.querySelector(':scope > .gl-frame'), id).not.toBeNull();
      expect(cell.querySelectorAll('.gl-frame'), id).toHaveLength(1);
      expect(cell.querySelector('.gl-frame-body > [data-inner]'), id).not.toBeNull();
      // the header content the view handed to its own Frame lands in the one header
      expect(cell.querySelector('.gl-frame-head .gl-frame-aside [data-count]')?.textContent, id).toBe('2 / 3 done');
      // content plates keep their padding
      expect(cell.querySelector('.gl-frame')!.hasAttribute('data-flush'), id).toBe(false);
    }
    expect(view.cell('l').querySelector('.gl-frame-note')?.textContent).toBe('A note.');
    expect(view.cell('k').querySelector('.gl-frame-note')).toBeNull();
    // without a title implement() draws nothing, and a view that frames itself still can
    expect(view.cell('u').hasAttribute('data-framed')).toBe(false);
    expect(view.cell('u').querySelector(':scope > .gl-body > .gl-frame')).not.toBeNull();
  });

  it('a title of spaces is no title', () => {
    const view = renderStub(`$/t='  '\n${page("BarChart('git.authors',title=$/t)")}`, {});
    expect(view.cell('a').querySelector('.gl-frame')).toBeNull();
  });
});

describe('tooltip ownership (F086)', () => {
  it('goes away with the view that showed it, on scroll and on blur; another view\'s hide() leaves it alone', () => {
    let first: ReturnType<typeof useTooltip> | undefined;
    let second: ReturnType<typeof useTooltip> | undefined;
    const A = () => { first = useTooltip(); return null; };
    const B = () => { second = useTooltip(); return null; };
    function Host(p: {a: boolean}) {
      return <KitProvider host={createFixtureHost()}>{p.a ? <A /> : null}<B /></KitProvider>;
    }
    const view = render(<Host a />);
    const tip = () => view.container.querySelector('[role="tooltip"]')?.textContent;
    act(() => first!.show('node Tests/*', 10, 10));
    expect(tip()).toBe('node Tests/*');
    // the pointer moved on to B, whose tooltip is up before A's pointer-leave arrives
    act(() => second!.show('from B', 20, 20));
    act(() => first!.hide());
    expect(tip()).toBe('from B');
    act(() => second!.hide());
    expect(tip()).toBeUndefined();
    // the view that showed it is replaced while the pointer rests
    act(() => first!.show('stale', 10, 10));
    view.rerender(<Host a={false} />);
    expect(tip()).toBeUndefined();
    act(() => second!.show('B again', 20, 20));
    fireEvent.scroll(window);
    expect(tip()).toBeUndefined();
    act(() => second!.show('B again', 20, 20));
    fireEvent.blur(window);
    expect(tip()).toBeUndefined();
  });
});

describe('one selection rule (F085)', () => {
  const file = (path: string): EntityRef => ({type: 'file', id: path, path});
  const dir = (path: string): EntityRef => ({type: 'dir', id: path, path});
  it('fileEntity: a file with its lines, a directory for a trailing slash', () => {
    expect(fileEntity('src/a.ts#L3-9')).toEqual({type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 3, endLine: 9});
    expect(fileEntity('src/a.ts')).toEqual({type: 'file', id: 'src/a.ts', path: 'src/a.ts'});
    expect(fileEntity('src/auth/', 'auth')).toEqual({type: 'dir', id: 'src/auth', path: 'src/auth', label: 'auth'});
    // line 0 is not a line, but it is not dropped by truthiness either
    expect(fileEntity('a.ts#L0').line).toBe(0);
  });

  it('matchSelection: exact, within a selected directory, containing the selection', () => {
    expect(matchSelection(null, file('a.ts'))).toBeUndefined();
    expect(matchSelection(file('src/a.ts'), file('src/a.ts'))).toBe('exact');
    // a row or a graph node that stands for the selected file or directory
    expect(matchSelection(file('src/a.ts'), {type: 'row', id: '7', path: 'src/a.ts'})).toBe('exact');
    expect(matchSelection(dir('src/auth'), {type: 'module', id: 'src/auth', path: 'src/auth'})).toBe('exact');
    expect(matchSelection(dir('src/auth'), {type: 'module', id: 'auth', path: 'src/auth/'})).toBe('exact');
    // inside the selected directory, but not a sibling that shares a prefix
    expect(matchSelection(dir('src/auth'), file('src/auth/cache.ts'))).toBe('within');
    expect(matchSelection(dir('src/auth'), dir('src/auth/store'))).toBe('within');
    expect(matchSelection(dir('src/auth'), file('src/authz.ts'))).toBeUndefined();
    expect(matchSelection(dir(''), file('README.md'))).toBe('within');
    // the directory or module the selection is in
    expect(matchSelection(file('src/auth/cache.ts'), dir('src/auth'))).toBe('contains');
    expect(matchSelection(file('src/auth/cache.ts'), {type: 'module', id: 'src', path: 'src'})).toBe('contains');
    expect(matchSelection(file('src/auth/cache.ts'), file('src/auth'))).toBeUndefined();
    // a symbol is narrower than its file
    const symbol: EntityRef = {type: 'symbol', id: 'login', path: 'src/auth/service.ts', line: 9};
    expect(matchSelection(file('src/auth/service.ts'), symbol)).toBe('within');
    expect(matchSelection(symbol, file('src/auth/service.ts'))).toBe('contains');
    expect(matchSelection(symbol, {type: 'symbol', id: 'logout', path: 'src/auth/service.ts'})).toBeUndefined();
    expect(matchSelection(dir('src'), symbol)).toBe('within');
    // people and commits are not places
    expect(matchSelection(dir('src'), {type: 'author', id: 'Mira', path: 'src/a.ts'})).toBeUndefined();
    expect(matchSelection({type: 'commit', id: 'abc', path: 'src'}, file('src/a.ts'))).toBeUndefined();
    expect(matchSelection({type: 'author', id: 'Mira'}, {type: 'author', id: 'Mira'})).toBe('exact');
  });

  // Decision D24: one hub of diagram node ids. The worked cases of the design, on a ticketing page: tables of one
  // schema.sql (each with its own lines) carry node:'PG', a Layers item and a table row name PG, actor G stands for GW.
  describe('links through diagram node ids (D24)', () => {
    const nodePG: EntityRef = {type: 'node', id: 'PG', label: 'Postgres'};
    const orders: EntityRef = {type: 'node', id: 'orders', label: 'orders', path: 'db/schema.sql', line: 10, endLine: 30, nodes: ['PG']};
    const payments: EntityRef = {type: 'node', id: 'payments', label: 'payments', path: 'db/schema.sql', line: 31, endLine: 50, nodes: ['PG']};
    const layersPG = linkedEntity(undefined, ['PG'], {id: 'tiers:Postgres', label: 'Postgres'})!;
    const row: EntityRef = {type: 'row', id: 'rows:System of record', label: 'System of record', nodes: ['PG']};
    const toPG: EntityRef = {type: 'message', id: 'co:5', label: '5. Orders to Postgres: insert', nodes: ['Ord', 'PG']};
    const msg3: EntityRef = {type: 'message', id: 'co:3', label: '3. Gateway to Inventory: hold seats', nodes: ['GW', 'Inv']};
    const msg1: EntityRef = {type: 'message', id: 'co:1', label: '1. User to Gateway: POST /checkout', nodes: ['Client', 'CDN', 'Q', 'GW']};
    const node = (id: string): EntityRef => ({type: 'node', id});
    const actorG = node('GW');
    const schema = file('db/schema.sql');

    it.each<[string, EntityRef, Array<[EntityRef, string | undefined]>]>([
      ['node PG', nodePG, [[nodePG, 'exact'], [layersPG, 'exact'], [orders, 'linked'], [payments, 'linked'], [row, 'linked'], [toPG, 'linked'], [msg3, undefined]]],
      ['table orders', orders, [[orders, 'exact'], [nodePG, 'linked'], [layersPG, 'linked'], [row, 'linked'], [payments, undefined], [toPG, undefined]]],
      ['the row', row, [[row, 'exact'], [nodePG, 'linked'], [orders, 'linked'], [payments, 'linked'], [layersPG, 'linked'], [toPG, 'linked']]],
      ['message 3', msg3, [[node('GW'), 'linked'], [node('Inv'), 'linked'], [actorG, 'linked'], [{...msg3, id: 'other:2'}, 'linked'], [msg1, undefined], [nodePG, undefined]]],
      ['message 1 (via CDN, Q)', msg1, [[node('Client'), 'linked'], [node('CDN'), 'linked'], [node('Q'), 'linked'], [node('GW'), 'linked'], [msg3, undefined]]],
      ['actor G', actorG, [[node('GW'), 'exact'], [msg3, 'linked'], [msg1, 'linked'], [nodePG, undefined]]],
      ['the file schema.sql', schema, [[orders, 'exact'], [payments, 'exact'], [nodePG, undefined], [row, undefined]]],
    ])('selecting %s', (_name, selection, cases) => {
      expect(cases.map(([entity]) => matchSelection(selection, entity))).toEqual(cases.map(([, how]) => how));
      for (const [entity, how] of cases) expect(marksSelection(selection, entity)).toBe(how === 'exact' || how === 'linked');
    });

    it('a self-message, a row standing for several nodes, and nodes of one file', () => {
      const self: EntityRef = {type: 'message', id: 's:2', label: '2. A to itself: tick', nodes: ['A', 'A']};
      expect(hubOf(self)).toEqual(['A']);
      expect(matchSelection(self, node('A'))).toBe('linked');
      // an author-written row naming two nodes lights with either, and lights each; a table standing for PG and
      // itself does not stand for both
      const stores: EntityRef = {type: 'row', id: 'l:Stores', label: 'Stores', nodes: ['PG', 'Redis']};
      expect(matchSelection(node('PG'), stores)).toBe('linked');
      expect(matchSelection(node('Redis'), stores)).toBe('linked');
      expect(matchSelection(stores, node('PG'))).toBe('linked');
      expect(matchSelection(stores, orders)).toBeUndefined();
      // two nodes of one file are one place only where their lines meet; a node without lines is the whole file
      expect(matchSelection(orders, payments)).toBeUndefined();
      expect(matchSelection({type: 'node', id: 'a', path: 'x.sql', line: 10, endLine: 30}, {type: 'node', id: 'b', path: 'x.sql', line: 25})).toBe('exact');
      expect(matchSelection({type: 'node', id: 'a', path: 'x.sql'}, {type: 'node', id: 'b', path: 'x.sql', line: 5})).toBe('exact');
      // a line of the file selected elsewhere is the place of the table whose lines hold it
      expect(matchSelection({...schema, line: 12}, orders)).toBe('exact');
      expect(matchSelection({...schema, line: 40}, orders)).toBeUndefined();
      expect(matchSelection({...schema, line: 40}, payments)).toBe('exact');
    });

    it('leaves entities that name no node as they were', () => {
      expect(matchSelection(nodePG, {type: 'row', id: '7', path: 'src/a.ts'})).toBeUndefined();
      expect(matchSelection(file('src/a.ts'), {type: 'row', id: '7', path: 'src/a.ts'})).toBe('exact');
      expect(matchSelection(dir('src/auth'), {type: 'node', id: 'S', path: 'src/auth/session.ts', nodes: ['PG']})).toBe('within');
      expect(matchSelection({type: 'commit', id: 'abc'}, {type: 'commit', id: 'def'})).toBeUndefined();
      expect(matchSelection({type: 'symbol', id: 'login', path: 'a.ts'}, file('a.ts'))).toBe('contains');
      // a file carrying nodes is still that file to a file tree, and links like a node
      const filed: EntityRef = {...file('src/api.ts'), nodes: ['GW']};
      expect(matchSelection(file('src/api.ts'), filed)).toBe('exact');
      expect(matchSelection(actorG, filed)).toBe('linked');
      expect(hubOf(file('src/api.ts'))).toEqual([]);
    });

    it('linkedEntity: an item\'s own entity carries its nodes; without one, one node is that node, several a row', () => {
      const own = file('src/api.ts');
      const item = {id: 'tiers:API', label: 'API'};
      expect(linkedEntity(undefined, [], item)).toBeUndefined();
      expect(linkedEntity(own, [], item)).toBe(own);
      expect(linkedEntity(own, ['GW'], item)).toEqual({...own, nodes: ['GW']});
      expect(linkedEntity(undefined, ['GW'], item)).toEqual({type: 'node', id: 'GW', label: 'API'});
      expect(linkedEntity(undefined, ['GW', 'Q'], item)).toEqual({type: 'row', id: 'tiers:API', label: 'API', nodes: ['GW', 'Q']});
    });
  });

  it('useSelection().match follows /ui/sel', () => {
    const seen: Array<string | undefined> = [];
    const Probe: GlView<any> = ({id}) => {
      const {match} = useSelection(id);
      seen.push(match({type: 'file', id: 'src/auth/cache.ts', path: 'src/auth/cache.ts'}));
      return null;
    };
    const view = renderStub(page("DataTable('git.churn')"), {DataTable: Probe});
    view.setData('/ui/sel', {type: 'dir', id: 'src/auth', path: 'src/auth'});
    view.setData('/ui/sel', {type: 'file', id: 'src/auth/cache.ts', path: 'src/auth/cache.ts'});
    expect(seen).toEqual([undefined, 'within', 'exact']);
  });
});

describe('link status for controls that send to the agent (F024)', () => {
  it('is live unless the shell says otherwise', () => {
    const seen: string[] = [];
    const Probe = () => { seen.push(useLinkStatus()); return null; };
    render(<Probe />);
    render(<KitProvider host={createFixtureHost()}><Probe /></KitProvider>);
    render(<KitProvider host={createFixtureHost()} link="ended"><Probe /></KitProvider>);
    expect(seen).toEqual(['live', 'live', 'ended']);
  });
});

describe('host actions keep working from a stub (sanity for the crumb)', () => {
  it('drill is one action with the dataset key and the target', () => {
    const Probe: GlView<any> = ({id}) => {
      const host = useHostActions(id);
      useEffect(() => host.drill('k', 'src'), [host]);
      return null;
    };
    const view = renderStub(page("DataTable('git.churn')"), {DataTable: Probe});
    expect(view.actions).toEqual([expect.objectContaining({name: 'gl_drill', context: {ds: 'k', target: 'src'}})]);
  });
});
