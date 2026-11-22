// packages/viewer/test/harness.tsx  (first version by WP0; owned by the viewer kit)
// Renders real A2UI v1.0 messages through the real components, the real kit and a FixtureHost, under jsdom.
// Component tests in test/<chunk>/ use nothing else:
//
//   const view = renderExpress(`root=Page('T',[t])\nt=DataTable('git.churn',title='Churn')`, {datasets: 'ready'});
//   const table = await screen.findByRole('table');           // lazy chunks resolve asynchronously: use findBy*
//   view.send(buildPatch(...)); view.setData('/ui/sel', ...); view.actions; view.host.calls; view.cell('t')
//   view.reports, view.stateOf('t')    the state each component tells the host (reports-are-component-state): I_/W_/E_ codes; states has OK too
//
//   renderSpec(messages, options)      messages as the server would send them (fixtures, hand-written wire JSON)
//   renderExpress(spec, options)       Express source -> the server's snapshot (refs expanded, /ds /ui /meta filled)
//
// Isolation between component packages. The harness builds the catalog the way src/catalog.ts does (implement() over
// COMPONENTS and the six chunk index files; 'layout' and 'content' eager, the other four lazy) but loads each chunk
// index on its own and tolerates a failure: a chunk whose index.ts cannot be imported (a missing file, a syntax
// error, a throw at module scope) turns into an E_RENDER redline on that chunk's components only, and every other
// chunk's tests keep running. `chunks` and `chunkErrors` say what loaded. The harness never imports src/catalog.ts;
// test/harness.test.tsx checks that file and that all six chunks load (a shared gate that can go red because of any
// package). Run your own directories while you work: `npx vitest run packages/viewer/test/table`.
//
// jsdom has no layout, so the harness installs a fake one (see installLayout): every element reports the size given
// in `size` (default 960 x 600), ResizeObserver fires once on observe, and the few DOM methods jsdom lacks are
// stubbed. That is enough for useSize, @tanstack/react-virtual and SVG text measuring. RTL's cleanup() (automatic
// between tests) unmounts; the fakes are removed with it.
import {A2uiSurface, type ReactCatalogComponent} from '@a2ui/react';
import {Catalog, MessageProcessor, type ActionPayload, type SurfaceModel} from '@a2ui/web_core/v1_0';
import {CATALOG_ID, COMPONENTS, PROTOCOL_VERSION, calcFunctions, type A2uiMessage, type Chunk, type DataClient, type LinkStatus} from '@glimpse/catalog';
import {createFixtureHost, type FixtureHost} from '@glimpse/catalog/fixtures';
import {buildSurface, type BuildSurfaceOptions} from '@glimpse/catalog/testing';
import {act, render} from '@testing-library/react';
import {useSyncExternalStore, type ReactNode} from 'react';
import {afterEach} from 'vitest';
import {KitProvider, createRedefinitions, implement, kitSlots, type ChunkLoaders, type RenderReport, type ViewModule} from '../src/kit/index.ts';

export {buildPatch, buildSurface} from '@glimpse/catalog/testing';
export {DATASET_FIXTURES, HOST_FIXTURES, createFixtureHost, datasetFixture, errorDataset, pendingDataset} from '@glimpse/catalog/fixtures';

// ---------------------------------------------------------------- chunks
// Each import is spelled out so the bundler can see it. They are loaded up front, so React.lazy resolves within a
// tick instead of after a module transform.
const CHUNK_IMPORTS: Record<Chunk, () => Promise<ViewModule>> = {
  layout: () => import('../src/components/layout/index.ts'),
  content: () => import('../src/components/content/index.ts'),
  table: () => import('../src/components/table/index.ts'),
  code: () => import('../src/components/code/index.ts'),
  charts: () => import('../src/components/charts/index.ts'),
  diagrams: () => import('../src/components/diagrams/index.ts'),
};
const CHUNK_NAMES = Object.keys(CHUNK_IMPORTS) as Chunk[];
const settled = await Promise.allSettled(CHUNK_NAMES.map(name => CHUNK_IMPORTS[name]()));

/** The chunk index modules that loaded, by chunk name. A chunk that failed to load is absent (see chunkErrors). */
export const chunks: Partial<Record<Chunk, ViewModule>> = {};
/** Why a chunk index failed to import, by chunk name. Empty when everything loads. */
export const chunkErrors: Partial<Record<Chunk, Error>> = {};
settled.forEach((result, i) => {
  const name = CHUNK_NAMES[i]!;
  if (result.status === 'fulfilled' && result.value?.views) chunks[name] = result.value;
  else {
    const reason: unknown = result.status === 'rejected' ? result.reason : new Error('the module does not export `views`');
    chunkErrors[name] = new Error(`components/${name}/index.ts failed to load: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
});

const LAZY: ReadonlySet<Chunk> = new Set(['table', 'code', 'charts', 'diagrams']);
/** Loaded eager chunks are passed as modules, loaded lazy chunks as resolved loaders, broken chunks as loaders that reject. */
const LOADERS = Object.fromEntries(
  CHUNK_NAMES.map(name => {
    const loaded = chunks[name];
    if (!loaded) return [name, () => Promise.reject(chunkErrors[name])];
    return [name, LAZY.has(name) ? () => Promise.resolve(loaded) : loaded];
  }),
) as ChunkLoaders;

/** A fresh catalog (A2uiSurface mutates the one it renders), equivalent to createGlimpseCatalog(kitSlots). */
function createTestCatalog(): Catalog<ReactCatalogComponent> {
  return new Catalog<ReactCatalogComponent>(CATALOG_ID, PROTOCOL_VERSION, COMPONENTS.map(def => implement(def as never, LOADERS, kitSlots)), calcFunctions());
}

export interface RenderSpecOptions {
  /** Replaces methods of the FixtureHost (for example a 100k-row `rows` stub). Calls are still recorded in `host.calls`. */
  host?: Partial<DataClient>;
  /** Data-model writes applied after the messages, as JSON pointer -> value: {'/ds/git_churn': dataset, '/ui/file': 'a.ts'}. */
  data?: Record<string, unknown>;
  /** Size every element reports in the fake layout. Default {width: 960, height: 600}. false: leave jsdom untouched. */
  size?: {width: number; height: number} | false;
  /** Surface to render when the messages create several. Default: the first one created. */
  surfaceId?: string;
  /** State of the link the views see through useLinkStatus(). Default 'live'. */
  link?: LinkStatus;
  /** Wraps the surface inside KitProvider: extra providers, a sized container, a `.gl-page` grid. */
  wrapper?: (surface: ReactNode) => ReactNode;
}

export interface RenderedSpec {
  processor: MessageProcessor<ReactCatalogComponent>;
  /** The rendered surface. A getter: after a delete + create it is the new SurfaceModel. */
  readonly surface: SurfaceModel<ReactCatalogComponent>;
  surfaceId: string;
  container: HTMLElement;
  /** Every action dispatched so far (gl_select, gl_open, agent events), as the server would receive it. */
  actions: ActionPayload[];
  /** Everything reported on the processor's error channel ({code, message, ...}): messages rejected by send() and render-time errors. Usually asserted empty. */
  errors: unknown[];
  /**
   * Every state other than OK a component reported to the host, in order, as the shell would post it (decisions show-reports-what-tab-drew,
   * reports-are-component-state): {code: an I_*, W_* or E_* code, message: 'Name#id: ...', surfaceId, componentId}. A component reports its
   * state when its cell mounts, when it changes and again when an update names it (send() does that), so the same
   * state can appear more than once. States arrive at the end of the task: await (findBy, waitFor, settle) first.
   */
  reports: RenderReport[];
  /** Everything reported, OK included (an OK withdraws what the component said before). */
  states: RenderReport[];
  /** The current state of each component that reported one: component id -> 'OK' or the code. */
  stateOf(componentId: string): string | undefined;
  host: FixtureHost;
  /** Text written to the clipboard so far. */
  clipboard: string[];
  /** Applies more messages (a patch, a dataset update) inside act(). Rejected messages land in `errors`. */
  send(messages: A2uiMessage | readonly A2uiMessage[]): void;
  /** Writes one data-model value inside act(). */
  setData(path: string, value: unknown): void;
  /** Reads one data-model value. */
  getData<T = unknown>(path: string): T | undefined;
  /** The `.gl-cell` of a component id; throws when it is not mounted. */
  cell(componentId: string): HTMLElement;
  /** Awaits pending lazy chunks, effects and resolved fetches. Prefer findBy* queries; use this before asserting absence. */
  settle(): Promise<void>;
  unmount(): void;
}

// ---------------------------------------------------------------- fake layout
const DEFAULT_SIZE = {width: 960, height: 600};
let restoreLayout: (() => void) | undefined;

/**
 * Makes jsdom answer layout questions: offsetWidth / offsetHeight / clientWidth / clientHeight and
 * getBoundingClientRect report `size`; ResizeObserver calls back once, synchronously, on observe(); scrollTo (on
 * elements and on the window),
 * scrollIntoView, Element.animate, matchMedia, SVG getBBox / getComputedTextLength (6.5 px per character) exist.
 * renderSpec calls it for you; it is exported for tests that render without the harness.
 */
export function installLayout(size: {width: number; height: number} = DEFAULT_SIZE): void {
  restoreLayout?.();
  const undo: Array<() => void> = [];
  const define = (target: object, key: string, descriptor: PropertyDescriptor, force = true) => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    if (!force && typeof (target as Record<string, unknown>)[key] === 'function') return;
    Object.defineProperty(target, key, {configurable: true, ...descriptor});
    undo.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else delete (target as Record<string, unknown>)[key];
    });
  };
  const rect = () => ({x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, width: size.width, height: size.height, toJSON: () => ({})});

  for (const key of ['offsetWidth', 'clientWidth', 'scrollWidth']) define(HTMLElement.prototype, key, {get: () => size.width});
  for (const key of ['offsetHeight', 'clientHeight']) define(HTMLElement.prototype, key, {get: () => size.height});
  define(Element.prototype, 'getBoundingClientRect', {value: rect, writable: true});

  class FakeResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe(target: Element) {
      const box = [{inlineSize: size.width, blockSize: size.height}];
      const entry = {target, contentRect: rect(), borderBoxSize: box, contentBoxSize: box, devicePixelContentBoxSize: box};
      this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  define(globalThis, 'ResizeObserver', {value: FakeResizeObserver, writable: true});

  // Things jsdom does not implement at all: only added when missing.
  const noop = () => {};
  // jsdom's window.scrollTo only logs "not implemented"; a test that spies on it keeps its spy.
  if (!('mock' in window.scrollTo)) define(window, 'scrollTo', {value: noop, writable: true});
  define(Element.prototype, 'scrollTo', {value: noop, writable: true}, false);
  define(Element.prototype, 'scrollIntoView', {value: noop, writable: true}, false);
  define(Element.prototype, 'animate', {
    writable: true,
    value: () => ({finished: Promise.resolve(), cancel: noop, finish: noop, play: noop, pause: noop, addEventListener: noop, removeEventListener: noop, onfinish: null}),
  }, false);
  define(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({matches: false, media: query, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false}),
  }, false);
  const textWidth = (el: Element) => (el.textContent?.length ?? 0) * 6.5;
  define(SVGElement.prototype, 'getComputedTextLength', {writable: true, value(this: SVGElement) { return textWidth(this); }}, false);
  define(SVGElement.prototype, 'getBBox', {writable: true, value(this: SVGElement) { return {x: 0, y: 0, width: textWidth(this), height: 14}; }}, false);

  restoreLayout = () => {
    for (const step of undo.reverse()) step();
    restoreLayout = undefined;
  };
}

/** Removes the fake layout (automatic after each test). */
export function uninstallLayout(): void {
  restoreLayout?.();
}

let restoreClipboard: (() => void) | undefined;
function installClipboard(sink: string[]): void {
  restoreClipboard?.();
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {writeText: (text: string) => { sink.push(text); return Promise.resolve(); }, readText: () => Promise.resolve(sink.at(-1) ?? '')},
  });
  restoreClipboard = () => {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
    restoreClipboard = undefined;
  };
}

afterEach(() => {
  uninstallLayout();
  restoreClipboard?.();
});

// ---------------------------------------------------------------- render
/** The lenient configuration the real viewer uses (design 2.6); strictness lives in the server. */
const VIEWER_VALIDATION = {allowUnknownElements: false, allowDanglingReferences: true, allowOrphanComponents: true, allowMissingRoot: true};

function firstSurfaceId(messages: readonly A2uiMessage[]): string | undefined {
  for (const message of messages) if ('createSurface' in message) return message.createSurface.surfaceId;
  return undefined;
}

/**
 * Renders messages through the real components. Throws when a message is rejected, so a broken fixture fails loudly.
 * The messages are cloned first: the data model keeps references to what it is given.
 */
export function renderSpec(messages: A2uiMessage | readonly A2uiMessage[], options: RenderSpecOptions = {}): RenderedSpec {
  const list = (Array.isArray(messages) ? messages : [messages]) as readonly A2uiMessage[];
  const surfaceId = options.surfaceId ?? firstSurfaceId(list);
  if (!surfaceId) throw new Error('renderSpec: the messages create no surface');
  if (options.size === false) uninstallLayout();
  else installLayout(options.size ?? DEFAULT_SIZE);

  const actions: ActionPayload[] = [];
  const errors: unknown[] = [];
  const reports: RenderReport[] = [];
  const states: RenderReport[] = [];
  const report = (state: RenderReport) => {
    states.push(state);
    if (state.code !== 'OK') reports.push(state);
  };
  const redefinitions = createRedefinitions();
  const clipboard: string[] = [];
  installClipboard(clipboard);
  const host = createFixtureHost(options.host);
  const processor = new MessageProcessor<ReactCatalogComponent>([createTestCatalog()], action => void actions.push(action), {
    validationConfig: VIEWER_VALIDATION,
  });
  processor.model.onError.subscribe(error => void errors.push(error));

  const rejected = processor.processMessagesWithErrors(structuredClone(list));
  if (rejected.length > 0) throw new Error(`renderSpec: ${rejected.length} message(s) rejected: ${JSON.stringify(rejected[0])}`);
  const current = () => processor.model.getSurface(surfaceId);
  for (const [path, value] of Object.entries(options.data ?? {})) current()?.dataModel.set(path, structuredClone(value));

  // Re-render when the surface object changes (delete + create), the way the shell does.
  let version = 0;
  const listeners = new Set<() => void>();
  const bump = () => { version++; for (const listener of listeners) listener(); };
  const created = processor.onSurfaceCreated(bump);
  const deleted = processor.onSurfaceDeleted(bump);
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => void listeners.delete(listener); };

  function Host() {
    const tick = useSyncExternalStore(subscribe, () => version);
    const surface = current();
    const node = surface ? <A2uiSurface key={tick} surface={surface} /> : null;
    return <KitProvider host={host} link={options.link} report={report} watch={redefinitions.watch}>{options.wrapper ? options.wrapper(node) : node}</KitProvider>;
  }
  const rendered = render(<Host />);

  return {
    processor,
    get surface() {
      const surface = current();
      if (!surface) throw new Error(`surface "${surfaceId}" does not exist (it was deleted)`);
      return surface;
    },
    surfaceId,
    container: rendered.container,
    actions,
    errors,
    reports,
    states,
    stateOf: componentId => states.findLast(state => state.componentId === componentId)?.code,
    host,
    clipboard,
    send(more) {
      const batch = structuredClone(Array.isArray(more) ? more : [more]);
      // Rejections are reported on the processor's error channel, which `errors` already listens to. The cells of
      // the components an update names say their state again, as in the shell.
      act(() => {
        processor.processMessagesWithErrors(batch);
        redefinitions.applied(batch);
      });
    },
    setData(path, value) {
      act(() => void current()?.dataModel.set(path, structuredClone(value)));
    },
    getData<T>(path: string) {
      return current()?.dataModel.get(path) as T | undefined;
    },
    cell(componentId) {
      const cell = [...rendered.container.querySelectorAll<HTMLElement>('.gl-cell')].find(c => c.getAttribute('data-id') === componentId);
      if (!cell) throw new Error(`no .gl-cell for component "${componentId}". Mounted: ${[...rendered.container.querySelectorAll('.gl-cell')].map(c => c.getAttribute('data-id')).join(', ')}`);
      return cell;
    },
    async settle() {
      for (let i = 0; i < 10; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    },
    unmount() {
      created.unsubscribe();
      deleted.unsubscribe();
      rendered.unmount();
    },
  };
}

export interface RenderExpressOptions extends RenderSpecOptions, Omit<BuildSurfaceOptions, 'data'> {}

/**
 * Compiles Express the way the server would for a new surface and renders it. Source refs and default sources
 * become /ds bindings filled with pending envelopes (default) or the ready fixture datasets ({datasets: 'ready'}).
 * `data` is written to the data model after creation (JSON pointer -> value), like in renderSpec.
 * The surface id is 'test' unless options.surfaceId says otherwise. Throws on a spec the compiler rejects.
 */
export function renderExpress(spec: string, options: RenderExpressOptions = {}): RenderedSpec {
  const {datasets, meta, ui, ...rest} = options;
  const surfaceId = rest.surfaceId ?? 'test';
  return renderSpec(buildSurface(surfaceId, spec, {datasets, meta, ui}), {...rest, surfaceId});
}
