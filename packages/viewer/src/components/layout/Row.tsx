// packages/viewer/src/components/layout/Row.tsx
// Horizontal flex row. The children share the width by their `span` (default 1 each) and wrap unless `wrap=false`.
import type * as C from '@glimpse/catalog';
import {useRef} from 'react';
import {inVisualOrder, useArrangement} from '../../kit/arrange.tsx';
import {ArrangeContext, useChildIds, useSurfaceId, type GlView} from '../../kit/index.ts';
import css from './Row.module.css';
import {gapPx} from './shared.ts';

const ALIGN = {start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline'} as const;

export const RowView: GlView<typeof C.Row> = ({id, props, child}) => {
  const element = useRef<HTMLDivElement>(null);
  const childIds = useChildIds(id);
  const arrangement = useArrangement(useSurfaceId(), id, childIds, {container: element, flow: 'row', defaultSpan: 1});
  const children = inVisualOrder(arrangement, childIds, Array.isArray(props.children) ? props.children : []);
  const align = (props.align && ALIGN[props.align]) || 'stretch';
  return (
    <div className={css.row} ref={element} data-wrap={props.wrap === false ? undefined : ''} style={{'--gap': `${gapPx(props.gap, 12)}px`, '--align': align}}>
      <ArrangeContext.Provider value={arrangement}>{children.map(token => child(token))}</ArrangeContext.Provider>
    </div>
  );
};
