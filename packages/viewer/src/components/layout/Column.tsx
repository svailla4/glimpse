// packages/viewer/src/components/layout/Column.tsx
// Vertical stack, gap 12 px unless `gap` says otherwise. Its children are not arrangeable.
import type * as C from '@glimpse/catalog';
import {ArrangeContext, type GlView} from '../../kit/index.ts';
import css from './Column.module.css';
import {gapPx, vars} from './shared.ts';

const ALIGN = {start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch'} as const;

export const ColumnView: GlView<typeof C.Column> = ({props, child}) => {
  const children = Array.isArray(props.children) ? props.children : [];
  const align = (props.align && ALIGN[props.align]) || 'stretch';
  return (
    <div className={css.column} style={vars({'--gap': `${gapPx(props.gap, 12)}px`, '--align': align})}>
      <ArrangeContext.Provider value={null}>{children.map(token => child(token))}</ArrangeContext.Provider>
    </div>
  );
};
