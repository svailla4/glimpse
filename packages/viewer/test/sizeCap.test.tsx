// packages/viewer/test/sizeCap.test.tsx  (owned by the viewer kit)
// Decision D20: useSizeCap() gives a view its maximum height in px, from its own cell's size step and its family,
// with the very numbers implement() puts in the cell's --gl-h. Stub views, as a component package writes them.
import {A2uiSurface, type ReactCatalogComponent} from '@a2ui/react';
import {Catalog, MessageProcessor} from '@a2ui/web_core/v1_0';
import {CATALOG_ID, COMPONENTS} from '@glimpse/catalog';
import {act, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import {DEFAULT_CAP, implement, sizeCap, useSizeCap, type ChunkLoaders, type GlView, type KitSlots, type ViewModule} from '../src/kit/index.ts';

const Probe: GlView<any> = ({id}) => <output data-testid={id}>{useSizeCap()}</output>;
const Container: GlView<any> = ({id, props, child}) => (
  <div>
    <output data-testid={id}>{useSizeCap()}</output>
    {(props.children ?? []).map((token: any) => child(token))}
    {child(props.start)}
    {child(props.end)}
  </div>
);

function makeCatalog() {
  const views: Record<string, GlView<any>> = {};
  for (const def of COMPONENTS) views[def.name] = def.family === 'layout' ? Container : Probe;
  const mod: ViewModule = {views};
  const loader = async () => mod;
  const loaders: ChunkLoaders = {layout: mod, content: mod, table: loader, charts: loader, diagrams: loader, code: loader};
  const slots: KitSlots = {
    Frame: ({children}) => <section className="gl-frame"><div className="gl-body">{children}</div></section>,
    Drafting: () => <i>drafting</i>,
    Redline: ({code, message}) => <b>{code} {message}</b>,
  };
  return new Catalog<ReactCatalogComponent>(CATALOG_ID, '1.0', COMPONENTS.map(def => implement(def as never, loaders, slots)), []);
}

function renderComponents(components: Array<Record<string, unknown>>) {
  const processor = new MessageProcessor<ReactCatalogComponent>([makeCatalog()]);
  const children = components.filter(c => !components.some(other => other.start === c.id || other.end === c.id)).map(c => c.id);
  const errors = processor.processMessagesWithErrors([{version: '1.0', createSurface: {surfaceId: 's', catalogId: CATALOG_ID, components: [
    {id: 'root', component: 'Page', title: 'Caps', children}, ...components,
  ]}}] as never);
  expect(errors).toEqual([]);
  return render(<A2uiSurface surface={processor.model.getSurface('s')!} />);
}

const capOf = async (id: string) => Number((await screen.findByTestId(id)).textContent);
const cellOf = (dom: HTMLElement, id: string) => dom.querySelector(`.gl-cell[data-id="${id}"]`) as HTMLElement;

const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
function setViewportHeight(px: number) {
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: px});
  act(() => void window.dispatchEvent(new Event('resize')));
}
afterEach(() => {
  if (innerHeight) Object.defineProperty(window, 'innerHeight', innerHeight);
});

describe('useSizeCap (D20: size is a maximum height)', () => {
  it('answers the size step in px, and the cell gets the same height', async () => {
    const {container} = renderComponents([
      {id: 's', component: 'DataTable', data: [{a: 1}], size: 's'},
      {id: 'm', component: 'Graph', size: 'm'},
      {id: 'l', component: 'CodeView', size: 'l'},
      {id: 'xl', component: 'Text', text: 'x', size: 'xl'},
    ]);
    expect([await capOf('s'), await capOf('m'), await capOf('l'), await capOf('xl')]).toEqual([160, 280, 420, 640]);
    for (const id of ['s', 'm', 'l', 'xl']) expect(cellOf(container, id).style.getPropertyValue('--gl-h'), id).toBe(`${await capOf(id)}px`);
  });

  it('without a size step: 640 for the diagram family, 420 for every other family', async () => {
    renderComponents([
      {id: 'graph', component: 'Graph'},
      {id: 'flow', component: 'Flowchart', data: {edges: [['A', 'B']]}},
      {id: 'erd', component: 'ERDiagram', data: {tables: []}},
      {id: 'table', component: 'DataTable', data: [{a: 1}]},
      {id: 'code', component: 'CodeView'},
      {id: 'prose', component: 'Text', text: 'x'},
      {id: 'spark', component: 'Sparkline', data: [1, 2, 3]},
    ]);
    expect([await capOf('graph'), await capOf('flow'), await capOf('erd')]).toEqual([640, 640, 640]);
    expect([await capOf('table'), await capOf('code'), await capOf('prose'), await capOf('spark')]).toEqual([420, 420, 420, 420]);
  });

  it("fill follows the window: its height minus the masthead, never under 420", async () => {
    setViewportHeight(1000);
    renderComponents([{id: 'fill', component: 'CodeView', size: 'fill'}, {id: 'fixed', component: 'CodeView', size: 'm'}]);
    expect(await capOf('fill')).toBe(840);
    setViewportHeight(500);
    expect(await capOf('fill')).toBe(420);
    setViewportHeight(1200);
    expect(await capOf('fill')).toBe(1040);
    expect(await capOf('fixed')).toBe(280);
  });

  it("counts the cell's own step only: a child of a sized container without a size gets its family default", async () => {
    renderComponents([
      {id: 'split', component: 'Split', start: 'left', end: 'right', size: 's'},
      {id: 'left', component: 'DataTable', data: [{a: 1}]},
      {id: 'right', component: 'Graph'},
    ]);
    expect([await capOf('split'), await capOf('left'), await capOf('right')]).toEqual([160, 420, 640]);
  });

  it('outside a component it answers the default', () => {
    render(<Probe id="loose" props={{} as never} child={() => null} />);
    expect(Number(screen.getByTestId('loose').textContent)).toBe(DEFAULT_CAP);
  });

  it('sizeCap() is the rule itself', () => {
    expect(sizeCap('s', 'diagram', 0)).toBe(160);
    expect(sizeCap(undefined, 'diagram', 0)).toBe(640);
    expect(sizeCap(undefined, 'data', 0)).toBe(420);
    expect(sizeCap(undefined, undefined, 0)).toBe(420);
    expect(sizeCap('huge', 'diagram', 0)).toBe(640); // an unknown step is no step
    expect(sizeCap('toString', 'data', 0)).toBe(420); // nor is an inherited property name
    expect(sizeCap('fill', 'data', 900.6)).toBe(741);
    expect(sizeCap('fill', 'data', 0)).toBe(420);
  });
});
