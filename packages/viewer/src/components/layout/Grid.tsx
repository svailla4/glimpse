// packages/viewer/src/components/layout/Grid.tsx
// Columns: `cols='3'` is three equal tracks, `cols='2:1'` is `2fr 1fr`; by default one track per child, at most 4.
// A child without `span` takes one track. `span` is a width on the 12-column grid, as everywhere (decision layout-does-the-obvious):
// once a child names one, the Grid lays its children on 12 columns like the page does, and a child that names none
// takes the share of the width its track would have had (12 / tracks, or its ratio). So `Grid([a(span=6), b(span=6)])`
// and `Grid([map(span=8), tree(span=4)],'2:1')` sit side by side. Below 720 px of page width it is one column.
// `cols` is read by the catalog's parseCols, as the server reads it: a guess ('2fr 1fr') is drawn as the server would
// write it ('2:1'); what cannot be read is drawn as the default tracks and reported as W_COLS.
import type * as C from '@glimpse/catalog';
import {MAX_TRACKS, parseCols} from '@glimpse/catalog';
import {useMemo, useRef} from 'react';
import {inVisualOrder, useArrangement, type Arrangement} from '../../kit/arrange.tsx';
import {ArrangeContext, useChildIds, useChildSpans, useReportState, useSurfaceId, type GlView} from '../../kit/index.ts';
import css from './Grid.module.css';
import {gapPx, vars} from './shared.ts';

const COLUMNS = 12;

/**
 * The 12-column span of the i-th child that names none, when its siblings name theirs: the width of the track it would
 * have taken (`i` modulo the track count), in twelfths.
 */
export function shareOf(weights: readonly number[], index: number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const weight = weights[index % weights.length] ?? 1;
  return Math.min(COLUMNS, Math.max(1, Math.round((COLUMNS * weight) / total)));
}

export const GridView: GlView<typeof C.Grid> = ({id, props, child}) => {
  const element = useRef<HTMLDivElement>(null);
  const children = Array.isArray(props.children) ? props.children : [];
  const count = children.length;
  const written = String(props.cols ?? '').trim();
  const read = useMemo(() => (written ? parseCols(written) : undefined), [written]);
  const weights = useMemo(() => read ?? new Array<number>(Math.min(4, Math.max(1, count))).fill(1), [read, count]);
  useReportState(written && !read ? 'W_COLS' : undefined, `cols '${written.slice(0, 40)}' is not a count or a ratio: drawn as equal columns. Write '3' or '2:1'`);
  const childIds = useChildIds(id);
  const spans = useChildSpans(id);
  // A span is a width on 12 columns: a Grid whose children name spans is laid on 12 columns.
  const twelve = spans.some(span => span !== undefined);
  const tracks = twelve ? COLUMNS : weights.length;
  const defaultSpan = twelve ? shareOf(weights, 0) : 1;
  // What each child spans in the spec: its own span, else its track's share on 12 columns, else one track.
  const specSpans = useMemo(() => (twelve ? spans.map((span, i) => span ?? shareOf(weights, i)) : spans), [twelve, spans, weights]);
  const arrangement = useArrangement(useSurfaceId(), id, childIds, {container: element, tracks, defaultSpan, spans: specSpans});
  // On 12 columns, a child that names no span gets its track's share as the span its cell shows (data-span), unless
  // the person gave it another one.
  const shares = useMemo(() => new Map(twelve ? childIds.flatMap((childId, i) => (spans[i] === undefined ? [[childId, shareOf(weights, i)] as const] : [])) : []), [twelve, childIds, spans, weights]);
  const api = useMemo<Arrangement>(() => (shares.size === 0 ? arrangement : {
    ...arrangement,
    get(componentId) {
      const own = arrangement.get(componentId);
      const share = shares.get(componentId);
      return share === undefined || own?.span !== undefined ? own : {...own, span: share};
    },
  }), [arrangement, shares]);
  const style = useMemo(() => {
    const gap = `${gapPx(props.gap, 20)}px`;
    // 12 columns: the cells read their span the way they do on the page (styles/base.css), narrow widths included.
    if (twelve) return vars({'--cols': `repeat(${COLUMNS}, minmax(0, 1fr))`, '--gap': gap});
    // What the cells of this grid read (styles/base.css): one track by default.
    const placement: Record<`--${string}`, string | number> = {'--gl-c0': 'span 1'};
    for (let span = 1; span <= MAX_TRACKS; span++) placement[`--gl-c${span}`] = `span ${Math.min(span, tracks)}`;
    return vars({...placement, '--cols': weights.map(weight => `minmax(0, ${weight}fr)`).join(' '), '--gap': gap});
  }, [weights, tracks, twelve, props.gap]);
  return (
    <div className={css.grid} ref={element} style={style} data-tracks={tracks} data-columns={twelve ? COLUMNS : undefined}>
      <ArrangeContext.Provider value={api}>{inVisualOrder(arrangement, childIds, children).map(token => child(token))}</ArrangeContext.Provider>
    </div>
  );
};
