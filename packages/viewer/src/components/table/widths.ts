// Column widths for DataTable. No DOM: widths are estimated from the text the cells print, so the table can lay out
// before anything is measured and tests can check the arithmetic.
//
// Every column has a floor (what keeps it legible, never more than it needs) and a want (the width of its widest
// value and of its header). The plate's spare width goes first to a path column until each row's label tells it
// apart (`…/` and the name, and the parent directories a repeated name needs: `…/web_core/CHANGELOG.md`), then to the
// columns of short values (names, statuses, kinds) until nine values in ten are whole, then back to the headers of
// the short tabular columns (numbers, ages, deltas), then to the columns whose text a reader needs whole (text, code,
// symbols, modules, authors) so that each of them has as few of its rows cut as the others (a column of long commands
// gets more than a column of short package names), then to the paths, then to the visual columns (chips, languages,
// bars, heat), and only then is what is left shared out so the rows fill the plate. A tabular column is as wide as
// its values and its header; when the plate is short of width its header gives way first, down to its first five
// letters (the full label is the tooltip), because a header is the same on every row and the values are what the
// rows say. So a package name, an owner or a 'medium' is never cut while a version or a count sits in white space.
import type {DataRow} from '@glimpse/catalog';
import {fmtCell} from '../../kit/index.ts';
import {MAX_CHIPS, ageText, chipLabel} from './cells.tsx';
import type {Column} from './rows.ts';

type Kind = Column['kind'];

/** Floor of a column of each kind, and its weight when width is shared out (0: the column never grows). */
const TRACKS: Readonly<Record<Kind, readonly [floor: number, grow: number]>> = {
  text: [88, 2],
  code: [140, 3],
  // The path column takes the largest share: it is what tells the rows apart (paths-keep-file-name).
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
/**
 * A textual column whose usual value (nine in ten) is at most this wide holds short values (names, statuses, kinds,
 * package names): they are made whole before a number keeps room for its header and before long text grows.
 */
const SHORT_VALUES = 128;
/** A cut header keeps this many letters and its ellipsis (`CONTR…`); a label one letter longer is never cut. */
const HEAD_KEEP = 5;

// Text metrics of the table's fonts (12.5 px IBM Plex Sans, 12 px IBM Plex Mono, 10.5 px uppercase mono chips).
const UI_SIZE = 12.5;
/**
 * Advance widths of printable ASCII (space to `~`) in the cells' face, IBM Plex Sans 400 as the viewer bundles it, in
 * thousandths of an em, measured in Chromium. A flat average (6.7 px a character) put 'medium' at 40 px where it draws
 * at 46 and cut it, and put names of narrow letters wider than they are.
 */
const UI_EM = [
  236, 284, 419, 713, 598, 927, 694, 242, 335, 335, 450, 600, 272, 399, 272, 383, 600, 600, 600, 600, 600, 600, 600, 600,
  600, 600, 292, 292, 600, 600, 600, 477, 891, 641, 653, 621, 671, 583, 559, 695, 707, 400, 510, 634, 501, 812, 707, 708,
  606, 708, 640, 581, 572, 678, 609, 891, 613, 593, 580, 317, 383, 317, 600, 565, 600, 534, 580, 503, 580, 549, 324, 528,
  568, 250, 250, 527, 272, 873, 568, 560, 580, 580, 367, 487, 351, 568, 492, 768, 507, 499, 464, 343, 314, 343, 600,
];
/** Width in px of `text` in the cells' UI face. Letters beyond ASCII take 0.62 em, full-width ones (CJK) a whole em. */
export function uiTextWidth(text: string): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    em += code >= 32 && code < 127 ? UI_EM[code - 32]! / 1000 : code > 0x2e7f ? 1 : 0.62;
  }
  return em * UI_SIZE;
}
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
    case 'lang': return DOT + uiTextWidth(fmtCell(value, column));
    case 'code': case 'symbol': case 'commit': return fmtCell(value, column).trim().length * MONO_CHAR;
    case 'bar': return 96 + fmtCell(value, column).length * MONO_CHAR;
    case 'heat': return 52 + fmtCell(value, column).length * MONO_CHAR;
    default: return uiTextWidth(fmtCell(value, column));
  }
}

/** Where measureColumns puts the typical width of a column (its 90th percentile), next to the largest under `key`. */
export const typicalKey = (key: string): string => `\u0002${key}`;
/** Where measureColumns puts the width the j-th of STEPS shares of a column's values need (see columnWidths). */
export const stepKey = (key: string, j: number): string => `\u0003${j}\u0003${key}`;
/** Where measureColumns puts the width a path column's labels need to tell nine rows in ten apart (labelWidth). */
export const labelKey = (key: string): string => `\u0004${key}`;
/** The share of a column's values that sets its typical width: one long outlier does not set it. */
const TYPICAL_SHARE = 0.9;
/** Shares of a column's values, in steps of 5 %, up to its typical width: the levels textual columns are raised by. */
const STEPS = 18;
/** Pixels given at a time while textual columns share the width by what it shows (columnWidths). */
const CHUNK = 4;

const nth = (sorted: readonly number[], share: number): number => sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)] ?? 0;

/** A path's file part, without a `#L12` location. */
const filePart = (value: string): string => {
  const hash = value.indexOf('#L');
  return hash >= 0 ? value.slice(0, hash) : value;
};

/** A repeated file name is told apart by at most this many parent directories. */
export const MAX_PARENTS = 3;

/**
 * Per path of one column, how many of its directories its label needs so that no other file of the column ends the
 * same way (0 for a name no other file has): `…/web_core/CHANGELOG.md` beside `…/lit_core/CHANGELOG.md` needs 1,
 * `…/a2ui-kanban/…/vite.config.ts` beside `…/a2ui-recipe/…/vite.config.ts` (both under `client/`) needs 2. Never more
 * than MAX_PARENTS. Locations of one file (`#L12`, `#L40`) count as that one file. Not a path: undefined.
 */
export function distinctDepths(values: readonly unknown[]): Array<number | undefined> {
  const files = values.map(value => (typeof value === 'string' && value !== '' ? filePart(value) : undefined));
  const parts = new Map<string, string[]>();
  for (const file of files) if (file !== undefined && !parts.has(file)) parts.set(file, file.split('/').filter(Boolean));
  // How many distinct files end in each run of k trailing segments.
  const ends = new Map<string, number>();
  const end = (segments: readonly string[], k: number) => `${k}\u0000${segments.slice(-k).join('/')}`;
  for (const segments of parts.values()) {
    for (let k = 1; k <= Math.min(segments.length, MAX_PARENTS + 1); k++) ends.set(end(segments, k), (ends.get(end(segments, k)) ?? 0) + 1);
  }
  return files.map(file => {
    if (file === undefined) return undefined;
    const segments = parts.get(file)!;
    let k = 1;
    while (k < segments.length && k <= MAX_PARENTS && (ends.get(end(segments, k)) ?? 0) > 1) k++;
    return k - 1;
  });
}

/**
 * Per path, the width of the label a narrow cell draws for it (kit PathText): `…/` and its file name, `:line` and as
 * many parent directories as it takes to differ from every other file of the column (distinctDepths:
 * `…/web_core/CHANGELOG.md` beside `…/lit/CHANGELOG.md`). A path that is whole at that point is its own width.
 */
export function labelWidths(values: readonly unknown[]): number[] {
  const depths = distinctDepths(values);
  return values.map((value, i) => {
    const depth = depths[i];
    if (typeof value !== 'string' || depth === undefined) return 0;
    const file = filePart(value);
    const segments = file.split('/').filter(Boolean);
    const k = depth + 1;
    const line = value.length > file.length ? value.slice(file.length + 2).replace(/^(\d+).*$/, ':$1') : '';
    const label = segments.slice(-k).join('/').length + (k < segments.length ? 2 : 0) + line.length;
    return label * MONO_CHAR;
  });
}

/**
 * Measures `rows` into `into`: per column, under its key, the largest need (characters for a content-sized column,
 * px for the others), under typicalKey(key) the need of nine values in ten, under stepKey(key, j) the need of each
 * share of the values up to that (textual columns), and under labelKey(key) the label width of nine paths in ten
 * (path columns). Keeps the larger of what is there.
 */
export function measureColumns(rows: readonly DataRow[], columns: readonly Column[], into: Map<string, number> = new Map()): Map<string, number> {
  const limit = Math.min(rows.length, MEASURED_ROWS);
  const keep = (key: string, value: number) => into.set(key, Math.max(into.get(key) ?? 0, value));
  for (const column of columns) {
    const sized = isContentSized(column);
    if (!sized && TRACKS[column.kind][1] === 0) continue;
    const needs: number[] = [];
    for (let i = 0; i < limit; i++) {
      const value = rows[i]![column.key];
      needs.push(sized ? contentChars(value, column) : contentWidth(value, column));
    }
    needs.sort((a, b) => a - b);
    keep(column.key, needs.at(-1) ?? 0);
    keep(typicalKey(column.key), nth(needs, TYPICAL_SHARE));
    if (column.kind === 'path') {
      const labels = labelWidths(rows.slice(0, limit).map(row => row[column.key])).sort((a, b) => a - b);
      keep(labelKey(column.key), nth(labels, TYPICAL_SHARE));
    } else if (!sized && TEXTUAL.has(column.kind)) {
      for (let j = 0; j < STEPS; j++) keep(stepKey(column.key, j), nth(needs, ((j + 1) * TYPICAL_SHARE) / STEPS));
    }
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
  /** A textual column: the width each of STEPS growing shares of its values needs, the last one being `typical`. */
  steps?: readonly number[];
  /** A path column: the width at which nine of its rows in ten are told apart (labelWidths), served first. */
  label?: number;
  /** A textual column of short values (SHORT_VALUES): its typical width, served before headers and long text. */
  short?: number;
  /**
   * A tabular column: the width of its values and its whole header label. Below it the header is cut (never under
   * HEAD_KEEP letters, its floor); above it, up to `want`, it gets the room of a sort glyph and its kind's floor.
   */
  heading?: number;
}

const headWidth = (column: Column) => Math.round(column.label.length * HEAD_CHAR + SORT_GLYPH);
/** The header's label alone, and the part of it a cut header keeps. */
const headLabel = (column: Column) => column.label.length * HEAD_CHAR;
const headKept = (column: Column) => Math.min(column.label.length, HEAD_KEEP + 1) * HEAD_CHAR;
/** Chips and languages are short labels that read badly cut ('TO…'): their floor is their want, up to this. */
const LABEL_FLOOR: Partial<Record<Kind, number>> = {chip: 160, lang: 140};

/**
 * The floor, typical width and want of a column, from what its cells need (`need`: the largest, `typical`: nine in
 * ten; undefined: nothing measured yet). `more` adds what measureColumns found besides: the needs of growing shares of
 * a textual column's values (`steps`) and the label width of a path column (`label`).
 */
export function columnBox(column: Column, need: number | undefined, typical: number | undefined = need, more: {steps?: readonly (number | undefined)[]; label?: number} = {}): ColumnBox {
  const [kindFloor, grow] = TRACKS[column.kind];
  const head = headWidth(column);
  if (isContentSized(column)) {
    if (need === undefined) return {floor: kindFloor, typical: kindFloor, want: kindFloor, grow, fixed: true, textual: false};
    // Its values always; its header whole when there is room, else its first letters (the label is the tooltip).
    const values = need * MONO_CHAR + 2;
    const size = (n: number) => Math.round(Math.min(MAX_CONTENT, Math.max(values, n)));
    const want = size(Math.max(kindFloor, head));
    return {floor: size(headKept(column)), typical: want, want, grow, fixed: true, textual: false, heading: size(headLabel(column))};
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
  const box: ColumnBox = {floor, typical: Math.max(usual, floor), want, grow, fixed: false, textual: TEXTUAL.has(column.kind)};
  // Short values: every one of them whole when the widest is short too, else nine in ten (one long name gives way).
  if (box.textual && column.kind !== 'path' && need !== undefined) {
    const short = want <= SHORT_VALUES ? want : box.typical <= SHORT_VALUES ? box.typical : undefined;
    if (short !== undefined && short > floor) box.short = short;
  }
  if (box.textual && more.steps?.every(step => step !== undefined)) {
    // Never above the typical width: past it a column grows with the others, to its want.
    box.steps = more.steps.map(step => Math.min(box.typical, Math.max(floor, fit(step))));
  }
  if (column.kind === 'path' && more.label !== undefined) box.label = Math.min(want, Math.max(floor, Math.round(more.label + 4)));
  return box;
}

/** columnBox from what measureColumns measured: `stats` holds its keys, each read through `keyOf`. */
export function columnBoxFrom(column: Column, stats: ReadonlyMap<string, number>, keyOf: (key: string) => string = key => key): ColumnBox {
  const read = (key: string) => stats.get(keyOf(key));
  return columnBox(column, read(column.key), read(typicalKey(column.key)), {
    steps: Array.from({length: STEPS}, (_, j) => read(stepKey(column.key, j))),
    label: read(labelKey(column.key)),
  });
}

export const COLUMN_GAP = 12;
export const SIDE_PADDING = 14;

/** The width the columns' floors add up to, with gaps and side padding: below it the table scrolls sideways. */
export function floorWidth(boxes: readonly ColumnBox[]): number {
  return boxes.reduce((sum, box) => sum + box.floor, 0) + COLUMN_GAP * Math.max(0, boxes.length - 1) + SIDE_PADDING * 2;
}

/**
 * Width of each column in a table `width` px wide (0: not measured; every column then gets its want). Spare width
 * goes, in turn: to the path columns up to their label width (each row told apart from the others), to the columns of
 * short values until they are whole (nine in ten when one is long), to the tabular columns up to their whole header
 * label and then up to their want (sort glyph, kind floor), to the other textual columns up to their typical width
 * (nine values in ten drawn whole) by shares of their values and then up to their want (the long outliers), to the
 * paths up to their typical width and then their want, to the other growing columns (bars, heat, chips) up to theirs,
 * and what is left to all growing columns in proportion to their want (to the content-sized ones by weight only when
 * nothing else grows), so the rows fill the plate.
 * The textual columns rise together by the share of their values drawn whole: each gets the width for its shortest
 * 5 %, then 10 %, ... of values, so a column of long commands is cut in as few rows as a column of short names and
 * gets the width that takes. The other steps fill like water (max-min): a short column is whole before a long one
 * grows, and the long columns that are still cut end up equally wide.
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
  const raiseByText = (indexes: number[]) => {
    const gain = (i: number) => boxes[i]!.steps!.reduce((sum, step) => (step > widths[i]! ? sum + 1 / step : sum), 0);
    while (rest > 0) {
      let best = -1;
      for (const i of indexes) if (gain(i) > 0 && (best < 0 || gain(i) > gain(best))) best = i;
      if (best < 0) return;
      // up to the next step of that column, a few pixels at a time
      const next = boxes[best]!.steps!.find(step => step > widths[best]!)!;
      const by = Math.min(rest, CHUNK, next - widths[best]!);
      widths[best]! += by;
      rest -= by;
    }
  };
  const all = boxes.map((_, i) => i);
  const growing = all.filter(i => !boxes[i]!.fixed && boxes[i]!.grow > 0);
  const textual = growing.filter(i => boxes[i]!.textual);
  const tabular = all.filter(i => boxes[i]!.heading !== undefined);
  raise(growing.filter(i => boxes[i]!.label !== undefined), box => box.label!);
  // Short values (names, statuses) whole, then the headers of the numbers beside them, then a sort glyph's room: a
  // header is cut before a value is, and only for a value that is short enough to be made whole by it.
  raise(textual.filter(i => boxes[i]!.short !== undefined), box => box.short!);
  raise(tabular, box => box.heading!);
  raise(tabular, box => box.want);
  // By what a pixel shows: each step of a column stands for 5 % of its values, and a pixel more shows 1/need of each
  // value still cut. The column whose cut values gain the most from it takes the next few pixels, so a common short
  // name is made whole cheaply and a column of long commands then takes the width (raiseByText).
  raiseByText(textual.filter(i => boxes[i]!.steps !== undefined));
  // Text is whole, outliers too, before a path shows more directories than its label needs: a path gives way at its
  // directories by design (paths-keep-file-name), a package name or an owner cut is just cut.
  const paths = textual.filter(i => boxes[i]!.label !== undefined);
  const words = textual.filter(i => boxes[i]!.label === undefined);
  raise(words, box => box.typical);
  raise(words, box => box.want);
  raise(paths, box => box.typical);
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
