import type {OutlineResult} from '@glimpse/catalog';
import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {renderExpress, type RenderedSpec} from '../harness.tsx';

const names = (cell: HTMLElement) => [...cell.querySelectorAll('[role="option"]')].map(row => row.getAttribute('data-symbol'));
const row = (cell: HTMLElement, name: string) => cell.querySelector<HTMLElement>(`[data-symbol="${name}"]`)!;
const outlineCalls = (view: RenderedSpec) => view.host.calls.filter(call => call.method === 'outline').map(call => call.args[0]);
const SERVICE = ['TTL_SECONDS', 'login', 'issueToken', 'verify', 'AuthError', 'status'];

describe('SymbolOutline', () => {
  it('lists the symbols of a file with kind badges, line numbers, depth and export emphasis', async () => {
    const view = renderExpress(`root=Page('T',[o])\no=SymbolOutline('src/auth/service.ts#L3')`);
    const cell = view.cell('o');
    expect(cell.querySelector('[data-gl-state="drafting"]')).not.toBeNull();
    await waitFor(() => expect(names(cell)).toEqual(SERVICE));
    expect(outlineCalls(view)).toEqual(['src/auth/service.ts']);
    expect(row(cell, 'login').textContent).toBe('FNlogin8');
    expect(row(cell, 'AuthError').textContent).toBe('CLSAuthError27');
    expect(row(cell, 'TTL_SECONDS').textContent).toBe('CONSTTTL_SECONDS5');
    expect(row(cell, 'login').hasAttribute('data-exported')).toBe(true);
    expect(row(cell, 'verify').hasAttribute('data-exported')).toBe(false);
    expect(row(cell, 'status').style.getPropertyValue('--gl-depth')).toBe('1');
    expect(cell.querySelector('[data-gl-path]')?.textContent).toBe('src/auth/service.ts');
    expect(cell.textContent).toContain('6 symbols');
    expect(view.errors).toEqual([]);
  });

  it('outlines a README by its headings, with a heading badge (F092)', async () => {
    const symbols: OutlineResult['symbols'] = [
      {name: 'Glimpse', kind: 'heading', line: 1, endLine: 40, depth: 0, exported: true},
      {name: 'Install', kind: 'heading', line: 5, endLine: 20, depth: 1, exported: true},
    ];
    const view = renderExpress(`root=Page('T',[o])\no=SymbolOutline('README.md')`, {host: {outline: path => Promise.resolve({path, symbols})}});
    const cell = view.cell('o');
    await waitFor(() => expect(names(cell)).toEqual(['Glimpse', 'Install']));
    expect(row(cell, 'Install').textContent).toBe('HInstall5');
    expect(row(cell, 'Install').querySelector('[title="heading"]')).not.toBeNull();
    expect(view.reports).toEqual([]);
  });

  it('selecting a symbol writes the file location, so a CodeView beside it scrolls there', async () => {
    const view = renderExpress(`root=Page('T',[o,c])\no=SymbolOutline('src/auth/service.ts')\nc=CodeView()`);
    const cell = view.cell('o');
    await waitFor(() => expect(names(cell)).toEqual(SERVICE));
    fireEvent.click(row(cell, 'issueToken'));
    expect(view.getData('/ui/sel')).toEqual({type: 'symbol', id: 'src/auth/service.ts#issueToken@16', path: 'src/auth/service.ts', line: 16, endLine: 20, label: 'issueToken'});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts#L16-20');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'o', context: {ref: {type: 'symbol', line: 16}}});
    await waitFor(() => expect(row(cell, 'issueToken').getAttribute('aria-selected')).toBe('true'));
    expect(cell.querySelectorAll('[data-selected]')).toHaveLength(1);

    const code = view.cell('c');
    await waitFor(() => expect(code.querySelector('[data-line="16"]')?.hasAttribute('data-selected')).toBe(true));
    expect(code.querySelectorAll('[data-selected]')).toHaveLength(5);
    // the outline follows the same file and does not fetch again
    expect(outlineCalls(view)).toEqual(['src/auth/service.ts']);

    fireEvent.click(row(cell, 'login'), {metaKey: true});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/auth/service.ts#L8'}});
  });

  it('follows /ui/file when file is omitted and refetches when /meta/rev changes', async () => {
    let edition = 1;
    const outline = (path: string): Promise<OutlineResult> =>
      Promise.resolve({path, symbols: [{name: `${path.replace(/\W/g, '_')}_v${edition}`, kind: 'fn', line: 1, depth: 0, exported: true}]});
    const view = renderExpress(`root=Page('T',[o])\no=SymbolOutline()`, {host: {outline}});
    const cell = view.cell('o');
    await waitFor(() => expect(cell.querySelector('[data-gl-state="empty"]')?.textContent).toBe('no file selected'));
    expect(outlineCalls(view)).toEqual([]);

    view.setData('/ui/file', 'a.ts#L10-20');
    await waitFor(() => expect(names(cell)).toEqual(['a_ts_v1']));
    view.setData('/ui/file', 'a.ts#L30');
    await view.settle();
    expect(outlineCalls(view)).toEqual(['a.ts']);

    view.setData('/ui/file', 'b.ts');
    await waitFor(() => expect(names(cell)).toEqual(['b_ts_v1']));
    edition = 2;
    view.setData('/meta/rev', 5);
    await waitFor(() => expect(names(cell)).toEqual(['b_ts_v2']));
    expect(outlineCalls(view)).toEqual(['a.ts', 'b.ts', 'b.ts']);
  });

  it('is one tab stop: arrows move, Enter selects, typing filters, Escape clears', async () => {
    const view = renderExpress(`root=Page('T',[o])\no=SymbolOutline('src/auth/service.ts')`);
    const cell = view.cell('o');
    await waitFor(() => expect(names(cell)).toEqual(SERVICE));
    const list = within(cell).getByRole('listbox');
    expect(list.tabIndex).toBe(0);
    expect(cell.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    const active = () => cell.querySelector('[data-active]')?.getAttribute('data-symbol');
    expect(active()).toBe('TTL_SECONDS');
    fireEvent.keyDown(list, {key: 'ArrowDown'});
    fireEvent.keyDown(list, {key: 'ArrowDown'});
    await waitFor(() => expect(active()).toBe('issueToken'));
    expect(list.getAttribute('aria-activedescendant')).toBe(row(cell, 'issueToken').id);
    fireEvent.keyDown(list, {key: 'End'});
    await waitFor(() => expect(active()).toBe('status'));
    fireEvent.keyDown(list, {key: 'Home'});
    fireEvent.keyDown(list, {key: 'ArrowDown'});
    fireEvent.keyDown(list, {key: 'Enter'});
    expect(view.getData('/ui/sel')).toMatchObject({type: 'symbol', label: 'login', line: 8});

    for (const key of 'TO') fireEvent.keyDown(list, {key});
    await waitFor(() => expect(names(cell)).toEqual(['issueToken']));
    expect(cell.querySelector('[data-gl-filter]')?.textContent).toBe('TO');
    expect(cell.textContent).toContain('1 of 6 symbols');
    fireEvent.keyDown(list, {key: 'x'});
    await waitFor(() => expect(names(cell)).toEqual([]));
    expect(within(cell).getByRole('status').textContent).toBe('no symbol matches “TOx”');
    fireEvent.keyDown(list, {key: 'Backspace'});
    await waitFor(() => expect(names(cell)).toEqual(['issueToken']));
    fireEvent.keyDown(list, {key: 'Enter', ctrlKey: true});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/auth/service.ts#L16'}});
    fireEvent.keyDown(list, {key: 'Escape'});
    await waitFor(() => expect(names(cell)).toEqual(SERVICE));
    expect(view.getData('/ui/sel')).not.toBeNull();
    fireEvent.keyDown(list, {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  it('shows empty, error and malformed answers as states', async () => {
    const none = renderExpress(`root=Page('T',[o])\no=SymbolOutline('README.md')`, {host: {outline: path => Promise.resolve({path, symbols: []})}});
    await waitFor(() => expect(none.cell('o').querySelector('[data-gl-state="empty"]')?.textContent).toBe('no symbols in README.md'));
    none.unmount();

    const failed = renderExpress(`root=Page('T',[o])\no=SymbolOutline('gone.ts')`, {host: {outline: () => Promise.reject(new Error('404'))}});
    await waitFor(() => expect(failed.cell('o').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_OUTLINE'));
    failed.unmount();

    const wrong = renderExpress(`root=Page('T',[o])\no=SymbolOutline('a.ts')`, {host: {outline: () => Promise.resolve({path: 'a.ts', symbols: 'none'} as never)}});
    await waitFor(() => expect(wrong.cell('o').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_SHAPE'));
    wrong.unmount();

    const symbols = [
      null, 'text', {name: 'noLine'}, {line: 3}, {name: 'dup', line: 4, kind: 'fn'}, {name: 'dup', line: 4, kind: 'fn'},
      {name: 'odd', line: '9', kind: 'widget', depth: 400, exported: 'yes', endLine: 2},
    ];
    const mixed = renderExpress(`root=Page('T',[o])\no=SymbolOutline('a.ts')`, {host: {outline: () => Promise.resolve({path: 'a.ts', symbols} as never)}});
    const cell = mixed.cell('o');
    await waitFor(() => expect(names(cell)).toEqual(['dup', 'odd']));
    expect(row(cell, 'odd').textContent).toBe('SYModd9');
    expect(row(cell, 'odd').style.getPropertyValue('--gl-depth')).toBe('12');
    expect(row(cell, 'odd').hasAttribute('data-exported')).toBe(false);
    expect(cell.querySelector('[data-gl-marginal]')?.textContent).toBe('5 malformed dropped');
    fireEvent.click(row(cell, 'odd'));
    expect(mixed.getData('/ui/file')).toBe('a.ts#L9');
  });

  it('keeps a 2,000-symbol outline out of the DOM', async () => {
    const symbols = Array.from({length: 2000}, (_, i) => ({name: `symbol${i}`, kind: 'fn' as const, line: i + 1, depth: 0, exported: false}));
    const view = renderExpress(`root=Page('T',[o])\no=SymbolOutline('big.ts',title='Outline',size='m')`, {host: {outline: path => Promise.resolve({path, symbols})}});
    const cell = view.cell('o');
    await waitFor(() => expect(names(cell)[0]).toBe('symbol0'));
    expect(names(cell).length).toBeLessThan(80);
    expect(cell.querySelector('.gl-frame-head [data-gl-path]')?.textContent).toBe('big.ts');
    const list = within(cell).getByRole('listbox');
    for (const key of '1999') fireEvent.keyDown(list, {key});
    await waitFor(() => expect(names(cell)).toEqual(['symbol1999']));
  });
});
