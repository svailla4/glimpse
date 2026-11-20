// packages/viewer/src/components/layout/Plate.tsx
// The numbered plate around several children, stacked with a 12 px gap. Double-click the header (or use its
// disclosure button) to collapse it. A plate that starts collapsed mounts its children when it is first opened.
import {COMPONENT_BY_NAME} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useCallback, useState} from 'react';
import {PlateFrame} from '../../kit/Frame.tsx';
import {ArrangeContext, useChildIds, type GlView} from '../../kit/index.ts';
import {useChildInfo} from '../../kit/surface.ts';
import css from './Plate.module.css';
import {asText} from './shared.ts';

/** One bare table, code view or diagram takes the whole box (design 8.3: plate padding 0). */
const FLUSH_FAMILIES: ReadonlySet<string> = new Set(['data', 'diagram', 'code']);

export const PlateView: GlView<typeof C.Plate> = ({id, props, child}) => {
  const start = props.collapsed === true;
  const [collapsed, setCollapsed] = useState(start);
  const [opened, setOpened] = useState(!start);
  // The agent can open or close a plate with a patch; the person's own toggle holds until the prop changes again.
  const [seen, setSeen] = useState(start);
  if (seen !== start) {
    setSeen(start);
    setCollapsed(start);
    if (!start) setOpened(true);
  }
  const toggle = useCallback(() => {
    setCollapsed(value => !value);
    setOpened(true);
  }, []);

  const children = Array.isArray(props.children) ? props.children : [];
  const [only, ...more] = useChildInfo(useChildIds(id));
  const flush = only !== undefined && more.length === 0 && !only.titled && FLUSH_FAMILIES.has(COMPONENT_BY_NAME.get(only.type)?.family ?? '');
  return (
    <PlateFrame id={id} name="Plate" title={asText(props.title)} note={asText(props.note)} flush={flush} collapse={{collapsed, toggle}}>
      <div className={css.stack}>
        <ArrangeContext.Provider value={null}>{opened ? children.map(token => child(token)) : null}</ArrangeContext.Provider>
      </div>
    </PlateFrame>
  );
};
