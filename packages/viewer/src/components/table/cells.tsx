// One renderer per FieldKind. Text comes from the kit formatters; this file adds the visual treatment (bars, heat
// swatches, sparklines, chips) and wraps entity kinds in EntityLink so selection, open and copy work in a cell.
import type {DataRow, Dataset} from '@glimpse/catalog';
import {memo, type JSX, type PointerEvent, type ReactNode} from 'react';
import {EntityLink, Icon, PathText, fmtCell, fmtDate, fmtNum, seqVar, useTooltip} from '../../kit/index.ts';
import s from './cells.module.css';
import {cellEntity, isRecord, num, type Column} from './rows.ts';

const DASH = '—';
const MINUS = '−';

/** What a cell needs besides its row: where it lives, and what its column looks like across rows. */
export interface CellContext {
  componentId: string;
  ds: Dataset | undefined;
  /**
   * Categorical ink per kind of category, from the kit (D6): a key the session knows wears its ink, the others take
   * the free inks in order of first appearance in this table. A cell never picks or greys out a colour itself.
   */
  cat: Readonly<Record<'lang' | 'module' | 'chip', (key: string | undefined) => string>>;
  /** Largest value per column key, for bars and heat swatches. */
  max: ReadonlyMap<string, number>;
}

const isBlank = (value: unknown) => value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
const Blank = () => <span className={s.blank}>{DASH}</span>;

function Dot(p: {color: string}): JSX.Element {
  return <span className={s.dot} style={{background: p.color}} aria-hidden="true" />;
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

/** Chips drawn in one cell. */
export const MAX_CHIPS = 6;
type ChipTone = 'good' | 'info' | 'serious' | 'critical';
const CHIP_TONES: Readonly<Record<string, ChipTone>> = {
  a: 'good', added: 'good', new: 'good', done: 'good', ok: 'good', stable: 'good',
  m: 'info', modified: 'info', todo: 'info', note: 'info',
  r: 'serious', renamed: 'serious', hack: 'serious', xxx: 'serious', warn: 'serious', watch: 'serious',
  d: 'critical', deleted: 'critical', fixme: 'critical', bug: 'critical', hotspot: 'critical',
};
const STATUS_WORDS: Readonly<Record<string, string>> = {A: 'added', M: 'modified', D: 'deleted', R: 'renamed'};

/** The text of a chip value: its label when it is an object. */
export const chipLabel = (value: unknown): string => (isRecord(value) && typeof value.label === 'string' ? value.label : String(value));
/** Whether a chip's dot carries a status tone (added, fixme, ...) rather than a category colour. */
export const chipHasTone = (label: string): boolean => Object.hasOwn(CHIP_TONES, label.toLowerCase());

function Chip(p: {value: unknown; status: boolean; color: (key: string | undefined) => string}): JSX.Element {
  const raw = chipLabel(p.value);
  const tone = chipHasTone(raw) ? CHIP_TONES[raw.toLowerCase()] : undefined;
  return (
    <span className={s.chip} data-tone={tone}>
      <span className={s.chipDot} style={tone ? undefined : {background: p.color(raw)}} aria-hidden="true" />
      {(p.status && STATUS_WORDS[raw]) || raw}
    </span>
  );
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const DAY_AGES = [[365, 'y'], [30, 'mo'], [7, 'wk'], [1, 'd']] as const;

/**
 * Age text of a date. A value with a time is an age down to the minute ('20 min'). A day-only value ('2026-11-20',
 * a UTC day as the analyzers write it) knows nothing below a day, so it is counted in whole days against today's UTC
 * date and never shown in hours: 'today', '1 d', '3 wk'.
 */
export function ageText(iso: string, now: number = Date.now()): string {
  if (!DAY_ONLY.test(iso.trim())) return fmtDate(iso, 'rel');
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return DASH;
  const days = Math.abs(Math.round((Math.floor(now / DAY_MS) * DAY_MS - time) / DAY_MS));
  for (const [size, unit] of DAY_AGES) if (days >= size) return `${Math.floor(days / size)} ${unit}`;
  return 'today';
}

/** A date as its age ('3 d'); the absolute date is in the tooltip and in the accessible text. */
export function DateCell(p: {iso: string}): JSX.Element {
  const tip = useTooltip();
  const rel = ageText(p.iso);
  if (rel === DASH) return <span className={s.text} title={p.iso}>{p.iso}</span>;
  const abs = fmtDate(p.iso, 'abs');
  const show = (event: PointerEvent) => tip.show(<span className={s.tip}>{abs}</span>, event.clientX, event.clientY);
  return (
    <time className={s.date} dateTime={p.iso} onPointerEnter={show} onPointerMove={show} onPointerLeave={tip.hide}>
      {rel}
      <span className={s.hidden}>{rel === 'today' ? ', ' : ' ago, '}{abs}</span>
    </time>
  );
}

function Delta(p: {value: unknown}): ReactNode {
  if (isRecord(p.value)) {
    const add = num(p.value.add);
    const del = num(p.value.del);
    if (add === undefined && del === undefined) return <Blank />;
    // A zero is not a change: it is printed in the dim ink, never in green or red.
    return (
      <span className={s.delta}>
        <span className={add ? s.add : s.zero}>+{fmtNum(add ?? 0)}</span> <span className={del ? s.del : s.zero}>{MINUS}{fmtNum(del ?? 0)}</span>
      </span>
    );
  }
  const n = num(p.value);
  if (n === undefined) return <span className={s.text}>{String(p.value)}</span>;
  return <span className={s.delta}><span className={n === 0 ? s.zero : n < 0 ? s.del : s.add}>{n < 0 ? '' : '+'}{fmtNum(n)}</span></span>;
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
          {(Array.isArray(value) ? value.slice(0, MAX_CHIPS) : [value]).map((item, i) => <Chip key={i} value={item} status={column.key === 'status'} color={ctx.cat.chip} />)}
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
          <Dot color={ctx.cat.module(typeof value === 'string' ? value : undefined)} />
          {/* A module is a directory ('typescript/renderers'): its last segment tells the rows apart (D12). */}
          {typeof value === 'string' && value.includes('/') ? <PathText file={value} /> : <span className={s.mono}>{text}</span>}
        </Entity>
      );
    case 'lang':
      return (
        <span className={s.entity}>
          <Dot color={ctx.cat.lang(typeof value === 'string' ? value : undefined)} />
          <span className={s.plain}>{text}</span>
        </span>
      );
    default:
      return <span className={s.text} title={text.length > 24 ? text : undefined}>{text}</span>;
  }
});

/** Grid track per kind: a floor that keeps the cell legible and a share of the spare width. */
const TRACKS: Readonly<Record<Column['kind'], readonly [min: number, grow: number]>> = {
  text: [88, 2],
  code: [140, 3],
  // The path column takes the largest share: it is what tells the rows apart (D12).
  path: [168, 4],
  symbol: [112, 2],
  module: [88, 1.4],
  author: [64, 1.2],
  lang: [88, 1.2],
  commit: [64, 0],
  num: [44, 0.8],
  bytes: [60, 0.8],
  pct: [48, 0.8],
  duration: [60, 0.8],
  bar: [88, 1.2],
  heat: [92, 1],
  spark: [72, 0],
  chip: [76, 1],
  date: [52, 0.8],
  delta: [80, 0.9],
  bool: [32, 0],
};
/**
 * Kinds whose text is short, mono and tabular. Their column is as wide as its longest value and its header, no
 * wider, so the spare width goes to the columns that have something to say with it (paths, text, bars).
 */
const CONTENT_SIZED: ReadonlySet<Column['kind']> = new Set(['num', 'bytes', 'pct', 'duration', 'date', 'delta']);
const CHAR = 7.25;
const HEAD_CHAR = 7.1;
const SORT_GLYPH = 12;
const MAX_CONTENT = 168;

export const isContentSized = (column: Column): boolean => CONTENT_SIZED.has(column.kind);
/** A column that takes a share of the spare width. */
export const isFlexible = (column: Column): boolean => TRACKS[column.kind][1] > 0 && !CONTENT_SIZED.has(column.kind);

/** Characters a content-sized cell prints, 0 for a blank. */
export function contentChars(value: unknown, column: Column): number {
  if (isBlank(value)) return 0;
  if (column.kind === 'date') return typeof value === 'string' ? Math.max(5, ageText(value).length) : String(value).length;
  return fmtCell(value, column).length;
}

/**
 * Width of a column's track. `chars` is the longest value seen in a content-sized column (undefined: not measured).
 * `flexible` says the table has another column to take the spare width; without one a content-sized column grows.
 */
export function minWidthOf(column: Column, chars?: number): number {
  const floor = TRACKS[column.kind][0];
  if (!CONTENT_SIZED.has(column.kind) || chars === undefined) return floor;
  const head = column.label.length * HEAD_CHAR + SORT_GLYPH;
  return Math.round(Math.min(MAX_CONTENT, Math.max(floor, chars * CHAR + 2, head)));
}
export function trackOf(column: Column, chars?: number, flexible = false): string {
  const [, grow] = TRACKS[column.kind];
  const min = minWidthOf(column, chars);
  if (grow === 0 || (flexible && CONTENT_SIZED.has(column.kind) && chars !== undefined)) return `${min}px`;
  return `minmax(${min}px, ${grow}fr)`;
}
export const isRightAligned = (column: Column): boolean => column.kind === 'num' || column.kind === 'bytes' || column.kind === 'pct' || column.kind === 'duration';
