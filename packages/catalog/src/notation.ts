// packages/catalog/src/notation.ts
// DataTable columns: a list [{key, kind?, label?}] (or 'key' items), and the older shorthand string
// ('path commits:bar last:date=Last_change') the built-in presets still use. One pure reader shared by the server
// (checks literal columns at show time) and the viewer (reads them, and reports what a patch wrote that it cannot
// draw), so the two always agree. Flowchart and SequenceDiagram take data, not a notation (diagrams.ts).
import type {Field, FieldKind} from './datasets.ts';

const clip = (text: string, max = 40) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Its own copy of diagrams.ts describeValue: importing it would make that module a chunk the table and diagram chunks
// share (an extra request on every page with a table).
const describeValue = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;

/** Every FieldKind, in the order the docs list them. */
export const FIELD_KINDS = [
  'text', 'num', 'bytes', 'pct', 'duration', 'path', 'symbol', 'module', 'author', 'commit', 'lang',
  'date', 'bar', 'heat', 'spark', 'chip', 'delta', 'code', 'bool',
] as const satisfies readonly FieldKind[];
const KIND_SET: ReadonlySet<string> = new Set(FIELD_KINDS);
// Compile-time check that FIELD_KINDS lists every FieldKind.
type MissingKind = Exclude<FieldKind, (typeof FIELD_KINDS)[number]>;
const allKindsListed: MissingKind extends never ? true : never = true;
void allKindsListed;

/** One column of DataTable.columns in the list form. `field` and `name` are read as `key`, `title` as `label`. */
export interface ColumnItem { key: string; kind?: FieldKind; label?: string }
/** DataTable.columns as an author writes it: the list (the documented form), or the shorthand string. */
export type ColumnsValue = Array<string | ColumnItem> | string;

/** Spellings of `key` and `label` an entry may use; the first one present wins. */
const KEY_PROPS = ['key', 'field', 'name'] as const;
const LABEL_PROPS = ['label', 'title'] as const;
const ITEM_PROPS: ReadonlySet<string> = new Set([...KEY_PROPS, 'kind', ...LABEL_PROPS]);
const ITEM_HINT = "'key' or {key, kind?, label?}";

export interface ColumnProblem {
  /** 1-based position of the column; 0 for the value as a whole. */
  column: number;
  /**
   * kind: an unknown kind (the column draws without it); dropped: the column is not drawn; ignored: keys of an entry
   * that are not read; shape: the value is neither a list nor a string (no column is read).
   */
  type: 'kind' | 'dropped' | 'ignored' | 'shape';
  message: string;
}
export interface ReadColumns {
  fields: Field[];
  problems: ColumnProblem[];
}

const unknownKind = (kind: unknown, key: string) =>
  `unknown kind ${typeof kind === 'string' ? `"${clip(kind, 20)}"` : describeValue(kind)} for column "${clip(key)}". Kinds: ${FIELD_KINDS.join(' ')}`;

/** The field name a list entry names, and the property it is under ('' for a bare string). */
export function columnKey(item: unknown): {key: string; prop: string} | undefined {
  if (typeof item === 'string') return item.trim() !== '' ? {key: item.trim(), prop: ''} : undefined;
  if (!isRecord(item)) return undefined;
  for (const prop of KEY_PROPS) {
    const value = item[prop];
    if (typeof value === 'string' && value.trim() !== '') return {key: value.trim(), prop};
  }
  return undefined;
}

/** The tokens of the shorthand string, in order. */
export const shorthandTokens = (spec: string): string[] => spec.trim().split(/\s+/).filter(Boolean);

/** The field name of a shorthand token, as written ('commits:bar=Commits' -> 'commits'). */
export const tokenKey = (token: string): string => /^[^:=]*/.exec(token)![0];

/** A shorthand token: 'key[:kind][=Label]' ('_' in a label is a space). */
function splitToken(token: string): {key: string; kind?: string; label?: string} {
  const eq = token.indexOf('=');
  const head = eq >= 0 ? token.slice(0, eq) : token;
  const colon = head.indexOf(':');
  return {
    key: colon >= 0 ? head.slice(0, colon) : head,
    ...(colon >= 0 ? {kind: head.slice(colon + 1)} : {}),
    ...(eq >= 0 ? {label: token.slice(eq + 1).replace(/_/g, ' ')} : {}),
  };
}

/**
 * DataTable.columns, either form, as fields. Never throws: every entry is judged on its own. An entry with an unknown
 * kind keeps its key and label and draws with the kind the data gives it; an entry with no key is not drawn; both
 * are named in `problems`, with the keys of an entry that are not read.
 */
export function readColumns(value: unknown): ReadColumns {
  const fields: Field[] = [];
  const problems: ColumnProblem[] = [];
  if (value === undefined || value === null) return {fields, problems};
  if (typeof value === 'string') {
    shorthandTokens(value).forEach((token, i) => {
      const {key, kind, label} = splitToken(token);
      if (!key) {
        problems.push({column: i + 1, type: 'dropped', message: `"${clip(token)}" has no field name`});
        return;
      }
      const known = kind !== undefined && KIND_SET.has(kind);
      if (kind !== undefined && !known) problems.push({column: i + 1, type: 'kind', message: unknownKind(kind, key)});
      fields.push({key, ...(known ? {kind: kind as FieldKind} : {}), ...(label ? {label} : {})});
    });
    return {fields, problems};
  }
  if (!Array.isArray(value)) {
    problems.push({column: 0, type: 'shape', message: `expected a list [${ITEM_HINT}], received ${describeValue(value)}`});
    return {fields, problems};
  }
  value.forEach((item, i) => {
    const column = i + 1;
    const named = columnKey(item);
    if (!named) {
      problems.push({column, type: 'dropped', message: isRecord(item) ? `no key: expected ${ITEM_HINT}` : `expected ${ITEM_HINT}, received ${describeValue(item)}`});
      return;
    }
    if (!isRecord(item)) {
      fields.push({key: named.key});
      return;
    }
    const {key} = named;
    let kind: FieldKind | undefined;
    if (item.kind !== undefined) {
      if (typeof item.kind === 'string' && KIND_SET.has(item.kind)) kind = item.kind as FieldKind;
      else problems.push({column, type: 'kind', message: unknownKind(item.kind, key)});
    }
    const label = LABEL_PROPS.map(prop => item[prop]).find((text): text is string => typeof text === 'string' && text.trim() !== '');
    const ignored = Object.keys(item).filter(prop => !ITEM_PROPS.has(prop));
    if (ignored.length > 0) problems.push({column, type: 'ignored', message: `ignored ${ignored.length === 1 ? 'key' : 'keys'} ${ignored.slice(0, 6).join(', ')} of column "${clip(key)}"`});
    fields.push({key, ...(kind ? {kind} : {}), ...(label ? {label: label.trim()} : {})});
  });
  return {fields, problems};
}
