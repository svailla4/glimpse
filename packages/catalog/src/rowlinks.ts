// packages/catalog/src/rowlinks.ts
// The diagram node ids a table row stands for (decision D24), read the same way by the server's checks (cleanItems)
// and the viewer's table rows. A module of its own, like links.ts and for the same reason: links.ts is in the eager
// script, and only the lazy table chunk reads rows in the tab.
import {MAX_ENTITY_NODES} from './datasets.ts';

/**
 * The diagram node ids a table row stands for: only a field named exactly `node` whose value is a text id or a list
 * of them. A row is data, so `nodes` is not read and a number is not an id (a column of counts or hosts links
 * nothing). `problem` says what was not linked; the server says it only on a view whose diagrams the table links.
 */
export function rowNodes(row: Record<string, unknown>, max = MAX_ENTITY_NODES): {ids: string[]; problem?: string} {
  const raw = row.node;
  if (raw === undefined) return {ids: []};
  const written: unknown[] = Array.isArray(raw) ? raw : [raw];
  const ok = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  const read = [...new Set(written.filter(ok).map(v => v.trim()))];
  const bad = written.findIndex(v => !ok(v));
  const shown = (v: unknown) => (typeof v === 'string' ? "''" : Array.isArray(v) ? '[...]' : typeof v === 'object' && v !== null ? '{...}' : String(v));
  const problems = [
    bad >= 0 ? `node ${Array.isArray(raw) ? `entry ${bad + 1} ` : ''}${shown(written[bad])} is not a node id, not linked` : undefined,
    read.length > max ? `node: ${read.length} ids, the first ${max} linked` : undefined,
  ].filter(Boolean);
  return {ids: read.slice(0, max), ...(problems.length > 0 ? {problem: problems.join('; ')} : {})};
}
