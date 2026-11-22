// packages/viewer/test/layout/layout.test.tsx - Page, Section, Plate, Grid, Row and Column from real wire messages.
import {act, fireEvent, screen, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {shareOf} from '../../src/components/layout/Grid.tsx';
import {buildPatch, buildSurface, renderExpress, renderSpec} from '../harness.tsx';

const redlines = (root: HTMLElement) => [...root.querySelectorAll('[data-gl-state="redline"]')].map(el => el.textContent);
const inner = (cell: HTMLElement) => cell.querySelector<HTMLElement>(':scope > .gl-body > *')!;

describe('Page', () => {
  it('renders the masthead with title, subtitle and provenance over the 12-column grid', async () => {
    const view = renderExpress(`root=Page('Atlas',[a,b],'an atlas of the codebase')\na=Text('one',span=7)\nb=Text('two',span=5)`);
    await view.settle();
    const page = view.cell('root');
    expect(page.getAttribute('data-gl')).toBe('Page');
    expect(within(page).getByRole('heading', {level: 1}).textContent).toBe('Atlas');
    expect(within(page).getByText('an atlas of the codebase')).toBeTruthy();
    expect(within(page).getByText('main @ 4f2a91c')).toBeTruthy();
    const container = page.querySelector('.gl-page')!;
    expect(container.getAttribute('data-width')).toBe('page');
    const grid = container.querySelector(':scope > .gl-grid12')!;
    expect([...grid.querySelectorAll('.gl-cell')].map(cell => [cell.getAttribute('data-id'), cell.getAttribute('data-span')])).toEqual([['a', '7'], ['b', '5']]);
    expect(redlines(view.container)).toEqual([]);
    expect(view.errors).toEqual([]);
  });

  it('follows bindings: a bound title and /meta updates', async () => {
    const view = renderExpress(`$/name='First'\nroot=Page($/name,[],width='wide')`);
    await view.settle();
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('First');
    expect(view.container.querySelector('.gl-page')?.getAttribute('data-width')).toBe('wide');
    view.setData('/name', 'Second');
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('Second');
    view.setData('/meta/repo', {name: 'demo', root: '/repo', branch: 'feat/x', head: '0123456789abcdef', dirty: true, shallow: true});
    expect(screen.getByText('feat/x @ 0123456 · dirty · shallow')).toBeTruthy();
  });

  it('shows no provenance outside a git repository, and survives missing or malformed meta', async () => {
    const view = renderExpress(`root=Page('T',[Text('x')])`);
    await view.settle();
    view.setData('/meta/repo', {name: 'plain', root: '/repo', dirty: false});
    expect(view.container.querySelector('[title="branch @ commit"]')).toBeNull();
    view.setData('/meta', null);
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('T');
    view.setData('/meta', {repo: {head: 42, branch: 'main'}});
    expect(screen.getByText('main')).toBeTruthy();
    view.setData('/name', '');
    expect(redlines(view.container)).toEqual([]);
  });

  it('treats a title or caption bound to something that is not text as no text', async () => {
    const view = renderExpress(`$/t={a:1}\nroot=Page($/t,[s,p,d],$/t)\ns=Section($/t,[Text('in section')],$/t)\np=Plate($/t,[Text('in plate')],note=$/t)\nd=DataTable('git.churn',title='Table',note=$/t)`);
    await view.settle();
    expect(view.container.querySelector('[data-code="E_RENDER"]')).toBeNull();
    expect(screen.queryByRole('heading', {level: 1})).toBeNull();
    expect(screen.getByRole('heading', {level: 2}).textContent).toBe('');
    expect(screen.getByText('in section')).toBeTruthy();
    expect(screen.getByText('in plate')).toBeTruthy();
    expect(view.container.querySelector('.gl-frame-note')).toBeNull();
    view.setData('/t', 2026);
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('2026');
  });

  it('renders an empty title as no heading and a child that does not exist yet as nothing', async () => {
    const messages = buildSurface('s', `$/t=''\nroot=Page($/t,[a])\na=Text('here')`);
    const create = messages[0]!;
    if (!('createSurface' in create)) throw new Error('expected createSurface');
    create.createSurface.components = create.createSurface.components.map(c => (c.id === 'root' ? {...c, children: ['a', 'later']} : c));
    const view = renderSpec(messages);
    await view.settle();
    expect(screen.queryByRole('heading', {level: 1})).toBeNull();
    expect(screen.getByText('here')).toBeTruthy();
    view.send({version: '1.0', updateComponents: {surfaceId: 's', components: [{id: 'later', component: 'Text', text: 'arrived'}]}});
    expect(await screen.findByText('arrived')).toBeTruthy();
    expect(redlines(view.container)).toEqual([]);
  });
});

describe('Section', () => {
  it('renders a labelled region with its heading, subtitle and a nested grid', async () => {
    const view = renderExpress(`root=Page('T',[s])\ns=Section('History',[a,b],'what changed')\na=Text('one',span=6)\nb=Text('two',span=6)`);
    await view.settle();
    const region = screen.getByRole('region', {name: 'History'});
    expect(within(region).getByRole('heading', {level: 2}).textContent).toBe('History');
    expect(within(region).getByText('what changed')).toBeTruthy();
    expect([...region.querySelectorAll(':scope > .gl-grid12 .gl-cell')].map(cell => cell.getAttribute('data-id'))).toEqual(['a', 'b']);
    view.send(buildPatch('test', buildSurface('test', `root=Page('T',[s])\ns=Section('History',[a,b],'what changed')\na=Text('one',span=6)\nb=Text('two',span=6)`), `s=Section('Recent history',[b])`));
    await view.settle();
    expect(screen.getByRole('heading', {level: 2}).textContent).toBe('Recent history');
    expect(screen.queryByText('one')).toBeNull();
    expect(view.errors).toEqual([]);
  });
});

describe('Plate', () => {
  const SPEC = `root=Page('T',[p])\np=Plate('Languages',[a,b],note='Counted by lines.')\na=Text('first')\nb=Text('second')`;

  it('draws the numbered frame around its children, with the note as a caption', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    const frame = view.cell('p').querySelector<HTMLElement>('.gl-frame')!;
    expect(frame.getAttribute('data-gl-frame')).toBe('Plate');
    expect(screen.getByRole('region', {name: 'Languages'})).toBe(frame);
    expect(within(frame).getByRole('heading', {level: 3}).textContent).toBe('Languages');
    expect(frame.querySelector('.gl-frame-note')?.textContent).toBe('Counted by lines.');
    expect([...frame.querySelectorAll('.gl-frame-body .gl-cell')].map(cell => cell.getAttribute('data-id'))).toEqual(['a', 'b']);
    // a plate with several children keeps its padding
    expect(frame.hasAttribute('data-flush')).toBe(false);
    // the layout Plate is not framed a second time by the kit
    expect(view.cell('p').hasAttribute('data-framed')).toBe(false);
    expect(view.container.querySelectorAll('.gl-frame')).toHaveLength(1);
  });

  it('collapses on a header double-click and from its disclosure button', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    const frame = view.cell('p').querySelector<HTMLElement>('.gl-frame')!;
    const toggle = within(frame).getByRole('button', {name: 'Collapse plate'});
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.doubleClick(frame.querySelector('.gl-frame-head')!);
    expect(frame.hasAttribute('data-collapsed')).toBe(true);
    expect(within(frame).getByRole('button', {name: 'Expand plate'}).getAttribute('aria-expanded')).toBe('false');
    // collapsed content stays mounted, so opening again is instant
    expect(screen.getByText('first')).toBeTruthy();
    fireEvent.click(within(frame).getByRole('button', {name: 'Expand plate'}));
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
    // a double-click on the button itself is two toggles, not three
    fireEvent.doubleClick(within(frame).getByRole('button', {name: 'Collapse plate'}));
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
  });

  it('starts collapsed without mounting its children, and follows a patch of `collapsed`', async () => {
    const spec = `root=Page('T',[p])\np=Plate('Details',[a],collapsed=true)\na=Text('inside')`;
    const view = renderExpress(spec);
    await view.settle();
    const frame = view.cell('p').querySelector<HTMLElement>('.gl-frame')!;
    expect(frame.hasAttribute('data-collapsed')).toBe(true);
    expect(screen.queryByText('inside')).toBeNull();
    fireEvent.click(within(frame).getByRole('button', {name: 'Expand plate'}));
    expect(await screen.findByText('inside')).toBeTruthy();
    fireEvent.click(within(frame).getByRole('button', {name: 'Collapse plate'}));
    view.send(buildPatch('test', buildSurface('test', spec), `p=Plate('Details',[a],collapsed=false)`));
    await view.settle();
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
  });

  it('gives a single bare table, code view or diagram the whole box', async () => {
    const view = renderExpress(`root=Page('T',[p,q,r])\np=Plate('One table',[DataTable('git.churn')])\nq=Plate('Titled table',[DataTable('git.churn',title='Own frame')])\nr=Plate('Text',[Text('x')])`);
    await view.settle();
    const flush = (id: string) => view.cell(id).querySelector(':scope > .gl-body > .gl-frame')!.hasAttribute('data-flush');
    expect(flush('p')).toBe(true);
    expect(flush('q')).toBe(false);
    expect(flush('r')).toBe(false);
  });
});

describe('Grid', () => {
  const style = (el: HTMLElement, name: string) => el.style.getPropertyValue(name);

  it('lays children out on the tracks `cols` asks for', async () => {
    const view = renderExpress(`root=Page('T',[g,h,i])\ng=Grid([Text('a'),Text('b'),Text('c')],'2:1')\nh=Grid([Text('d'),Text('e')],'3',gap='s')\ni=Grid([Text('f'),Text('g'),Text('h'),Text('i'),Text('j')])`);
    await view.settle();
    const g = inner(view.cell('g'));
    expect(style(g, '--cols')).toBe('minmax(0, 2fr) minmax(0, 1fr)');
    expect(style(g, '--gap')).toBe('20px');
    expect(g.getAttribute('data-tracks')).toBe('2');
    expect(g.querySelectorAll('.gl-cell')).toHaveLength(3);
    const h = inner(view.cell('h'));
    expect(style(h, '--cols')).toBe('minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)');
    expect(style(h, '--gap')).toBe('8px');
    // default: one track per child, at most four
    expect(inner(view.cell('i')).getAttribute('data-tracks')).toBe('4');
  });

  it('gives a child one track while no child names a span', async () => {
    const view = renderExpress(`root=Page('T',[g])\ng=Grid([Text('a'),Text('b'),Text('c')],'3')`);
    await view.settle();
    const g = inner(view.cell('g'));
    expect(style(g, '--gl-c0')).toBe('span 1');
    expect(g.hasAttribute('data-columns')).toBe(false);
    expect([...g.querySelectorAll('.gl-cell')].map(cell => cell.getAttribute('data-span'))).toEqual([null, null, null]);
  });

  it('reads span on 12 columns, as the page does: span=6 twice is two halves, not two full rows (layout-does-the-obvious, V034)', async () => {
    const view = renderExpress(
      `root=Page('T',[g,h,i,j])\ng=Grid([Text('a',span=6),Text('b',span=6)])\nh=Grid([Text('c',span=6),Text('d',span=6)],'1:1')\ni=Grid([Text('map',span=8),Text('tree',span=4)],'2:1')\nj=Grid([Text('files'),Text('code',span=8)],'1:2')`,
    );
    await view.settle();
    const spansOf = (id: string) => [...inner(view.cell(id)).querySelectorAll('.gl-cell')].map(cell => cell.getAttribute('data-span'));
    for (const id of ['g', 'h', 'i', 'j']) {
      const grid = inner(view.cell(id));
      // the 12 columns of the page grid; the cells read data-span against them (styles/base.css)
      expect(grid.getAttribute('data-columns'), id).toBe('12');
      expect(style(grid, '--cols'), id).toBe('repeat(12, minmax(0, 1fr))');
      expect(style(grid, '--gl-c6'), id).toBe('');
    }
    expect(spansOf('g')).toEqual(['6', '6']);
    expect(spansOf('h')).toEqual(['6', '6']);
    expect(spansOf('i')).toEqual(['8', '4']);
    // a child that names no span takes the share its track would have had: 1 of 1:2 is 4 of 12
    expect(spansOf('j')).toEqual(['4', '8']);
    // and a span of 12 is the whole row
    expect(shareOf([1, 1], 0)).toBe(6);
    expect(shareOf([2, 1], 1)).toBe(4);
    expect(shareOf([1, 1, 1, 1], 5)).toBe(3);
  });

  it('follows a patch that adds or drops the spans of its children', async () => {
    const spec = `root=Page('T',[g])\ng=Grid([a,b])\na=Text('a')\nb=Text('b')`;
    const view = renderExpress(spec);
    await view.settle();
    expect(inner(view.cell('g')).hasAttribute('data-columns')).toBe(false);
    view.send(buildPatch('test', buildSurface('test', spec), `a=Text('a',span=7)\nb=Text('b',span=5)`));
    await view.settle();
    expect(inner(view.cell('g')).getAttribute('data-columns')).toBe('12');
    expect([view.cell('a').getAttribute('data-span'), view.cell('b').getAttribute('data-span')]).toEqual(['7', '5']);
    view.send(buildPatch('test', buildSurface('test', spec), `a=Text('a')\nb=Text('b')`));
    await view.settle();
    expect(inner(view.cell('g')).hasAttribute('data-columns')).toBe(false);
  });

  it('falls back to the default tracks on a malformed `cols`, renders with no children, and follows a patch', async () => {
    const spec = `root=Page('T',[g,e])\ng=Grid([Text('a'),Text('b')],'wide')\ne=Grid([])`;
    const view = renderExpress(spec);
    await view.settle();
    expect(inner(view.cell('g')).getAttribute('data-tracks')).toBe('2');
    expect(inner(view.cell('e')).getAttribute('data-tracks')).toBe('1');
    view.send(buildPatch('test', buildSurface('test', spec), `g=Grid([Text('a'),Text('b'),Text('c')],'1:1:2',gap='none')`));
    await view.settle();
    expect(inner(view.cell('g')).getAttribute('data-tracks')).toBe('3');
    expect(style(inner(view.cell('g')), '--gap')).toBe('0px');
    expect(redlines(view.container)).toEqual([]);
    expect(view.errors).toEqual([]);
  });

  // `cols` the server never checked (the harness renders without it): the tab draws the guess the server would
  // write, and says what it could not read (W_COLS) until a patch gives it something it can.
  it('draws a guess as the server reads it, and reports a `cols` it cannot read as W_COLS', async () => {
    const spec = `root=Page('T',[g,h])\ng=Grid([Text('a'),Text('b')],'wide')\nh=Grid([Text('c'),Text('d')],'2fr 1fr')`;
    const view = renderExpress(spec);
    await view.settle();
    expect(style(inner(view.cell('h')), '--cols')).toBe('minmax(0, 2fr) minmax(0, 1fr)');
    await waitFor(() => expect(view.stateOf('g')).toBe('W_COLS'));
    expect(view.reports.filter(report => report.code === 'W_COLS')).toEqual([
      {code: 'W_COLS', message: "Grid#g: cols 'wide' is not a count or a ratio: drawn as equal columns. Write '3' or '2:1'", surfaceId: 'test', name: 'Grid', componentId: 'g', text: "cols 'wide' is not a count or a ratio: drawn as equal columns. Write '3' or '2:1'"},
    ]);
    expect(view.stateOf('h')).toBe('OK');
    view.send(buildPatch('test', buildSurface('test', spec), `g=Grid([Text('a'),Text('b')],'1:3')`));
    await waitFor(() => expect(view.stateOf('g')).toBe('OK'));
    expect(style(inner(view.cell('g')), '--cols')).toBe('minmax(0, 1fr) minmax(0, 3fr)');
  });
});

describe('Row and Column', () => {
  it('Row shares the width by span, wraps by default, and maps gap and align', async () => {
    const view = renderExpress(`root=Page('T',[r,s])\nr=Row([Text('a',span=2),Text('b')])\ns=Row([Text('c')],gap='l',align='center',wrap=false)`);
    await view.settle();
    const r = inner(view.cell('r'));
    expect(r.hasAttribute('data-wrap')).toBe(true);
    expect(r.style.getPropertyValue('--gap')).toBe('12px');
    expect(r.style.getPropertyValue('--align')).toBe('stretch');
    const [a, b] = [...r.querySelectorAll<HTMLElement>('.gl-cell')];
    expect(a!.style.getPropertyValue('--gl-span')).toBe('2');
    expect(b!.style.getPropertyValue('--gl-span')).toBe('');
    const s = inner(view.cell('s'));
    expect(s.hasAttribute('data-wrap')).toBe(false);
    expect(s.style.getPropertyValue('--gap')).toBe('32px');
    expect(s.style.getPropertyValue('--align')).toBe('center');
  });

  it('Column stacks with a 12 px gap unless told otherwise', async () => {
    const spec = `root=Page('T',[c])\nc=Column([Text('a'),Text('b')])`;
    const view = renderExpress(spec);
    await view.settle();
    const c = inner(view.cell('c'));
    expect(c.style.getPropertyValue('--gap')).toBe('12px');
    expect(c.style.getPropertyValue('--align')).toBe('stretch');
    expect([...c.querySelectorAll('.gl-cell')].map(cell => cell.textContent)).toEqual(['a', 'b']);
    view.send(buildPatch('test', buildSurface('test', spec), `c=Column([Text('a'),Text('b'),Text('c')],'none','end')`));
    await view.settle();
    expect(c.style.getPropertyValue('--gap')).toBe('0px');
    expect(c.style.getPropertyValue('--align')).toBe('flex-end');
    expect(c.querySelectorAll('.gl-cell')).toHaveLength(3);
  });

  it('containers hold other containers and many children without trouble', async () => {
    const texts = Array.from({length: 300}, (_, i) => `Text('t${i}')`).join(',');
    const view = renderExpress(`root=Page('T',[Row([Column([Grid([Row([Text('deep')])])])]),Column([${texts}])])`);
    await view.settle();
    expect(screen.getByText('deep')).toBeTruthy();
    expect(screen.getByText('t299')).toBeTruthy();
    expect(redlines(view.container)).toEqual([]);
    act(() => view.unmount());
  });
});
