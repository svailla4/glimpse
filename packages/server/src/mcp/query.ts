// The `query` tool (design 6.3): a source's result as text, without rendering, so the model can ground what it says.
import type {DirNode, GraphData} from '@glimpse/catalog';
import {jsonQuote, problem, readsAsViewerLine, skeleton, sourceCode, SpecError, UNSAFE_CHAR} from '../spec/errors.ts';
import {boundWarnings} from '../session/datasets.ts';
import type {Session} from '../session/session.ts';
import {failure, text, type ToolResult} from './result.ts';

export const QUERY_DESCRIPTION =
  'Run a Glimpse source and return rows as text, without rendering, to ground what you say. ref like "git.hotspots src top=10".';

export const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ref'],
  properties: {
    ref: {type: 'string'},
    fields: {type: 'string', description: 'Space-separated field names.'},
    limit: {type: 'integer', minimum: 1, maximum: 200},
  },
} as const;

export interface QueryArgs { ref: string; fields?: string; limit?: number }

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_CELL = 200;

/**
 * What the lines of a tool result start with (decision D10): a row whose first cell reads like one of these could
 * pass for the result's own framing, e.g. a file named `warn the source failed` or `total=0 returned=0`. Tested on
 * the skeleton of the cell (finding V016), so look-alike letters and invisible characters do not get past it.
 */
const wild = (word: string) => [...word].map(ch => (/[a-z]/.test(ch) ? `[${ch}\\P{ASCII}]` : ch)).join('');
// Each letter may also be any character outside ASCII, as in readsAsViewerLine: a table of look-alikes is never complete.
const FRAMING = new RegExp(`^\\s*(?:(?:${['ok', 'warn', 'fixed', 'repo', 'ds', 'parts', 'slots', 'sig'].map(wild).join('|')})\\s|${wild('total')}=|${wild('edges')}$|${wild('e')}_[a-z_]+\\s|${wild('nothing was rendered')})`, 'u');

/**
 * One value as a cell. Rows are repository content: a cell that holds a line break, a tab or an invisible
 * character, or that could be read as a `viewer:` line, is printed JSON-quoted with every invisible character
 * escaped, so a row can neither forge another line nor show a path that does not exist (a newline in a file name
 * stays visible as \n). The first cell of a row is also quoted when it reads like the result's own framing. A
 * `delta` cell reads `+12 -4`.
 */
export function cell(value: unknown, first = false): string {
  if (isRecord(value) && typeof value.add === 'number' && typeof value.del === 'number' && Object.keys(value).length === 2) return `+${value.add} -${value.del}`;
  const raw = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const clipped = raw.length > MAX_CELL ? raw.slice(0, MAX_CELL - 1) + '…' : raw;
  const seen = skeleton(clipped);
  return UNSAFE_CHAR.test(clipped) || readsAsViewerLine(clipped) || (first && FRAMING.test(seen)) ? jsonQuote(clipped) : clipped;
}

const tsv = (header: string[], rows: unknown[][]): string => [header.join('\t'), ...rows.map(row => row.map((value, i) => cell(value, i === 0)).join('\t'))].join('\n');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Finding V027: a source may mix records with bare values (repo.stack: languages as {label, slotKey}, frameworks and
 * tools as plain strings). Every row is kept: a bare value becomes the `label` of a row when the records have labels,
 * else its `value`.
 */
function asRecords(rows: unknown[]): Array<Record<string, unknown>> {
  const records = rows.filter(isRecord);
  if (records.length === rows.length) return records;
  const key = records.some(row => Object.hasOwn(row, 'label')) ? 'label' : 'value';
  return rows.map(row => (isRecord(row) ? row : {[key]: row}));
}

/** A field of a row, own properties only: `constructor` or `toString` is not a field of anything (finding V021). */
const fieldOf = (row: Record<string, unknown>, key: string): unknown => (Object.hasOwn(row, key) ? row[key] : undefined);

function rowsText(rows: unknown[], fieldKeys: string[] | undefined, wanted: string[] | undefined, limit: number, total: number | undefined): string {
  const records = asRecords(rows);
  const present = [...new Set(records.slice(0, 50).flatMap(row => Object.keys(row)))];
  const known = fieldKeys && fieldKeys.length > 0 && records.every(row => fieldKeys.some(key => Object.hasOwn(row, key))) ? fieldKeys : present;
  const header = wanted && wanted.length > 0 ? wanted : known;
  const missing = wanted?.filter(name => !records.some(row => Object.hasOwn(row, name))) ?? [];
  if (records.length > 0 && missing.length > 0) {
    throw new SpecError([problem('E_ARGS', `no field "${missing[0]}". Fields: ${[...new Set([...known, ...present])].join(' ')}`)]);
  }
  const page = records.slice(0, limit);
  return `${tsv(header, page.map(row => header.map(key => fieldOf(row, key))))}\ntotal=${total ?? records.length} returned=${page.length}`;
}

function treeText(root: DirNode, limit: number): string {
  const rows: unknown[][] = [];
  let total = 0;
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);
    total++;
    if (rows.length < limit) rows.push([node.path === '' ? '.' : node.path, node.files, node.loc]);
    if (Array.isArray(node.children)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return `${tsv(['path', 'files', 'loc'], rows)}\ntotal=${total} returned=${rows.length}`;
}

/**
 * A graph as two tables. `total` is the size of the whole graph: the source's own count when it cut the graph to its
 * node budget (finding V024: 'total=143' for a file with 160 importers read as complete), else the nodes it returned.
 */
export function graphText(graph: GraphData, limit: number, cutFrom?: number): string {
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(isRecord);
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter(isRecord);
  const shownNodes = nodes.slice(0, limit);
  const shownEdges = [...edges].sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)).slice(0, limit);
  const total = Math.max(nodes.length, Number.isFinite(cutFrom) ? cutFrom! : 0);
  return [
    tsv(['id', 'label', 'fanIn', 'fanOut'], shownNodes.map(node => [node.id, node.label, node.fanIn, node.fanOut])),
    'edges',
    tsv(['from', 'to', 'weight'], shownEdges.map(edge => [edge.from, edge.to, edge.weight])),
    `total=${total} returned=${shownNodes.length}${total > nodes.length ? ` (graph cut to ${nodes.length})` : ''} edges=${edges.length} returned_edges=${shownEdges.length}`,
  ].join('\n');
}

export async function queryTool(session: Session, args: QueryArgs): Promise<ToolResult> {
  try {
    const refText = typeof args.ref === 'string' ? args.ref.trim() : '';
    if (!refText) throw new SpecError([problem('E_ARGS', `ref is required, e.g. "git.hotspots src top=10".`)]);
    const limit = Number.isInteger(args.limit) ? Math.min(MAX_LIMIT, Math.max(1, args.limit!)) : DEFAULT_LIMIT;
    const wanted = typeof args.fields === 'string' ? args.fields.split(/[\s,]+/).filter(Boolean) : undefined;
    // Decision D8: HEAD, the revision and the file index are looked at before anything is computed.
    await session.revalidate();
    const {ref, outcome} = await session.runRef(refText);
    if (!outcome.ok) throw new SpecError([problem(sourceCode(outcome.error.code), `${refText}: ${outcome.error.message}`)]);
    const {meta, result} = outcome;
    // Finding V003: what a source says about its own data is a caveat of these rows, not something to fix; it ends
    // the `total=` line, which stays the last line of the body.
    const caveats = boundWarnings(result.warnings ?? []);
    let body: string;
    if (meta.kind === 'tree' && isRecord(result.data)) body = treeText(result.data as unknown as DirNode, limit);
    else if (meta.kind === 'graph' && isRecord(result.data)) body = graphText(result.data as unknown as GraphData, limit, result.truncated?.total);
    else if (Array.isArray(result.data)) {
      // An explicit top= is the model's own cut; otherwise `limit` pages the full set of a pageable source.
      const rows: unknown[] = 'top' in ref.args ? result.data : result.allRows ?? result.data;
      // Sources differ in where they state the size of the full set; the largest figure is the honest total.
      const total = Math.max(result.total ?? 0, result.truncated?.total ?? 0, result.allRows?.length ?? 0, rows.length);
      body = rowsText(rows, (result.fields ?? meta.fields)?.map(field => field.key), wanted, limit, total);
    } else if (isRecord(result.data)) body = `${tsv(['key', 'value'], Object.entries(result.data))}\ntotal=${Object.keys(result.data).length} returned=${Object.keys(result.data).length}`;
    else body = `${cell(result.data, true)}\ntotal=1 returned=1`;
    return text(caveats.length > 0 ? `${body}; ${caveats.join('; ')}` : body, session.events.drain());
  } catch (error) {
    return failure(error);
  }
}
