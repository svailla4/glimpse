// One renderer per FieldKind. Text comes from the kit formatters; this file adds the visual treatment (bars, heat
// swatches, sparklines, chips) and wraps entity kinds in EntityLink so selection, open and copy work in a cell.
import type {DataRow, Dataset, SurfaceMeta} from '@glimpse/catalog';
import {memo, type JSX, type PointerEvent, type ReactNode} from 'react';
import {EntityLink, Icon, PathText, catVar, fmtCell, fmtDate, fmtNum, seqVar, useTooltip} from '../../kit/index.ts';
import s from './cells.module.css';
import {cellEntity, isRecord, num, type Column} from './rows.ts';

const DASH = '—';
const MINUS = '−';

/** What a cell needs besides its row: where it lives, and what its column looks like across rows. */
export interface CellContext {
  componentId: string;
  ds: Dataset | undefined;
  slots: SurfaceMeta['slots'] | undefined;
  /** Largest value per column key, for bars and heat swatches. */
  max: ReadonlyMap<string, number>;
}

const isBlank = (value: unknown) => value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
const Blank = () => <span className={s.blank}>{DASH}</span>;

function Dot(p: {slot: number | undefined}): JSX.Element {
  return <span className={s.dot} style={{background: catVar(p.slot ?? 0)}} aria-hidden="true" />;
}

function Bar(p: {value: number; max: number; text: string}): JSX.Element {
  const share = p.max > 0 ? Math.min(1, Math.max(0, p.value / p.max)) : 0;
  return (
    <span className={s.bar}>
      <span className={s.track} aria-hidden="true">
        <span className={s.fill} style={{width: `${(share * 100).toFixed(1)}%`}} />
      </span>
      <span className={s.barValue}>{p.text}</span>
    </span>
  );
}

function Heat(p: {value: number; max: number; text: string}): JSX.Element {
  const share = p.max > 0 ? Math.min(1, Math.max(0, p.value / p.max)) : 0;
  return (
    <span className={s.heat}>
      <span className={s.swatch} style={{background: seqVar(1 + share * 6)}} aria-hidden="true" />
      <span className={s.heatValue}>{p.text}</span>
    </span>
  );
}

const SPARK_W = 72;
const SPARK_H = 16;
function Spark(p: {values: number[]; label: string}): JSX.Element {
  const {values} = p;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const step = values.length > 1 ? (SPARK_W - 4) / (values.length - 1) : 0;
  const points = values.map((v, i) => [2 + i * step, 2 + (SPARK_H - 4) * (1 - (v - lo) / span)] as const);
  const last = points.at(-1);
  return (
    <svg className={s.spark} width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={p.label}>
      {points.length > 1 ? <polyline points={points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} /> : null}
      {last ? <circle cx={last[0]} cy={last[1]} r="1.75" /> : null}
    </svg>
  );
}

type ChipTone = 'good' | 'info' | 'serious' | 'critical';
const CHIP_TONES: Readonly<Record<string, ChipTone>> = {
  a: 'good', added: 'good', new: 'good', done: 'good', ok: 'good', stable: 'good',
  m: 'info', modified: 'info', todo: 'info', note: 'info',
  r: 'serious', renamed: 'serious', hack: 'serious', xxx: 'serious', warn: 'serious', watch: 'serious',
  d: 'critical', deleted: 'critical', fixme: 'critical', bug: 'critical', hotspot: 'critical',
};
const STATUS_WORDS: Readonly<Record<string, string>> = {A: 'added', M: 'modified', D: 'deleted', R: 'renamed'};

function Chip(p: {value: unknown; status: boolean}): JSX.Element {
  const raw = isRecord(p.value) && typeof p.value.label === 'string' ? p.value.label : String(p.value);
  const tone = CHIP_TONES[raw.toLowerCase()];
  return (
    <span className={s.chip} data-tone={tone}>
      <span className={s.chipDot} aria-hidden="true" />
      {(p.status && STATUS_WORDS[raw]) || raw}
    </span>
  );
}

/** A date as its age ('3 d'); the absolute date is in the tooltip and in the accessible text. */
export function DateCell(p: {iso: string}): JSX.Element {
  const tip = useTooltip();
  const rel = fmtDate(p.iso, 'rel');
  if (rel === DASH) return <span className={s.text} title={p.iso}>{p.iso}</span>;
  const abs = fmtDate(p.iso, 'abs');
  const show = (event: PointerEvent) => tip.show(<span className={s.tip}>{abs}</span>, event.clientX, event.clientY);
  return (
    <time className={s.date} dateTime={p.iso} onPointerEnter={show} onPointerMove={show} onPointerLeave={tip.hide}>
      {rel}
      <span className={s.hidden}> ago, {abs}</span>
    </time>
  );
}

function Delta(p: {value: unknown}): ReactNode {
  if (isRecord(p.value)) {
    const add = num(p.value.add);
    const del = num(p.value.del);
    if (add === undefined && del === undefined) return <Blank />;
    return (
      <span className={s.delta}>
        <span className={s.add}>+{fmtNum(add ?? 0)}</span> <span className={s.del}>{MINUS}{fmtNum(del ?? 0)}</span>
      </span>
    );
  }
  const n = num(p.value);
  if (n === undefined) return <span className={s.text}>{String(p.value)}</span>;
  return <span className={s.delta}><span className={n < 0 ? s.del : s.add}>{n < 0 ? '' : '+'}{fmtNum(n)}</span></span>;
}

function Entity(p: {column: Column; row: DataRow; ctx: CellContext; children: ReactNode}): JSX.Element {
  const entity = cellEntity(p.column, p.row, p.ctx.ds);
  return (
    <span className={s.entity}>
      {entity ? <EntityLink entity={entity} componentId={p.ctx.componentId}>{p.children}</EntityLink> : p.children}
    </span>
  );
}

/** The content of one cell (no layout box: the table owns the cell element). */
export const CellContent = memo(function CellContent(p: {column: Column; row: DataRow; ctx: CellContext}): ReactNode {
  const {column, row, ctx} = p;
  const value = row[column.key];
  if (isBlank(value)) return <Blank />;
  const text = fmtCell(value, column);
  switch (column.kind) {
    case 'num': case 'bytes': case 'pct': case 'duration':
      return <span className={s.num}>{text}</span>;
    case 'bar': {
      const n = num(value);
      return n === undefined ? <span className={s.text}>{text}</span> : <Bar value={n} max={ctx.max.get(column.key) ?? 0} text={text} />;
    }
    case 'heat': {
      const n = num(value);
      return n === undefined ? <span className={s.text}>{text}</span> : <Heat value={n} max={ctx.max.get(column.key) ?? 0} text={text} />;
    }
    case 'spark': {
      const values = Array.isArray(value) ? value.map(num).filter((v): v is number => v !== undefined) : [];
      return values.length > 0 ? <Spark values={values} label={`${column.label}: ${text}`} /> : <Blank />;
    }
    case 'chip':
      return (
        <span className={s.chips}>
          {(Array.isArray(value) ? value.slice(0, 6) : [value]).map((item, i) => <Chip key={i} value={item} status={column.key === 'status'} />)}
        </span>
      );
    case 'date':
      return typeof value === 'string' ? <DateCell iso={value} /> : <span className={s.text}>{String(value)}</span>;
    case 'delta':
      return <Delta value={value} />;
    case 'code':
      return <code className={s.code} title={String(value)}>{String(value).trim()}</code>;
    case 'bool': {
      if (value === true || value === 'true') return <span className={s.bool} role="img" aria-label="yes"><Icon name="check" /></span>;
      return <span className={s.blank} role="img" aria-label="no">{DASH}</span>;
    }
    case 'path':
      return typeof value === 'string' ? <Entity column={column} row={row} ctx={ctx}><PathText file={value} /></Entity> : <span className={s.text}>{text}</span>;
    case 'symbol':
      return <Entity column={column} row={row} ctx={ctx}><span className={s.mono}>{text}</span></Entity>;
    case 'commit':
      return <Entity column={column} row={row} ctx={ctx}><span className={s.sha}>{text}</span></Entity>;
    case 'author':
      return <Entity column={column} row={row} ctx={ctx}><span className={s.plain}>{text}</span></Entity>;
    case 'module':
      return (
        <Entity column={column} row={row} ctx={ctx}>
          <Dot slot={typeof value === 'string' ? ctx.slots?.module?.[value] : undefined} />
          <span className={s.mono}>{text}</span>
        </Entity>
      );
    case 'lang':
      return (
        <span className={s.entity}>
          <Dot slot={typeof value === 'string' ? ctx.slots?.lang?.[value] : undefined} />
          <span className={s.plain}>{text}</span>
        </span>
      );
    default:
      return <span className={s.text} title={text.length > 24 ? text : undefined}>{text}</span>;
  }
});

/** Grid track per kind: a floor that keeps the cell legible and a share of the spare width. */
const TRACKS: Readonly<Record<Column['kind'], readonly [min: number, track: string]>> = {
  text: [88, 'minmax(88px, 2fr)'],
  code: [140, 'minmax(140px, 3fr)'],
  path: [156, 'minmax(156px, 3fr)'],
  symbol: [112, 'minmax(112px, 2fr)'],
  module: [88, 'minmax(88px, 1.4fr)'],
  author: [64, 'minmax(64px, 1.2fr)'],
  lang: [88, 'minmax(88px, 1.2fr)'],
  commit: [64, '64px'],
  num: [44, 'minmax(44px, 0.8fr)'],
  bytes: [60, 'minmax(60px, 0.8fr)'],
  pct: [48, 'minmax(48px, 0.8fr)'],
  duration: [60, 'minmax(60px, 0.8fr)'],
  bar: [100, 'minmax(100px, 1.6fr)'],
  heat: [92, 'minmax(92px, 1fr)'],
  spark: [72, '72px'],
  chip: [76, 'minmax(76px, 1fr)'],
  date: [52, 'minmax(52px, 0.8fr)'],
  delta: [80, 'minmax(80px, 0.9fr)'],
  bool: [32, '32px'],
};
export const trackOf = (column: Column): string => TRACKS[column.kind][1];
export const minWidthOf = (column: Column): number => TRACKS[column.kind][0];
export const isRightAligned = (column: Column): boolean => column.kind === 'num' || column.kind === 'bytes' || column.kind === 'pct' || column.kind === 'duration';
