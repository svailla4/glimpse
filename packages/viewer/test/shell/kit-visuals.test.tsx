// packages/viewer/test/shell/kit-visuals.test.tsx - the kit modules WP4 owns: plate frame, states, entity text,
// tooltip, icons, formatters and colour helpers.
import type {Dataset, Field} from '@glimpse/catalog';
import {act, fireEvent, render, screen, within} from '@testing-library/react';
import {useRef} from 'react';
import {describe, expect, it, vi} from 'vitest';
import {
  DASH, DataGate, Drafting, Empty, EntityLink, ICON_NAMES, Icon, KitProvider, Marginal, PathText, PlateAside, Redline, catVar, entityClipText, fmtCell,
  fmtDate, fmtNum, marginalText, seqVar, toNumber, useDataset, useSize, useTooltip, type DataState, type GlView,
} from '../../src/kit/index.ts';
import {createFixtureHost, datasetFixture, errorDataset, installLayout, pendingDataset} from '../harness.tsx';
import {renderStub} from './stub.tsx';

describe('plate frame', () => {
  it('frames a titled leaf: numbered header, title, body, caption; and not an untitled one', () => {
    const view = renderStub(`root=Page('T',[a,b])\na=DataTable('git.churn',title='Most changed',note='Last 90 days.',size='m',span=6)\nb=DataTable('git.churn')`, {});
    const cell = view.cell('a');
    const frame = cell.querySelector<HTMLElement>(':scope > .gl-frame')!;
    expect(cell.getAttribute('data-framed')).toBe('true');
    expect(frame.tagName).toBe('SECTION');
    expect(frame.getAttribute('data-gl-frame')).toBe('DataTable');
    expect(screen.getByRole('region', {name: 'Most changed'})).toBe(frame);
    const [head, body, note] = [...frame.children] as HTMLElement[];
    expect(head!.classList.contains('gl-frame-head')).toBe(true);
    expect(within(head!).getByRole('heading', {level: 3}).textContent).toBe('Most changed');
    // the aside slot lives in the header; the view's content in a .gl-body that fills the rest
    expect(head!.querySelector('.gl-frame-aside')).not.toBeNull();
    expect(body!.classList.contains('gl-body')).toBe(true);
    expect(body!.classList.contains('gl-frame-body')).toBe(true);
    expect(body!.querySelector('[data-stub="DataTable"]')).not.toBeNull();
    expect(note!.tagName).toBe('FOOTER');
    expect(note!.textContent).toBe('Last 90 days.');
    // a table gets the whole box
    expect(frame.hasAttribute('data-flush')).toBe(true);
    expect(view.cell('b').querySelector('.gl-frame')).toBeNull();
    expect(view.cell('b').querySelector(':scope > .gl-body > [data-stub="DataTable"]')).not.toBeNull();
    // outside an arranging container the header is not a handle
    expect(head!.hasAttribute('data-arrange')).toBe(false);
    expect(frame.querySelector('.gl-resize')).toBeNull();
  });

  it('keeps padding around a chart, gives code and diagrams the whole box, and follows a bound title', () => {
    const view = renderStub(`$/t='Before'\nroot=Page('T',[c,g,v])\nc=BarChart('git.authors',title=$/t)\ng=Graph(title='G')\nv=CodeView('a.ts',title='V')`, {});
    const flush = (id: string) => view.cell(id).querySelector<HTMLElement>('.gl-frame')!.hasAttribute('data-flush');
    expect([flush('c'), flush('g'), flush('v')]).toEqual([false, true, true]);
    expect(within(view.cell('c')).getByRole('heading', {level: 3}).textContent).toBe('Before');
    view.setData('/t', 'After');
    expect(within(view.cell('c')).getByRole('heading', {level: 3}).textContent).toBe('After');
    // an empty title is no plate at all
    view.setData('/t', '');
    expect(view.cell('c').querySelector('.gl-frame')).toBeNull();
  });

  it('shows the view\'s PlateAside content in the header', () => {
    const Table: GlView<any> = () => <><PlateAside><button type="button">Re-layout</button></PlateAside><p>body</p></>;
    const view = renderStub(`root=Page('T',[a])\na=DataTable('git.churn',title='With a control')`, {DataTable: Table});
    expect(view.cell('a').querySelector('.gl-frame-head .gl-frame-aside button')?.textContent).toBe('Re-layout');
    expect(view.cell('a').querySelector('.gl-frame-body')?.textContent).toBe('body');
  });
});

describe('states', () => {
  it('Drafting, Empty and Redline carry the frozen hooks and say what they stand for', () => {
    const {container} = render(
      <>
        <Drafting />
        <Drafting label="reading git log" />
        <Empty message="no rows bound at /deps/cycles" />
        <Redline code="E_SHAPE" id="Graph#deps" message="expected an object, received a string" />
      </>,
    );
    const [plain, labelled] = [...container.querySelectorAll('[data-gl-state="drafting"]')];
    expect(plain!.textContent).toBe('drafting');
    expect(labelled!.textContent).toBe('reading git log');
    expect(labelled!.getAttribute('role')).toBe('status');
    expect(labelled!.getAttribute('aria-busy')).toBe('true');
    expect(labelled!.querySelectorAll('svg line')).toHaveLength(2);
    expect(container.querySelector('[data-gl-state="empty"]')?.textContent).toBe('no rows bound at /deps/cycles');
    const redline = container.querySelector('[data-gl-state="redline"]')!;
    expect(redline.getAttribute('data-code')).toBe('E_SHAPE');
    expect(redline.getAttribute('role')).toBe('alert');
    expect(redline.textContent).toBe('E_SHAPE Graph#deps expected an object, received a string');
  });

  function Probe(p: {input: unknown}) {
    const state = useDataset<unknown[]>(p.input as never);
    return <DataGate state={state} id="Probe#p">{(rows, s) => <output>{rows.length} rows of {s.total ?? '?'}</output>}</DataGate>;
  }
  const state = (c: HTMLElement) => c.querySelector('[data-gl-state]')?.getAttribute('data-gl-state');

  it('DataGate picks the state from the data: pending, error, empty, ready, unexpanded ref', () => {
    const fixture = datasetFixture<unknown[]>('git.churn');
    const ready = {...fixture, total: fixture.data!.length};
    const cases: Array<[unknown, string | undefined, string]> = [
      [pendingDataset('git.churn', 'reading history'), 'drafting', 'reading history'],
      [errorDataset('git.churn', 'E_NO_GIT', 'not a git repository'), 'redline', 'E_NO_GIT Probe#p not a git repository'],
      [{...ready, data: []}, 'empty', 'no data from git.churn'],
      [undefined, 'empty', 'nothing bound'],
      [[], 'empty', 'no items'],
      [{}, 'empty', 'no entries'],
      ['git.churn src', 'redline', 'E_UNEXPANDED_REF Probe#p source ref "git.churn src" was not expanded by the server'],
      [ready, undefined, `${ready.data!.length} rows of ${ready.total ?? '?'}`],
      [[1, 2, 3], undefined, '3 rows of ?'],
    ];
    for (const [input, expected, text] of cases) {
      const {container, unmount} = render(<Probe input={input} />);
      expect(state(container), text).toBe(expected);
      expect(container.textContent, text).toBe(text);
      unmount();
    }
  });

  it('DataGate puts the marginal note of cut data in the plate header, or above the content without a plate', () => {
    const cut: Dataset = {...datasetFixture('git.churn'), total: 12840, truncated: {total: 12840, returned: 500, strategy: 'topN', by: 'score'}};
    const Table: GlView<any> = ({id, props}) => {
      const state = useDataset<unknown[]>(props.data);
      return <DataGate state={state} id={`DataTable#${id}`}>{rows => <output>{rows.length} rows</output>}</DataGate>;
    };
    const view = renderStub(`root=Page('T',[a,b])\na=DataTable($/cut,title='Cut table')\nb=DataTable($/cut)`, {DataTable: Table}, {data: {cut}});
    expect(view.cell('a').querySelector('.gl-frame-head [data-gl-marginal]')?.textContent).toBe('showing 500 of 12,840 · top by score');
    expect(view.cell('a').querySelector('.gl-frame-body')?.textContent).toMatch(/^\d+ rows$/);
    expect(view.cell('b').querySelector('.gl-body > .gl-aside [data-gl-marginal]')?.textContent).toBe('showing 500 of 12,840 · top by score');
  });

  it('PlateAside renders in place without a plate', () => {
    const {container} = render(<PlateAside><button type="button">Re-layout</button></PlateAside>);
    expect(container.querySelector('.gl-aside button')?.textContent).toBe('Re-layout');
  });
});

describe('marginal note', () => {
  const ready = (extra: Partial<DataState<unknown>>): DataState<unknown> => ({status: 'ready', ...extra});
  it('describes how the data was cut, and says nothing when it was not', () => {
    expect(marginalText(ready({truncated: {total: 12840, returned: 500, strategy: 'topN', by: 'score'}}))).toBe('showing 500 of 12,840 · top by score');
    expect(marginalText(ready({truncated: {total: 3000, returned: 1500, strategy: 'treecut'}}))).toBe('showing 1,500 of 3,000 · tree cut');
    expect(marginalText(ready({truncated: {total: 900, returned: 150, strategy: 'neighborhood'}}))).toBe('showing 150 of 900 · neighbourhood');
    expect(marginalText(ready({data: [1, 2], total: 40}))).toBe('showing 2 of 40');
    expect(marginalText(ready({data: [1, 2], total: 2}))).toBeUndefined();
    expect(marginalText(ready({data: {a: 1}, total: 40}))).toBeUndefined();
    expect(render(<Marginal state={ready({data: [1]})} />).container.innerHTML).toBe('');
    expect(render(<Marginal state={ready({data: [1], total: 5})} />).container.textContent).toBe('showing 1 of 5');
  });
});

describe('entity text', () => {
  it('PathText dims the directory, inks the basename, and shows line and extension', () => {
    const {container, rerender} = render(<PathText file="src/core/ledger/posting.ts#L41-58" />);
    const path = container.querySelector('.gl-path')!;
    expect(path.getAttribute('data-path')).toBe('src/core/ledger/posting.ts');
    expect(path.getAttribute('title')).toBe('src/core/ledger/posting.ts#L41-58');
    expect(path.querySelector('.gl-path-dir')?.textContent).toBe('src/core/ledger/');
    expect(path.querySelector('.gl-path-base')?.textContent).toBe('posting.ts');
    expect(path.querySelector('.gl-path-line')?.textContent).toBe(':41-58');
    expect(path.querySelector('.gl-path-ext')?.textContent).toBe('TS');
    rerender(<PathText file="Makefile" />);
    expect(container.querySelector('.gl-path-dir')).toBeNull();
    expect(container.querySelector('.gl-path-ext')).toBeNull();
    expect(container.textContent).toBe('Makefile');
    rerender(<PathText file="docs/a.b/.gitignore#L3" label="ignore rules" />);
    expect(container.querySelector('.gl-path-base')?.textContent).toBe('ignore rules');
    expect(container.querySelector('.gl-path-line')?.textContent).toBe(':3');
    rerender(<PathText file="" />);
    expect(container.querySelector('.gl-path')).not.toBeNull();
  });

  it('entityClipText is path:line, or the label for entities without a path', () => {
    expect(entityClipText({type: 'file', id: 'a', path: 'src/a.ts', line: 12, endLine: 20})).toBe('src/a.ts:12');
    expect(entityClipText({type: 'dir', id: 'src', path: 'src'})).toBe('src');
    expect(entityClipText({type: 'author', id: 'mira', label: 'Mira'})).toBe('Mira');
    expect(entityClipText({type: 'module', id: 'core/ledger'})).toBe('core/ledger');
  });

  const Entities: GlView<any> = ({id}) => (
    <p>
      <EntityLink entity={{type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 3}} componentId={id}><PathText file="src/a.ts#L3" /></EntityLink>
      <EntityLink entity={{type: 'author', id: 'mira', label: 'Mira'}} componentId={id}>Mira</EntityLink>
    </p>
  );

  it('EntityLink selects on click, opens with Cmd/Ctrl-click or o, copies with c, clears with Escape', () => {
    const clipboard: string[] = [];
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: (text: string) => { clipboard.push(text); return Promise.resolve(); }}});
    try {
      const view = renderStub(`root=Page('T',[x])\nx=Text('placeholder')`, {Text: Entities});
      const [file, author] = [...view.container.querySelectorAll<HTMLButtonElement>('.gl-entity')];
      expect(file!.getAttribute('data-entity-type')).toBe('file');
      expect(file!.type).toBe('button');
      expect(file!.hasAttribute('data-selected')).toBe(false);

      fireEvent.click(file!);
      expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 3});
      expect(view.getData('/ui/file')).toBe('src/a.ts#L3');
      expect(file!.getAttribute('data-selected')).toBe('true');
      expect(author!.hasAttribute('data-selected')).toBe(false);
      expect(view.actions.map(a => [a.name, a.sourceComponentId])).toEqual([['gl_select', 'x']]);

      fireEvent.click(author!);
      expect(view.getData('/ui/sel')).toEqual({type: 'author', id: 'mira', label: 'Mira'});
      // an entity without a path leaves the followed file alone
      expect(view.getData('/ui/file')).toBe('src/a.ts#L3');
      expect(file!.hasAttribute('data-selected')).toBe(false);

      fireEvent.click(file!, {metaKey: true});
      fireEvent.keyDown(file!, {key: 'o'});
      expect(view.actions.filter(a => a.name === 'gl_open').map(a => a.context)).toEqual([{file: 'src/a.ts#L3'}, {file: 'src/a.ts#L3'}]);
      // a Cmd-click opens without changing the selection, and there is nothing to open for an author
      expect(view.getData('/ui/sel')).toEqual({type: 'author', id: 'mira', label: 'Mira'});
      fireEvent.keyDown(author!, {key: 'o'});
      expect(view.actions.filter(a => a.name === 'gl_open')).toHaveLength(2);

      fireEvent.keyDown(file!, {key: 'c'});
      fireEvent.keyDown(author!, {key: 'c'});
      expect(clipboard).toEqual(['src/a.ts:3', 'Mira']);
      // with a modifier the key belongs to the browser (Cmd+C copies the selection)
      fireEvent.keyDown(file!, {key: 'c', metaKey: true});
      expect(clipboard).toHaveLength(2);

      fireEvent.keyDown(author!, {key: 'Escape'});
      expect(view.getData('/ui/sel') ?? null).toBeNull();
      expect(author!.hasAttribute('data-selected')).toBe(false);
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });
});

describe('tooltip', () => {
  function Target() {
    const tip = useTooltip();
    return (
      <>
        <button type="button" onClick={() => tip.show(<b>84 commits</b>, 100, 50)}>near</button>
        <button type="button" onClick={() => tip.show('edge', 990, 590)}>far</button>
        <button type="button" onClick={() => tip.hide()}>hide</button>
      </>
    );
  }
  it('shows below and right of the pointer, flips at the viewport edge, hides, and is inert outside a provider', () => {
    // the tooltip measures 200 x 40 in a 1000 x 600 viewport
    installLayout({width: 200, height: 40});
    const size = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
    const height = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    render(<KitProvider host={createFixtureHost()}><Target /></KitProvider>);
    act(() => screen.getByRole('button', {name: 'near'}).click());
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('84 commits');
    expect([tip.style.left, tip.style.top]).toEqual(['112px', '62px']);
    expect(tip.style.pointerEvents).toBe('none');
    act(() => screen.getByRole('button', {name: 'far'}).click());
    expect([screen.getByRole('tooltip').style.left, screen.getByRole('tooltip').style.top]).toEqual(['778px', '538px']);
    act(() => screen.getByRole('button', {name: 'hide'}).click());
    expect(screen.queryByRole('tooltip')).toBeNull();
    size.mockRestore();
    height.mockRestore();

    const bare = render(<Target />);
    act(() => within(bare.container).getByRole('button', {name: 'near'}).click());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('icons and colours', () => {
  it('every registered icon renders as a decorative 1.5 px stroke glyph', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(20);
    for (const name of ICON_NAMES) {
      const {container, unmount} = render(<Icon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('data-icon'), name).toBe(name);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('stroke-width')).toBe('1.5');
      expect(svg.getAttribute('width')).toBe('14');
      unmount();
    }
    expect(render(<Icon name="refresh" size={16} />).container.querySelector('svg')?.getAttribute('width')).toBe('16');
  });

  it('colour helpers only ever return token variables', () => {
    expect(catVar(1)).toBe('var(--gl-cat-1)');
    expect(catVar(8)).toBe('var(--gl-cat-8)');
    for (const slot of [0, 9, -1, 2.5, Number.NaN]) expect(catVar(slot)).toBe('var(--gl-cat-other)');
    expect(seqVar(1)).toBe('var(--gl-seq-1)');
    expect(seqVar(3.6)).toBe('var(--gl-seq-4)');
    expect(seqVar(99)).toBe('var(--gl-seq-7)');
    expect(seqVar(-4)).toBe('var(--gl-seq-1)');
    expect(seqVar(Number.NaN)).toBe('var(--gl-seq-1)');
  });
});

describe('formatters', () => {
  it('toNumber accepts numbers and numeric strings only', () => {
    expect(toNumber(12)).toBe(12);
    expect(toNumber(' 3.5 ')).toBe(3.5);
    expect(toNumber('1e3')).toBe(1000);
    for (const bad of [null, undefined, '', '  ', 'abc', '12px', Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) expect(toNumber(bad), String(bad)).toBeUndefined();
  });

  it('fmtNum formats each kind, with a real minus sign and a dash for no value', () => {
    expect(fmtNum(12840)).toBe('12,840');
    expect(fmtNum('1284')).toBe('1,284');
    expect(fmtNum(0.126)).toBe('0.13');
    expect(fmtNum(-4)).toBe('−4');
    expect(fmtNum(12840, 'compact')).toBe('12.8k');
    expect(fmtNum(999, 'compact')).toBe('999');
    expect(fmtNum(212_400, 'compact')).toBe('212k');
    expect(fmtNum(2_000_000, 'compact')).toBe('2M');
    expect(fmtNum(3_400_000_000, 'compact')).toBe('3.4B');
    expect(fmtNum(131072, 'bytes')).toBe('131 kB');
    expect(fmtNum(512, 'bytes')).toBe('512 B');
    expect(fmtNum(60.14, 'pct')).toBe('60.1%');
    expect(fmtNum(100, 'pct')).toBe('100%');
    expect(fmtNum(1500, 'duration')).toBe('1.5 s');
    expect(fmtNum(420, 'duration')).toBe('420 ms');
    expect(fmtNum(7_200_000, 'duration')).toBe('2 h');
    for (const none of [null, undefined, Number.NaN, 'n/a', {}]) expect(fmtNum(none)).toBe(DASH);
  });

  it('fmtDate gives a relative age or an absolute day, and a dash for junk', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(fmtDate(ago(5_000), 'rel')).toBe('now');
    expect(fmtDate(ago(3 * 3_600_000 + 1000), 'rel')).toBe('3 h');
    expect(fmtDate(ago(3 * 86_400_000 + 1000), 'rel')).toBe('3 d');
    expect(fmtDate(ago(15 * 86_400_000), 'rel')).toBe('2 wk');
    expect(fmtDate(ago(800 * 86_400_000), 'rel')).toBe('2 y');
    expect(fmtDate('2026-11-12T23:30:00Z', 'abs')).toBe('12 Nov 2026');
    expect(fmtDate('not a date', 'rel')).toBe(DASH);
    expect(fmtDate('', 'abs')).toBe(DASH);
  });

  it('fmtCell formats a value for its field kind and never throws on the wrong type', () => {
    const cell = (value: unknown, field: Partial<Field>) => fmtCell(value, {key: 'k', ...field} as Field);
    expect(cell(1284, {kind: 'num'})).toBe('1,284');
    expect(cell(84, {kind: 'bar', unit: 'commits'})).toBe('84 commits');
    expect(cell('many', {kind: 'num'})).toBe('many');
    expect(cell(2048, {kind: 'bytes'})).toBe('2 kB');
    expect(cell(41.26, {kind: 'pct'})).toBe('41.3%');
    expect(cell(90_000, {kind: 'duration'})).toBe('1.5 min');
    expect(cell(true, {kind: 'bool'})).toBe('✓');
    expect(cell(false, {kind: 'bool'})).toBe(DASH);
    expect(cell('4f2a91c0ffee', {kind: 'commit'})).toBe('4f2a91c');
    expect(cell({add: 120, del: 44}, {kind: 'delta'})).toBe('+120 −44');
    expect(cell('+3', {kind: 'delta'})).toBe('+3');
    expect(cell([1200, 3, null], {kind: 'spark'})).toBe(`1.2k 3 ${DASH}`);
    expect(cell(42, {kind: 'date'})).toBe(DASH);
    expect(cell(['a', {b: 1}], {kind: 'text'})).toBe('a, {"b":1}');
    expect(cell({a: 1}, {})).toBe('{"a":1}');
    expect(cell(7, {unit: 'files'})).toBe('7 files');
    for (const none of [null, undefined, '']) expect(cell(none, {kind: 'num'})).toBe(DASH);
  });
});

describe('useSize', () => {
  it('reports the measured box and {0, 0} without layout', () => {
    function Box() {
      const ref = useRef<HTMLDivElement>(null);
      const {width, height} = useSize(ref);
      return <div ref={ref}>{width}x{height}</div>;
    }
    expect(render(<Box />).container.textContent).toBe('0x0');
    installLayout({width: 640, height: 280});
    expect(render(<Box />).container.textContent).toBe('640x280');
  });
});
