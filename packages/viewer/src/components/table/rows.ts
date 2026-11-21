// Row logic for the table family: coercion, column resolution, sort, search, grouping and the entity a row stands
// for. No DOM. Which entity a file location names and how an entity relates to the selection are the kit's rules.
import {
  parseFileLoc, parseRef, readNodes,
  type DataRow, type Dataset, type EntityRef, type Field, type FieldKind,
} from '@glimpse/catalog';
import {fileEntity, linkedEntity, matchSelection} from '../../kit/index.ts';

/** Numbers and numeric strings; everything else (null, '', NaN, objects) is undefined. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a value is, for E_SHAPE messages. */
export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

// ---------------------------------------------------------------- rows
export interface NormalRows {
  rows: DataRow[];
  /** Items that were neither objects nor scalars and were left out. */
  skipped: number;
}

/** Rows as objects: scalars become `{value}`, anything else (null, nested arrays) is dropped and counted. */
export function normalizeRows(data: unknown): NormalRows | undefined {
  if (!Array.isArray(data)) return undefined;
  const rows: DataRow[] = [];
  let skipped = 0;
  for (const item of data) {
    if (isRecord(item)) rows.push(item);
    else if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') rows.push({value: item});
    else skipped++;
  }
  return {rows, skipped};
}

// ---------------------------------------------------------------- columns
export interface Column {
  key: string;
  label: string;
  kind: FieldKind;
  unit?: string;
  priority: 1 | 2 | 3;
}

const SNIFF_ROWS = 50;
const MAX_SNIFFED_COLUMNS = 24;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const KEY_KINDS: ReadonlyArray<readonly [RegExp, FieldKind]> = [
  [/^(?:path|file|dir)$/i, 'path'],
  [/^(?:sha|commit)$/i, 'commit'],
  [/^(?:author|owner)$/i, 'author'],
  [/^lang(?:uage)?$/i, 'lang'],
  [/^module$/i, 'module'],
];

/** One path segment or more, then a name: no spaces, no scheme (`https:`), not a package scope (`@scope/name`). */
const PATH_LIKE = /^(?![\w+.-]+:)(?!@)[^\s/][^\s]*\/[^\s/]+$/;

/**
 * A value that reads as a repository path: `src/a.ts`, `docs/guide/intro`, `web/x.tsx#L19`. A single slash between
 * two words without an extension (`and/or`, `@ledger/site`, `km/h`) is not one. A column of such values is a path
 * column whatever its name ('with', 'where'), so its cells keep the file name and give way at the directory (D12).
 */
export function looksLikePath(value: string): boolean {
  if (!PATH_LIKE.test(value)) return false;
  const file = value.replace(/#L\d+(?:-\d+)?$/, '');
  if (file !== value) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(file.slice(file.lastIndexOf('/') + 1)) || (file.match(/\//g)?.length ?? 0) >= 2;
}

function sniffKind(key: string, rows: readonly DataRow[]): FieldKind {
  let seen: FieldKind | undefined;
  const limit = Math.min(rows.length, SNIFF_ROWS);
  for (let i = 0; i < limit; i++) {
    const value = rows[i]?.[key];
    if (value === null || value === undefined || value === '') continue;
    let kind: FieldKind;
    if (typeof value === 'number') kind = 'num';
    else if (typeof value === 'boolean') kind = 'bool';
    else if (Array.isArray(value)) kind = value.length > 0 && value.every(v => typeof v === 'number') ? 'spark' : 'text';
    else if (isRecord(value)) kind = 'add' in value || 'del' in value ? 'delta' : 'text';
    else if (typeof value === 'string') kind = KEY_KINDS.find(([re]) => re.test(key))?.[1] ?? (ISO_DATE.test(value) ? 'date' : looksLikePath(value) ? 'path' : 'text');
    else kind = 'text';
    if (seen !== undefined && seen !== kind) return 'text';
    seen = kind;
  }
  return seen ?? 'text';
}

const humanize = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');

/**
 * Columns from the `columns` prop (as read by readColumns), else the dataset's fields, else sniffed from the first 50
 * rows. A column the prop names without a kind takes the kind (and label) the dataset declares for that field.
 */
export function resolveColumns(wanted: readonly Field[] | undefined, fields: readonly Field[] | undefined, rows: readonly DataRow[]): Column[] {
  const declared = new Map((fields ?? []).map(field => [field.key, field]));
  const finish = (field: Field): Column => {
    const base = declared.get(field.key);
    return {
      key: field.key,
      label: field.label ?? base?.label ?? humanize(field.key),
      kind: field.kind ?? base?.kind ?? sniffKind(field.key, rows),
      ...(field.unit ?? base?.unit ? {unit: field.unit ?? base?.unit} : {}),
      priority: field.priority ?? base?.priority ?? 2,
    };
  };
  if (wanted && wanted.length > 0) return wanted.map(finish);
  if (fields && fields.length > 0) return fields.filter(field => typeof field?.key === 'string').map(finish);
  const keys: string[] = [];
  const known = new Set<string>();
  const limit = Math.min(rows.length, SNIFF_ROWS);
  for (let i = 0; i < limit && keys.length < MAX_SNIFFED_COLUMNS; i++) {
    for (const key of Object.keys(rows[i] ?? {})) {
      if (known.has(key)) continue;
      known.add(key);
      keys.push(key);
      if (keys.length >= MAX_SNIFFED_COLUMNS) break;
    }
  }
  return keys.map(key => finish({key}));
}

/** The field names the data has: the dataset's fields and the keys of its first rows. */
export function knownFields(fields: readonly Field[] | undefined, rows: readonly DataRow[]): string[] {
  const keys = new Set<string>();
  for (const field of fields ?? []) if (typeof field?.key === 'string') keys.add(field.key);
  const limit = Math.min(rows.length, SNIFF_ROWS);
  for (let i = 0; i < limit; i++) for (const key of Object.keys(rows[i] ?? {})) keys.add(key);
  return [...keys];
}

export interface CheckedColumns {
  columns: Column[];
  /** Fields the `columns` prop names that the data does not have; they are left out. */
  missing: string[];
}

/**
 * resolveColumns, without the columns the data does not have (decisions D14, D15): a guessed field name never draws
 * a column of dashes. When none of the named columns exists the table falls back to its default columns. The server
 * already corrects the field names of a bound source; this catches inline data and anything it could not know.
 */
export function checkColumns(wanted: readonly Field[], fields: readonly Field[] | undefined, rows: readonly DataRow[]): CheckedColumns {
  const columns = resolveColumns(wanted, fields, rows);
  if (wanted.length === 0 || rows.length === 0) return {columns, missing: []};
  const known = new Set(knownFields(fields, rows));
  const kept = columns.filter(column => known.has(column.key));
  const missing = columns.filter(column => !known.has(column.key)).map(column => column.key);
  if (missing.length === 0) return {columns, missing};
  return {columns: kept.length > 0 ? kept : resolveColumns(undefined, fields, rows), missing};
}

/** `fields: a b c` for a message that names a field the data lacks; at most `max` names. */
export function fieldList(known: readonly string[], max = 12): string {
  return `fields: ${known.slice(0, max).join(' ')}${known.length > max ? ' …' : ''}`;
}

export const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set(['num', 'bytes', 'pct', 'duration', 'bar', 'heat']);

// ---------------------------------------------------------------- sort
export interface SortSpec { key: string; desc: boolean }

export function parseSort(text: string | undefined): SortSpec | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const desc = trimmed.startsWith('-');
  const key = desc || trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  return key ? {key, desc} : undefined;
}
export const formatSort = (sort: SortSpec | undefined): string | undefined => (sort ? (sort.desc ? '-' : '') + sort.key : undefined);

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});

function sortValue(value: unknown, kind: FieldKind | undefined): number | string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (kind === 'delta' && isRecord(value)) return (num(value.add) ?? 0) + (num(value.del) ?? 0);
  if (kind === 'date' && typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
  }
  if (kind !== undefined && NUMERIC_KINDS.has(kind)) return num(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.reduce<number>((sum, v) => sum + (num(v) ?? 0), 0);
  return undefined;
}

/** A sorted copy. Rows without a value for the field stay last in both directions; ties keep their order. */
export function sortRows(rows: readonly DataRow[], sort: SortSpec | undefined, kindOf: (key: string) => FieldKind | undefined): DataRow[] {
  if (!sort) return rows as DataRow[];
  const kind = kindOf(sort.key);
  const keyed = rows.map(row => ({row, value: sortValue(row[sort.key], kind)}));
  const direction = sort.desc ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.value === undefined || b.value === undefined) return a.value === b.value ? 0 : a.value === undefined ? 1 : -1;
    if (typeof a.value === 'number' && typeof b.value === 'number') return direction * (a.value - b.value);
    return direction * collator.compare(String(a.value), String(b.value));
  });
  return keyed.map(entry => entry.row);
}

// ---------------------------------------------------------------- search
const haystacks = new WeakMap<DataRow, string>();
function haystack(row: DataRow): string {
  let text = haystacks.get(row);
  if (text === undefined) {
    text = Object.values(row).map(value => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''))).join('\u0001').toLowerCase();
    haystacks.set(row, text);
  }
  return text;
}

/** Substring match over every cell of a row, case-insensitive (the same rule the server applies to `q`). */
export function filterRows(rows: readonly DataRow[], query: string): DataRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows as DataRow[];
  return rows.filter(row => haystack(row).includes(needle));
}

// ---------------------------------------------------------------- groups
export type TableItem =
  | {type: 'group'; key: string; count: number; open: boolean}
  | {type: 'row'; row: DataRow};

/** Group label of a row. Path-like fields group by file, so 'a.ts#L3' and 'a.ts#L9' share a group. */
export function groupKeyOf(row: DataRow, field: string, kind: FieldKind | undefined): string {
  const value = row[field];
  if (value === null || value === undefined || value === '') return '';
  if (kind === 'path' && typeof value === 'string') return parseFileLoc(value).path;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Flat list for the virtualizer: a header per group (in order of first appearance) followed by its rows when open. */
export function groupItems(rows: readonly DataRow[], field: string | undefined, kind: FieldKind | undefined, closed: ReadonlySet<string>): TableItem[] {
  if (!field) return rows.map(row => ({type: 'row', row}));
  const groups = new Map<string, DataRow[]>();
  for (const row of rows) {
    const key = groupKeyOf(row, field, kind);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  const items: TableItem[] = [];
  for (const [key, members] of groups) {
    const open = !closed.has(key);
    items.push({type: 'group', key, count: members.length, open});
    if (open) for (const row of members) items.push({type: 'row', row});
  }
  return items;
}

// ---------------------------------------------------------------- entities
const DIR_KEY = /^dir(?:ectory)?$/i;

/** The file a row names: its `path` or `file` field (a FileLoc), when present. */
export function rowFile(row: DataRow): string | undefined {
  const value = typeof row.path === 'string' && row.path ? row.path : typeof row.file === 'string' && row.file ? row.file : undefined;
  return value?.trim() || undefined;
}

/** The entity an entity-kind cell stands for; undefined for empty cells and non-entity kinds. */
export function cellEntity(column: Column, row: DataRow, ds: Dataset | undefined): EntityRef | undefined {
  const value = row[column.key];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  switch (column.kind) {
    case 'path': {
      if (DIR_KEY.test(column.key) || value.endsWith('/')) {
        const path = value.replace(/\/+$/, '');
        return path ? {type: 'dir', id: path, path} : undefined;
      }
      return fileEntity(value);
    }
    case 'module': return {type: 'module', id: value};
    case 'author': return {type: 'author', id: value};
    case 'commit': return {type: 'commit', id: value};
    case 'symbol': {
      // code.symbols rows carry no file: it is the target of the source ref.
      const ref = ds ? parseRef(ds.source) : undefined;
      const file = rowFile(row) ?? (ref?.source === 'code.symbols' ? ref.target : undefined);
      const line = num(row.line);
      const endLine = num(row.endLine);
      const path = file ? parseFileLoc(file).path : undefined;
      return {type: 'symbol', id: value, ...(path ? {path} : {}), ...(path && line != null ? {line} : {}), ...(path && line != null && endLine != null ? {endLine} : {})};
    }
    default: return undefined;
  }
}

/**
 * What activating a row selects: the file in its `path` / `file` field, else its first entity cell, else the row
 * itself (identified by its first cell). A row written inline (not from a source) that names diagram nodes in a `node`
 * field (`node:'PG'`, decision D24) carries them, so it lights with node PG; a source's `node` field is only data.
 */
export function rowEntity(row: DataRow, columns: readonly Column[], index: number, ds: Dataset | undefined): EntityRef {
  const own = ownEntity(row, columns, index, ds);
  return ds?.$ds ? own : (linkedEntity(own, readNodes(row).ids, {id: own.id, label: own.label ?? own.id}) ?? own);
}

function ownEntity(row: DataRow, columns: readonly Column[], index: number, ds: Dataset | undefined): EntityRef {
  const file = rowFile(row);
  if (file) return fileEntity(file);
  for (const column of columns) {
    const entity = cellEntity(column, row, ds);
    if (entity) return entity;
  }
  const first = columns[0] ? row[columns[0].key] : undefined;
  const label = first === null || first === undefined || typeof first === 'object' ? undefined : String(first);
  return {type: 'row', id: `${ds?.$ds ?? 'rows'}:${label ?? index}`, ...(label ? {label} : {})};
}

/**
 * How the surface selection marks an entity: it is the selection, it lies inside the selected directory or names the
 * same diagram nodes (decision D24: marked, but not the selected row), or neither.
 */
export type SelectionMark = 'exact' | 'within' | undefined;

export function selectionMark(selected: EntityRef | null, entity: EntityRef): SelectionMark {
  const match = matchSelection(selected, entity);
  // Two rows of one file ('a.ts#L3', 'a.ts#L9') are different places: a selection with a line marks only its row.
  if (match === 'exact') return selected?.line == null || entity.line == null || selected.line === entity.line ? 'exact' : undefined;
  return match === 'within' || match === 'linked' ? 'within' : undefined;
}

/** `path:line` for an editor or a terminal; the label or id for entities without a path. The kit's rule (`c` copies the same text in every component). */
export {entityClipText as clipText} from '../../kit/index.ts';

export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text)?.catch(() => {});
}
