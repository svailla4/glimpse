// SegmentedBar: part-to-whole with slot colours, folding into "other", selection dimming and the legend's keyboard.
import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, errorDataset, renderExpress} from '../harness.tsx';

const state = (cell: HTMLElement) => cell.querySelector('[data-gl-state]')?.getAttribute('data-gl-state');
const code = (cell: HTMLElement) => cell.querySelector('[data-gl-state="redline"]')?.getAttribute('data-code');
const segments = (cell: HTMLElement) => [...cell.querySelectorAll<HTMLElement>('[data-segment]')];
const legend = (cell: HTMLElement) => [...cell.querySelectorAll<HTMLElement>('ul button')];

describe('SegmentedBar', () => {
  it('draws the default source: pending, then one segment per language in its assigned ink, with a legend', async () => {
    const view = renderExpress(`root=Page('T',[langs])\nlangs=SegmentedBar(title='Languages')`);
    const cell = view.cell('langs');
    expect(cell.getAttribute('data-framed')).toBe('true');
    expect(state(cell)).toBe('drafting');
    view.setData('/ds/files_langs', datasetFixture('files.langs'));
    await waitFor(() => expect(segments(cell)).toHaveLength(6));
    expect(segments(cell).map(segment => segment.getAttribute('data-segment'))).toEqual(['TypeScript', 'CSS', 'Go', 'SQL', 'Markdown', 'JSON']);
    // widths are proportional to the value role (loc); inks come from /meta/slots, so a language keeps its colour across plates
    expect(segments(cell).map(segment => segment.style.flexGrow)).toEqual(['2530', '700', '400', '270', '210', '100']);
    expect(segments(cell).map(segment => segment.style.background)).toEqual([1, 2, 3, 4, 5, 6].map(slot => `var(--gl-cat-${slot})`));
    expect(legend(cell).map(entry => entry.textContent)).toEqual(['TypeScript60.1%', 'CSS16.6%', 'Go9.5%', 'SQL6.4%', 'Markdown5%', 'JSON2.4%']);
    expect(within(cell).getByRole('img').getAttribute('aria-label')).toBe('Segmented bar, 6 segments, largest TypeScript 60.1%');
    expect(view.errors).toEqual([]);
  });

  it('takes label= and value=, sums duplicate labels and counts rows when there is no value field', async () => {
    const view = renderExpress(
      `$/rows=[{owner:'Mira',lang:'TypeScript',loc:300},{owner:'Jon',lang:'Go',loc:100},{owner:'Mira',lang:'CSS',loc:'100'}]
root=Page('T',[a,b])
a=SegmentedBar($/rows,'owner','loc')
b=SegmentedBar('code.todos','tag')`,
      {datasets: 'ready'},
    );
    expect(legend(view.cell('a')).map(entry => entry.textContent)).toEqual(['Mira80%', 'Jon20%']);
    // no slots are assigned to these labels: inks are taken in order
    expect(segments(view.cell('a')).map(segment => segment.style.background)).toEqual(['var(--gl-cat-1)', 'var(--gl-cat-2)']);
    expect(legend(view.cell('b')).map(entry => entry.textContent)).toEqual(['TODO33.3%', 'FIXME33.3%', 'HACK33.3%']);
  });

  it('merges segments under 2% and beyond the eighth ink into "other", and reports rows it had to leave out', async () => {
    const rows = [
      ...Array.from({length: 10}, (_, i) => ({name: `m${i}`, loc: 100})),
      {name: 'tiny-a', loc: 3},
      {name: 'tiny-b', loc: 2},
      {name: 'zero', loc: 0},
      {name: 'negative', loc: -5},
      {name: 'text', loc: 'many'},
      {loc: 10},
      null,
    ];
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[a])\na=SegmentedBar($/rows)`, {data: {'/rows': rows}});
    const cell = view.cell('a');
    const labels = segments(cell).map(segment => segment.getAttribute('data-segment'));
    expect(labels).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'other (4)']);
    expect(segments(cell).at(-1)!.style.background).toBe('var(--gl-cat-other)');
    expect(segments(cell).at(-1)!.style.flexGrow).toBe('205');
    expect(cell.textContent).toContain('5 rows without a positive value left out');
    // the merged segment is not an entity
    fireEvent.click(segments(cell).at(-1)!);
    expect(view.actions).toEqual([]);
  });

  it('click selects: the mark is outlined, the rest dims, and a selection made elsewhere is mirrored', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=SegmentedBar('git.authors','author','commits')`, {datasets: 'ready'});
    const cell = view.cell('a');
    const first = segments(cell)[0]!;
    const name = first.getAttribute('data-segment')!;
    fireEvent.click(first);
    expect(view.getData('/ui/sel')).toEqual({type: 'author', id: name, label: name});
    await waitFor(() => expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'a'}));
    expect(segments(cell).map(segment => segment.hasAttribute('data-selected'))).toEqual(segments(cell).map((_, i) => i === 0));
    expect(segments(cell).slice(1).every(segment => segment.hasAttribute('data-dimmed'))).toBe(true);
    expect(legend(cell)[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(legend(cell).slice(1).every(entry => entry.hasAttribute('data-dimmed'))).toBe(true);
    // another component selects the second author
    const second = segments(cell)[1]!.getAttribute('data-segment')!;
    view.setData('/ui/sel', {type: 'author', id: second});
    await waitFor(() => expect(segments(cell)[1]!.hasAttribute('data-selected')).toBe(true));
    expect(first.hasAttribute('data-dimmed')).toBe(true);
    // a selection it does not contain dims nothing
    view.setData('/ui/sel', {type: 'file', id: 'README.md', path: 'README.md'});
    await waitFor(() => expect(cell.querySelector('[data-dimmed]')).toBeNull());
  });

  it('the legend is one tab stop: arrows, Home and End rove; Enter selects; Escape clears', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=SegmentedBar('files.langs')`, {datasets: 'ready'});
    const entries = legend(view.cell('a'));
    expect(entries.map(entry => entry.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    entries[0]!.focus();
    fireEvent.keyDown(entries[0]!, {key: 'ArrowRight'});
    expect(document.activeElement).toBe(entries[1]);
    fireEvent.keyDown(entries[1]!, {key: 'End'});
    expect(document.activeElement).toBe(entries[5]);
    fireEvent.keyDown(entries[5]!, {key: 'ArrowLeft'});
    expect(document.activeElement).toBe(entries[4]);
    fireEvent.keyDown(entries[4]!, {key: 'Enter'});
    expect(view.getData('/ui/sel')).toEqual({type: 'row', id: 'Markdown', label: 'Markdown'});
    fireEvent.keyDown(entries[4]!, {key: 'Home'});
    expect(document.activeElement).toBe(entries[0]);
    fireEvent.keyDown(entries[0]!, {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  it('shows the value and share of the segment under the pointer', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=SegmentedBar('files.langs')`, {datasets: 'ready'});
    fireEvent.pointerMove(segments(view.cell('a'))[1]!, {clientX: 40, clientY: 12});
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('CSS700 · 16.6%');
    fireEvent.pointerLeave(segments(view.cell('a'))[1]!);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('covers error, empty, wrong shape, all zeros, one datum and a binding update', async () => {
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[a,b])\na=SegmentedBar($/rows,title='Bound',size='s')\nb=SegmentedBar()`);
    expect(state(view.cell('a'))).toBe('empty');
    expect(view.cell('a').getAttribute('data-size')).toBe('s');
    view.setData('/ds/files_langs', errorDataset('files.langs', 'E_INTERNAL', 'scan failed'));
    await waitFor(() => expect(code(view.cell('b'))).toBe('E_INTERNAL'));
    view.setData('/rows', 'TypeScript 60%');
    await waitFor(() => expect(code(view.cell('a'))).toBe('E_SHAPE'));
    view.setData('/rows', [1, 2, 3]);
    await waitFor(() => expect(view.cell('a').textContent).toContain('expected rows (a list of objects), received number'));
    view.setData('/rows', [{lang: 'Go', loc: 0}, {lang: 'CSS', loc: 0}]);
    await waitFor(() => expect(state(view.cell('a'))).toBe('empty'));
    view.setData('/rows', [{lang: 'Go', loc: 12}]);
    await waitFor(() => expect(legend(view.cell('a')).map(entry => entry.textContent)).toEqual(['Go100%']));
    view.setData('/rows', [{lang: 'Go', loc: 1}, {lang: 'x'.repeat(500), loc: 3}]);
    await waitFor(() => expect(segments(view.cell('a')).map(segment => segment.style.flexGrow)).toEqual(['1', '3']));
    // the plate survives every state
    expect(within(view.cell('a')).getByRole('heading', {name: 'Bound'})).toBeTruthy();
  });
});
