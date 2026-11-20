import type {FileQuery, FileSlice, TokenLine} from '@glimpse/catalog';
import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {HOST_FIXTURES, renderExpress, type RenderedSpec} from '../harness.tsx';

const FOLLOW = `root=Page('T',[c])\nc=CodeView()`;
const LINE = 20;

/** A file of `total` lines whose text names its line number and an edition, served in the windows that are asked for. */
const bigFile = (total: number, edition: () => number = () => 1) => (q: FileQuery): Promise<FileSlice> => {
  const start = Math.max(1, q.start ?? 1);
  const end = Math.min(total, q.end ?? start + 399);
  const lines = Array.from({length: Math.max(0, end - start + 1)}, (_, i): TokenLine => [[`line ${start + i} v${edition()}`, 0]]);
  return Promise.resolve({path: q.path, lang: 'typescript', total, start, end, lines, size: total * 12, rev: edition()});
};
const fileCalls = (view: RenderedSpec) => view.host.calls.filter(call => call.method === 'file').map(call => call.args[0] as FileQuery);
const region = (cell: HTMLElement) => within(cell).getByRole('region');
const line = (cell: HTMLElement, n: number) => cell.querySelector<HTMLElement>(`[data-line="${n}"]`);
const text = (cell: HTMLElement, n: number) => line(cell, n)?.lastElementChild?.textContent;
const scrollTo = (cell: HTMLElement, top: number) => {
  region(cell).scrollTop = top;
  fireEvent.scroll(region(cell));
};

describe('CodeView', () => {
  it('follows /ui/file when file is omitted and shows the header, gutter and token classes', async () => {
    const view = renderExpress(FOLLOW);
    const cell = view.cell('c');
    await waitFor(() => expect(cell.querySelector('[data-gl-state="empty"]')?.textContent).toBe('no file selected'));
    expect(fileCalls(view)).toEqual([]);

    view.setData('/ui/file', 'src/auth/service.ts');
    await waitFor(() => expect(text(cell, 1)).toBe("import {cache} from './cache';"));
    expect(fileCalls(view)).toEqual([{path: 'src/auth/service.ts', start: 1, end: 400}]);
    expect(cell.querySelector('[data-gl-path]')?.textContent).toBe('src/auth/service.ts');
    expect(cell.querySelector('[data-gl-lang]')?.textContent).toBe('typescript');
    expect(cell.textContent).toMatch(/\d+ lines/);
    expect(line(cell, 1)?.querySelector('.gl-tok-kw')?.textContent).toBe('import');
    expect(line(cell, 1)?.querySelector('.gl-tok-str')?.textContent).toBe("'./cache'");
    expect(within(cell).getByRole('button', {name: 'Select line 1'}).textContent).toBe('1');
    expect(cell.innerHTML).not.toContain('<script');

    // the selection moves on: the next file replaces this one without a drafting frame in between
    view.setData('/ui/file', 'src/api/routes.ts#L3');
    expect(cell.querySelector('[data-gl-state]')).toBeNull();
    await waitFor(() => expect(cell.querySelector('[data-gl-path]')?.textContent).toBe('src/api/routes.ts'));
    expect(line(cell, 3)?.hasAttribute('data-selected')).toBe(true);
    expect(view.errors).toEqual([]);
  });

  it('opens at the range of a file location: fetches that window, scrolls there and sets the range off', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('big.ts#L620-630',mark='625')`, {host: {file: bigFile(1000)}});
    const cell = view.cell('c');
    await waitFor(() => expect(fileCalls(view)).toEqual([{path: 'big.ts', start: 401, end: 800}]));
    await waitFor(() => expect(text(cell, 620)).toBe('line 620 v1'));
    expect(region(cell).scrollTop).toBe((620 - 1 - 3) * LINE);
    expect(line(cell, 1)).toBeNull();
    expect(line(cell, 620)?.hasAttribute('data-region')).toBe(true);
    expect(line(cell, 631)?.hasAttribute('data-region')).toBe(false);
    expect(line(cell, 620)?.hasAttribute('data-hl')).toBe(false);
    expect(line(cell, 625)?.hasAttribute('data-marked')).toBe(true);
    expect(line(cell, 625)?.hasAttribute('data-hl')).toBe(true);
    expect(fileCalls(view)).toHaveLength(1);

    // scrolling back to the top asks for the first window, once
    scrollTo(cell, 0);
    await waitFor(() => expect(text(cell, 1)).toBe('line 1 v1'));
    scrollTo(cell, 40);
    await view.settle();
    expect(fileCalls(view)).toEqual([{path: 'big.ts', start: 401, end: 800}, {path: 'big.ts', start: 1, end: 400}]);
  });

  it('scrolls to a selection with a line and marks it, without jumping when it is already in view', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('big.ts')`, {host: {file: bigFile(1000)}});
    const cell = view.cell('c');
    await waitFor(() => expect(text(cell, 1)).toBe('line 1 v1'));
    view.setData('/ui/sel', {type: 'symbol', id: 'big.ts#f@900', path: 'big.ts', line: 900, endLine: 902});
    await waitFor(() => expect(region(cell).scrollTop).toBe((900 - 1 - 3) * LINE));
    fireEvent.scroll(region(cell));
    await waitFor(() => expect(text(cell, 900)).toBe('line 900 v1'));
    expect([899, 900, 901, 902, 903].map(n => line(cell, n)?.hasAttribute('data-selected'))).toEqual([false, true, true, true, false]);

    view.setData('/ui/sel', {type: 'file', id: 'big.ts', path: 'big.ts', line: 905});
    await view.settle();
    expect(region(cell).scrollTop).toBe((900 - 1 - 3) * LINE);
    expect(line(cell, 905)?.hasAttribute('data-selected')).toBe(true);
    // a selection in another file leaves this one alone
    view.setData('/ui/sel', {type: 'file', id: 'other.ts', path: 'other.ts', line: 5});
    await view.settle();
    expect(cell.querySelector('[data-selected]')).toBeNull();
  });

  it('reads the windows in view again when /meta/rev changes, keeping the old lines until the new ones arrive', async () => {
    let edition = 1;
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('big.ts')`, {host: {file: bigFile(1000, () => edition)}});
    const cell = view.cell('c');
    await waitFor(() => expect(text(cell, 2)).toBe('line 2 v1'));
    edition = 2;
    view.setData('/meta/rev', 2);
    expect(text(cell, 2)).toBe('line 2 v1');
    expect(cell.querySelector('[data-gl-state]')).toBeNull();
    await waitFor(() => expect(text(cell, 2)).toBe('line 2 v2'));
    expect(fileCalls(view)).toEqual([{path: 'big.ts', start: 1, end: 400}, {path: 'big.ts', start: 1, end: 400}]);
  });

  it('selects a line from the gutter, a range with shift, and reports it as gl_select', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('src/auth/service.ts')`);
    const cell = view.cell('c');
    fireEvent.click(await within(cell).findByRole('button', {name: 'Select line 8'}));
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/service.ts', path: 'src/auth/service.ts', line: 8});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts#L8');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'c', context: {ref: {line: 8}}});
    await waitFor(() => expect(line(cell, 8)?.hasAttribute('data-selected')).toBe(true));

    fireEvent.click(within(cell).getByRole('button', {name: 'Select line 12'}), {shiftKey: true});
    expect(view.getData('/ui/sel')).toMatchObject({line: 8, endLine: 12});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts#L8-12');
    await waitFor(() => expect(cell.querySelectorAll('[data-selected]')).toHaveLength(5));
  });

  it('is operable from the keyboard: arrows move a cursor, Enter selects, o opens, c copies, Escape clears', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('src/auth/service.ts')`);
    const cell = view.cell('c');
    await waitFor(() => expect(line(cell, 1)).not.toBeNull());
    const keys = region(cell);
    expect(keys.tabIndex).toBe(0);
    fireEvent.keyDown(keys, {key: 'ArrowDown'});
    await waitFor(() => expect(line(cell, 1)?.hasAttribute('data-cursor')).toBe(true));
    fireEvent.keyDown(keys, {key: 'ArrowDown'});
    fireEvent.keyDown(keys, {key: 'ArrowDown'});
    await waitFor(() => expect(line(cell, 3)?.hasAttribute('data-cursor')).toBe(true));
    fireEvent.keyDown(keys, {key: 'Enter'});
    expect(view.getData('/ui/sel')).toMatchObject({type: 'file', path: 'src/auth/service.ts', line: 3});
    fireEvent.keyDown(keys, {key: 'ArrowDown', shiftKey: true});
    expect(view.getData('/ui/sel')).toMatchObject({line: 3, endLine: 4});
    // a range the reader extends does not scroll the view back to its first line
    await view.settle();
    expect(keys.scrollTop).toBe(0);
    fireEvent.keyDown(keys, {key: 'o'});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/auth/service.ts#L4'}});
    fireEvent.keyDown(keys, {key: 'c'});
    await waitFor(() => expect(view.clipboard).toEqual(['src/auth/service.ts:4']));
    fireEvent.keyDown(keys, {key: 'End'});
    await waitFor(() => expect(cell.querySelector('[data-cursor]')?.getAttribute('data-line')).toBe(String(cell.querySelectorAll('[data-line]').length)));
    fireEvent.keyDown(keys, {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    fireEvent.click(within(cell).getByRole('button', {name: /Open src\/auth\/service.ts in the editor/}));
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/auth/service.ts'}});
  });

  it('anchors agent notes after their line, follows the binding, and drops malformed notes with a count', async () => {
    const view = renderExpress(`$/marks=[{line:2,text:'Guard first.',kind:'risk'}]\nroot=Page('T',[c])\nc=CodeView('src/auth/service.ts',notes=$/marks)`);
    const cell = view.cell('c');
    const note = await within(cell).findByRole('note');
    expect(note.textContent).toBe('Risk · agentGuard first.');
    expect(note.getAttribute('data-kind')).toBe('risk');
    expect(note.closest('[data-index]')).toBe(line(cell, 2)?.closest('[data-index]'));
    expect(line(cell, 2)?.querySelector('[data-note]')?.getAttribute('data-note')).toBe('start');
    expect(cell.querySelector('[data-gl-marginal]')).toBeNull();

    view.setData('/marks', [
      {line: 1, endLine: 3, text: 'Imports.'},
      {line: '3', text: 'Also here.', kind: 'nonsense'},
      {line: 0, text: 'no such line'},
      {line: 4},
      null,
      'a string',
      {line: 99_999, text: 'Past the end.'},
    ]);
    // a note past the end of the file hangs on its last line
    await waitFor(() => expect(within(cell).getAllByRole('note').map(n => n.textContent)).toEqual(['Note · agent · L1–3Imports.', 'Note · agentAlso here.', 'Note · agentPast the end.']));
    expect(within(cell).getAllByRole('note').at(-1)?.closest('[data-index]')?.querySelector('[data-line]')?.getAttribute('data-line')).toBe(String(HOST_FIXTURES.file.total));
    expect([1, 2, 3].map(n => line(cell, n)?.querySelector('[data-note]')?.getAttribute('data-note'))).toEqual(['start', 'mid', 'start']);
    expect(cell.querySelector('[data-gl-marginal]')?.textContent).toBe('4 malformed notes dropped');

    view.setData('/marks', {not: 'a list'});
    await waitFor(() => expect(within(cell).queryAllByRole('note')).toEqual([]));
    expect(cell.querySelector('[data-gl-marginal]')?.textContent).toBe('1 malformed note dropped');
    expect(line(cell, 1)).not.toBeNull();
  });

  it('puts its header into the plate header when it has a title', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('src/auth/service.ts',title='Source',size='m')`);
    const cell = view.cell('c');
    await waitFor(() => expect(line(cell, 1)).not.toBeNull());
    expect(cell.querySelector('.gl-frame-head [data-gl-path]')?.textContent).toBe('src/auth/service.ts');
    expect(cell.querySelector('.gl-frame-body [data-gl-path]')).toBeNull();
    expect(cell.querySelector('[data-gl-code="view"]')?.getAttribute('data-fit')).toBe('fill');
  });

  it('drafts while the first window is on its way, then redlines a failure and names a skipped file', async () => {
    let fail: ((error: Error) => void) | undefined;
    const pending = renderExpress(`root=Page('T',[c])\nc=CodeView('slow.ts')`, {host: {file: () => new Promise((_, reject) => { fail = reject; })}});
    await waitFor(() => expect(pending.cell('c').querySelector('[data-gl-state="drafting"]')?.textContent).toBe('reading slow.ts'));
    fail!(new Error('403 outside the root'));
    await waitFor(() => expect(pending.cell('c').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_FILE'));
    expect(pending.cell('c').textContent).toContain('slow.ts: 403 outside the root');
    pending.unmount();

    const missing = renderExpress(`root=Page('T',[c])\nc=CodeView('src/missing.ts')`);
    await waitFor(() => expect(missing.cell('c').querySelector('[data-gl-state="empty"]')?.textContent).toBe('src/missing.ts does not exist'));
    missing.unmount();

    const skipped = (reason: FileSlice['skipped'], size: number) => (q: FileQuery): Promise<FileSlice> =>
      Promise.resolve({path: q.path, lang: 'text', total: 0, start: 0, end: 0, lines: [], size, skipped: reason, rev: 1});
    const binary = renderExpress(`root=Page('T',[c])\nc=CodeView('logo.png')`, {host: {file: skipped('binary', 900)}});
    await waitFor(() => expect(binary.cell('c').querySelector('[data-gl-state="empty"]')?.textContent).toBe('logo.png is a binary file'));
    binary.unmount();
    const large = renderExpress(`root=Page('T',[c])\nc=CodeView('dump.sql')`, {host: {file: skipped('too-large', 3_400_000)}});
    await waitFor(() => expect(large.cell('c').querySelector('[data-gl-state="empty"]')?.textContent).toBe('dump.sql is too large to show (3.4 MB)'));
    large.unmount();
    // the service says 'outside-root' for every file that is not in the inventory, inside the root or not
    const ignored = renderExpress(`root=Page('T',[c])\nc=CodeView('.git/config')`, {host: {file: skipped('outside-root', 0)}});
    await waitFor(() => expect(ignored.cell('c').querySelector('[data-gl-state="empty"]')?.textContent).toBe('.git/config is not a file of this project (outside it, ignored, or under .git)'));
    await waitFor(() => expect(ignored.reports.map(report => report.message)).toContain('CodeView#c: .git/config is not a file of this project (outside it, ignored, or under .git)'));
    ignored.unmount();
    const empty = renderExpress(`root=Page('T',[c])\nc=CodeView('empty.ts')`, {host: {file: bigFile(0)}});
    await waitFor(() => expect(empty.cell('c').querySelector('[data-gl-state="empty"]')?.textContent).toBe('empty.ts is empty'));
  });

  it('survives a malformed slice', async () => {
    const slice = {path: 'odd.ts', lang: 7, total: '4', start: 1, end: 4, size: null, rev: 1, lines: ['plain string', [['ok', 3], ['bad class', 42], 'bare', [9, 9]], null, {not: 'a line'}]};
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('odd.ts')`, {host: {file: () => Promise.resolve(slice as never)}});
    const cell = view.cell('c');
    await waitFor(() => expect(text(cell, 1)).toBe('plain string'));
    expect(text(cell, 2)).toBe('okbad classbare');
    expect(line(cell, 2)?.querySelector('.gl-tok-fn')?.textContent).toBe('ok');
    expect(text(cell, 3)).toBe('');
    expect(cell.querySelectorAll('[data-line]')).toHaveLength(4);
    expect(view.errors).toEqual([]);
  });

  it('keeps a 50,000-line file out of the DOM and reads it window by window', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('huge.ts',size='l')`, {host: {file: bigFile(50_000)}});
    const cell = view.cell('c');
    await waitFor(() => expect(text(cell, 1)).toBe('line 1 v1'));
    expect(cell.querySelectorAll('[data-line]').length).toBeLessThan(80);
    scrollTo(cell, 30_100 * LINE);
    await waitFor(() => expect(text(cell, 30_110)).toBe('line 30110 v1'));
    expect(cell.querySelectorAll('[data-line]').length).toBeLessThan(80);
    expect(fileCalls(view).map(q => q.start)).toEqual([1, 30_001]);
    // rows between windows show a placeholder until their window arrives
    scrollTo(cell, 400 * LINE - 300);
    await waitFor(() => expect(text(cell, 405)).toBe('line 405 v1'));
    expect(fileCalls(view).map(q => q.start)).toEqual([1, 30_001, 401]);
  });
});
