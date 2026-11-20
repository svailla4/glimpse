// Column widths for DataTable. No DOM: widths are estimated from the text the cells print, so the table can lay out
// before anything is measured and tests can check the arithmetic.
//
// Every column has a floor (what keeps it legible, never more than it needs) and a want (the width of its widest
// value and of its header). The plate's spare width goes first to the columns whose text a reader needs whole (text,
// code, paths, symbols, modules, authors), then to the visual columns (chips, languages, bars, heat), and only then is
// what is left shared out so the rows fill the plate. Short tabular columns (numbers, ages, deltas) are exactly as
// wide as their text. So a package name or a TODO's text is never cut while a version or a count sits in white space.
import type {DataRow} from '@glimpse/catalog';
import {fmtCell} from '../../kit/index.ts';
import {MAX_CHIPS, ageText, chipLabel} from './cells.tsx';
import type {Column} from './rows.ts';

type Kind = Column['kind'];

/** Floor of a column of each kind, and its weight when width is shared out (0: the column never grows). */
const TRACKS: Readonly<Record<Kind, readonly [floor: number, grow: number]>> = {
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

/** Short, mono, tabular kinds: as wide as their longest value and their header, no wider. */
const CONTENT_SIZED: ReadonlySet<Kind> = new Set(['num', 'bytes', 'pct', 'duration', 'date', 'delta']);
/** Kinds whose text the reader needs whole: they are served first. */
const TEXTUAL: ReadonlySet<Kind> = new Set(['text', 'code', 'path', 'symbol', 'module', 'author']);
/** The most a column asks for: past this its text elides and the full value is the tooltip. */
const MAX_WANT: Partial<Record<Kind, number>> = {text: 560, code: 560, path: 560, symbol: 360, module: 320, author: 200, chip: 320, lang: 200, bar: 200, heat: 140};
const MAX_CONTENT = 168;

// Text metrics of the table's fonts (12.5 px IBM Plex Sans, 12 px IBM Plex Mono, 10.5 px uppercase mono chips).
const UI_CHAR = 6.7;
const MONO_CHAR = 7.25;
const CHIP_CHAR = 6.9;
const HEAD_CHAR = 7.1;
const SORT_GLYPH = 12;
const DOT = 12;
const EXT_BADGE = 34;
/** Rows measured for a column's want: enough to find the long values, cheap for a 2,000-row dataset. */
const MEASURED_ROWS = 1000;

export const isContentSized = (column: Column): boolean => CONTENT_SIZED.has(column.kind);

const isBlank = (value: unknown) => value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));

/** Characters a content-sized cell prints, 0 for a blank. */
export function contentChars(value: unknown, column: Column): number {
  if (isBlank(value)) return 0;
  if (column.kind === 'date') return typeof value === 'string' ? Math.max(5, ageText(value).length) : String(value).length;
  return fmtCell(value, column).length;
}

/** Estimated width in px of what a cell draws, 0 for a blank. */
export function contentWidth(value: unknown, column: Column): number {
  if (isBlank(value)) return 0;
  switch (column.kind) {
    case 'path': {
      if (typeof value !== 'string') return String(value).length * MONO_CHAR;
      const hash = value.indexOf('#L');
      const path = hash >= 0 ? value.slice(0, hash) : value;
      const line = hash >= 0 ? value.slice(hash + 2).replace(/^(\d+).*$/, ':$1') : '';
      const base = path.slice(path.lastIndexOf('/') + 1);
      const dot = base.lastIndexOf('.');
      const badge = dot > 0 && base.length - dot - 1 <= 4 ? EXT_BADGE : 0;
      return (path.length + line.length) * MONO_CHAR + badge;
    }
    case 'chip': {
      const items = Array.isArray(value) ? value.slice(0, MAX_CHIPS) : [value];
      return items.reduce<number>((sum, item, i) => sum + (i > 0 ? 4 : 0) + 24 + chipLabel(item).length * CHIP_CHAR, 0);
    }
    case 'module': return DOT + fmtCell(value, column).length * MONO_CHAR;
    case 'lang': return DOT + fmtCell(value, column).length * UI_CHAR;
    case 'code': case 'symbol': case 'commit': return fmtCell(value, column).trim().length * MONO_CHAR;
    case 'bar': return 96 + fmtCell(value, column).length * MONO_CHAR;
    case 'heat': return 52 + fmtCell(value, column).length * MONO_CHAR;
    default: return fmtCell(value, column).length * UI_CHAR;
  }
}

/** Where measureColumns puts the typical width of a column (its 90th percentile), next to the largest under `key`. */
export const typicalKey = (key: string): string => `\u0002${key}`;
/** The share of a column's values that sets its typical width: one long outlier does not set it. */
const TYPICAL_SHARE = 0.9;

/**
 * Measures `rows` into `into`: per column, under its key, the largest need (characters for a content-sized column,
 * px for the others) and, under typicalKey(key), the need of nine values in ten. Keeps the larger of what is there.
 */
export function measureColumns(rows: readonly DataRow[], columns: readonly Column[], into: Map<string, number> = new Map()): Map<string, number> {
  const limit = Math.min(rows.length, MEASURED_ROWS);
  for (const column of columns) {
    const sized = isContentSized(column);
    if (!sized && TRACKS[column.kind][1] === 0) continue;
    const needs: number[] = [];
    for (let i = 0; i < limit; i++) {
      const value = rows[i]![column.key];
      needs.push(sized ? contentChars(value, column) : contentWidth(value, column));
    }
    needs.sort((a, b) => a - b);
    const max = needs.at(-1) ?? 0;
    const typical = needs[Math.max(0, Math.ceil(needs.length * TYPICAL_SHARE) - 1)] ?? 0;
    into.set(column.key, Math.max(into.get(column.key) ?? 0, max));
    into.set(typicalKey(column.key), Math.max(into.get(typicalKey(column.key)) ?? 0, typical));
  }
  return into;
}

export interface ColumnBox {
  /** Never narrower: what keeps the column legible, and no more than it needs. */
  floor: number;
  /** What nine of its values in ten and its header need: served before any column grows past its own. */
  typical: number;
  /** What its widest value and its header need. */
  want: number;
  grow: number;
  /** Never wider than its want (numbers, ages, a sha, a sparkline). */
  fixed: boolean;
  textual: boolean;
}

const headWidth = (column: Column) => Math.round(column.label.length * HEAD_CHAR + SORT_GLYPH);
/** Chips and languages are short labels that read badly cut ('TO…'): their floor is their want, up to this. */
const LABEL_FLOOR: Partial<Record<Kind, number>> = {chip: 160, lang: 140};

/**
 * The floor, typical width and want of a column, from what its cells need (`need`: the largest, `typical`: nine in
 * ten; undefined: nothing measured yet).
 */
export function columnBox(column: Column, need: number | undefined, typical: number | undefined = need): ColumnBox {
  const [kindFloor, grow] = TRACKS[column.kind];
  const head = headWidth(column);
  if (isContentSized(column)) {
    const width = need === undefined ? kindFloor : Math.round(Math.min(MAX_CONTENT, Math.max(kindFloor, need * MONO_CHAR + 2, head)));
    return {floor: width, typical: width, want: width, grow, fixed: true, textual: false};
  }
  if (grow === 0) return {floor: kindFloor, typical: kindFloor, want: kindFloor, grow, fixed: true, textual: false};
  const cap = MAX_WANT[column.kind] ?? 320;
  const fit = (n: number | undefined) => (n === undefined ? kindFloor : Math.round(Math.min(cap, Math.max(n + 4, head))));
  const want = Math.max(fit(need), Math.min(kindFloor, head));
  const usual = Math.min(want, fit(typical));
  // A column of short values (script names, versions) is not held at its kind's floor: its widest value sets it, so a
  // short identifier is never cut. Chips and languages keep up to a larger floor: one cut chip reads badly ('TO…').
  const label = LABEL_FLOOR[column.kind];
  const floor = Math.min(label === undefined ? kindFloor : Math.max(kindFloor, label), want);
  return {floor, typical: Math.max(usual, floor), want, grow, fixed: false, textual: TEXTUAL.has(column.kind)};
}

export const COLUMN_GAP = 12;
export const SIDE_PADDING = 14;

/** The width the columns' floors add up to, with gaps and side padding: below it the table scrolls sideways. */
export function floorWidth(boxes: readonly ColumnBox[]): number {
  return boxes.reduce((sum, box) => sum + box.floor, 0) + COLUMN_GAP * Math.max(0, boxes.length - 1) + SIDE_PADDING * 2;
}

/**
 * Width of each column in a table `width` px wide (0: not measured; every column then gets its want). Spare width
 * goes, in turn: to the textual columns up to their typical width (nine values in ten drawn whole), to the same up to
 * their want (the long outliers), to the other growing columns (bars, heat, chips) up to theirs, and what is left to
 * all growing columns in proportion to their want (to the content-sized ones by weight only when nothing else grows),
 * so the rows fill the plate.
 * Each step fills like water (max-min): a short column is whole before a long one grows, and the long columns that
 * are still cut end up equally wide.
 */
export function columnWidths(boxes: readonly ColumnBox[], width: number): number[] {
  const widths = boxes.map(box => box.floor);
  if (width <= 0) return boxes.map(box => box.want);
  let rest = width - floorWidth(boxes);
  if (rest <= 0) return widths;
  const raise = (indexes: number[], capOf: (box: ColumnBox) => number) => {
    if (indexes.length === 0 || rest <= 0) return;
    const at = (level: number) => indexes.map(i => Math.max(widths[i]!, Math.min(capOf(boxes[i]!), level)));
    const used = (level: number) => at(level).reduce((sum, w, k) => sum + w - widths[indexes[k]!]!, 0);
    let high = Math.max(...indexes.map(i => capOf(boxes[i]!)));
    if (used(high) > rest) {
      // The water level: every column below it is raised to it (or to its cap), and that uses exactly `rest`.
      let low = 0;
      for (let step = 0; step < 40; step++) {
        const mid = (low + high) / 2;
        if (used(mid) > rest) high = mid;
        else low = mid;
      }
      high = low;
    }
    const next = at(high);
    rest -= used(high);
    indexes.forEach((i, k) => {
      widths[i] = next[k]!;
    });
  };
  const all = boxes.map((_, i) => i);
  const growing = all.filter(i => !boxes[i]!.fixed && boxes[i]!.grow > 0);
  const textual = growing.filter(i => boxes[i]!.textual);
  raise(textual, box => box.typical);
  raise(textual, box => box.want);
  raise(growing.filter(i => !boxes[i]!.textual), box => box.want);
  // What is left keeps the proportions of the content (a version column does not grow as much as a path column);
  // without a growing column the content-sized ones share it by weight.
  const takers = growing.length > 0 ? growing : all.filter(i => boxes[i]!.grow > 0);
  const weightOf = (i: number) => (growing.length > 0 ? boxes[i]!.want : boxes[i]!.grow);
  const weight = takers.reduce((sum, i) => sum + weightOf(i), 0);
  if (rest > 0 && weight > 0) for (const i of takers) widths[i]! += (rest * weightOf(i)) / weight;
  return widths;
}

/**
 * The grid tracks: a column that took a share of the spare width is `minmax(floor, <width>fr)`, so the browser keeps
 * the proportions when the plate changes size before the next measure; the others are fixed in px.
 */
export function columnTracks(boxes: readonly ColumnBox[], widths: readonly number[]): string[] {
  return boxes.map((box, i) => {
    const width = widths[i]!;
    return box.fixed && width <= box.want + 0.5 ? `${Math.round(width)}px` : `minmax(${box.floor}px, ${Math.max(1, Math.round(width))}fr)`;
  });
}
