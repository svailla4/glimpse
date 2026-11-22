// packages/viewer/src/kit/implement.tsx
// The ONLY file that touches the @a2ui/react component API. Family directories export plain React views;
// this wraps each one with: grid cell (span/size as data attributes + CSS variables) + plate frame or plain body
// + error boundary + lazy chunk + Suspense. Layout CSS for .gl-cell lives in styles/base.css.
//
// The box a view is given (one rule for the frame, base.css and every view):
//   .gl-cell > .gl-frame > ... .gl-body > view      framed: a non-layout component that takes `title` and has one
//   .gl-cell > .gl-body > view                      everything else
// A view always sits in a .gl-body, which is as tall as the view makes it (decision content-sized-plates). The
// size step is a maximum: base.css caps the .gl-body of a cell that has data-size at `--gl-h`, and a view that
// scrolls reads the same number from useSizeCap() and makes itself min(its content, cap) tall. Charts and Split
// are the exception: for them the size step is the height of the box (base.css), so `height: 100%` fills it.
//
// What a view may rely on, beyond GlViewProps:
// - Ids. `id` is the view's own component id. The tokens in `props.children` / a `child` prop are opaque render
//   handles for `child(token)`; the component ids behind them come from useChildIds(id[, prop]) and the surface id
//   from useSurfaceId() (hooks.ts). Persistence keys (design 12.1) are built from those and useMeta().repo.name.
// - The plate header. Controls and notes that belong in the header go through <PlateAside> (below).
// - Errors. A view that throws shows a redline in its own cell. The boundary lets go of the error when the
//   component's props change (new data, a patch), so a view comes back once what broke it is replaced.
// - Its maximum height. useSizeCap() (sizeCap.ts) answers in px from the cell's `size` step and family (content-sized-plates).
// - Other chunks. A view of another chunk is reused through borrowView() (below), never by importing its file.
// - Styles. Component CSS Modules wrap their content in `@layer gl.components { ... }`; the build checks it.
import {Component, Suspense, createContext, lazy, useContext, useMemo, useState, type FC, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {createComponentImplementation, useA2uiSurface, type ReactCatalogComponent} from '@a2ui/react';
import {hasFrame, type ChildToken, type Chunk, type ComponentDef, type PropMap, type ViewProps} from '@glimpse/catalog';
import type {AnyComponentDef} from '@glimpse/catalog';
import {CellReportContext, Subpart, useCellReporter} from './report.ts';
import {FILL_MIN, FILL_OFFSET, SIZE_STEPS, SizeCellContext, type SizeCell, type SizeStep} from './sizeCap.ts';

/** What every family view receives. */
export interface GlViewProps<D> {
  /** A2UI component id (stable; use for DOM ids, action source, test ids). */
  id: string;
  /** Resolved props: bindings unwrapped, actions as functions, children as opaque tokens. */
  props: ViewProps<D>;
  /** Renders a child token (from a `child`/`children` prop). */
  child: (token: ChildToken | undefined) => ReactNode;
}
export type GlView<D = AnyComponentDef> = FC<GlViewProps<D>>;
/** Shape of packages/viewer/src/components/<chunk>/index.ts */
export interface ViewModule { views: Record<string, GlView<any>> }
/** Eager chunks ('layout', 'content') pass the module itself; lazy chunks pass () => import('./components/<chunk>/index.ts'). */
export type ChunkLoaders = Record<Chunk, ViewModule | (() => Promise<ViewModule>)>;

export interface KitSlots {
  /**
   * Wraps the view when the component has a `title` (plate frame). The frame renders `children` inside an element
   * with class `gl-body` that takes the height left under the header, and renders `aside` inside its header: that
   * is where <PlateAside> content of the view appears.
   */
  Frame: FC<{id: string; def: ComponentDef; title: string; note?: string; aside?: ReactNode; scope?: ReactNode; children: ReactNode}>;
  /** Suspense fallback and "dataset pending" look. */
  Drafting: FC<{label?: string}>;
  /** Error look. */
  Redline: FC<{code: string; id: string; message: string}>;
}

/**
 * Human arrangement of the cells of one container (design 12.1.A). A container view (Page, Section, Grid, Row)
 * wraps its children in <ArrangeContext.Provider>; implement() asks it for the override of each cell it renders.
 * The agent never sees or sends any of this.
 */
export interface ArrangeApi {
  /** Override for a direct child by A2UI component id, or undefined to keep what the spec says. */
  get(componentId: string): {span?: number; order?: number} | undefined;
}
/** No provider (the default) means no overrides: cells render exactly as specified. */
export const ArrangeContext = createContext<ArrangeApi | null>(null);

/**
 * Where the content of <PlateAside> (the plate header) and of the scope row under it goes: the element to portal
 * into; null when the view has no plate (the content renders in place); false while the plate is mounting (the
 * content waits one render instead of flashing in the body first).
 */
type Slot = HTMLElement | null | false;
const AsideContext = createContext<Slot>(null);
const ScopeContext = createContext<Slot>(null);

/** The component a view renders for: what a state (Empty, Redline) reports to the host, and whose plate it sits in. */
export interface CellInfo {
  /** Catalog component name. */
  name: string;
  /** A2UI component id. */
  id: string;
  /** Whether implement() drew the plate frame around the view. */
  framed: boolean;
  /** Whether that plate gives its whole box to the view (no padding): states bring their own inset. */
  flush: boolean;
}
const CellContext = createContext<CellInfo | null>(null);
/** The cell the calling view is rendered in; null outside a component (the shell's own states). */
export function useCell(): CellInfo | null {
  return useContext(CellContext);
}

/**
 * Content a view owns but that belongs in its plate header: the marginal note for truncated data, a "Re-layout"
 * control, a small toolbar (design 5.1, 5.5, 12.1.B). Render it anywhere in the view, usually first:
 *   <PlateAside><button type="button" onClick={relayout}>Re-layout</button></PlateAside>
 * With a plate frame the content is portalled into the frame header. Without one (no `title`) it renders in place,
 * inside <div class="gl-aside">, so put it where a toolbar row at the top of the body reads well.
 * DataGate already renders the Marginal note this way; a view does not repeat it.
 */
export function PlateAside(p: {children: ReactNode}): ReactNode {
  const header = useContext(AsideContext);
  if (header === false) return null;
  return header ? createPortal(p.children, header) : <div className="gl-aside">{p.children}</div>;
}

/**
 * The row under the plate header that says what the plate is scoped to (the drill crumb of DataGate). In place,
 * inside <div class="gl-scope">, when there is no plate. Kit-internal: views get it through DataGate.
 */
export function PlateScope(p: {children: ReactNode}): ReactNode {
  const row = useContext(ScopeContext);
  if (row === false) return null;
  return row ? createPortal(p.children, row) : <div className="gl-scope">{p.children}</div>;
}

const sameProps = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]));
};

interface BoundaryProps {
  id: string;
  name: string;
  Redline: KitSlots['Redline'];
  /** The resolved props of the component: when one of them changes, a caught error is let go and the view renders again. */
  watch: Record<string, unknown>;
  /** Called before the retry (a lazy chunk that failed to load is asked for again). */
  onRetry?: () => void;
  children: ReactNode;
}
interface BoundaryState {
  error?: Error;
  /** The props the view threw on: the retry waits until they are no longer the current ones. */
  failed?: Record<string, unknown>;
}
class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = {};
  static getDerivedStateFromError(error: Error): BoundaryState { return {error, failed: undefined}; }
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return state.error && state.failed === undefined ? {failed: props.watch} : null;
  }
  componentDidUpdate() {
    const {error, failed} = this.state;
    if (error && failed && !sameProps(failed, this.props.watch)) {
      this.props.onRetry?.();
      this.setState({error: undefined, failed: undefined});
    }
  }
  render() {
    const {Redline, id, name, children} = this.props;
    // The redline reports itself to the host (states.tsx), so a render error always reaches the session log.
    return this.state.error ? <Redline code="E_RENDER" id={`${name}#${id}`} message={this.state.error.message || String(this.state.error)} /> : children;
  }
}

class Quiet extends Component<{fallback: ReactNode; children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/**
 * A view that another chunk owns, for use inside your own view (design 5.7: CodeTour uses Steps). Call it once at
 * module scope, with the other chunk's INDEX:
 *   const Steps = borrowView<typeof C.Steps>(() => import('../content/index.ts'), 'Steps', LocalSteps);
 *   ... <Steps id={id} props={{data}} child={() => null} />
 * `Fallback` renders while that chunk loads, when it has no such view yet, when it fails to load and when the
 * borrowed view throws, so your component never depends on another package being finished. Never import another
 * chunk's component file by path. Pass your own component `id`: actions and selection need a real component id.
 * A borrowed view is a part of your component (decision reports-are-component-state): an empty state or a redline it draws is not reported as
 * your component's state. Report what your component as a whole shows with your own <Empty> or useReportState().
 */
export function borrowView<D = AnyComponentDef>(load: () => Promise<ViewModule>, name: string, Fallback: GlView<D>): GlView<D> {
  const Lazy = lazy(async () => {
    const views = await load().then(module => module.views, (): ViewModule['views'] => ({}));
    return {default: (views[name] ?? Fallback) as GlView<D>};
  });
  return function Borrowed(props: GlViewProps<D>) {
    const fallback = <Fallback {...props} />;
    return (
      <Subpart>
        <Quiet fallback={fallback}>
          <Suspense fallback={fallback}><Lazy {...props} /></Suspense>
        </Quiet>
      </Subpart>
    );
  };
}

/** The cell's --gl-h by size step: the same numbers useSizeCap() answers with (sizeCap.ts). */
const SIZE_PX: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SIZE_STEPS).map(([step, px]) => [step, `${px}px`])),
  fill: `max(${FILL_MIN}px, calc(100vh - ${FILL_OFFSET}px))`,
};

/** Families whose view is one table, code view or diagram: the plate gives them the whole box (design 8.3). */
export const FLUSH_FAMILIES: ReadonlySet<string> = new Set(['data', 'diagram', 'code']);

/**
 * Whether implement() draws the plate when the component has a title: the catalog's rule (hasFrame), every
 * non-layout component that carries the frame group title, note and size. Callout and CodeBlock take a `title` of
 * their own (a lead-in, a file label) without that group and draw it themselves.
 */
export function isFrameable(def: {name: string; family: string; props: object}): boolean {
  return hasFrame(def);
}

/**
 * The id of the component whose plate implement() already drew around the calling view; null when there is none.
 * The kit Frame reads it: a view that wraps itself in <Frame> for its own id gets no second plate.
 */
export const FramedContext = createContext<string | null>(null);

type LazyLoader = () => Promise<ViewModule>;

/**
 * The lazy chunk modules that have arrived, by loader. React.lazy suspends on its first render even when the module
 * is already here (a promise settles a tick later), and React 19 then holds the revealed boundary back for 300 ms:
 * the whole grace a `show` gives a live tab to report what it drew (decision show-reports-what-tab-drew), and a needless drafting flash. A
 * view of a chunk that has arrived therefore renders at once.
 */
const arrived = new WeakMap<LazyLoader, ViewModule>();

/** Runs a lazy chunk's loader, and remembers the module once it is here. Every load of a lazy chunk goes through it. */
export function loadChunk(loader: LazyLoader): Promise<ViewModule> {
  return loader().then(module => {
    arrived.set(loader, module);
    return module;
  });
}

/** The lazy component of one view of a lazy chunk; already resolved when the chunk has arrived (see `arrived`). */
function lazyView(loader: LazyLoader, pick: (module: ViewModule) => FC<GlViewProps<any>>): FC<GlViewProps<any>> {
  return lazy(() => {
    const ready = arrived.get(loader);
    if (!ready) return loadChunk(loader).then(module => ({default: pick(module)}));
    // A thenable that calls back at once: React.lazy then takes the view in this very render.
    const value = {default: pick(ready)};
    // biome-ignore lint/suspicious/noThenProperty: a settled thenable is the point; a Promise would call back a tick later
    return {then: (resolve: (loaded: typeof value) => void) => resolve(value)} as unknown as Promise<typeof value>;
  }) as unknown as FC<GlViewProps<any>>;
}

export function implement<N extends string, P extends PropMap>(
  def: ComponentDef<N, P>,
  loaders: ChunkLoaders,
  slots: KitSlots,
): ReactCatalogComponent {
  const {Frame, Drafting, Redline} = slots;
  // A component without a view shows a redline and still renders its children, so an unfinished container
  // does not hide the finished components inside it.
  const childProps = Object.entries(def.props).filter(([, prop]) => prop.kind === 'child' || prop.kind === 'children').map(([key]) => key);
  const Missing: GlView<any> = ({id, props, child}) => (
    <>
      <Redline code="E_NOT_IMPLEMENTED" id={`${def.name}#${id}`} message="No view registered." />
      {childProps.flatMap(key => (Array.isArray(props[key]) ? props[key] : [props[key]])).map((token: ChildToken | undefined) => child(token))}
    </>
  );
  const loader = loaders[def.chunk];
  // React.lazy keeps a rejection for good, so a chunk that failed to load gets a new lazy component when the
  // boundary retries.
  const load = typeof loader === 'function' ? () => lazyView(loader, module => module.views[def.name] ?? Missing) : undefined;
  let Loaded: FC<GlViewProps<any>> | undefined = load?.();
  const retry = load ? () => { Loaded = load(); } : undefined;
  const View: FC<GlViewProps<any>> =
    typeof loader === 'function'
      ? props => {
          const Current = Loaded as FC<GlViewProps<any>>;
          return <Current {...props} />;
        }
      : (loader.views[def.name] ?? Missing);
  const frameable = isFrameable(def);
  const hasNote = 'note' in def.props;
  const flush = FLUSH_FAMILIES.has(def.family);
  const api = {
    name: def.name,
    schema: def.schema,
    ...(def.allowedParents ? {allowedParents: def.allowedParents} : {}),
    ...(def.allowedChildren ? {allowedChildren: def.allowedChildren} : {}),
  };
  return createComponentImplementation(api as never, ({props, buildChild, context}: any) => {
    const id: string = context.componentModel.id;
    const arranged = useContext(ArrangeContext)?.get(id);
    const [header, setHeader] = useState<HTMLElement | null>(null);
    const [scope, setScope] = useState<HTMLElement | null>(null);
    const span: number | undefined = arranged?.span ?? props.span ?? undefined;
    const child = (token: ChildToken | undefined): ReactNode =>
      token == null ? null : typeof token === 'string' ? buildChild(token) : buildChild(token.id, token.basePath);
    const title: string = frameable && typeof props.title === 'string' ? props.title.trim() : '';
    const framed = title !== '';
    const cell = useMemo<CellInfo>(() => ({name: def.name, id, framed, flush: framed && flush}), [id, framed]);
    const size: SizeStep | undefined = typeof props.size === 'string' && Object.hasOwn(SIZE_PX, props.size) ? props.size : undefined;
    const sizeCell = useMemo<SizeCell>(() => ({size, family: def.family}), [size]);
    // The component's state for the host (decision reports-are-component-state): what the states inside this cell draw, as one report.
    const reporter = useCellReporter(def.name, id, useA2uiSurface()?.id);
    const body = (
      <CellContext.Provider value={cell}>
        <SizeCellContext.Provider value={sizeCell}>
          <CellReportContext.Provider value={reporter}>
            <FramedContext.Provider value={framed ? id : null}>
              <AsideContext.Provider value={framed ? (header ?? false) : null}>
                <ScopeContext.Provider value={framed ? (scope ?? false) : null}>
                  <Boundary id={id} name={def.name} Redline={Redline} watch={props} onRetry={retry}>
                    <Suspense fallback={<Drafting />}>
                      <View id={id} props={props} child={child} />
                    </Suspense>
                  </Boundary>
                </ScopeContext.Provider>
              </AsideContext.Provider>
            </FramedContext.Provider>
          </CellReportContext.Provider>
        </SizeCellContext.Provider>
      </CellContext.Provider>
    );
    return (
      <div
        className="gl-cell"
        data-gl={def.name}
        data-gl-id={id}
        data-id={id}
        data-family={def.family}
        data-span={span}
        data-size={props.size ?? undefined}
        data-framed={framed || undefined}
        style={{
          ['--gl-span' as never]: span,
          ['--gl-h' as never]: props.size ? SIZE_PX[props.size] : undefined,
          order: arranged?.order,
        }}
      >
        {framed ? (
          <Frame
            id={id}
            def={def as never}
            title={title}
            note={hasNote ? props.note : undefined}
            aside={<div className="gl-frame-aside" ref={setHeader} />}
            scope={<div className="gl-frame-scope" ref={setScope} />}
          >
            {body}
          </Frame>
        ) : (
          <div className="gl-body">{body}</div>
        )}
      </div>
    );
  }) as ReactCatalogComponent;
}
