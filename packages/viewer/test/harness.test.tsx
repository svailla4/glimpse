// packages/viewer/test/harness.test.tsx  (WP0, frozen)
// Proves the test harness itself: real catalog, FixtureHost, fake layout, message and data plumbing. It makes no
// assumption about which components are implemented, so it keeps passing as the component packages land.
import {COMPONENT_BY_NAME, type A2uiMessage, type Rows} from '@glimpse/catalog';
import gallery from '@glimpse/catalog/fixtures/gallery.wire.json';
import {useVirtualizer} from '@tanstack/react-virtual';
import {act, screen, waitFor} from '@testing-library/react';
import {useEffect, useRef, useState} from 'react';
import {describe, expect, it} from 'vitest';
import {kitSlots, useHost, useSize, useTooltip} from '../src/kit/index.ts';
import {buildPatch, buildSurface, chunkErrors, chunks, datasetFixture, installLayout, renderExpress, renderSpec} from './harness.tsx';

const hasView = (name: string) => {
  const def = COMPONENT_BY_NAME.get(name);
  return def ? name in (chunks[def.chunk]?.views ?? {}) : false;
};
const redlines = (root: HTMLElement, code_: string) => [...root.querySelectorAll(`[data-gl-state="redline"][data-code="${code_}"]`)];

describe('shared gate: the six chunks and the app catalog', () => {
  // These two tests fail when ANY component package breaks its chunk index. Tests in test/<chunk>/ do not.
  it('every chunk index loads and exports `views`', () => {
    expect(Object.fromEntries(Object.entries(chunkErrors).map(([name, error]) => [name, error.message]))).toEqual({});
    expect(Object.keys(chunks).sort()).toEqual(['charts', 'code', 'content', 'diagrams', 'layout', 'table']);
    for (const [chunk, module] of Object.entries(chunks)) {
      for (const [name, view] of Object.entries(module.views)) {
        expect(COMPONENT_BY_NAME.get(name)?.chunk, `${name} is exported by components/${chunk}/index.ts`).toBe(chunk);
        expect(typeof view, name).toMatch(/^(function|object)$/);
      }
    }
  });

  it('src/catalog.ts builds the app catalog with every component', async () => {
    const {createGlimpseCatalog} = await import('../src/catalog.ts');
    const catalog = createGlimpseCatalog(kitSlots);
    expect([...catalog.components.keys()].sort()).toEqual([...COMPONENT_BY_NAME.keys()].sort());
  });
});

describe('renderSpec', () => {
  it('renders the gallery fixture through the real catalog: no crash, and a redline for every component without a view', async () => {
    const view = renderSpec(gallery as A2uiMessage[]);
    await view.settle();
    expect(view.surfaceId).toBe('gallery');
    expect(view.errors).toEqual([]);
    const root = view.cell('root');
    expect(root.getAttribute('data-gl')).toBe('Page');
    expect(root.getAttribute('data-family')).toBe('layout');
    // nothing throws while rendering
    expect(redlines(view.container, 'E_RENDER').map(el => el.textContent)).toEqual([]);
    // each mounted component either has a view or says so
    const cells = [...view.container.querySelectorAll<HTMLElement>('.gl-cell')];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const name = cell.getAttribute('data-gl')!;
      expect(COMPONENT_BY_NAME.has(name), name).toBe(true);
      const own = redlines(cell, 'E_NOT_IMPLEMENTED').filter(el => el.closest('.gl-cell') === cell);
      expect(own.length, `${name}#${cell.getAttribute('data-id')}`).toBe(hasView(name) ? 0 : 1);
      if (own[0]) expect(own[0].textContent).toContain(`${name}#${cell.getAttribute('data-id')}`);
    }
  });

  it('exposes the processor, the surface, the data model and the cells', async () => {
    const messages = buildSurface('s', `$/note='first'\nroot=Page('T',[a,b])\na=Text($/note,span=4)\nb=DataTable('git.churn top=3',title='Churn',size='m',span=8)`, {datasets: 'ready'});
    const view = renderSpec(messages, {data: {'/extra': {n: 1}}});
    await view.settle();
    expect(view.surface.id).toBe('s');
    expect(view.processor.model.getSurface('s')).toBe(view.surface);
    expect(view.getData('/note')).toBe('first');
    expect(view.getData('/extra')).toEqual({n: 1});
    expect(view.getData('/ui')).toEqual({sel: null, file: null});
    expect(view.getData<{repo: {name: string}}>('/meta')?.repo.name).toBe('demo');
    const cell = view.cell('b');
    expect(cell.getAttribute('data-gl')).toBe('DataTable');
    expect(cell.getAttribute('data-span')).toBe('8');
    expect(cell.getAttribute('data-size')).toBe('m');
    expect(cell.getAttribute('data-framed')).toBe('true');
    expect(cell.querySelector('.gl-frame')).not.toBeNull();
    expect(() => view.cell('nope')).toThrow(/no \.gl-cell for component "nope"/);
  });

  it('send() applies patches and dataset updates, setData() writes the data model, rejected messages land in errors', async () => {
    const base = buildSurface('s', `$/note='first'\nroot=Page('T',[a])\na=Text($/note)`);
    const view = renderSpec(base);
    view.send(buildPatch('s', base, `$/note='second'`));
    expect(view.getData('/note')).toBe('second');
    view.send(buildPatch('s', base, `a=DataTable('git.log top=2')`));
    await waitFor(() => expect(view.cell('a').getAttribute('data-gl')).toBe('DataTable'));
    const ready = datasetFixture<Rows>('git.log top=2');
    expect(view.getData<{status: string}>(`/ds/${ready.$ds}`)?.status).toBe('pending');
    view.send({version: '1.0', updateDataModel: {surfaceId: 's', path: `/ds/${ready.$ds}`, value: ready}});
    expect(view.getData<{status: string; data: Rows}>(`/ds/${ready.$ds}`)).toMatchObject({status: 'ready', data: [{sha: '4f2a91c0d1'}, {sha: '9be01d2a77'}]});
    view.setData('/ui/file', 'src/a.ts#L3');
    expect(view.getData('/ui/file')).toBe('src/a.ts#L3');
    expect(view.errors).toEqual([]);
    view.send({version: '1.0', updateComponents: {surfaceId: 's', components: [{id: 'a', component: 'Text', text: 'x', bogus: true}]}});
    expect(view.errors).toHaveLength(1);
    expect(JSON.stringify(view.errors[0])).toContain('bogus');
  });

  it('follows a replace (deleteSurface + createSurface) to the new surface', async () => {
    const view = renderExpress(`root=Page('Old',[a])\na=Text('one')`, {surfaceId: 's'});
    const before = view.surface;
    view.send([{version: '1.0', deleteSurface: {surfaceId: 's'}}, ...buildSurface('s', `root=Page('New',[b])\nb=Text('two')`)]);
    await waitFor(() => expect(view.cell('b')).toBeTruthy());
    expect(view.surface).not.toBe(before);
    expect(() => view.cell('a')).toThrow();
    expect(view.errors).toEqual([]);
  });

  it('collects actions as the server would receive them', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=Text('x')`);
    await act(async () => { await view.surface.dispatchAction({event: {name: 'gl_open', context: {file: 'src/a.ts#L3'}}} as never, 'a'); });
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]).toMatchObject({name: 'gl_open', surfaceId: 'test', sourceComponentId: 'a', context: {file: 'src/a.ts#L3'}});
  });

  it('throws on messages the viewer would reject and on a spec the compiler rejects', () => {
    expect(() => renderSpec([{version: '1.0', updateDataModel: {surfaceId: 'nowhere', value: 1}}])).toThrow(/create no surface/);
    expect(() => renderSpec([{version: '1.0', createSurface: {surfaceId: 's', catalogId: 'urn:glimpse:catalog:v1', components: [{id: 'root', component: 'Page', title: 'T', children: [], width: 'huge'}]}}])).toThrow(/rejected/);
    expect(() => renderExpress(`root=Page('T',[Nope()])`)).toThrow();
  });
});

describe('renderExpress', () => {
  it('fills source refs with pending envelopes by default and with the fixture datasets on request', () => {
    const pending = renderExpress(`root=Page('T',[DataTable('git.churn'),Stats()])`);
    expect(pending.getData('/ds/git_churn')).toMatchObject({status: 'pending', source: 'git.churn'});
    expect(pending.getData('/ds/repo_kpis')).toMatchObject({status: 'pending', source: 'repo.kpis'});
    pending.unmount();
    const ready = renderExpress(`root=Page('T',[DataTable('git.churn'),Stats()])`, {datasets: 'ready', ui: {file: 'README.md'}, meta: {rev: 7}});
    const churn = ready.getData<{status: string; data: Rows}>('/ds/git_churn');
    expect(churn).toMatchObject({status: 'ready', source: 'git.churn'});
    expect(churn?.data[0]).toMatchObject({path: 'src/auth/service.ts', commits: 51});
    expect(ready.getData('/ui/file')).toBe('README.md');
    expect(ready.getData('/meta/rev')).toBe(7);
  });
});

describe('KitProvider, FixtureHost and the fake layout', () => {
  function Probe() {
    const host = useHost();
    const tip = useTooltip();
    const ref = useRef<HTMLDivElement>(null);
    const size = useSize(ref);
    const [lines, setLines] = useState<number>();
    useEffect(() => {
      void host.file({path: 'src/auth/service.ts'}).then(slice => setLines(slice.lines.length));
    }, [host]);
    return (
      <div ref={ref} data-testid="probe">
        <button type="button" onClick={() => tip.show(<b>tip text</b>, 10, 20)}>show</button>
        <button type="button" onClick={() => tip.hide()}>hide</button>
        <span data-testid="size">{size.width}x{size.height}</span>
        <span data-testid="lines">{lines ?? 'loading'}</span>
      </div>
    );
  }
  const withProbe = (surface: React.ReactNode) => <><Probe />{surface}</>;

  it('provides the FixtureHost, records its calls and accepts overrides', async () => {
    const view = renderExpress(`root=Page('T',[])`, {wrapper: withProbe});
    await waitFor(() => expect(screen.getByTestId('lines').textContent).toBe('29'));
    expect(view.host.calls).toEqual([{method: 'file', args: [{path: 'src/auth/service.ts'}]}]);
    view.unmount();
    const stubbed = renderExpress(`root=Page('T',[])`, {wrapper: withProbe, host: {file: async q => ({path: q.path, lang: 'text', total: 2, start: 1, end: 2, lines: [[['a', 0]], [['b', 0]]], size: 3, rev: 1})}});
    await waitFor(() => expect(screen.getByTestId('lines').textContent).toBe('2'));
    expect(stubbed.host.calls).toHaveLength(1);
  });

  it('gives elements a size: 960 x 600 by default, or the size asked for', () => {
    renderExpress(`root=Page('T',[])`, {wrapper: withProbe});
    expect(screen.getByTestId('size').textContent).toBe('960x600');
    expect(screen.getByTestId('probe').offsetWidth).toBe(960);
    expect(screen.getByTestId('probe').getBoundingClientRect()).toMatchObject({width: 960, height: 600});
  });

  it('honours a custom size and leaves jsdom alone with size: false', () => {
    const view = renderExpress(`root=Page('T',[])`, {wrapper: withProbe, size: {width: 1320, height: 420}});
    expect(screen.getByTestId('size').textContent).toBe('1320x420');
    view.unmount();
    renderExpress(`root=Page('T',[])`, {wrapper: withProbe, size: false});
    expect(screen.getByTestId('size').textContent).toBe('0x0');
  });

  it('shows and hides tooltips through the provider', async () => {
    renderExpress(`root=Page('T',[])`, {wrapper: withProbe});
    act(() => screen.getByRole('button', {name: 'show'}).click());
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('tip text');
    expect(tip.style.left).toBe('22px');
    act(() => screen.getByRole('button', {name: 'hide'}).click());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('records clipboard writes and stubs the DOM methods jsdom lacks', async () => {
    const view = renderExpress(`root=Page('T',[])`);
    await navigator.clipboard.writeText('src/a.ts:3');
    expect(view.clipboard).toEqual(['src/a.ts:3']);
    const el = view.container;
    expect(() => { el.scrollTo(0, 10); el.scrollIntoView(); }).not.toThrow();
    expect(typeof el.animate([{opacity: 0}, {opacity: 1}], 100).cancel).toBe('function');
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.textContent = 'twelve chars';
    expect((text as SVGTextElement).getComputedTextLength()).toBe(78);
  });

  it('lets a virtualized list render only its visible rows', () => {
    function List() {
      const parent = useRef<HTMLDivElement>(null);
      const rows = useVirtualizer({count: 100_000, getScrollElement: () => parent.current, estimateSize: () => 28, overscan: 4});
      return (
        <div ref={parent} data-testid="scroller" style={{height: 600, overflow: 'auto'}}>
          <div style={{height: rows.getTotalSize(), position: 'relative'}}>
            {rows.getVirtualItems().map(item => <div key={item.key} data-row={item.index} style={{position: 'absolute', top: item.start, height: item.size}}>row {item.index}</div>)}
          </div>
        </div>
      );
    }
    const view = renderExpress(`root=Page('T',[])`, {wrapper: surface => <><List />{surface}</>});
    const mounted = view.container.querySelectorAll('[data-row]');
    // 600 px / 28 px = 22 visible rows, plus overscan
    expect(mounted.length).toBeGreaterThanOrEqual(22);
    expect(mounted.length).toBeLessThan(40);
    expect(mounted[0]!.textContent).toBe('row 0');
  });

  it('installLayout can be used on its own and is undone after each test', () => {
    expect(typeof ResizeObserver).toBe('undefined');
    installLayout({width: 100, height: 50});
    expect(document.body.offsetHeight).toBe(50);
    expect(typeof ResizeObserver).toBe('function');
  });

  it('starts every test without the fake layout', () => {
    expect(typeof ResizeObserver).toBe('undefined');
    expect(document.body.offsetWidth).toBe(0);
    expect('clipboard' in navigator && navigator.clipboard !== undefined).toBe(false);
  });
});
