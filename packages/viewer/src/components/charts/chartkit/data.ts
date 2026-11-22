// Pure data helpers shared by every chart: coercion, field sniffing, default encodings, entities, series slots and
// text fitting. Nothing here touches the DOM.
import type {DataRow, EntityRef, Field, FieldKind, Format, Roles, Rows} from '@glimpse/catalog';
import {elidePath, fileEntity, fmtNum, splitPath} from '../../../kit/index.ts';

export const DASH = '—';
export const OTHER = 'other';

/** Finite numbers and numeric strings; everything else (null, '', NaN, Infinity, objects) is undefined. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Epoch milliseconds of an ISO date string or a Date. With `epoch`, numbers count too (seconds below 1e11). */
export function time(value: unknown, epoch = false): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value === 'string') {
    const text = value.trim();
    if (!ISO_DATE.test(text)) return undefined;
    const t = Date.parse(text.replace(' ', 'T'));
    return Number.isNaN(t) ? undefined : t;
  }
  if (epoch && typeof value === 'number' && Number.isFinite(value)) return Math.abs(value) < 1e11 ? value * 1000 : value;
  return undefined;
}

/** Text of a category value. Null, undefined and '' are the dash. */
export function label(value: unknown): string {
  if (value == null || value === '') return DASH;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : DASH;
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value) ?? DASH;
  } catch {
    return DASH;
  }
}

/** What a value is, for E_SHAPE messages: 'string', 'array of 3', 'object', 'null'. */
export function received(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array of ${value.length}`;
  return typeof value;
}

const isRecord = (value: unknown): value is DataRow => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The object rows of an array and how many entries were not objects. Undefined when the value is not an array. */
export function cleanRows(input: unknown): {rows: Rows; skipped: number} | undefined {
  if (!Array.isArray(input)) return undefined;
  const rows = input.filter(isRecord);
  return {rows, skipped: input.length - rows.length};
}

// ---------------------------------------------------------------- fields
export type FieldClass = 'num' | 'date' | 'cat';
export interface FieldInfo {
  key: string;
  label: string;
  kind?: FieldKind;
  unit?: string;
  cls: FieldClass;
}
export interface FieldSet {
  list: FieldInfo[];
  /** Every key the data has: the fields the dataset describes, then any other key of the first rows. */
  keys: string[];
  /** Info for any key, sniffed from the rows when the dataset does not describe it. */
  get(key: string): FieldInfo;
  first(cls: FieldClass, not?: ReadonlyArray<string | undefined>): FieldInfo | undefined;
  /**
   * The key a field name from a spec means: the name itself, the same name in another case, or the key whose label
   * it is. Undefined when the data has no such field.
   */
  find(name: string): string | undefined;
}

const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(['num', 'bytes', 'pct', 'duration', 'bar', 'heat']);
const SNIFF_ROWS = 50;
/** Rows read for the keys the data has: a key that only appears further down is rare and costs a false W_FIELD. */
const KEY_ROWS = 200;

function sniff(rows: Rows, key: string): FieldClass {
  let seen = 0;
  let numeric = 0;
  let dates = 0;
  for (let i = 0; i < rows.length && i < SNIFF_ROWS; i++) {
    const value = rows[i]![key];
    if (value == null || value === '') continue;
    seen++;
    if (num(value) !== undefined) numeric++;
    else if (time(value) !== undefined) dates++;
  }
  // a stray 'n/a' does not turn a measure into a category: the majority of the sample decides
  if (numeric * 2 > seen) return 'num';
  if (dates * 2 > seen) return 'date';
  return 'cat';
}

/** Describes the columns of a rows dataset: from `fields` when the dataset has them, else from the first 50 rows. */
export function inspect(rows: Rows, fields?: Field[]): FieldSet {
  const describe = (key: string, field?: Field): FieldInfo => ({
    key,
    label: field?.label ?? key,
    kind: field?.kind,
    unit: field?.unit,
    cls: field?.kind ? (NUMERIC_KINDS.has(field.kind) ? 'num' : field.kind === 'date' ? 'date' : 'cat') : sniff(rows, key),
  });
  const present = new Set<string>();
  for (let i = 0; i < rows.length && i < KEY_ROWS; i++) for (const key of Object.keys(rows[i]!)) present.add(key);
  let list: FieldInfo[];
  if (Array.isArray(fields) && fields.length > 0) {
    list = fields.filter(field => field && typeof field.key === 'string').map(field => describe(field.key, field));
  } else {
    list = [...present].map(key => describe(key));
  }
  const byKey = new Map(list.map(info => [info.key, info]));
  const keys = [...byKey.keys()];
  for (const key of present) if (!byKey.has(key)) keys.push(key);
  const known = new Set(keys);
  return {
    list,
    keys,
    get(key) {
      let info = byKey.get(key);
      if (!info) {
        info = describe(key);
        byKey.set(key, info);
      }
      return info;
    },
    first: (cls, not = []) => list.find(info => info.cls === cls && !not.includes(info.key)),
    find(name) {
      if (known.has(name)) return name;
      const lower = name.toLowerCase();
      return keys.find(key => key.toLowerCase() === lower) ?? list.find(info => info.label.toLowerCase() === lower)?.key;
    },
  };
}

// ---------------------------------------------------------------- field names a spec gave (decisions reports-are-component-state, guessed-fields-repaired)
/** A field name the spec gave for `prop` that the data does not have. */
export interface FieldMiss {
  prop: string;
  name: string;
}

/**
 * Checks one field name of a spec against the data. A name the data has comes back as its key; one it does not have
 * is listed in `misses` and dropped, so the chart falls back to its default encoding for that prop, as it would had
 * the spec left the prop out, and says what it could not find (W_FIELD). It never draws an empty plate for a guess.
 */
export function checkField(fields: FieldSet, prop: string, name: string | undefined, misses: FieldMiss[]): string | undefined {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text === '') return undefined;
  const key = fields.find(text);
  if (key === undefined) misses.push({prop, name: text});
  return key;
}

/** checkField for a prop that takes several names ('commits files'), or one label with spaces ('Main module'). */
export function checkFields(fields: FieldSet, prop: string, spec: string | undefined, misses: FieldMiss[]): string[] {
  const whole = typeof spec === 'string' && /\s/.test(spec.trim()) ? fields.find(spec.trim()) : undefined;
  if (whole !== undefined) return [whole];
  const keys: string[] = [];
  for (const name of words(spec)) {
    const key = checkField(fields, prop, name, misses);
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

const LISTED_FIELDS = 16;

/**
 * The W_FIELD message: each missing name with the prop that asked for it, where it was looked for, and the fields
 * the data has. `no field "date" (x) in git.timeline; fields: week module commits`.
 */
export function missText(misses: readonly FieldMiss[], fields: FieldSet, source?: string): string {
  const names = misses.map(miss => `"${say(miss.name, 40)}" (${miss.prop})`).join(', ');
  const keys = fields.keys.length > LISTED_FIELDS ? [...fields.keys.slice(0, LISTED_FIELDS), '…'] : fields.keys;
  return `no field${misses.length === 1 ? '' : 's'} ${names} in ${source ?? 'the data'}; fields: ${keys.length > 0 ? keys.join(' ') : 'none'}`;
}

/** The plate's note for the same: short, since the axes already name the fields drawn instead. */
export function missNote(misses: readonly FieldMiss[]): string | undefined {
  if (misses.length === 0) return undefined;
  return `no field ${misses.map(miss => `"${say(miss.name, 24)}"`).join(', ')}`;
}

/**
 * Why a chart draws nothing. W_FIELD: a field the spec named is not in the data (and the default found nothing
 * either). W_SHAPE: the data has no field the chart can draw. Both are told to the model (decision reports-are-component-state).
 */
export interface Unfit {
  code: 'W_FIELD' | 'W_SHAPE';
  message: string;
}

/** The Unfit for a model that found nothing to draw: the missing names when the spec gave any, else `why`. */
export function unfit(why: string, misses: readonly FieldMiss[], fields: FieldSet, source?: string): Unfit {
  return misses.length > 0 ? {code: 'W_FIELD', message: missText(misses, fields, source)} : {code: 'W_SHAPE', message: source ? `${why} (${source})` : why};
}

// ---------------------------------------------------------------- additive measures
// Lines, files and bytes add up across rows: a remainder of them can be one `other` bar. Commit counts per file do
// not (one commit touches many files), nor do authors, scores, shares or complexity: summing them draws a bar no
// row has (V004).
const ADDITIVE = /^(loc|sloc|lines|lines of code|non-blank lines|files|bytes|size|count|add|added|additions|insertions|del|deleted|deletions|tokens)$/i;

/** True when the values of a measure can be summed across rows into a meaningful remainder. */
export function additive(info: FieldInfo | undefined): boolean {
  if (!info) return false;
  if (info.kind === 'bytes') return true;
  if (info.kind === 'pct' || info.kind === 'duration') return false;
  return ADDITIVE.test(info.key) || ADDITIVE.test(info.label);
}

/** A statistic of whole numbers (a median of line counts) is drawn as a whole number. */
export function asWhole(value: number, values: readonly number[]): number {
  return Number.isInteger(value) || !values.every(Number.isInteger) ? value : Math.round(value);
}

/** First non-empty candidate: an explicit prop, then the dataset's role, then a sniffed field. */
export function pick(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find(candidate => typeof candidate === 'string' && candidate.trim() !== '')?.trim();
}

/** 'commits files' -> ['commits', 'files']. */
export function words(spec: string | undefined): string[] {
  return spec ? spec.split(/[\s,]+/).filter(Boolean) : [];
}

export function roleY(roles: Roles | undefined): string[] {
  return Array.isArray(roles?.y) ? roles.y.filter(key => typeof key === 'string') : [];
}

export function formatOf(info: FieldInfo | undefined): Format {
  return info?.kind === 'bytes' ? 'bytes' : info?.kind === 'pct' ? 'pct' : info?.kind === 'duration' ? 'duration' : 'num';
}

/** A value as text in its field's format, with the unit when the dataset names one. */
export function fmtValue(value: number | undefined, info?: FieldInfo): string {
  if (value === undefined) return DASH;
  const text = fmtNum(value, formatOf(info));
  return info?.unit && formatOf(info) === 'num' ? `${text} ${info.unit}` : text;
}

/** Formatter for axis ticks: compact above 10,000 so labels stay short. */
export function tickFormat(ticks: readonly number[], format: Format): (value: number) => string {
  const big = ticks.some(tick => Math.abs(tick) >= 10_000);
  return value => fmtNum(value, format === 'num' && big ? 'compact' : format);
}

// ---------------------------------------------------------------- entities and selection
const ENTITY_KINDS: Partial<Record<FieldKind, EntityRef['type']>> = {path: 'file', module: 'module', author: 'author', commit: 'commit', symbol: 'symbol'};
// Inline rows carry no field kinds: the usual column names say what a value is.
const ENTITY_KEYS: Record<string, EntityRef['type']> = {path: 'file', file: 'file', module: 'module', author: 'author', owner: 'author', commit: 'commit', sha: 'commit', symbol: 'symbol'};

/**
 * The entity a mark stands for. A path field (or a row that carries `path` / `file`) is a file; module, author,
 * commit and symbol fields are entities of that type; anything else is a `row` named by its label.
 */
export function entityOf(info: FieldInfo | undefined, value: unknown, row?: DataRow): EntityRef | undefined {
  const text = typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined;
  if (text !== undefined && info) {
    const type = info.kind ? ENTITY_KINDS[info.kind] : ENTITY_KEYS[info.key.toLowerCase()];
    if (type === 'file') return fileEntity(text);
    if (type) return {type, id: text, label: text};
  }
  const path = row && (typeof row.path === 'string' ? row.path : typeof row.file === 'string' ? row.file : undefined);
  if (path) return fileEntity(path);
  return text === undefined ? undefined : {type: 'row', id: text, label: text};
}

// Whether a mark's entity is the surface selection or lies inside it (same type and id, the same path, a file inside
// a selected directory), and what `c` copies, are the kit's rules (marksSelection, entityClipText): one definition
// for every component. Re-exported under the names the charts use.
export {entityClipText as clipText, marksSelection as matches} from '../../../kit/index.ts';

// ---------------------------------------------------------------- series and slots
export type SlotKind = 'lang' | 'module' | 'author';

/** Which /meta/slots table names the inks of a field's values, if any. */
export function slotKind(info: Pick<FieldInfo, 'key' | 'kind'> | undefined): SlotKind | undefined {
  if (!info) return undefined;
  if (info.kind === 'lang' || info.kind === 'module' || info.kind === 'author') return info.kind;
  if (info.kind !== undefined) return undefined;
  if (/^(lang|language)$/i.test(info.key)) return 'lang';
  if (/^module$/i.test(info.key)) return 'module';
  if (/^(author|owner)$/i.test(info.key)) return 'author';
  return undefined;
}

// Colour slots for series names come from the kit (design stable-category-colours): a name the session gave a slot keeps it, the rest
// take the lowest free slots in order of first appearance, and only a ninth name is `other`. Re-exported so the
// charts have one import site.
export {assignSlots, isOtherKey} from '../../../kit/index.ts';

/**
 * Fill of the folded `other` series: a light neutral, so the remainder never reads as the heaviest ink of a chart.
 * Lines and dots keep the plain `other` ink (`catVar(0)`), which has to hold against the surface on its own.
 */
export const OTHER_FILL = 'color-mix(in oklab, var(--gl-cat-other) 38%, var(--gl-surface))';

/** Fill for a series slot: its categorical ink, or the light neutral for `other`. */
export function fillVar(slot: number): string {
  return slot >= 1 && slot <= 8 ? `var(--gl-cat-${slot})` : OTHER_FILL;
}

/**
 * A categorical ink as an area tint (treemap and icicle cells): mixed into the surface, more strongly on the dark
 * plate, where a light mix turns to mud.
 */
export function tintVar(ink: string): string {
  return `light-dark(color-mix(in oklab, ${ink} 32%, var(--gl-surface)), color-mix(in oklab, ${ink} 46%, var(--gl-surface)))`;
}

/** Up to eight series are kept; beyond that the seven largest stay and the rest fold into `other`. */
export function foldSeries(totals: ReadonlyMap<string, number>, max = 8): {keep: string[]; folded: Set<string>} {
  const names = [...totals.keys()];
  if (names.length <= max) return {keep: names, folded: new Set()};
  const ranked = [...names].sort((a, b) => Math.abs(totals.get(b) ?? 0) - Math.abs(totals.get(a) ?? 0));
  const top = new Set(ranked.slice(0, max - 1));
  return {keep: names.filter(name => top.has(name)), folded: new Set(names.filter(name => !top.has(name)))};
}

/**
 * The `max` largest series, in their order, for a measure whose remainder cannot be summed into `other`: the rest
 * are left out and counted.
 */
export function topSeries(totals: ReadonlyMap<string, number>, max = 8): {keep: string[]; dropped: number} {
  const names = [...totals.keys()];
  if (names.length <= max) return {keep: names, dropped: 0};
  const ranked = [...names].sort((a, b) => Math.abs(totals.get(b) ?? 0) - Math.abs(totals.get(a) ?? 0));
  const top = new Set(ranked.slice(0, max));
  return {keep: names.filter(name => top.has(name)), dropped: names.length - max};
}

// ---------------------------------------------------------------- text fitting
// IBM Plex Mono advances 0.6 em per glyph, so tick and label widths are arithmetic: no layout read, and the same
// answer in tests as in a browser.
const ADVANCE = 0.6;

export function textWidth(text: string, px = 11): number {
  return text.length * px * ADVANCE;
}

/** Width of the widest of some texts; 0 for none. */
export function widest(texts: Iterable<string>, px = 11): number {
  let width = 0;
  for (const text of texts) width = Math.max(width, textWidth(text, px));
  return width;
}

/** Cuts text to a pixel width with an ellipsis at the end. */
export function clip(text: string, maxPx: number, px = 11): string {
  const fit = Math.floor(maxPx / (px * ADVANCE));
  if (text.length <= fit) return text;
  return fit <= 1 ? '' : text.slice(0, fit - 1) + '…';
}

/**
 * Cuts a path to a pixel width with the ellipsis at the front: the end of a path is the part that names it. The cut
 * is the kit's (elidePath, design rule paths-keep-file-name): whole directories go first and the last name stays whole when it can.
 */
export function clipTail(text: string, maxPx: number, px = 11): string {
  const fit = Math.floor(maxPx / (px * ADVANCE));
  if (text.length <= fit) return text;
  return fit <= 1 ? '' : elidePath(text, fit);
}

/**
 * A path fitted to a pixel width (clipTail), split into the directory part (drawn dim, ellipsis included) and the
 * base name (drawn in ink).
 */
export function clipPath(path: string, maxPx: number, px = 11): {dir: string; base: string} {
  return splitPath(clipTail(path, maxPx, px));
}

/**
 * Fits a path-like name ('typescript/renderers/lit', 'swift/core/Tests/*') by cutting its middle: the last segment
 * stays whole, then as many leading segments as fit, so names that share a prefix stay apart. Text without a slash
 * is cut at the end. `dir` is everything before the last segment as drawn, ellipsis included.
 */
export function clipName(text: string, maxPx: number, px = 11): {dir: string; base: string} {
  const fit = Math.floor(maxPx / (px * ADVANCE));
  const parts = text.split('/');
  // a trailing wildcard or an empty segment is not a name: it stays with the segment before it
  let tail = 1;
  while (tail < parts.length && /^\**$/.test(parts[parts.length - tail]!)) tail++;
  if (parts.length <= tail) return {dir: '', base: clip(text, maxPx, px)};
  const base = parts.slice(parts.length - tail).join('/');
  const lead = parts.slice(0, parts.length - tail);
  if (text.length <= fit) return {dir: lead.join('/') + '/', base};
  if (base.length + 2 > fit) return {dir: '', base: clip(base, maxPx, px)};
  let head = '';
  for (const part of lead) {
    if (head.length + part.length + 1 + 2 + base.length > fit) break;
    head += part + '/';
  }
  return {dir: head + '…/', base};
}

/** '1 row', '12,840 rows': the count in tabular form with the noun in the right number. */
export function count(n: number, noun: string): string {
  return `${fmtNum(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** Short text for aria labels and announcements: long labels are cut so a label never reads for a minute. */
export function say(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
