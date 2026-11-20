// packages/viewer/src/kit/Frame.tsx
// The Linework plate: a hairline box with four registration ticks, a 40 px header (`PL. 03` from the CSS counter
// `plate`, then the title in the display face), the body, and an italic caption. implement() draws it around a
// frameable leaf that has a title (the `Frame` slot); the layout component Plate draws the same frame around several
// children (`PlateFrame`). Looks are in styles/kit.css.
// Contract (KitSlots.Frame in implement.tsx): `children` go inside a `.gl-body` that takes the height left under the
// header, and `aside` (the <PlateAside> slot of the view) goes in the header.
import {useId, type JSX, type ReactNode} from 'react';
import {useArrangeHandle} from './arrange.tsx';
import {Icon} from './icons.tsx';
import type {KitSlots} from './implement.tsx';

export interface PlateFrameProps {
  /** Component id: the cell this plate belongs to, for arranging it inside its container. */
  id: string;
  /** Component name, exposed as data-gl-frame. */
  name: string;
  title: string;
  note?: string;
  /** Rendered at the right of the header. */
  aside?: ReactNode;
  /** No body padding: the plate holds one table, code view or diagram. */
  flush?: boolean;
  /** Makes the plate collapsible: a disclosure button in the header, and a double-click on the header. */
  collapse?: {collapsed: boolean; toggle(): void};
  /** Extra class names for the body element. The kit owns its `display`: a collapsed plate hides it. */
  bodyClassName?: string;
  children: ReactNode;
}

/** Where the plate's interactive header content ends and the drag surface begins. */
const INTERACTIVE = 'button, a, input, select, textarea';

export function PlateFrame(p: PlateFrameProps): JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const handle = useArrangeHandle(p.id);
  const {collapse} = p;
  return (
    <section className="gl-frame" data-gl-frame={p.name} data-flush={p.flush || undefined} data-collapsed={collapse?.collapsed || undefined} aria-labelledby={titleId}>
      <header
        className="gl-frame-head"
        {...handle?.header}
        onDoubleClick={collapse ? event => { if (!(event.target as Element).closest(INTERACTIVE)) collapse.toggle(); } : undefined}
      >
        <h3 className="gl-frame-title" id={titleId}>{p.title}</h3>
        {p.aside}
        {collapse ? (
          <button type="button" className="gl-frame-toggle" aria-expanded={!collapse.collapsed} aria-controls={bodyId} aria-label={collapse.collapsed ? 'Expand plate' : 'Collapse plate'} onClick={collapse.toggle}>
            <Icon name="chevron-down" />
          </button>
        ) : null}
        {handle?.status}
      </header>
      <div className={p.bodyClassName ? `gl-frame-body ${p.bodyClassName}` : 'gl-frame-body'} id={bodyId}>{p.children}</div>
      {p.note ? <footer className="gl-frame-note">{p.note}</footer> : null}
      {handle?.edge}
    </section>
  );
}

/** Families whose view is one table, code view or diagram: the plate gives them the whole box (design 8.3). */
const FLUSH_FAMILIES: ReadonlySet<string> = new Set(['data', 'diagram', 'code']);

export const Frame: KitSlots['Frame'] = ({id, def, title, note, aside, children}) => (
  // `note` is a bound prop: anything but text (a binding that resolved to an object) is no caption.
  <PlateFrame id={id} name={def.name} title={title} note={typeof note === 'string' ? note : undefined} aside={aside} flush={FLUSH_FAMILIES.has(def.family)} bodyClassName="gl-body">
    {children}
  </PlateFrame>
);
