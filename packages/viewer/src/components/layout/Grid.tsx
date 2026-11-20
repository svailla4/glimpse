// packages/viewer/src/components/layout/Grid.tsx
// Columns: `cols='3'` is three equal tracks, `cols='2:1'` is `2fr 1fr`; by default one track per child, at most 4.
// A child takes one track, or `span` tracks (never more than there are). Below 720 px of page width it is one column.
import type * as C from '@glimpse/catalog';
import {useMemo, useRef} from 'react';
import {useArrangement} from '../../kit/arrange.tsx';
import {ArrangeContext, useChildIds, useSurfaceId, type GlView} from '../../kit/index.ts';
import css from './Grid.module.css';
import {gapPx, vars} from './shared.ts';

const MAX_TRACKS = 12;

/** Track weights for a `cols` value; undefined when it is neither a count nor a ratio of positive numbers. */
export function parseCols(cols: string | undefined): number[] | undefined {
  const text = cols?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const count = Number(text);
    return count >= 1 ? new Array<number>(Math.min(MAX_TRACKS, count)).fill(1) : undefined;
  }
  const parts = text.split(':').map(part => Number(part.trim()));
  if (parts.length < 2 || parts.length > MAX_TRACKS || parts.some(n => !Number.isFinite(n) || n <= 0)) return undefined;
  return parts;
}

export const GridView: GlView<typeof C.Grid> = ({id, props, child}) => {
  const element = useRef<HTMLDivElement>(null);
  const children = Array.isArray(props.children) ? props.children : [];
  const count = children.length;
  const weights = useMemo(() => parseCols(props.cols) ?? new Array<number>(Math.min(4, Math.max(1, count))).fill(1), [props.cols, count]);
  const tracks = weights.length;
  const arrangement = useArrangement(useSurfaceId(), id, useChildIds(id), {container: element, tracks, defaultSpan: 1});
  const style = useMemo(() => {
    // What the cells of this grid read (styles/base.css): one track by default, `span` tracks clamped to the grid.
    const placement: Record<`--${string}`, string | number> = {'--gl-c0': 'span 1'};
    for (let span = 1; span <= MAX_TRACKS; span++) placement[`--gl-c${span}`] = `span ${Math.min(span, tracks)}`;
    return vars({...placement, '--cols': weights.map(weight => `minmax(0, ${weight}fr)`).join(' '), '--gap': `${gapPx(props.gap, 20)}px`});
  }, [weights, tracks, props.gap]);
  return (
    <div className={css.grid} ref={element} style={style} data-tracks={tracks}>
      <ArrangeContext.Provider value={arrangement}>{children.map(token => child(token))}</ArrangeContext.Provider>
    </div>
  );
};
