// Regression tests for the review findings in the code family: `mark` written the way file locations are (F041),
// lines that fail to load and can be asked for again, the wording of an empty diff (F046), the diff list header
// (F003) and the scroll cue (F016).
import {readLineMarks, type DiffPayload, type FileQuery, type FileSlice, type TokenLine} from '@glimpse/catalog';
import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {ignoredMarksText} from '../../src/components/code/codekit/lines.tsx';
import {HOST_FIXTURES, renderExpress} from '../harness.tsx';

const slice = (q: FileQuery, total: number, note = ''): FileSlice => {
  const start = Math.max(1, q.start ?? 1);
  const end = Math.min(total, q.end ?? start + 399);
  const lines = Array.from({length: Math.max(0, end - start + 1)}, (_, i): TokenLine => [[`line ${start + i}${note}`, 0]]);
  return {path: q.path, lang: 'typescript', total, start, end, lines, size: total * 12, rev: 1};
};
const marked = (cell: HTMLElement) => [...cell.querySelectorAll('[data-marked]')].map(line => Number(line.getAttribute('data-line')));
const text = (cell: HTMLElement, n: number) => cell.querySelector(`[data-line="${n}"]`)?.lastElementChild?.textContent;

describe('mark (F041, accept-familiar-variants)', () => {
  it('reads line ranges written like file locations, and says which segments name no line', () => {
    expect(readLineMarks('3,7-9').ranges).toEqual([[3, 3], [7, 9]]);
    // what a writer who has just typed 'path#L1-60' reaches for
    expect(readLineMarks('L1-60').ranges).toEqual([[1, 60]]);
    expect(readLineMarks('#L10-L20, l3 ; 5:7').ranges).toEqual([[10, 20], [3, 3], [5, 7]]);
    expect(readLineMarks('9-7').ranges).toEqual([[7, 9]]);
    expect(readLineMarks(4).ranges).toEqual([[4, 4]]);
    expect(readLineMarks(undefined)).toEqual({ranges: [], ignored: []});
    const bad = readLineMarks('L2, take(), 0, 3-');
    expect(bad.ranges).toEqual([[2, 2]]);
    expect(bad.ignored).toEqual(['take()', '0', '3-']);
    expect(ignoredMarksText(bad.ignored)).toBe('mark: "take()", "0", "3-" are not line ranges');
    expect(ignoredMarksText(['x'])).toBe('mark: "x" is not a line range');
  });

  it("highlights CodeView lines for mark='L2-3', exactly as for '2-3'", async () => {
    const view = renderExpress(`root=Page('T',[a,b])\na=CodeView('big.ts#L1-60',mark='L2-3')\nb=CodeView('big.ts',mark='2-3')`, {host: {file: q => Promise.resolve(slice(q, 100))}});
    await waitFor(() => expect(marked(view.cell('a'))).toEqual([2, 3]));
    await waitFor(() => expect(marked(view.cell('b'))).toEqual([2, 3]));
    expect(view.cell('a').querySelector('[data-gl-mark-ignored]')).toBeNull();
  });

  it('says so in the header when a mark names no line, instead of silently marking nothing', async () => {
    const view = renderExpress(`root=Page('T',[a,b])\na=CodeView('big.ts',mark='the loop')\nb=CodeBlock('a\\nb\\nc','ts',mark='L2, nope')`, {host: {file: q => Promise.resolve(slice(q, 100))}});
    await waitFor(() => expect(view.cell('a').querySelector('[data-gl-mark-ignored]')?.textContent).toBe('mark: "the loop" is not a line range'));
    expect(marked(view.cell('a'))).toEqual([]);
    const block = view.cell('b');
    await waitFor(() => expect(block.querySelector('[data-gl-mark-ignored]')?.textContent).toBe('mark: "nope" is not a line range'));
    expect([...block.querySelectorAll('[data-hl]')].map(line => line.getAttribute('data-line'))).toEqual(['2']);
  });

  // Decision reports-are-component-state: what the view cannot mark is told to the model, not only noted in the header.
  it('reports W_MARK for parts that name no line and for lines past the end, and OK for a mark it draws', async () => {
    const view = renderExpress(
      `root=Page('T',[a,b,c,d,e])\na=CodeView('big.ts',mark='the loop, 2')\nb=CodeView('big.ts',mark='95-110,120')\nc=CodeView('big.ts',mark='L2-3')\nd=CodeBlock('a\\nb\\nc','ts',mark='L2, nope')\ne=CodeBlock('a\\nb\\nc','ts',mark='3-4')`,
      {host: {file: q => Promise.resolve(slice(q, 100))}},
    );
    await waitFor(() => expect(view.stateOf('b')).toBe('W_MARK'));
    await waitFor(() => expect(view.stateOf('c')).toBe('OK'));
    const said = (id: string) => view.reports.findLast(report => report.componentId === id && report.code === 'W_MARK')?.message;
    expect(said('a')).toBe("CodeView#a: mark 'the loop' ignored: write 'L10-20' or '3,7-9'");
    expect(said('b')).toBe("CodeView#b: mark '95-110', '120' are past the last line (100)");
    expect(said('d')).toBe("CodeBlock#d: mark 'nope' ignored: write 'L10-20' or '3,7-9'");
    expect(said('e')).toBe("CodeBlock#e: mark '3-4' is past the last line (3)");
  });
});

describe('CodeView: lines that fail to load', () => {
  it('names the lines of a window that did not load and loads them on Retry', async () => {
    let down = true;
    const file = (q: FileQuery): Promise<FileSlice> => ((q.start ?? 1) > 400 && down ? Promise.reject(new Error('503 busy')) : Promise.resolve(slice(q, 1000)));
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('big.ts')`, {host: {file}});
    const cell = view.cell('c');
    await waitFor(() => expect(text(cell, 2)).toBe('line 2'));
    expect(cell.querySelector('[data-gl-code-failed]')).toBeNull();

    // scroll into the second window: its request fails
    const region = within(cell).getByRole('region');
    region.scrollTop = 20 * 500;
    fireEvent.scroll(region);
    const notice = await waitFor(() => {
      const found = cell.querySelector<HTMLElement>('[data-gl-code-failed]');
      if (!found) throw new Error('no notice yet');
      return found;
    });
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('lines 401–800 did not load: 503 busy');
    // the file stays on screen: no redline, the lines are placeholders
    expect(cell.querySelector('[data-gl-state]')).toBeNull();
    expect(cell.querySelector('[data-line="500"] [data-gl-wait]')).not.toBeNull();
    // the view does not hammer a host that keeps failing
    const asked = () => view.host.calls.filter(call => call.method === 'file' && (call.args[0] as FileQuery).start === 401).length;
    await view.settle();
    expect(asked()).toBe(1);

    down = false;
    fireEvent.click(within(notice).getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(text(cell, 500)).toBe('line 500'));
    expect(asked()).toBe(2);
    expect(cell.querySelector('[data-gl-code-failed]')).toBeNull();
    expect(view.errors).toEqual([]);
  });

  it('asks again for a failed window when the working tree moves', async () => {
    let down = true;
    const file = (q: FileQuery): Promise<FileSlice> => ((q.start ?? 1) > 400 && down ? Promise.reject(new Error('503 busy')) : Promise.resolve(slice(q, 1000)));
    const failing = renderExpress(`root=Page('T',[c])\nc=CodeView('big.ts')`, {host: {file}});
    await waitFor(() => expect(text(failing.cell('c'), 2)).toBe('line 2'));
    const region = within(failing.cell('c')).getByRole('region');
    region.scrollTop = 20 * 500;
    fireEvent.scroll(region);
    await waitFor(() => expect(failing.cell('c').querySelector('[data-gl-code-failed]')).not.toBeNull());
    down = false;
    failing.setData('/meta/rev', 2);
    await waitFor(() => expect(text(failing.cell('c'), 500)).toBe('line 500'));
    expect(failing.cell('c').querySelector('[data-gl-code-failed]')).toBeNull();
  });

  it('offers Retry under the redline of a file that could not be read at all', async () => {
    let down = true;
    const file = (q: FileQuery): Promise<FileSlice> => (down ? Promise.reject(new Error('socket hang up')) : Promise.resolve(slice(q, 50)));
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('flaky.ts')`, {host: {file}});
    const cell = view.cell('c');
    await waitFor(() => expect(cell.querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_FILE'));
    down = false;
    fireEvent.click(within(cell).getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(text(cell, 3)).toBe('line 3'));
    expect(cell.querySelector('[data-gl-state="redline"]')).toBeNull();
  });
});

describe('DiffView: wording and the list header (F046, F003)', () => {
  const empty = (q: {range: string}): Promise<DiffPayload> => Promise.resolve({range: q.range, files: [], totals: {files: 0, add: 0, del: 0}, rev: 1});
  const emptyText = async (spec: string) => {
    const view = renderExpress(`root=Page('T',[d])\nd=${spec}`, {host: {diff: empty}});
    const found = await waitFor(() => {
      const state = view.cell('d').querySelector('[data-gl-state="empty"]');
      if (!state) throw new Error('not empty yet');
      return state.textContent;
    });
    view.unmount();
    return found;
  };

  it('says what is empty in plain words, never "wt"', async () => {
    expect(await emptyText('DiffView()')).toBe('no uncommitted changes');
    expect(await emptyText("DiffView('staged')")).toBe('no staged changes');
    expect(await emptyText("DiffView('main..HEAD')")).toBe('no changes in main..HEAD');
    expect(await emptyText("DiffView('wt','src/a.ts')")).toBe('no uncommitted changes to src/a.ts');
    expect(await emptyText("DiffView('HEAD~8..HEAD','src/a.ts')")).toBe('no changes to src/a.ts in HEAD~8..HEAD');
  });

  it('keeps the list header in its own column: the range can shorten, the totals are whole, a zero is dim', async () => {
    const payload: DiffPayload = structuredClone(HOST_FIXTURES.diff);
    payload.files[0] = {...payload.files[0]!, del: 0};
    const view = renderExpress(`root=Page('T',[d])\nd=DiffView('feature/a-very-long-branch-name..HEAD')`, {host: {diff: () => Promise.resolve(payload)}});
    const cell = view.cell('d');
    await waitFor(() => expect(cell.querySelectorAll('[role="option"]')).toHaveLength(2));
    const head = cell.querySelector('[role="listbox"]')!.previousElementSibling as HTMLElement;
    // the range and the count are separate boxes (the range gives way first), with the whole text as the tooltip
    const meta = head.firstElementChild as HTMLElement;
    expect(meta.getAttribute('title')).toBe('feature/a-very-long-branch-name..HEAD · 2 files');
    expect([...meta.children].map(part => part.textContent)).toEqual(['feature/a-very-long-branch-name..HEAD', ' · 2 files']);
    // the totals are the last box of the header and belong to the list, not to the file header beside it
    expect(head.lastElementChild!.textContent).toMatch(/^\+\d+ −\d+$/);
    expect(head.parentElement!.contains(head.lastElementChild)).toBe(true);
    // a file without deletions prints "−0" without the red
    const first = cell.querySelector('[role="option"]')!;
    const [add, del] = [...first.lastElementChild!.children];
    expect(add!.hasAttribute('data-add')).toBe(true);
    expect(del!.textContent).toBe('−0');
    expect(del!.hasAttribute('data-del')).toBe(false);
    // a path in the list is a directory that can give way and a file name that stays
    expect(first.querySelector('.gl-path-base')?.textContent).toBe('limiter.ts');
    expect(first.querySelector('.gl-path')?.getAttribute('title')).toBe('src/api/limiter.ts');
  });
});

describe('code scrollers: the scroll cue (F016)', () => {
  it('marks a scroller with more lines below, and clears the mark at the end', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeView('big.ts',size='m')`, {host: {file: q => Promise.resolve(slice(q, 1000))}});
    const cell = view.cell('c');
    await waitFor(() => expect(text(cell, 2)).toBe('line 2'));
    const region = within(cell).getByRole('region');
    Object.defineProperty(region, 'scrollHeight', {configurable: true, value: 20_000});
    fireEvent.scroll(region);
    expect(region.hasAttribute('data-more-y')).toBe(true);
    region.scrollTop = 20_000 - region.clientHeight;
    fireEvent.scroll(region);
    expect(region.hasAttribute('data-more-y')).toBe(false);
  });
});
