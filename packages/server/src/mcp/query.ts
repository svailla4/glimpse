// The `query` tool (design 6.3): a source's result as text, without rendering, so the model can ground what it says.
import type {DirNode, GraphData} from '@glimpse/catalog';
import {problem, sourceCode, SpecError} from '../spec/errors.ts';
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

const isControl = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
};

/**
 * What the lines of a tool result start with (decision D10): a row whose first cell reads like one of these could
 * pass for the result's own framing, e.g. a file named `warn the source failed` or `total=0 returned=0`.
 */
const FRAMING = /^\s*(?:viewer\s*:|(?:ok|warn|fixed|repo|ds|parts|slots|sig)\s|total=|edges$|E_[A-Z_]+\s|Nothing was rendered)/i;

/**
 * One value as a cell. Rows are repository content: a cell that holds a line break or a tab, or that could be read
 * as a `viewer:` line, is printed JSON-quoted, so a row can neither forge another line nor show a path that does
 * not exist (a newline in a file name stays visible as \n). The first cell of a row is also quoted when it reads like
 * the result's own framing. A `delta` cell reads `+12 -4`.
 */
export function cell(value: unknown, first = false): string {
  if (isRecord(value) && typeof value.add === 'number' && typeof value.del === 'number' && Object.keys(value).length === 2) return `+${value.add} -${value.del}`;
  const raw = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const clipped = raw.length > MAX_CELL ? raw.slice(0, MAX_CELL - 1) + '…' : raw;
  return isControl(clipped) || /^\s*viewer\s*:/i.test(clipped) || (first && FRAMING.test(clipped)) ? JSON.stringify(clipped) : clipped;
}

const tsv = (header: string[], rows: unknown[][]): string => [header.join('\t'), ...rows.map(row => row.map((value, i) => cell(value, i === 0)).join('\t'))].join('\n');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function rowsText(rows: unknown[], fieldKeys: string[] | undefined, wanted: string[] | undefined, limit: number, total: number | undefined): string {
  const records = rows.filter(isRecord);
  if (records.length === 0 && rows.length > 0) {
    return `${tsv(['value'], rows.slice(0, limit).map(value => [value]))}\ntotal=${total ?? rows.length} returned=${Math.min(limit, rows.length)}`;
  }
  const known = fieldKeys && fieldKeys.length > 0 ? fieldKeys : [...new Set(records.slice(0, 50).flatMap(row => Object.keys(row)))];
  const header = wanted && wanted.length > 0 ? wanted : known;
  const missing = wanted?.filter(name => !records.some(row => name in row)) ?? [];
  if (records.length > 0 && missing.length > 0) {
    throw new SpecError([problem('E_ARGS', `no field "${missing[0]}". Fields: ${[...new Set([...known, ...records.slice(0, 50).flatMap(row => Object.keys(row))])].join(' ')}`)]);
  }
  const page = records.slice(0, limit);
  return `${tsv(header, page.map(row => header.map(key => row[key])))}\ntotal=${total ?? records.length} returned=${page.length}`;
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

function graphText(graph: GraphData, limit: number): string {
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(isRecord);
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter(isRecord);
  const shownNodes = nodes.slice(0, limit);
  const shownEdges = [...edges].sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)).slice(0, limit);
  return [
    tsv(['id', 'label', 'fanIn', 'fanOut'], shownNodes.map(node => [node.id, node.label, node.fanIn, node.fanOut])),
    'edges',
    tsv(['from', 'to', 'weight'], shownEdges.map(edge => [edge.from, edge.to, edge.weight])),
    `total=${nodes.length} returned=${shownNodes.length} edges=${edges.length} returned_edges=${shownEdges.length}`,
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
    const warnings = boundWarnings(result.warnings ?? []).map(warning => `warn ${warning}`);
    let body: string;
    if (meta.kind === 'tree' && isRecord(result.data)) body = treeText(result.data as unknown as DirNode, limit);
    else if (meta.kind === 'graph' && isRecord(result.data)) body = graphText(result.data as unknown as GraphData, limit);
    else if (Array.isArray(result.data)) {
      // An explicit top= is the model's own cut; otherwise `limit` pages the full set of a pageable source.
      const rows: unknown[] = 'top' in ref.args ? result.data : result.allRows ?? result.data;
      // Sources differ in where they state the size of the full set; the largest figure is the honest total.
      const total = Math.max(result.total ?? 0, result.truncated?.total ?? 0, result.allRows?.length ?? 0, rows.length);
      body = rowsText(rows, (result.fields ?? meta.fields)?.map(field => field.key), wanted, limit, total);
    } else if (isRecord(result.data)) body = `${tsv(['key', 'value'], Object.entries(result.data))}\ntotal=${Object.keys(result.data).length} returned=${Object.keys(result.data).length}`;
    else body = `${cell(result.data, true)}\ntotal=1 returned=1`;
    return text([body, ...warnings].join('\n'), session.events.drain());
  } catch (error) {
    return failure(error);
  }
}
