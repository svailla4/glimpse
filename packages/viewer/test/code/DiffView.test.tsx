import type {DiffFile, DiffPayload} from '@glimpse/catalog';
import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {HOST_FIXTURES, renderExpress} from '../harness.tsx';

const SPEC = `root=Page('T',[d])\nd=DiffView()`;
const NARROW = {width: 700, height: 600};
const paths = (cell: HTMLElement) => [...cell.querySelectorAll('[role="option"]')].map(option => option.getAttribute('data-path'));
const shown = (cell: HTMLElement) => cell.querySelector('[data-gl-path]')?.getAttribute('data-gl-path');
const lines = (cell: HTMLElement, tone: string) => [...cell.querySelectorAll(`[data-t="${tone}"]`)].map(line => line.lastElementChild?.textContent);
const diffCalls = (view: {host: {calls: Array<{method: string; args: unknown[]}>}}) => view.host.calls.filter(call => call.method === 'diff').map(call => call.args[0]);
const fixture = (): DiffPayload => structuredClone(HOST_FIXTURES.diff);

describe('DiffView', () => {
  it('drafts, then lists the changed files and shows the first file unified below 960 px', async () => {
    const view = renderExpress(SPEC, {size: NARROW});
    const cell = view.cell('d');
    expect(cell.querySelector('[data-gl-state="drafting"]')).not.toBeNull();
    await waitFor(() => expect(paths(cell)).toEqual(['src/api/limiter.ts', 'src/auth/service.ts']));
    expect(diffCalls(view)).toEqual([{range: 'wt'}]);
    expect(shown(cell)).toBe('src/api/limiter.ts');
    expect(cell.querySelector('[data-gl-code="diff"]')?.getAttribute('data-mode')).toBe('unified');
    expect(lines(cell, '+')).toHaveLength(10);
    expect(lines(cell, '+')[2]).toBe('const WINDOW_SECONDS = 60;');
    expect(cell.querySelector('.gl-tok-kw')?.textContent).toBe('import');
    const first = cell.querySelector('[role="option"]')!;
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(within(first as HTMLElement).getByRole('img', {name: 'added'})).toBeTruthy();
    expect(first.textContent).toContain('+10');
    expect(view.errors).toEqual([]);
  });

  it('picks split at 960 px in auto mode; mode and the s key override it', async () => {
    const view = renderExpress(SPEC, {data: {'/ui/file': 'src/auth/service.ts'}});
    const cell = view.cell('d');
    await waitFor(() => expect(cell.querySelector('[data-gl-code="diff"]')?.getAttribute('data-mode')).toBe('split'));
    expect(shown(cell)).toBe('src/auth/service.ts');
    // a removal sits beside the addition that replaces it
    const pair = [...cell.querySelectorAll('[data-gl-pair]')].find(row => row.querySelector('[data-t="-"]'))!;
    expect(pair.querySelector('[data-side="old"]')?.textContent).toContain('const TTL_SECONDS = 600;');
    expect(pair.querySelector('[data-side="new"]')?.textContent).toContain('const TTL_SECONDS = 900;');
    // an addition with no counterpart leaves the old side blank
    const lone = [...cell.querySelectorAll('[data-gl-pair]')].find(row => row.textContent?.includes('timingSafeEqual'))!;
    expect(lone.querySelector('[data-side="old"]')?.childElementCount).toBe(0);

    fireEvent.keyDown(cell.querySelector('[data-gl-code="diff"]')!, {key: 's'});
    await waitFor(() => expect(cell.querySelector('[data-gl-code="diff"]')?.getAttribute('data-mode')).toBe('unified'));
    fireEvent.click(within(cell).getByRole('button', {name: 'split'}));
    await waitFor(() => expect(cell.querySelector('[data-gl-pair]')).not.toBeNull());
    view.unmount();

    const forced = renderExpress(`root=Page('T',[d])\nd=DiffView(mode='unified')`);
    await waitFor(() => expect(forced.cell('d').querySelector('[data-gl-code="diff"]')?.getAttribute('data-mode')).toBe('unified'));
    forced.unmount();
    const split = renderExpress(`root=Page('T',[d])\nd=DiffView(mode='split')`, {size: NARROW});
    await waitFor(() => expect(split.cell('d').querySelector('[data-gl-code="diff"]')?.getAttribute('data-mode')).toBe('split'));
  });

  it('draws word-level marks inside changed lines', async () => {
    const view = renderExpress(SPEC, {size: NARROW, data: {'/ui/file': 'src/auth/service.ts'}});
    const cell = view.cell('d');
    await waitFor(() => expect(shown(cell)).toBe('src/auth/service.ts'));
    const marks = [...cell.querySelectorAll('mark')].map(mark => [mark.closest('[data-t]')?.getAttribute('data-t'), mark.textContent]);
    expect(marks).toContainEqual(['-', '600']);
    expect(marks).toContainEqual(['+', '900']);
    const removed = lines(cell, '-');
    expect(removed).toEqual(['const TTL_SECONDS = 600;', '  return (await digest(password)) === hash;']);
    expect([...cell.querySelectorAll('[data-gl-hunk]')].map(hunk => hunk.textContent)).toEqual([
      "@@ -3,5 +3,5 @@ import {db} from '../lib/db';",
      '@@ -22,4 +22,5 @@ export async function issueToken(user: User): Promise<Session> {',
    ]);
  });

  it('selects a file from the list: /ui/sel, /ui/file and gl_select change, and the hunks follow', async () => {
    const view = renderExpress(SPEC, {size: NARROW});
    const cell = view.cell('d');
    await waitFor(() => expect(paths(cell)).toHaveLength(2));
    fireEvent.click(cell.querySelector('[data-path="src/auth/service.ts"]')!);
    await waitFor(() => expect(shown(cell)).toBe('src/auth/service.ts'));
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/service.ts', path: 'src/auth/service.ts'});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'd', context: {ref: {type: 'file', id: 'src/auth/service.ts'}}});
    expect(cell.querySelector('[data-path="src/auth/service.ts"]')?.hasAttribute('data-selected')).toBe(true);

    // a selection made elsewhere moves the diff too; one that names no changed file leaves it alone
    view.setData('/ui/file', 'src/api/limiter.ts#L3');
    await waitFor(() => expect(shown(cell)).toBe('src/api/limiter.ts'));
    view.setData('/ui/file', 'README.md');
    await view.settle();
    expect(shown(cell)).toBe('src/api/limiter.ts');
    // a selected directory marks the changed files inside it
    view.setData('/ui/sel', {type: 'dir', id: 'src/auth', path: 'src/auth'});
    await waitFor(() => expect(cell.querySelector('[data-path="src/auth/service.ts"]')?.hasAttribute('data-selected')).toBe(true));
    expect(cell.querySelector('[data-path="src/api/limiter.ts"]')?.hasAttribute('data-selected')).toBe(false);
  });

  it('walks files with ] and [ and the list arrows, hunks with j and k, and selects a line from the gutter', async () => {
    const view = renderExpress(SPEC, {size: NARROW});
    const cell = view.cell('d');
    await waitFor(() => expect(paths(cell)).toHaveLength(2));
    const root = cell.querySelector('[data-gl-code="diff"]')!;
    fireEvent.keyDown(root, {key: ']'});
    await waitFor(() => expect(shown(cell)).toBe('src/auth/service.ts'));
    fireEvent.keyDown(root, {key: ']'});
    expect(shown(cell)).toBe('src/auth/service.ts');

    const active = () => cell.querySelector('[data-gl-hunk][data-active]')?.getAttribute('data-gl-hunk');
    await waitFor(() => expect(active()).toBe('0'));
    fireEvent.keyDown(root, {key: 'j'});
    await waitFor(() => expect(active()).toBe('1'));
    fireEvent.keyDown(root, {key: 'j'});
    expect(active()).toBe('1');
    fireEvent.keyDown(root, {key: 'k'});
    await waitFor(() => expect(active()).toBe('0'));

    fireEvent.click(within(cell).getByRole('button', {name: 'Select line 24'}));
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/service.ts', path: 'src/auth/service.ts', line: 24});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts#L24');
    await waitFor(() => expect(cell.querySelector('[data-hl]')?.textContent).toContain('timingSafeEqual'));
    fireEvent.keyDown(root, {key: 'o'});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/auth/service.ts#L24'}});
    fireEvent.keyDown(root, {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();

    const list = within(cell).getByRole('listbox');
    fireEvent.keyDown(list, {key: 'ArrowUp'});
    await waitFor(() => expect(shown(cell)).toBe('src/api/limiter.ts'));
    fireEvent.keyDown(list, {key: 'End'});
    await waitFor(() => expect(shown(cell)).toBe('src/auth/service.ts'));
    expect(list.getAttribute('aria-activedescendant')).toBe(cell.querySelector('[data-path="src/auth/service.ts"]')?.id);
  });

  it('draws the line-less hunk of a cut diff as a note row, never as a hunk to jump to', async () => {
    const payload = fixture();
    const cut = '@@ 4,120 more diff lines not shown: the change is too large for one view @@';
    payload.files[1]!.hunks!.push({oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, header: cut, lines: []});
    for (const mode of ['unified', 'split']) {
      const view = renderExpress(`root=Page('T',[d])\nd=DiffView(mode='${mode}')`, {size: NARROW, data: {'/ui/file': 'src/auth/service.ts'}, host: {diff: () => Promise.resolve(structuredClone(payload))}});
      const cell = view.cell('d');
      await waitFor(() => expect(cell.querySelector('[data-gl-diff-note]')?.textContent).toBe('4,120 more diff lines not shown: the change is too large for one view'));
      expect(cell.querySelector('[data-gl-diff-note]')?.getAttribute('role')).toBe('note');
      expect([...cell.querySelectorAll('[data-gl-hunk]')].map(hunk => hunk.textContent)).not.toContain(cut);
      expect(cell.querySelectorAll('[data-gl-hunk]')).toHaveLength(2);
      expect(cell.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(`Diff of src/auth/service.ts, ${mode}, 2 hunks, cut`);
      // j stops at the last real hunk
      const root = cell.querySelector('[data-gl-code="diff"]')!;
      fireEvent.keyDown(root, {key: 'j'});
      fireEvent.keyDown(root, {key: 'j'});
      await waitFor(() => expect(cell.querySelector('[data-gl-hunk][data-active]')?.getAttribute('data-gl-hunk')).toBe('1'));
      view.unmount();
    }
  });

  it('loads hunks on demand for a file that arrived without them', async () => {
    const full = fixture();
    const diff = (query: {range: string; path?: string}): Promise<DiffPayload> => {
      if (query.path) return Promise.resolve({...full, files: full.files.filter(file => file.path === query.path)});
      const files: DiffFile[] = full.files.map((file, i) => (i === 1 ? {...file, hunks: undefined} : file));
      return Promise.resolve({...full, files});
    };
    const view = renderExpress(SPEC, {size: NARROW, host: {diff}});
    const cell = view.cell('d');
    await waitFor(() => expect(paths(cell)).toHaveLength(2));
    expect(diffCalls(view)).toEqual([{range: 'wt'}]);
    fireEvent.click(cell.querySelector('[data-path="src/auth/service.ts"]')!);
    await waitFor(() => expect(lines(cell, '+')).toContain('const TTL_SECONDS = 900;'));
    expect(diffCalls(view)).toEqual([{range: 'wt'}, {range: 'wt', path: 'src/auth/service.ts'}]);
  });

  it('refetches when /meta/rev changes and keeps the old hunks on screen meanwhile', async () => {
    let edition = 0;
    let release: (() => void) | undefined;
    const diff = (): Promise<DiffPayload> => {
      const payload = fixture();
      if (edition++ === 0) return Promise.resolve(payload);
      payload.files = [payload.files[0]!];
      payload.files[0]!.hunks![0]!.lines[0]!.tokens = [['// edited on disk', 7]];
      return new Promise(resolve => {
        release = () => resolve(payload);
      });
    };
    const view = renderExpress(SPEC, {size: NARROW, host: {diff}});
    const cell = view.cell('d');
    await waitFor(() => expect(paths(cell)).toHaveLength(2));
    view.setData('/meta/rev', 2);
    await waitFor(() => expect(diffCalls(view)).toHaveLength(2));
    expect(cell.querySelector('[data-gl-state]')).toBeNull();
    expect(lines(cell, '+')[0]).toBe("import {cache} from '../auth/cache';");
    release!();
    await waitFor(() => expect(lines(cell, '+')[0]).toBe('// edited on disk'));
    expect(paths(cell)).toEqual([]);
    expect(cell.querySelector('.gl-tok-com')?.textContent).toBe('// edited on disk');
  });

  it('passes range and file to the host and follows a binding update', async () => {
    const view = renderExpress(`$/range='main..HEAD'\nroot=Page('T',[d])\nd=DiffView($/range,'src/auth/service.ts')`, {size: NARROW});
    const cell = view.cell('d');
    await waitFor(() => expect(shown(cell)).toBe('src/auth/service.ts'));
    expect(diffCalls(view)).toEqual([{range: 'main..HEAD', path: 'src/auth/service.ts'}]);
    expect(paths(cell)).toEqual([]);
    view.setData('/range', 'staged');
    await waitFor(() => expect(diffCalls(view).at(-1)).toEqual({range: 'staged', path: 'src/auth/service.ts'}));
  });

  it('says so when nothing changed, and redlines a failed or malformed answer', async () => {
    const empty = renderExpress(SPEC, {host: {diff: q => Promise.resolve({range: q.range, files: [], totals: {files: 0, add: 0, del: 0}, rev: 1})}});
    await waitFor(() => expect(empty.cell('d').querySelector('[data-gl-state="empty"]')?.textContent).toBe('no uncommitted changes'));
    empty.unmount();

    const failed = renderExpress(`root=Page('T',[d])\nd=DiffView('nope..x')`, {host: {diff: () => Promise.reject(new Error('unknown revision nope'))}});
    await waitFor(() => expect(failed.cell('d').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_DIFF'));
    expect(failed.cell('d').textContent).toContain('unknown revision nope');
    failed.unmount();

    const wrong = renderExpress(SPEC, {host: {diff: () => Promise.resolve('<html>' as never)}});
    await waitFor(() => expect(wrong.cell('d').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_SHAPE'));
  });

  it('survives malformed files, hunks and lines', async () => {
    const payload = {
      range: 'wt', rev: 1, totals: {files: 3, add: 1, del: 0},
      files: [
        null,
        {status: 'M'},
        {path: 'a.ts', status: 'X', add: '4', del: null, hunks: [null, {lines: [null, {t: '?', tokens: 'plain text'}, {t: '+', n: '7', tokens: [['ok', 99], 5], marks: 'no'}]}]},
        {path: 'a.ts', status: 'M', add: 1, del: 1},
        {path: 'logo.png', status: 'A', add: 0, del: 0, binary: true},
      ],
    };
    const view = renderExpress(SPEC, {size: NARROW, host: {diff: () => Promise.resolve(payload as never)}});
    const cell = view.cell('d');
    await waitFor(() => expect(paths(cell)).toEqual(['a.ts', 'logo.png']));
    expect(cell.querySelector('[data-gl-marginal]')?.textContent).toBe('3 malformed dropped');
    expect(cell.querySelector('[data-gl-hunk]')?.textContent).toBe('@@');
    expect(lines(cell, '+')).toEqual(['ok']);
    expect(cell.textContent).toContain('plain text');
    expect(cell.querySelector('[role="option"]')?.textContent).toContain('+4');
    fireEvent.click(cell.querySelector('[data-path="logo.png"]')!);
    await waitFor(() => expect(cell.querySelector('[data-gl-state="empty"]')?.textContent).toBe('logo.png is a binary file'));
    expect(view.errors).toEqual([]);
  });

  it('keeps a 20,000-line hunk and a 2,000-file list out of the DOM', async () => {
    const big: DiffPayload = {
      range: 'wt', rev: 1, totals: {files: 2000, add: 20_000, del: 0},
      files: Array.from({length: 2000}, (_, i): DiffFile => ({
        path: `src/gen/file${i}.ts`, status: 'A', add: i === 0 ? 20_000 : 1, del: 0,
        hunks: i === 0 ? [{oldStart: 0, oldLines: 0, newStart: 1, newLines: 20_000, header: '@@ -0,0 +1,20000 @@', lines: Array.from({length: 20_000}, (_, n) => ({t: '+' as const, n: n + 1, tokens: [[`line ${n + 1}`, 0]]}))}] : undefined,
      })),
    };
    const view = renderExpress(SPEC, {size: NARROW, host: {diff: () => Promise.resolve(big)}});
    const cell = view.cell('d');
    await waitFor(() => expect(lines(cell, '+').length).toBeGreaterThan(10));
    expect(cell.querySelectorAll('[data-t]').length).toBeLessThan(80);
    expect(cell.querySelectorAll('[role="option"]').length).toBeLessThan(80);
    const region = within(cell).getByRole('region');
    region.scrollTop = 24 + 15_000 * 20;
    fireEvent.scroll(region);
    await waitFor(() => expect(lines(cell, '+')).toContain('line 15001'));
  });
});
