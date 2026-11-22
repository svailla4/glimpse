// packages/viewer/test/shell/stub.tsx - renders a spec through implement() and the real kit slots with views the
// test supplies, so kit tests do not depend on any component package being finished.
import {A2uiSurface, type ReactCatalogComponent} from '@a2ui/react';
import {Catalog, MessageProcessor, type ActionPayload} from '@a2ui/web_core/v1_0';
import {CATALOG_ID, COMPONENTS, calcFunctions, type A2uiMessage, type DataClient} from '@glimpse/catalog';
import {createFixtureHost} from '@glimpse/catalog/fixtures';
import {buildSurface, type BuildSurfaceOptions} from '@glimpse/catalog/testing';
import {act, render} from '@testing-library/react';
import {KitProvider, createRedefinitions, implement, kitSlots, type ChunkLoaders, type GlView, type RenderReport, type ViewModule} from '../../src/kit/index.ts';
import {installLayout} from '../harness.tsx';

/** Containers render their children; everything else renders its name. */
const fallback = (name: string): GlView<any> => ({props, child}) => (
  <div data-stub={name}>
    {Array.isArray(props.children) ? props.children.map((token: any) => child(token)) : null}
    {child(props.start)}
    {child(props.end)}
  </div>
);

/** Lets the states queued in the task that just ran (they are coalesced to its end) reach `reports`. */
export const flushReports = () => act(async () => { await Promise.resolve(); });

export function renderStub(spec: string, views: Record<string, GlView<any>>, options: BuildSurfaceOptions = {}, host: Partial<DataClient> = {}) {
  installLayout();
  const all: Record<string, GlView<any>> = {};
  for (const def of COMPONENTS) all[def.name] = views[def.name] ?? fallback(def.name);
  const module: ViewModule = {views: all};
  const loaders: ChunkLoaders = {layout: module, content: module, table: module, charts: module, diagrams: module, code: module};
  const catalog = new Catalog<ReactCatalogComponent>(CATALOG_ID, '1.0', COMPONENTS.map(def => implement(def as never, loaders, kitSlots)), calcFunctions());
  const actions: ActionPayload[] = [];
  const reports: RenderReport[] = [];
  const states: RenderReport[] = [];
  const report = (state: RenderReport) => {
    states.push(state);
    if (state.code !== 'OK') reports.push(state);
  };
  const redefinitions = createRedefinitions();
  const processor = new MessageProcessor<ReactCatalogComponent>([catalog], action => void actions.push(action));
  processor.processMessages(structuredClone(buildSurface('test', spec, options)) as never);
  const surface = processor.model.getSurface('test')!;
  const view = render(<KitProvider host={createFixtureHost(host)} report={report} watch={redefinitions.watch}><A2uiSurface surface={surface} /></KitProvider>);
  return {
    ...view,
    surface,
    actions,
    /** The states other than OK the components reported for the host, in order (await flushReports() first). */
    reports,
    /** Every state reported, OK included. */
    states,
    /** Applies more messages, and tells the cells of the components an update names, as the shell does. */
    send: (messages: readonly A2uiMessage[]) => act(() => {
      processor.processMessages(structuredClone(messages) as never);
      redefinitions.applied(messages);
    }),
    cell: (id: string) => view.container.querySelector<HTMLElement>(`.gl-cell[data-id="${id}"]`)!,
    setData: (path: string, value: unknown) => act(() => void surface.dataModel.set(path, structuredClone(value))),
    getData: (path: string): unknown => surface.dataModel.get(path),
    settle: async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); },
  };
}
