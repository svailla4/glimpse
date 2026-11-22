// Authored data (decision D24): what the data a model writes for a diagram or a list declares, links and names. One
// table, AUTHORED, says it for every component whose data names diagram nodes or files, read by the catalog's own
// cleaners (diagrams.ts), so the server checks exactly what the tab draws. From it come the checks of inline data
// (expand.ts), of data bound to a $/path (diagramNotes) and of the links between components (linkNotes).
import {
  cleanFlow, cleanItems, cleanLayers, cleanSchema, cleanSequence, explainValue, isCall, type Clean, type FileLoc, type LayersItem, type WireComponent,
} from '@glimpse/catalog';
import {looseDistance, nearest, oneLine} from './errors.ts';
import type {FileCheck} from './expand.ts';

/** What one component's data says: the node ids it declares, the ones it links to, and the files it names. */
export interface Authored {
  declares: Array<{id: string; label: string}>;
  links: Array<{at: string; ids: string[]}>;
  files: Array<{at: string; file: FileLoc}>;
}

const NONE: Authored = {declares: [], links: [], files: []};

function mapClean<T>(cleaned: Clean<T>, map: (ast: T) => Partial<Authored>): Clean<Authored> {
  return cleaned.ok ? {ok: true, ast: {...NONE, ...map(cleaned.ast)}, fixes: cleaned.fixes, dropped: cleaned.dropped} : cleaned;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
const withFile = <T extends {file?: FileLoc}>(at: (item: T) => string) => (item: T) => (item.file !== undefined ? [{at: at(item), file: item.file}] : []);
const withNodes = <T extends {nodes?: string[]}>(at: (item: T) => string) => (item: T) => (item.nodes?.length ? [{at: at(item), ids: item.nodes}] : []);

/**
 * Decision D24, by component: the data's declarations (Flowchart nodes, ER tables, sequence actors without a node,
 * inline Graph nodes), its links (node:'PG' on an item, a table, a row or an actor; a message's via) and its files.
 * The cleaners' fixes and dropped clauses are those the tab would report; a value that is not the shape at all is
 * refused (Steps and DataTable never are: a value that is not a list links nothing).
 */
export const AUTHORED: Readonly<Record<string, (value: unknown) => Clean<Authored>>> = {
  Flowchart: value => mapClean(cleanFlow(value), ast => ({
    declares: ast.nodes.map(node => ({id: node.id, label: node.label})),
    files: ast.nodes.flatMap(withFile(node => `node ${oneLine(node.id, 40)}`)),
  })),
  SequenceDiagram: value => mapClean(cleanSequence(value), ast => ({
    // An actor without a node stands for the node of its own id.
    declares: ast.actors.filter(actor => actor.node === undefined).map(actor => ({id: actor.id, label: actor.label})),
    links: [
      ...ast.actors.flatMap(actor => (actor.node !== undefined ? [{at: `actor ${oneLine(actor.id, 40)}`, ids: [actor.node]}] : [])),
      ...ast.steps.flatMap(step => (step.kind === 'message' && step.via?.length ? [{at: `message ${oneLine(step.from, 30)} -> ${oneLine(step.to, 30)}`, ids: step.via}] : [])),
    ],
  })),
  ERDiagram: value => mapClean(cleanSchema(value), ast => ({
    declares: ast.tables.map(table => ({id: table.name, label: table.name})),
    links: ast.tables.flatMap(withNodes(table => `table ${oneLine(table.name, 40)}`)),
    files: ast.tables.flatMap(withFile(table => `table ${oneLine(table.name, 40)}`)),
  })),
  Layers: value => mapClean(cleanLayers(value), ast => {
    const items = ast.bands.flatMap(band => band.items);
    const at = (item: LayersItem) => `item '${oneLine(item.label, 30)}'`;
    return {links: items.flatMap(withNodes(at)), files: items.flatMap(withFile(at))};
  }),
  Steps: value => mapClean(cleanItems('step', value), ast => ({links: ast.flatMap(withNodes(item => item.at)), files: ast.flatMap(withFile(item => item.at))})),
  DataTable: value => mapClean(cleanItems('row', value), ast => ({links: ast.flatMap(withNodes(item => item.at))})),
  // Graph data is drawn as it is written; only its node ids matter here.
  Graph: value => ({
    ok: true,
    ast: {...NONE, declares: (isRecord(value) && Array.isArray(value.nodes) ? value.nodes : []).flatMap((node: unknown) => {
      const id = isRecord(node) ? textOf(node.id) : undefined;
      return id !== undefined ? [{id, label: textOf((node as Record<string, unknown>).label) ?? id}] : [];
    })},
    fixes: [],
    dropped: [],
  }),
};

/** The diagrams that once read Mermaid: text in their data prop is refused, with the data to write instead (D21). */
export const TEXT_DIAGRAMS: ReadonlySet<string> = new Set(['Flowchart', 'SequenceDiagram']);

// ---------------------------------------------------------------- the data model
export const isBinding = (value: unknown): value is {'@path': string} =>
  typeof value === 'object' && value !== null && typeof (value as {'@path'?: unknown})['@path'] === 'string';
/** The paths the server and the viewer write: never the model's data. */
export const SERVER_PATH = /^\/(?:ds|meta|ui)(?:\/|$)/;

export function lookup(data: unknown, path: string): unknown {
  let node = data;
  for (const segment of path.split('/').filter(Boolean)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

const topSegment = (path: string) => path.split('/').filter(Boolean)[0] ?? '';

/** The model's data a component's `data` binding reads, with its path; undefined for inline data or the server's paths. */
function boundData(comp: WireComponent, data: Record<string, unknown>): {path: string; value: unknown} | undefined {
  if (!isBinding(comp.data)) return undefined;
  const path = comp.data['@path'];
  return path.startsWith('/') && !SERVER_PATH.test(path) ? {path, value: lookup(data, path)} : undefined;
}

/** The $/paths bound inside inline data, outside calls (the paths a call reads are calcNotes' to check). */
export function inlinePaths(value: unknown, into: string[] = []): string[] {
  if (isBinding(value)) into.push(value['@path']);
  else if (!isCall(value) && typeof value === 'object' && value !== null) for (const item of Object.values(value)) inlinePaths(item, into);
  return into;
}

/**
 * Inline data as the tab's view reads it (decision D25): A2UI computes each call and resolves each $/path inside a
 * component's arguments, inline data included, before the view sees them, so the cleaners must not judge the call or
 * binding objects themselves (a call in a Layers item is drawn as its number, not "no label"). A call is its number,
 * or 0 when it has none (calcNotes says why); a $/path is what `read` finds there. Undefined when a path cannot be read
 * here (relative, or the server's or the viewer's): what draws is then the tab's to report.
 */
export function asDrawn(value: unknown, read: (path: string) => unknown = () => undefined): {value: unknown} | undefined {
  let unknown = false;
  const walk = (v: unknown): unknown => {
    if (isBinding(v)) {
      const path = v['@path'];
      if (path.startsWith('/') && !SERVER_PATH.test(path)) return read(path);
      unknown = true;
      return v;
    }
    if (isCall(v)) {
      const got = explainValue(v, read);
      return 'value' in got && typeof got.value === 'number' ? got.value : 0;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, walk(item)]));
    return v;
  };
  const drawn = walk(value);
  return unknown ? undefined : {value: drawn};
}

/**
 * What a component's data draws from the data model, for the checks run after the call: data bound to a $/path, and
 * inline data with $/paths inside it, read as the tab reads it (asDrawn). `at` names it in a message, `paths` are the
 * paths it reads. Undefined for inline data that reads no path (expandComponent checks it) and for data that cannot
 * be read here.
 */
function dataRead(comp: WireComponent, data: Record<string, unknown>): {at: string; paths: string[]; value: unknown} | undefined {
  const bound = boundData(comp, data);
  if (bound) return {at: `$${bound.path}`, paths: [bound.path], value: bound.value};
  if (comp.data === undefined || typeof comp.data === 'string' || isBinding(comp.data) || isCall(comp.data)) return undefined;
  const paths = inlinePaths(comp.data);
  const drawn = paths.length > 0 ? asDrawn(comp.data, path => lookup(data, path)) : undefined;
  return drawn && {at: 'data', paths, value: drawn.value};
}

/**
 * What the components bound to a $/path draw from the data model after a call, as `fixed` and `warn` lines, and the
 * files their data names (decision D24), for the session to check: those the call defines, and those whose path the
 * call wrote (`$/arch/nodes/G/group='api'` changes a diagram the call does not name). Inline data with $/paths inside
 * it is checked here too, as the tab reads it (dataRead); the rest of inline data was checked by expandComponent.
 * `written` holds the top segments of the paths written.
 */
export function diagramNotes(
  components: Iterable<WireComponent>, data: Record<string, unknown>, defined: ReadonlySet<string>, written: ReadonlySet<string>,
): {fixes: string[]; warnings: string[]; files: FileCheck[]} {
  const notes = {fixes: [] as string[], warnings: [] as string[], files: [] as FileCheck[]};
  for (const comp of components) {
    const read = AUTHORED[comp.component];
    const drawn = read ? dataRead(comp, data) : undefined;
    if (!read || !drawn) continue;
    if (!defined.has(comp.id) && !drawn.paths.some(path => written.has(topSegment(path)))) continue;
    // Nothing there is reported as an unbound path.
    if (drawn.value === undefined) continue;
    const where = `${comp.component}#${comp.id}`;
    const cleaned = read(drawn.value);
    if (!cleaned.ok) {
      notes.warnings.push(`${where}: E_SHAPE ${drawn.at}: ${cleaned.error}`);
      continue;
    }
    notes.fixes.push(...cleaned.fixes.map(fix => `${where}: ${fix}`));
    notes.warnings.push(...cleaned.dropped.map(drop => `${where}: not drawn: ${drop}`));
    notes.files.push(...cleaned.ast.files.map(({at, file}) => ({where: `${where} ${at}`, file, nested: true as const})));
  }
  return notes;
}

/** Ids named in one link line before the rest fold into "and N more". */
const MAX_LINK_IDS = 3;

/**
 * Decision D24: the node ids a component links to (node:'PG', an actor's node, a message's via) that nothing else on
 * the view declares or links to, one `warn` line per component, with the declared node whose label it is or the
 * nearest id. Checked like diagramNotes: the components the call defines and those bound under a path it wrote.
 * Every component on the view counts as a place an id may live, so a page built over two calls is judged whole.
 * Silent where the ids cannot be known: a Graph drawn from a source makes the check say nothing at all, and a
 * DataTable none of whose `node` values resolves is taken to have a `node` column of its own, not links.
 */
export function linkNotes(
  components: Iterable<WireComponent>, data: Record<string, unknown>, defined: ReadonlySet<string>, written: ReadonlySet<string>,
): string[] {
  /** Every node id on the view: the label it was declared with, and the components that declare or link it. */
  const keys = new Map<string, {label?: string; by: Set<string>}>();
  const key = (id: string, by: string, label?: string) => {
    const entry = keys.get(id) ?? {by: new Set<string>()};
    entry.by.add(by);
    if (label !== undefined && entry.label === undefined) entry.label = label;
    keys.set(id, entry);
  };
  const linking: Array<{comp: WireComponent; ids: string[]}> = [];
  for (const comp of components) {
    const read = AUTHORED[comp.component];
    if (!read) continue;
    // A Graph drawn from a source has node ids nobody here can see: any link may be to one of them.
    if (comp.component === 'Graph' && isBinding(comp.data) && !boundData(comp, data)) return [];
    // Inline data is read as the tab reads it, its calls computed and its $/paths resolved (asDrawn).
    const drawn = dataRead(comp, data);
    const value = drawn ? drawn.value : isBinding(comp.data) ? undefined : asDrawn(comp.data)?.value;
    // Text is a source ref (or Mermaid, already refused): it declares and links nothing the server can read.
    if (value === undefined || typeof value === 'string') continue;
    const cleaned = read(value);
    if (!cleaned.ok) continue;
    for (const {id, label} of cleaned.ast.declares) key(id, comp.id, label);
    const ids = [...new Set(cleaned.ast.links.flatMap(link => link.ids))];
    for (const id of ids) key(id, comp.id);
    if (ids.length > 0 && (defined.has(comp.id) || (drawn?.paths.some(path => written.has(topSegment(path))) ?? false))) linking.push({comp, ids});
  }
  const lines: string[] = [];
  for (const {comp, ids} of linking) {
    const elsewhere = (id: string) => [...(keys.get(id)?.by ?? [])].some(by => by !== comp.id);
    const bad = ids.filter(id => !elsewhere(id));
    if (bad.length === 0 || (comp.component === 'DataTable' && bad.length === ids.length)) continue;
    const known = [...keys].filter(([id]) => elsewhere(id));
    const hint = (id: string): string => {
      const labelled = known.find(([other, entry]) => other !== id && entry.label !== undefined && entry.label.toLowerCase() === id.toLowerCase());
      if (labelled) return ` (the label of node '${oneLine(labelled[0], 40)}')`;
      const best = nearest(id, known.map(([other]) => other), 1)[0];
      // As close as a typo, and not merely as short as the id itself ('A' is not a typo of 'B').
      return best !== undefined && looseDistance(id, best) <= Math.min(2, id.length - 1) ? ` (nearest: ${oneLine(best, 40)})` : '';
    };
    const where = `${comp.component}#${comp.id}`;
    if (bad.length === 1) {
      lines.push(`${where}: node '${oneLine(bad[0]!, 40)}' links to nothing on this view${hint(bad[0]!)}`);
      continue;
    }
    const named = bad.slice(0, MAX_LINK_IDS).map(id => `'${oneLine(id, 40)}'${hint(id)}`);
    const more = bad.length > MAX_LINK_IDS ? `, and ${bad.length - MAX_LINK_IDS} more` : '';
    lines.push(`${where}: nodes ${named.join(', ')}${more} link to nothing on this view`);
  }
  return lines;
}
