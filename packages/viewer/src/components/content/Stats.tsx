// Stats (design 5.3): a KPI strip. Equal-width Stat cells separated by hairlines. When the cells do not fit one row
// they are spread over rows of equal length (7 cells are 4 + 3, never 6 + 1), and every cell of the grid, a blank
// one at the end included, draws the same rules, so a wrapped strip has no half-drawn lines and no orphan.
import type {Roles, StatItem} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo, useRef, type JSX} from 'react';
import {DataGate, Empty, Redline, fmtNum, toNumber, useDataset, useSize, type GlView} from '../../kit/index.ts';
import {cellText, isLabelValueItem, isRecord, labelValueKeys, shapeHint, shapeMessage} from './shared/data.ts';
import {StatCell, asFormat, type StatCellProps} from './shared/StatCell.tsx';
import styles from './Stats.module.css';

/** Cells beyond this are counted in a note, not drawn: a KPI strip is a handful of numbers. */
const MAX_CELLS = 48;
/** A cell is never narrower than this; fewer columns are used instead. */
const MIN_CELL = 160;

/** Columns for `count` cells in a strip `width` px wide: as many as fit, then evened out so the rows are balanced. */
export function stripColumns(count: number, width: number): number {
  if (count <= 0) return 1;
  const fit = width > 0 ? Math.max(1, Math.floor(width / MIN_CELL)) : count;
  const rows = Math.ceil(count / fit);
  return Math.ceil(count / rows);
}

const hasFoot = (cell: StatCellProps) => toNumber(cell.delta) !== undefined || (Array.isArray(cell.spark) && cell.spark.filter(v => toNumber(v) !== undefined).length >= 2);

/** Mounted only once there are cells, so the strip is measured when it exists. */
function Strip(p: {cells: StatCellProps[]}): JSX.Element {
  const box = useRef<HTMLUListElement>(null);
  const {width} = useSize(box);
  const {cells} = p;
  const cols = stripColumns(cells.length, width);
  const rows = Math.ceil(cells.length / cols);
  const blanks = rows * cols - cells.length;
  // One cell with a sparkline or a delta makes every cell keep that line, so the rows are equally tall.
  const reserveFoot = cells.some(hasFoot);
  const place = (i: number) => ({'data-col': i % cols, 'data-row': Math.floor(i / cols), 'data-last-row': Math.floor(i / cols) === rows - 1 ? '' : undefined});
  return (
    <ul className={styles.strip} ref={box} style={{['--stats-cols' as never]: cols}} data-cols={cols} data-gl-stats="">
      {cells.map((cell, i) => (
        <li key={`${i}:${cell.label ?? ''}`} className={styles.cell} {...place(i)}>
          <StatCell {...cell} reserveFoot={reserveFoot} />
        </li>
      ))}
      {Array.from({length: blanks}, (_, i) => (
        <li key={`blank:${i}`} className={styles.cell} aria-hidden="true" data-blank="" {...place(cells.length + i)} />
      ))}
    </ul>
  );
}

function cellOf(item: Record<string, unknown>, label: unknown, value: unknown): StatCellProps {
  return {
    value,
    label: cellText(label).trim() || undefined,
    unit: cellText(item.unit).trim() || undefined,
    delta: item.delta,
    spark: item.spark,
    format: asFormat(item.format),
    tone: item.tone,
  };
}

/**
 * Cells from a list of items or from the object form {Label: value} (V002: the shapes KeyValue takes work here too).
 * An item's label is in `label`, `name`, `key`, `k` or `title`, its value in `value` or `v`, a dataset's roles first.
 * In the object form a value may itself be a {value, unit, delta, ...} item.
 */
export function normalize(data: unknown, roles?: Roles): StatCellProps[] {
  const cells: StatCellProps[] = [];
  if (isRecord(data)) {
    if (isLabelValueItem(data)) return normalize([data], roles);
    for (const [label, value] of Object.entries(data)) {
      if (isRecord(value)) {
        const {valueKey} = labelValueKeys(value);
        cells.push(cellOf(value, label, valueKey === undefined ? undefined : value[valueKey]));
      } else cells.push({value, label: label.trim() || undefined});
    }
    return cells;
  }
  if (!Array.isArray(data)) return cells;
  for (const item of data as readonly (StatItem | unknown)[]) {
    if (isRecord(item)) {
      const {labelKey, valueKey} = labelValueKeys(item, roles);
      if (labelKey === undefined && valueKey === undefined) continue;
      cells.push(cellOf(item, labelKey === undefined ? undefined : item[labelKey], valueKey === undefined ? undefined : item[valueKey]));
    } else if (typeof item === 'number' || typeof item === 'string') {
      cells.push({value: item});
    }
  }
  return cells;
}

export const StatsView: GlView<typeof C.Stats> = ({id, props}) => {
  const state = useDataset<StatItem[] | Record<string, unknown>>(props.data);
  const cells = useMemo(() => normalize(state.data, state.roles), [state.data, state.roles]);
  return (
    <DataGate state={state} id={`Stats#${id}`}>
      {data => {
        if (!Array.isArray(data) && !isRecord(data)) return <Redline code="E_SHAPE" id={`Stats#${id}`} message={shapeMessage('[{label, value}] or {Label: value}', data)} />;
        if (cells.length === 0) {
          const given = Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0;
          return given
            ? <Empty message={`no figures: Stats takes [{label, value}] or {Label: value}, got ${shapeHint(data)}`} code="W_SHAPE" />
            : <Empty message="no figures to show" />;
        }
        const shown = cells.slice(0, MAX_CELLS);
        return (
          <div className={styles.stats}>
            <Strip cells={shown} />
            {cells.length > shown.length ? <p className={styles.more}>showing {fmtNum(shown.length)} of {fmtNum(cells.length)}</p> : null}
          </div>
        );
      }}
    </DataGate>
  );
};
