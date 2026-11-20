// Stats (design 5.3): a KPI strip. Equal-width Stat cells separated by vertical hairlines, wrapping at 180 px a cell.
import type {StatItem} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo} from 'react';
import {DataGate, Empty, Redline, fmtNum, useDataset, type GlView} from '../../kit/index.ts';
import {cellText, isRecord, shapeMessage} from './shared/data.ts';
import {StatCell, asFormat, type StatCellProps} from './shared/StatCell.tsx';
import styles from './Stats.module.css';

/** Cells beyond this are counted in a note, not drawn: a KPI strip is a handful of numbers. */
const MAX_CELLS = 48;

function normalize(items: readonly unknown[]): StatCellProps[] {
  const cells: StatCellProps[] = [];
  for (const item of items as readonly (StatItem | unknown)[]) {
    if (isRecord(item)) {
      if (!('value' in item) && !('label' in item)) continue;
      cells.push({
        value: item.value,
        label: cellText(item.label).trim() || undefined,
        unit: cellText(item.unit).trim() || undefined,
        delta: item.delta,
        spark: item.spark,
        format: asFormat(item.format),
        tone: item.tone,
      });
    } else if (typeof item === 'number' || typeof item === 'string') {
      cells.push({value: item});
    }
  }
  return cells;
}

export const StatsView: GlView<typeof C.Stats> = ({id, props}) => {
  const state = useDataset<StatItem[]>(props.data);
  const cells = useMemo(() => (Array.isArray(state.data) ? normalize(state.data) : []), [state.data]);
  return (
    <DataGate state={state} id={`Stats#${id}`}>
      {data => {
        if (!Array.isArray(data)) return <Redline code="E_SHAPE" id={`Stats#${id}`} message={shapeMessage('a list of {label, value}', data)} />;
        if (cells.length === 0) return <Empty message="no figures to show" />;
        const shown = cells.slice(0, MAX_CELLS);
        return (
          <div className={styles.stats}>
            <ul className={styles.strip}>
              {shown.map((cell, i) => (
                <li key={`${i}:${cell.label ?? ''}`} className={styles.cell}>
                  <StatCell {...cell} />
                </li>
              ))}
            </ul>
            {cells.length > shown.length ? <p className={styles.more}>showing {fmtNum(shown.length)} of {fmtNum(cells.length)}</p> : null}
          </div>
        );
      }}
    </DataGate>
  );
};
