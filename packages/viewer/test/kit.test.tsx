// packages/viewer/test/kit.test.tsx  (first version by WP0; owned by the viewer kit)
// The kit contract: implement() + hooks against the final catalog, with stub views written exactly the way a
// component package writes them. Uses its own stub catalog, so it does not depend on any real component.
import {A2uiSurface, type ReactCatalogComponent} from '@a2ui/react';
import {ActionMessageSchema, Catalog, MessageProcessor, type ActionPayload} from '@a2ui/web_core/v1_0';
import {CATALOG_ID, COMPONENTS, VIEW_BY_NAME, datasetKey, parseRef, type DirNode, type Rows} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {buildSurface} from '@glimpse/catalog/testing';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {describe, expect, it} from 'vitest';
import {useChildIds, useDataset, useFollowedFile, useHostActions, useMeta, useSelection, useSurfaceId} from '../src/kit/hooks.ts';
import {ArrangeContext, PlateAside, borrowView, implement, loadChunk, type ArrangeApi, type ChunkLoaders, type GlView, type KitSlots, type ViewModule} from '../src/kit/implement.tsx';
import {DataGate} from '../src/kit/states.tsx';

const V = '1.0' as const;
const overview = () => buildSurface('overview', VIEW_BY_NAME.get('overview')!.build(undefined, {}));
const browser = () =>
  buildSurface('browser', `root=Page('Browse',[Grid([FileTree(),Column([CodeView(),SymbolOutline()])],'1:2'),Button('Explain',Event('explain',{file:$/ui/file}),'primary'),Ask('Which store?',['Redis','In-memory'],'store')])`);

// ---- stub views, written exactly the way a family package would write them -----------------------------------
const container = (name: string): GlView<any> => ({id, props, child}) => (
  <div data-testid={id} data-view={name} style={{display: 'grid', gap: 8}}>
    {props.title ? <h1 data-testid={`${id}-title`}>{props.title}</h1> : null}
    {(props.children ?? []).map((t: any) => child(t))}
    {child(props.start)}
    {child(props.end)}
  </div>
);
const Tabs: GlView<typeof C.Tabs> = ({id, props, child}) => {
  const [active, setActive] = useState(0);
  return (
    <div data-testid={id}>
      {props.labels.map((l, i) => <button type="button" key={l} onClick={() => setActive(i)}>{l}</button>)}
      <div data-testid={`${id}-panel`}>{child(props.children[active])}</div>
    </div>
  );
};
let renders: string[] = [];
const DataTable: GlView<typeof C.DataTable> = ({id, props}) => {
  const ds = useDataset<Rows>(props.data);
  renders.push(id);
  return <div data-testid={id} data-status={ds.status}>{ds.status === 'ready' ? `${ds.data!.length} rows cols=${props.columns ?? (ds.fields ?? []).map(f => f.key).join(',')}` : ds.message}</div>;
};
const FileTree: GlView<typeof C.FileTree> = ({id, props}) => {
  const ds = useDataset<DirNode>(props.data);
  const {select, selected} = useSelection(id);
  const host = useHostActions(id);
  return (
    <div data-testid={id} data-status={ds.status}>
      <button type="button" onClick={() => select({type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 3})}>pick a.ts</button>
      <button type="button" onClick={() => select({type: 'dir', id: 'src', path: 'src'})}>pick src</button>
      <button type="button" onClick={() => host.open('src/a.ts#L3')}>open a.ts</button>
      <span data-testid={`${id}-sel`}>{selected?.id ?? 'none'}</span>
    </div>
  );
};
const CodeView: GlView<typeof C.CodeView> = ({id, props}) => {
  const file = useFollowedFile(props.file);
  const meta = useMeta();
  return <pre data-testid={id}>{file ?? 'no file'}@{meta?.repo.head}</pre>;
};
const Button: GlView<typeof C.Button> = ({id, props}) => <button type="button" data-testid={id} onClick={() => void props.action()}>{props.label}</button>;
const Ask: GlView<typeof C.Ask> = ({id, props}) => {
  const host = useHostActions(id);
  return <div data-testid={id}>{props.prompt}{props.options.map(o => <button type="button" key={o} onClick={() => host.emit(props.name ?? 'answer', {choice: o})}>{o}</button>)}</div>;
};
const Boom: GlView<any> = () => { throw new Error('boom'); };
const generic = (name: string): GlView<any> => ({id, props}) => <div data-testid={id} data-view={name}>{JSON.stringify(props.data ?? props.text ?? props.file ?? null).slice(0, 60)}</div>;

function makeCatalog(overrides: Record<string, GlView<any> | undefined> = {}) {
  const views: Record<string, GlView<any>> = {};
  for (const def of COMPONENTS) views[def.name] = def.family === 'layout' ? container(def.name) : generic(def.name);
  Object.assign(views, {Tabs, DataTable, FileTree, CodeView, Button, Ask}, overrides);
  delete views.Icicle; // prove the "not implemented" placeholder
  for (const [name, view] of Object.entries(overrides)) if (!view) delete views[name];
  const mod: ViewModule = {views};
  const loader = async () => mod;
  const loaders: ChunkLoaders = {layout: mod, content: mod, table: loader, charts: loader, diagrams: loader, code: loader};
  const slots: KitSlots = {
    Frame: ({id, title, note, aside, children}) => (
      <section className="gl-frame" data-testid={`${id}-frame`}>
        <header data-testid={`${id}-head`}>{title}{aside}</header>
        <div className="gl-body">{children}</div>
        {note ? <footer>{note}</footer> : null}
      </section>
    ),
    Drafting: () => <i className="drafting">drafting</i>,
    Redline: ({code, id, message}) => <b data-testid={`redline-${id}`}>{code} {message}</b>,
  };
  return new Catalog<ReactCatalogComponent>(CATALOG_ID, '1.0', COMPONENTS.map(def => implement(def as never, loaders, slots)), []);
}
const cellOf = (dom: HTMLElement, id: string) => dom.querySelector(`.gl-cell[data-id="${id}"]`) as HTMLElement;

describe('kit contract: implement() + hooks against the final catalog', () => {
  it('renders the expanded overview preset; pending -> ready updates only the bound component', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog()]);
    const errs = processor.processMessagesWithErrors(overview() as never);
    expect(errs).toEqual([]);
    const surface = processor.model.getSurface('overview')!;
    const errors: unknown[] = [];
    surface.onError.subscribe(e => void errors.push(e));
    const {container: dom} = render(<A2uiSurface surface={surface} />);
    await waitFor(() => expect(screen.getByTestId('hot').getAttribute('data-status')).toBe('pending'));
    // bound title resolved from /meta/repo/name
    expect(screen.getByTestId('root-title').textContent).toBe('demo');
    // cell wrapper: span and size
    const cell = dom.querySelector('[data-gl-id="map"]') as HTMLElement;
    expect(cell.getAttribute('data-id')).toBe('map');
    expect(cell.getAttribute('data-span')).toBe('7');
    expect(cell.style.getPropertyValue('--gl-span')).toBe('7');
    expect(cell.getAttribute('data-size')).toBe('l');
    expect(cell.style.getPropertyValue('--gl-h')).toBe('420px');
    expect(cell.getAttribute('data-family')).toBe('chart');
    expect(cell.style.order).toBe('');
    expect(cell.parentElement!.tagName.toLowerCase()).toMatch(/^a2ui-react-treemap/);
    expect((cell.parentElement as HTMLElement).style.display).toBe('contents');
    // a cell without span or size carries neither attribute
    const plain = cellOf(dom, 'kpis');
    expect(plain.hasAttribute('data-span')).toBe(false);
    expect(plain.hasAttribute('data-size')).toBe(false);
    expect(plain.hasAttribute('data-framed')).toBe(false);
    // framed because title is set; langs (Plate) is a layout container, not framed by the kit
    expect(screen.getByTestId('hot-frame').textContent).toContain('Hotspots');
    expect(cellOf(dom, 'hot').getAttribute('data-framed')).toBe('true');
    expect(screen.queryByTestId('langs-frame')).toBeNull();
    // tabs mount only the active child
    expect(dom.querySelectorAll('.gl-cell').length).toBeGreaterThanOrEqual(13);

    renders = [];
    const key = datasetKey(parseRef('git.hotspots top=15'));
    act(() => processor.processMessages({version: V, updateDataModel: {surfaceId: 'overview', path: `/ds/${key}`, value: {
      $ds: key, kind: 'rows', status: 'ready', source: 'git.hotspots top=15', total: 212,
      fields: [{key: 'path', kind: 'path'}, {key: 'commits', kind: 'bar'}], data: [{path: 'a.ts', commits: 3}, {path: 'b.ts', commits: 1}]}}} as never));
    // the columns are whatever the preset asks for; what matters here is that the view saw the new rows
    const columns = String(surface.componentsModel.get('hot')?.properties.columns);
    expect(columns).toContain('path');
    await waitFor(() => expect(screen.getByTestId('hot').textContent).toBe(`2 rows cols=${columns}`));
    expect(new Set(renders)).toEqual(new Set(['hot']));
    // tabs: second child mounts on activation
    expect(screen.getByTestId('side-panel').querySelector('[data-view="List"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'External'}));
    await waitFor(() => expect(screen.getByTestId('side-panel').querySelector('[data-view="List"]')).not.toBeNull());
    // agent patches a data slot
    act(() => processor.processMessages({version: V, updateDataModel: {surfaceId: 'overview', path: '/notes', value: 'hello'}} as never));
    await waitFor(() => expect(screen.getByTestId('notes').textContent).toBe('"hello"'));
    expect(errors).toEqual([]);
  });

  it('selection links components with no props; host actions and agent events come out as v1.0 actions', async () => {
    const actions: ActionPayload[] = [];
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog()], a => void actions.push(a));
    expect(processor.processMessagesWithErrors(browser() as never)).toEqual([]);
    const surface = processor.model.getSurface('browser')!;
    render(<A2uiSurface surface={surface} />);
    const code = await screen.findByTestId('root_children_0_children_1_children_0');
    expect(code.textContent).toBe('no file@4f2a91c');
    fireEvent.click(screen.getByRole('button', {name: 'pick a.ts'}));
    await waitFor(() => expect(code.textContent).toBe('src/a.ts#L3@4f2a91c'));
    expect(surface.dataModel.get('/ui/sel')).toEqual({type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 3});
    expect(screen.getByTestId('root_children_0_children_0-sel').textContent).toBe('src/a.ts');
    fireEvent.click(screen.getByRole('button', {name: 'open a.ts'}));
    fireEvent.click(screen.getByRole('button', {name: 'Explain'}));
    fireEvent.click(screen.getByRole('button', {name: 'Redis'}));
    await waitFor(() => expect(actions.length).toBe(4));
    expect(actions.map(a => a.name)).toEqual(['gl_select', 'gl_open', 'explain', 'store']);
    expect(actions[0]!.context).toEqual({ref: {type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 3}});
    expect(actions[1]).toMatchObject({sourceComponentId: 'root_children_0_children_0', context: {file: 'src/a.ts#L3'}});
    expect(actions[2]!.context).toEqual({file: 'src/a.ts#L3'}); // binding resolved at click time
    expect(actions[3]!.context).toEqual({choice: 'Redis'});
    for (const a of actions) expect(() => ActionMessageSchema.parse({version: V, action: a})).not.toThrow();
    // selecting a directory moves the selection but leaves the followed file alone
    fireEvent.click(screen.getByRole('button', {name: 'pick src'}));
    await waitFor(() => expect(screen.getByTestId('root_children_0_children_0-sel').textContent).toBe('src'));
    expect(surface.dataModel.get('/ui/file')).toBe('src/a.ts#L3');
    expect(code.textContent).toBe('src/a.ts#L3@4f2a91c');
  });

  it('a throwing view and a missing view are contained per component', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog({Callout: Boom})]);
    processor.processMessages({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
      {id: 'root', component: 'Page', title: 'T', children: ['a', 'b', 'c']},
      {id: 'a', component: 'Callout', text: 'x'},
      {id: 'b', component: 'Icicle', data: {name: '', path: '', dir: true, files: 0, loc: 0, bytes: 0}},
      {id: 'c', component: 'Text', text: 'still here'},
    ]}} as never);
    const spy = console.error; console.error = () => {};
    try {
      render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
      await waitFor(() => expect(screen.getByTestId('redline-Callout#a').textContent).toBe('E_RENDER boom'));
      expect((await screen.findByTestId('redline-Icicle#b')).textContent).toContain('E_NOT_IMPLEMENTED');
      expect(screen.getByTestId('c').textContent).toBe('"still here"');
    } finally { console.error = spy; }
  });

  it('a container without a view shows the redline and still renders its children', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog({Page: undefined, Split: undefined, Grid: undefined})]);
    processor.processMessages({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
      {id: 'root', component: 'Page', title: 'T', children: ['g', 's']},
      {id: 'g', component: 'Grid', children: ['a']},
      {id: 'a', component: 'Text', text: 'in grid'},
      {id: 's', component: 'Split', start: 'l', end: 'r'},
      {id: 'l', component: 'Text', text: 'left'},
      {id: 'r', component: 'Text', text: 'right'},
    ]}} as never);
    const {container: dom} = render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
    for (const id of ['Page#root', 'Grid#g', 'Split#s']) expect((await screen.findByTestId(`redline-${id}`)).textContent).toContain('E_NOT_IMPLEMENTED');
    expect(screen.getByTestId('a').textContent).toBe('"in grid"');
    expect(screen.getByTestId('l').textContent).toBe('"left"');
    expect(screen.getByTestId('r').textContent).toBe('"right"');
    // children sit inside their parent's cell
    expect(cellOf(dom, 'g').contains(cellOf(dom, 'a'))).toBe(true);
    expect(cellOf(dom, 'root').contains(cellOf(dom, 's'))).toBe(true);
  });

  it('replace = deleteSurface + createSurface in one batch; a dropped prop does not linger', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog()]);
    const mk = (extra: object) => ({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, dataModel: {ui: {sel: null, file: 'src/keep.ts'}}, components: [
      {id: 'root', component: 'Page', title: 'T', children: ['t']}, {id: 't', component: 'DataTable', data: [{a: 1}], ...extra}]}});
    processor.processMessages(mk({title: 'Old title', columns: 'a:bar'}) as never);
    let force = () => {};
    function Host() {
      const [, setTick] = useState(0);
      force = () => setTick(n => n + 1);
      const s = processor.model.getSurface('s');
      return s ? <A2uiSurface surface={s} /> : null;
    }
    render(<Host />);
    await waitFor(() => expect(screen.getByTestId('t-frame')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('t').textContent).toBe('1 rows cols=a:bar'));
    act(() => { processor.processMessages([{version: V, deleteSurface: {surfaceId: 's'}}, mk({})] as never); force(); });
    await waitFor(() => expect(screen.getByTestId('t').textContent).toBe('1 rows cols='));
    expect(screen.queryByTestId('t-frame')).toBeNull();
  });
});

describe('ArrangeContext: human arrangement of cells (design 12.1.A)', () => {
  // A container the way WP4 writes Page, Section, Grid and Row: its children render inside a provider.
  let setArrangement: (next: Record<string, {span?: number; order?: number}>) => void = () => {};
  const Arranging: GlView<any> = ({id, props, child}) => {
    const [overrides, setOverrides] = useState<Record<string, {span?: number; order?: number}>>({b: {span: 4, order: -1}, c: {order: 2}});
    setArrangement = setOverrides;
    const api: ArrangeApi = {get: componentId => overrides[componentId]};
    return (
      <div data-testid={id}>
        <ArrangeContext.Provider value={api}>{(props.children ?? []).map((t: any) => child(t))}</ArrangeContext.Provider>
      </div>
    );
  };
  const messages = () => ({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
    {id: 'root', component: 'Page', title: 'T', children: ['a', 'b', 'c', 'col']},
    {id: 'a', component: 'Text', text: 'a', span: 6},
    {id: 'b', component: 'Text', text: 'b', span: 6},
    {id: 'c', component: 'Text', text: 'c'},
    {id: 'col', component: 'Column', children: ['d']},
    {id: 'd', component: 'Text', text: 'd', span: 3},
  ]}});

  it('applies order and span overrides by component id, and leaves other cells as specified', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog({Page: Arranging})]);
    processor.processMessages(messages() as never);
    const {container: dom} = render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
    await screen.findByTestId('d');
    // overridden: span replaces the spec's span in the attribute and the variable; order is an inline style
    const b = cellOf(dom, 'b');
    expect(b.getAttribute('data-span')).toBe('4');
    expect(b.style.getPropertyValue('--gl-span')).toBe('4');
    expect(b.style.order).toBe('-1');
    // order only: the spec's (absent) span is kept
    const c = cellOf(dom, 'c');
    expect(c.hasAttribute('data-span')).toBe(false);
    expect(c.style.order).toBe('2');
    // no override: exactly what the spec says
    const a = cellOf(dom, 'a');
    expect(a.getAttribute('data-span')).toBe('6');
    expect(a.style.getPropertyValue('--gl-span')).toBe('6');
    expect(a.style.order).toBe('');
    // a grandchild is not a child of the arranging container: its id has no override
    expect(cellOf(dom, 'd').getAttribute('data-span')).toBe('3');
    expect(cellOf(dom, 'd').style.order).toBe('');
    // every cell is addressable by component id
    expect([...dom.querySelectorAll('.gl-cell')].map(cell => cell.getAttribute('data-id'))).toEqual(['root', 'a', 'b', 'c', 'col', 'd']);

    // the person rearranges: cells follow without a new message
    act(() => setArrangement({a: {span: 12, order: 1}}));
    await waitFor(() => expect(cellOf(dom, 'a').getAttribute('data-span')).toBe('12'));
    expect(cellOf(dom, 'a').style.order).toBe('1');
    expect(cellOf(dom, 'b').getAttribute('data-span')).toBe('6');
    expect(cellOf(dom, 'b').style.getPropertyValue('--gl-span')).toBe('6');
    expect(cellOf(dom, 'b').style.order).toBe('');
    expect(cellOf(dom, 'c').style.order).toBe('');
  });

  it('with no provider nothing changes: cells carry the spec span and no order', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog()]);
    processor.processMessages(messages() as never);
    const {container: dom} = render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
    await screen.findByTestId('d');
    expect(cellOf(dom, 'b').getAttribute('data-span')).toBe('6');
    for (const cell of dom.querySelectorAll<HTMLElement>('.gl-cell')) expect(cell.style.order).toBe('');
  });
});

describe('the box a view is given (design 4.7 rule 2, 8.4)', () => {
  const messages = () => ({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
    {id: 'root', component: 'Page', title: 'T', children: ['bare', 'framed', 'split', 'text']},
    {id: 'bare', component: 'FileTree', data: {name: '', path: '', dir: true, files: 0, loc: 0, bytes: 0}, size: 'fill'},
    {id: 'framed', component: 'CodeView', file: 'a.ts', title: 'Source', size: 'm'},
    {id: 'split', component: 'Split', start: 'l', end: 'r', size: 'l'},
    {id: 'l', component: 'Text', text: 'left'},
    {id: 'r', component: 'Text', text: 'right'},
    {id: 'text', component: 'Text', text: 'plain'},
  ]}});

  it('a sized cell always has one direct child that takes the height: the frame, or a .gl-body around the view', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog()]);
    processor.processMessages(messages() as never);
    const {container: dom} = render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
    await screen.findByTestId('framed');
    // no title: .gl-cell[data-size] > .gl-body > view
    const bare = cellOf(dom, 'bare');
    expect(bare.getAttribute('data-size')).toBe('fill');
    expect(bare.hasAttribute('data-framed')).toBe(false);
    expect([...bare.children].map(el => el.className)).toEqual(['gl-body']);
    expect(screen.getByTestId('bare').parentElement).toBe(bare.firstElementChild);
    // title: .gl-cell[data-size] > .gl-frame > ... .gl-body > view
    const framed = cellOf(dom, 'framed');
    expect(framed.getAttribute('data-framed')).toBe('true');
    expect([...framed.children].map(el => el.className)).toEqual(['gl-frame']);
    expect(screen.getByTestId('framed').closest('.gl-body')!.parentElement).toBe(framed.firstElementChild);
    // a sized layout component (Split) and an unsized leaf get the same plain body
    expect([...cellOf(dom, 'split').children].map(el => el.className)).toEqual(['gl-body']);
    expect([...cellOf(dom, 'text').children].map(el => el.className)).toEqual(['gl-body']);
    expect(cellOf(dom, 'text').hasAttribute('data-size')).toBe(false);
  });
});

describe('PlateAside: view content in the plate header (design 5.1, 12.1.B)', () => {
  const Tool: GlView<any> = ({id}) => (
    <div data-testid={id}>
      <PlateAside><button type="button">Re-layout</button></PlateAside>
      <span>body</span>
    </div>
  );
  const Gated: GlView<typeof C.DataTable> = ({id, props}) => {
    const state = useDataset<Rows>(props.data);
    return <DataGate state={state} id={`DataTable#${id}`}>{rows => <div data-testid={id}>{rows.length} rows</div>}</DataGate>;
  };
  const cut = {$ds: 'k', kind: 'rows', status: 'ready', source: 'git.hotspots top=2', data: [{a: 1}, {a: 2}], total: 212, truncated: {total: 212, returned: 2, strategy: 'topN', by: 'score'}};
  const messages = () => ({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
    {id: 'root', component: 'Page', title: 'T', children: ['framed', 'bare', 'cut', 'cutbare', 'whole']},
    {id: 'framed', component: 'Graph', data: {nodes: [], edges: []}, title: 'Deps'},
    {id: 'bare', component: 'Graph', data: {nodes: [], edges: []}},
    {id: 'cut', component: 'DataTable', data: cut, title: 'Hot'},
    {id: 'cutbare', component: 'DataTable', data: cut},
    {id: 'whole', component: 'DataTable', data: [{a: 1}], title: 'Whole'},
  ]}});

  it('portals into the frame header when there is a plate, and renders in place when there is none', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog({Graph: Tool})]);
    processor.processMessages(messages() as never);
    render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
    const framed = await screen.findByTestId('framed');
    await waitFor(() => expect(screen.getByTestId('framed-head').querySelector('.gl-frame-aside button')?.textContent).toBe('Re-layout'));
    expect(framed.querySelector('button')).toBeNull();
    expect(framed.textContent).toBe('body');
    const bare = await screen.findByTestId('bare');
    expect(bare.querySelector('.gl-aside button')?.textContent).toBe('Re-layout');
  });

  it('DataGate puts the marginal note of cut data there, and nothing when the data is whole', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog({DataTable: Gated})]);
    processor.processMessages(messages() as never);
    const {container: dom} = render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
    expect((await screen.findByTestId('cut')).textContent).toBe('2 rows');
    await waitFor(() => expect(screen.getByTestId('cut-head').querySelector('[data-gl-marginal]')?.textContent).toBe('showing 2 of 212 · top by score'));
    expect(cellOf(dom, 'cut').querySelectorAll('[data-gl-marginal]')).toHaveLength(1);
    expect(cellOf(dom, 'cutbare').querySelector('.gl-aside [data-gl-marginal]')?.textContent).toBe('showing 2 of 212 · top by score');
    expect(cellOf(dom, 'whole').querySelector('[data-gl-marginal]')).toBeNull();
    expect(screen.getByTestId('whole-head').querySelector('.gl-frame-aside')!.childElementCount).toBe(0);
  });
});

// Decision D3: React.lazy suspended on the first render of every component type even when its chunk had arrived, and
// React 19 holds a revealed boundary back by 300 ms, so the first DataTable of a tab reported its empty state after
// the grace of the `show` that drew it.
describe('lazy chunks: a view of a chunk that has arrived renders in the same frame', () => {
  it('draws the view on the first render, with no drafting fallback', async () => {
    const views: ViewModule['views'] = {DataTable: ({id}) => <div data-testid={id}>table</div>};
    const mod: ViewModule = {views};
    const tableChunk = async () => mod;
    const slots: KitSlots = {
      Frame: ({children}) => <section>{children}</section>,
      Drafting: () => <i data-testid="drafting">drafting</i>,
      Redline: ({code, id}) => <b data-testid={`redline-${id}`}>{code}</b>,
    };
    const loaders: ChunkLoaders = {layout: {views: {Page: container('Page')}}, content: {views: {}}, table: tableChunk, charts: tableChunk, diagrams: tableChunk, code: tableChunk};
    const catalog = new Catalog<ReactCatalogComponent>(CATALOG_ID, '1.0', COMPONENTS.map(def => implement(def as never, loaders, slots)), []);
    await loadChunk(tableChunk);
    const processor = new MessageProcessor<ReactCatalogComponent>([catalog]);
    processor.processMessages({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
      {id: 'root', component: 'Page', title: 'T', children: ['t']}, {id: 't', component: 'DataTable', data: []}]}} as never);
    render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
    // synchronously, before any await: the view and not the fallback
    expect(screen.queryByTestId('drafting')).toBeNull();
    expect(screen.getByTestId('t').textContent).toBe('table');
  });
});

describe('borrowView: a view from another chunk, with a fallback', () => {
  const Plain: GlView<typeof C.CodeBlock> = ({id, props}) => <pre data-testid={`${id}-plain`}>{props.code}</pre>;
  const Rich: GlView<typeof C.CodeBlock> = ({id, props}) => <pre data-testid={`${id}-rich`}>{props.lang}:{props.code}</pre>;
  const codeChunk = (views: ViewModule['views']) => async (): Promise<ViewModule> => ({views});
  const cases: Array<[string, GlView<typeof C.CodeBlock>, string]> = [
    ['uses the view when the other chunk has it', borrowView(codeChunk({CodeBlock: Rich}), 'CodeBlock', Plain), 'm-rich'],
    ['falls back when the other chunk has no such view yet', borrowView(codeChunk({}), 'CodeBlock', Plain), 'm-plain'],
    ['falls back when the other chunk fails to load', borrowView(() => Promise.reject(new Error('Failed to resolve import')), 'CodeBlock', Plain), 'm-plain'],
    ['falls back when the borrowed view throws', borrowView(codeChunk({CodeBlock: Boom}), 'CodeBlock', Plain), 'm-plain'],
  ];

  it.each(cases)('%s', async (_label, Code, testId) => {
    const Callout: GlView<typeof C.Callout> = ({id, props}) => <div data-testid={id}><Code id={id} props={{code: props.text, lang: 'ts'}} child={() => null} /></div>;
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog({Callout})]);
    processor.processMessages({version: V, createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
      {id: 'root', component: 'Page', title: 'T', children: ['m', 't']}, {id: 'm', component: 'Callout', text: 'let a'}, {id: 't', component: 'Text', text: 'after'}]}} as never);
    const spy = console.error; console.error = () => {};
    try {
      render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
      const shown = await screen.findByTestId(testId);
      expect(shown.textContent).toBe(testId === 'm-rich' ? 'ts:let a' : 'let a');
      // the borrower itself never shows a redline
      expect(screen.queryByTestId('redline-Callout#m')).toBeNull();
      expect(screen.getByTestId('t').textContent).toBe('"after"');
    } finally { console.error = spy; }
  });
});

describe('useSurfaceId and useChildIds: the ids behind the opaque child tokens (design 12.1)', () => {
  let seen: {surfaceId: string; children: string[]; start: string[]; none: string[]; tokens: unknown[]} | undefined;
  const Probe: GlView<any> = ({id, props, child}) => {
    seen = {surfaceId: useSurfaceId(), children: useChildIds(id), start: useChildIds('sp', 'start'), none: useChildIds('nope'), tokens: props.children};
    const ids = seen.children;
    // the i-th id belongs to the i-th token: an arrangement keyed by id can be applied while rendering tokens
    const api: ArrangeApi = {get: componentId => (componentId === ids[1] ? {span: 5} : undefined)};
    return <div data-testid={id}><ArrangeContext.Provider value={api}>{(props.children ?? []).map((t: any) => child(t))}</ArrangeContext.Provider></div>;
  };
  const messages = () => ({version: V, createSurface: {surfaceId: 'atlas', catalogId: CATALOG_ID, components: [
    {id: 'root', component: 'Page', title: 'T', children: ['a', 'b', 'sp']},
    {id: 'a', component: 'Text', text: 'a'},
    {id: 'b', component: 'Text', text: 'b', span: 4},
    {id: 'c', component: 'Text', text: 'c'},
    {id: 'sp', component: 'Split', start: 'l', end: 'r'},
    {id: 'l', component: 'Text', text: 'left'},
    {id: 'r', component: 'Text', text: 'right'},
  ]}});

  it('give the surface id and the child component ids, which the tokens in props do not', async () => {
    const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog({Page: Probe})]);
    processor.processMessages(messages() as never);
    const {container: dom} = render(<A2uiSurface surface={processor.model.getSurface('atlas')!} />);
    await screen.findByTestId('l');
    expect(seen).toMatchObject({surfaceId: 'atlas', children: ['a', 'b', 'sp'], start: ['l'], none: []});
    expect(seen!.tokens).toHaveLength(3);
    expect(seen!.tokens).not.toEqual(['a', 'b', 'sp']);
    expect(cellOf(dom, 'b').getAttribute('data-span')).toBe('5');
    expect(cellOf(dom, 'a').hasAttribute('data-span')).toBe(false);

    // the agent patches the container: the ids follow, in the new order
    act(() => processor.processMessages({version: V, updateComponents: {surfaceId: 'atlas', components: [{id: 'root', component: 'Page', title: 'T', children: ['c', 'a']}]}} as never));
    await waitFor(() => expect(seen!.children).toEqual(['c', 'a']));
    await waitFor(() => expect(cellOf(dom, 'a').getAttribute('data-span')).toBe('5'));
    // and another component's child prop changes too
    act(() => processor.processMessages({version: V, updateComponents: {surfaceId: 'atlas', components: [{id: 'root', component: 'Page', title: 'T', children: ['c', 'a', 'sp']}, {id: 'sp', component: 'Split', start: 'r', end: 'l'}]}} as never));
    await waitFor(() => expect(seen!.start).toEqual(['r']));
    expect(seen!.children).toEqual(['c', 'a', 'sp']);
  });
});
