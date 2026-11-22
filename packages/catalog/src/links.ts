// packages/catalog/src/links.ts
// The diagram node ids an item names (decision D24: `node:'PG'`), read the same way by the server's checks, the
// diagram cleaners (diagrams.ts) and the viewer's Steps and table rows.
//
// A module of its own, apart from diagrams.ts: Steps is in the eager script, and a module the eager script imports is
// bundled into it whole with everything the lazy diagram views use from it (importing readNodes from diagrams.ts put
// cleanFlow, cleanSequence, cleanLayers and cleanSchema, about 6 kB gzip, in the eager script).
import {MAX_ENTITY_NODES} from './datasets.ts';

/** What a value is, for the messages: 'a string', 'an array', 'null'; 'nothing' for a $/path that is not set. */
export const describeValue = (v: unknown): string =>
  v === null ? 'null' : v === undefined ? 'nothing' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
// diagrams.ts has its own copies of these two: they are not part of the catalog's interface.
const textOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
const received = (v: unknown): string => (typeof v === 'string' ? 'an empty string' : describeValue(v));

/**
 * The diagram node ids an item stands for (decision D24): `node:'PG'` or `node:['PG', 'Redis']`; `nodes` is read as
 * `node` and said in `alias`. Ids are kept once each, in written order, at most `max`. `problem` names what could not
 * be read (the readable ids are still returned).
 */
export function readNodes(o: Record<string, unknown>, key = 'node', max = MAX_ENTITY_NODES): {ids: string[]; alias?: string; problem?: string} {
  const used = o[key] !== undefined ? key : key === 'node' && o.nodes !== undefined ? 'nodes' : undefined;
  if (used === undefined) return {ids: []};
  const raw = o[used];
  const written: unknown[] = Array.isArray(raw) ? raw : [raw];
  const list = written.map(textOf);
  const read = [...new Set(list.filter((v): v is string => v !== undefined))];
  const ids = read.slice(0, max);
  const bad = list.indexOf(undefined);
  const problems = [
    bad >= 0 ? `${used}: expected 'ID' or ['ID', ...], received ${received(written[bad])}${Array.isArray(raw) ? ' in the list' : ''}` : undefined,
    read.length > ids.length ? `${used}: ${read.length} ids, the first ${max} kept` : undefined,
    used === 'node' && o.nodes !== undefined ? 'nodes not read (node is)' : undefined,
  ].filter(Boolean);
  return {ids, ...(used !== key ? {alias: `${used} -> ${key}`} : {}), ...(problems.length > 0 ? {problem: problems.join('; ')} : {})};
}
