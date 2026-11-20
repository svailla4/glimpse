// packages/viewer/src/kit/implement.tsx
// The ONLY file that touches the @a2ui/react component API. Family directories export plain React views;
// this wraps each one with: grid cell (span/size as data attributes + CSS variables) + plate frame or plain body
// + error boundary + lazy chunk + Suspense. Layout CSS for .gl-cell lives in styles/base.css.
//
// The box a view is given (one rule for the frame, base.css and every view):
//   .gl-cell > .gl-frame > ... .gl-body > view      framed: the component carries the frame group and has a title
//   .gl-cell > .gl-body > view                      everything else
// base.css sizes the direct child of a cell that has data-size (`.gl-cell[data-size] > :is(.gl-frame, .gl-body)
// { height: var(--gl-h) }`), and the frame lets its .gl-body take what is left under its header. So a view always
// sits in a .gl-body, and whenever the cell has data-size that box has a definite height: `height: 100%` on the
// view root fills it, with or without a title. Without data-size the box is as tall as the view makes it.
//
// What a view may rely on, beyond GlViewProps:
// - Ids. `id` is the view's own component id. The tokens in `props.children` / a `child` prop are opaque render
//   handles for `child(token)`; the component ids behind them come from useChildIds(id[, prop]) and the surface id
//   from useSurfaceId() (hooks.ts). Persistence keys (design 12.1) are built from those and useMeta().repo.name.
// - The plate header. Controls and notes that belong in the header go through <PlateAside> (below).
// - Other chunks. A view of another chunk is reused through borrowView() (below), never by importing its file.
// - Styles. Component CSS Modules wrap their content in `@layer gl.components { ... }`; the build checks it.
import {Component, Suspense, createContext, lazy, useContext, useState, type FC, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {createComponentImplementation, type ReactCatalogComponent} from '@a2ui/react';
import type {ChildToken, Chunk, ComponentDef, PropMap, ViewProps} from '@glimpse/catalog';
import type {AnyComponentDef} from '@glimpse/catalog';

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
  Frame: FC<{id: string; def: ComponentDef; title: string; note?: string; aside?: ReactNode; children: ReactNode}>;
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

/** The header element <PlateAside> portals into; null when the view is not framed (or the frame did not mount it). */
const AsideContext = createContext<HTMLElement | null>(null);

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
  return header ? createPortal(p.children, header) : <div className="gl-aside">{p.children}</div>;
}

class Boundary extends Component<{id: string; name: string; Redline: KitSlots['Redline']; children: ReactNode}, {error?: Error}> {
  state: {error?: Error} = {};
  static getDerivedStateFromError(error: Error) { return {error}; }
  render() {
    const {Redline, id, name, children} = this.props;
    return this.state.error ? <Redline code="E_RENDER" id={`${name}#${id}`} message={this.state.error.message} /> : children;
  }
}

class Quiet extends Component<{fallback: ReactNode; children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/**
 * A view that another chunk owns, for use inside your own view (design 5.3: Markdown renders fenced code through
 * CodeBlock; 5.7: CodeTour uses Steps and CodeView). Call it once at module scope, with the other chunk's INDEX:
 *   const Code = borrowView<typeof C.CodeBlock>(() => import('../code/index.ts'), 'CodeBlock', PlainCode);
 *   ... <Code id={id} props={{code, lang}} child={() => null} />
 * `Fallback` renders while that chunk loads, when it has no such view yet, when it fails to load and when the
 * borrowed view throws, so your component never depends on another package being finished. Never import another
 * chunk's component file by path. Pass your own component `id`: actions and selection need a real component id.
 */
export function borrowView<D = AnyComponentDef>(load: () => Promise<ViewModule>, name: string, Fallback: GlView<D>): GlView<D> {
  const Lazy = lazy(async () => {
    const views = await load().then(module => module.views, (): ViewModule['views'] => ({}));
    return {default: (views[name] ?? Fallback) as GlView<D>};
  });
  return function Borrowed(props: GlViewProps<D>) {
    const fallback = <Fallback {...props} />;
    return (
      <Quiet fallback={fallback}>
        <Suspense fallback={fallback}><Lazy {...props} /></Suspense>
      </Quiet>
    );
  };
}

const SIZE_PX: Record<string, string> = {s: '160px', m: '280px', l: '420px', xl: '640px', fill: 'max(420px, calc(100vh - 160px))'};

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
  const View: FC<GlViewProps<any>> =
    typeof loader === 'function'
      ? lazy(async () => ({default: (await loader()).views[def.name] ?? Missing}))
      : (loader.views[def.name] ?? Missing);
  const frameable = def.family !== 'layout' && 'title' in def.props && 'note' in def.props && 'size' in def.props;
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
    const span: number | undefined = arranged?.span ?? props.span ?? undefined;
    const child = (token: ChildToken | undefined): ReactNode =>
      token == null ? null : typeof token === 'string' ? buildChild(token) : buildChild(token.id, token.basePath);
    const framed = frameable && typeof props.title === 'string' && props.title !== '';
    const body = (
      <AsideContext.Provider value={framed ? header : null}>
        <Boundary id={id} name={def.name} Redline={Redline}>
          <Suspense fallback={<Drafting />}>
            <View id={id} props={props} child={child} />
          </Suspense>
        </Boundary>
      </AsideContext.Provider>
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
          <Frame id={id} def={def as never} title={props.title} note={props.note} aside={<div className="gl-frame-aside" ref={setHeader} />}>
            {body}
          </Frame>
        ) : (
          <div className="gl-body">{body}</div>
        )}
      </div>
    );
  }) as ReactCatalogComponent;
}
