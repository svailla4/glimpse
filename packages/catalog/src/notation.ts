// packages/catalog/src/notation.ts
// DataTable column shorthand ('path:file loc:num:Lines'). Pure functions shared by the server (checks literal columns
// at show time) and the viewer (reads them). Flowchart and SequenceDiagram take data, not a notation (diagrams.ts).
import type {Field, FieldKind} from './datasets.ts';

export interface NotationError { statement: number; message: string }

const clip = (text: string, max = 40) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

// ---------------------------------------------------------------- columns
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

function splitColumn(token: string): {key: string; kind?: string; label?: string} {
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
 * DataTable.columns shorthand: 'path commits:bar last:date=Last_change' ('_' in a label becomes a space).
 * Never throws: a token with an unknown kind keeps its key and label and renders as plain text; a token without a
 * key is dropped. Use checkColumns() to report those to the author.
 */
export function parseColumns(spec: string): Field[] {
  const fields: Field[] = [];
  for (const token of spec.trim().split(/\s+/).filter(Boolean)) {
    const {key, kind, label} = splitColumn(token);
    if (!key) continue;
    fields.push({key, ...(kind && KIND_SET.has(kind) ? {kind: kind as FieldKind} : {}), ...(label ? {label} : {})});
  }
  return fields;
}

/** Problems in a columns shorthand; `statement` is the 1-based position of the offending column. Empty when valid. */
export function checkColumns(spec: string): NotationError[] {
  const errors: NotationError[] = [];
  spec.trim().split(/\s+/).filter(Boolean).forEach((token, i) => {
    const {key, kind} = splitColumn(token);
    if (!key) errors.push({statement: i + 1, message: `column "${clip(token)}" has no field name`});
    else if (kind !== undefined && !KIND_SET.has(kind)) errors.push({statement: i + 1, message: `unknown kind "${kind}" for column "${key}". Kinds: ${FIELD_KINDS.join(' ')}`});
  });
  return errors;
}
