// packages/viewer/src/kit/Frame.tsx
// The Linework plate: a hairline box with four registration ticks, a header (`PL. 03` from the CSS counter `plate`,
// then the title in the display face), the body, and an italic caption. implement() draws it around a component that
// takes a title and has one (the `Frame` slot); the layout component Plate draws the same frame around several
// children (`PlateFrame`). Looks are in styles/kit.css.
// Contract (KitSlots.Frame in implement.tsx): `children` go inside a `.gl-body` that takes the height left under the
// header, `aside` (the <PlateAside> slot of the view) goes in the header and `scope` (the drill crumb) in a row of
// its own at the bottom of the header.
// The header never loses its title and never lets its controls out of the frame (design rule D11): the aside wraps
// to a second row when the two do not fit side by side, and text in it is cut with an ellipsis and a tooltip.
import {useCallback, useContext, useId, useState, type JSX, type KeyboardEvent, type PointerEvent, type ReactNode} from 'react';
import {useArrangeHandle} from './arrange.tsx';
import {Icon} from './icons.tsx';
import {FLUSH_FAMILIES, FramedContext, PlateAside, type KitSlots} from './implement.tsx';

export interface PlateFrameProps {
  /** Component id: the cell this plate belongs to, for arranging it inside its container. */
  id: string;
  /** Component name, exposed as data-gl-frame. */
  name: string;
  title: string;
  note?: string;
  /** Rendered at the right of the header; on a second header row when it does not fit beside the title. */
  aside?: ReactNode;
  /** Rendered as the last row of the header: what the plate is scoped to. */
  scope?: ReactNode;
  /** No body padding: the plate holds one table, code view or diagram. */
  flush?: boolean;
  /**
   * Makes the plate collapsible: a disclosure button in the header, a double-click on the header, and Enter or
   * Space with the header focused. `quiet` (the plate of one component) leaves the button out while the plate is
   * open, so the header of a component holds nothing its view did not put there.
   */
  collapse?: {collapsed: boolean; toggle(): void; quiet?: boolean};
  /** Extra class names for the body element. The kit owns its `display`: a collapsed plate hides it. */
  bodyClassName?: string;
  children: ReactNode;
}

/** Where the plate's interactive header content ends and the drag surface begins. */
const INTERACTIVE = 'button, a, input, select, textarea';
/** Header text that may be cut with an ellipsis: it gets its full text as a tooltip while it is. */
const CUTTABLE = '.gl-frame-title, .gl-marginal, .gl-frame-aside span, .gl-scope-target';

/**
 * Gives cut header text its full text as a tooltip, and takes it away again when the text fits. Listens on the
 * plate, not on the header: what a view portals into the header bubbles through the view, which is in the body.
 */
function revealCut(event: PointerEvent<HTMLElement>): void {
  const element = event.target instanceof Element ? event.target.closest(CUTTABLE) : null;
  if (!(element instanceof HTMLElement) || !element.closest('.gl-frame-head') || !event.currentTarget.contains(element)) return;
  const own = element.dataset.glCut !== undefined;
  if (element.title !== '' && !own) return;
  if (element.scrollWidth > element.clientWidth + 1) {
    element.title = element.textContent ?? '';
    element.dataset.glCut = '';
  } else if (own) {
    element.removeAttribute('title');
    delete element.dataset.glCut;
  }
}

export function PlateFrame(p: PlateFrameProps): JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const handle = useArrangeHandle(p.id);
  const {collapse} = p;
  const arrangeKeys = handle?.header.onKeyDown;
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    arrangeKeys?.(event);
    if (!collapse || event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    collapse.toggle();
  }, [arrangeKeys, collapse]);
  return (
    <section className="gl-frame" data-gl-frame={p.name} data-flush={p.flush || undefined} data-collapsed={collapse?.collapsed || undefined} aria-labelledby={titleId} onPointerOver={revealCut}>
      <header
        className="gl-frame-head"
        // A collapsible plate is operated from its header even where it cannot be moved.
        {...(handle?.header ?? (collapse ? {role: 'group' as const, tabIndex: 0} : undefined))}
        data-collapsible={collapse ? (collapse.quiet ? 'quiet' : '') : undefined}
        onKeyDown={handle || collapse ? onKeyDown : undefined}
        onDoubleClick={collapse ? event => { if (!(event.target as Element).closest(INTERACTIVE)) collapse.toggle(); } : undefined}
      >
        <h3 className="gl-frame-title" id={titleId}>{p.title}</h3>
        {p.aside}
        {collapse && (collapse.collapsed || !collapse.quiet) ? (
          // Out of the tab order: the header itself takes Enter and Space, so a plate stays one stop (design 5.1).
          <button type="button" className="gl-frame-toggle" tabIndex={-1} aria-expanded={!collapse.collapsed} aria-controls={bodyId} aria-label={collapse.collapsed ? 'Expand plate' : 'Collapse plate'} title={collapse.collapsed ? 'Expand (Enter)' : 'Collapse (Enter)'} onClick={collapse.toggle}>
            <Icon name="chevron-down" />
          </button>
        ) : null}
        {p.scope}
        {handle?.status}
      </header>
      <div className={p.bodyClassName ? `gl-frame-body ${p.bodyClassName}` : 'gl-frame-body'} id={bodyId}>{p.children}</div>
      {p.note ? <footer className="gl-frame-note">{p.note}</footer> : null}
      {handle?.edge}
    </section>
  );
}

export const Frame: KitSlots['Frame'] = ({id, def, title, note, aside, scope, children}) => {
  const outer = useContext(FramedContext);
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed(value => !value), []);
  // implement() already drew the plate of this component: a view that frames itself (content/shared/Plate.tsx)
  // adds its header content to that plate instead of drawing a second one.
  if (outer === id) {
    return (
      <>
        {aside ? <PlateAside>{aside}</PlateAside> : null}
        {children}
      </>
    );
  }
  return (
    // `note` is a bound prop: anything but text (a binding that resolved to an object) is no caption.
    <PlateFrame
      id={id}
      name={def.name}
      title={title}
      note={typeof note === 'string' && note.trim() !== '' ? note : undefined}
      aside={aside}
      scope={scope}
      flush={FLUSH_FAMILIES.has(def.family)}
      collapse={{collapsed, toggle, quiet: true}}
      bodyClassName="gl-body"
    >
      {children}
    </PlateFrame>
  );
};
