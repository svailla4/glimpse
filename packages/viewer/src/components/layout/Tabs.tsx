// packages/viewer/src/components/layout/Tabs.tsx
// A 28 px strip of labels over one panel per child. A tab mounts on first activation and stays mounted, so its
// state (scroll, sort, zoom) survives switching. Arrow keys, Home and End move between tabs.
import type * as C from '@glimpse/catalog';
import {useId, useRef, useState, type KeyboardEvent} from 'react';
import {ArrangeContext, Empty, useChildIds, type GlView} from '../../kit/index.ts';
import css from './Tabs.module.css';

export const TabsView: GlView<typeof C.Tabs> = ({id, props, child}) => {
  const uid = useId();
  const strip = useRef<HTMLDivElement>(null);
  const children = Array.isArray(props.children) ? props.children : [];
  const labels = Array.isArray(props.labels) ? props.labels : [];
  const ids = useChildIds(id);
  // Tabs are tracked by child id, so a patch that adds or reorders tabs keeps the open one open.
  const keys = children.map((_, index) => ids[index] ?? `#${index}`);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const active = Math.max(0, activeKey === undefined ? 0 : keys.indexOf(activeKey));

  const activate = (index: number, focus: boolean) => {
    const key = keys[index];
    if (key === undefined) return;
    const leaving = keys[active];
    setActiveKey(key);
    // The tab being left stays mounted, like every tab that has been opened.
    setVisited(previous => {
      const next = new Set(previous).add(key);
      if (leaving !== undefined) next.add(leaving);
      return next.size === previous.size ? previous : next;
    });
    if (focus) strip.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const last = keys.length - 1;
    const next =
      event.key === 'ArrowRight' ? (active === last ? 0 : active + 1)
      : event.key === 'ArrowLeft' ? (active === 0 ? last : active - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    activate(next, true);
  };

  if (keys.length === 0) return <Empty message="no tabs" />;
  return (
    <div className={css.tabs}>
      <div className={css.strip} role="tablist" ref={strip} onKeyDown={onKeyDown}>
        {keys.map((key, index) => (
          <button
            type="button"
            role="tab"
            key={key}
            id={`${uid}-tab-${index}`}
            className={css.tab}
            data-index={index}
            aria-selected={index === active}
            aria-controls={`${uid}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => activate(index, false)}
          >
            {typeof labels[index] === 'string' && labels[index] !== '' ? labels[index] : `Tab ${index + 1}`}
          </button>
        ))}
      </div>
      <ArrangeContext.Provider value={null}>
        {keys.map((key, index) => (
          <div role="tabpanel" key={key} id={`${uid}-panel-${index}`} className={css.panel} aria-labelledby={`${uid}-tab-${index}`} hidden={index !== active}>
            {index === active || visited.has(key) ? child(children[index]) : null}
          </div>
        ))}
      </ArrangeContext.Provider>
    </div>
  );
};
