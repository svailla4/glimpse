// Expansion (design 2.2 step 4): compiled messages are rewritten in place so that every data prop naming a source
// becomes a /ds binding, and the things only Glimpse can judge are checked: source refs, the Mermaid-style notation,
// column shorthand and reserved data paths. Pure apart from the in-place rewrite of messages nobody else holds yet.
import {
  acceptsArg, checkColumns, COMPONENT_BY_NAME, datasetKey, looksLikeRef, parseColumns, parseFlow, parseRef, parseSequence, PATHS, SOURCES,
  type A2uiMessage, type Prop, type SourceMeta, type SourceRef, type WireComponent,
} from '@glimpse/catalog';
import {resolveSource, type SourceRegistry} from '../sources/registry.ts';
import {nearest, oneLine, problem, type Problem} from './errors.ts';
import {pathProblem} from './guard.ts';

export interface Expansion {
  /** Source refs the call names, by dataset key, in order of first use. */
  refs: Map<string, SourceRef>;
  problems: Problem[];
  /** What is certain to draw wrong although the spec is valid, as `Name#id: text` (a `warn` line each). */
  warnings: string[];
  /** Literal files named by components (CodeView, FileRef, a CodeTour stop ...): the session checks they exist. */
  files: Array<{where: string; file: string}>;
  /** Literal DiffView ranges other than the working tree: the session checks the revisions exist. */
  ranges: Array<{where: string; range: string}>;
  /** Field names a component asks of a dataset, checked against the dataset's fields once it has settled. */
  fields: Array<{where: string; key: string; names: string[]}>;
}

/** The dataset kinds a data prop of this shape can draw; undefined when anything goes (JsonView, a single value). */
function kindsFor(shape: string | undefined): ReadonlySet<SourceMeta['kind']> | undefined {
  const text = shape ?? '';
  if (text === '' || /\bunknown\b/.test(text) || text === 'number|string') return undefined;
  if (text.includes('DirNode')) return new Set(['tree']);
  if (text.includes('GraphData')) return new Set(['graph']);
  if (text.includes('KeyValueData')) return new Set(['record', 'rows']);
  return new Set(['rows']);
}

const KIND_NOUN: Record<SourceMeta['kind'], string> = {rows: 'rows', tree: 'a tree', graph: 'a graph', record: 'a record'};

/** '0.3', '.3' and '30%' as the 'a:b' ratio Split draws; anything else is returned as written. */
export function splitRatio(text: string): string {
  const trimmed = text.trim();
  const share = /^(?:0?\.\d+)$/.test(trimmed) ? Number(trimmed) : /^\d{1,2}(?:\.\d+)?%$/.test(trimmed) ? Number(trimmed.slice(0, -1)) / 100 : undefined;
  if (share === undefined || !(share > 0 && share < 1)) return /^\d+\s*\/\s*\d+$/.test(trimmed) ? trimmed.replace(/\s*\/\s*/, ':') : text;
  const first = Math.round(share * 100);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(first, 100 - first);
  return `${first / d}:${(100 - first) / d}`;
}

const sourceNames = (registry: SourceRegistry): string[] => [...new Set([...SOURCES.map(s => s.name), ...registry.keys()])];

/** "'git.churn [path] [top=] [since=]'": how a ref of this source is written. */
export function refSignature(meta: SourceMeta): string {
  const target = meta.target ? (meta.targetRequired ? ` <${meta.target}>` : ` [${meta.target}]`) : '';
  const names = Object.keys(meta.args ?? {});
  if (meta.kind === 'rows' && !names.includes('top')) names.unshift('top');
  return `'${meta.name}${target}${names.map(name => ` [${name}=]`).join('')}'`;
}

/**
 * Parses and checks a ref the way the seam in sources.ts prescribes: the name must be a source (E_SOURCE), a required
 * target must be present and every argument name accepted (E_ARGS). Values are the source's business.
 */
export function checkRef(text: string, registry: SourceRegistry, where = ''): {ref: SourceRef; meta: SourceMeta} | {problem: Problem} {
  const ref = parseRef(text);
  const source = resolveSource(ref.source, registry);
  const at = where ? `${where}: ` : '';
  if (!source) {
    return {problem: problem('E_SOURCE', `${at}unknown source "${oneLine(ref.source, 60)}". Nearest: ${nearest(ref.source, sourceNames(registry)).join(' ')}`)};
  }
  const meta = source.meta;
  if (meta.targetRequired && !ref.target) {
    return {problem: problem('E_ARGS', `${at}${meta.name} needs a ${meta.target ?? 'target'}. Ref: ${refSignature(meta)}`)};
  }
  const unknown = Object.keys(ref.args).find(name => !acceptsArg(meta, name));
  if (unknown !== undefined) {
    return {problem: problem('E_ARGS', `${at}${meta.name} takes no argument "${unknown}". Ref: ${refSignature(meta)}`)};
  }
  return {ref, meta};
}

const allowsString = (prop: Prop): boolean => (prop.shape ?? '').split('|').some(part => part === 'string' || part === 'unknown');
const isBinding = (value: unknown): value is {'@path': string} =>
  typeof value === 'object' && value !== null && typeof (value as {'@path'?: unknown})['@path'] === 'string';

export function componentsOf(message: A2uiMessage): WireComponent[] {
  if ('createSurface' in message) return message.createSurface.components;
  if ('updateComponents' in message) return message.updateComponents.components;
  return [];
}

const MAX_CHECKS = 64;

/** What the session can verify about a component once it knows the repository and the data: files, ranges, fields. */
function collectChecks(comp: WireComponent, name: string, props: Record<string, Prop>, out: Expansion): void {
  const where = `${name}#${comp.id}`;
  const file = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '' && out.files.length < MAX_CHECKS) out.files.push({where, file: value.trim()});
  };
  // DiffView's file narrows a diff and may name a file the change deleted, so it is not expected to exist.
  if ('file' in props && name !== 'DiffView') file(comp.file);
  if (name === 'CodeTour' && Array.isArray(comp.data)) for (const stop of comp.data) file((stop as {file?: unknown} | null)?.file);
  if (name === 'DiffView' && typeof comp.range === 'string' && !['', 'wt', 'staged'].includes(comp.range.trim()) && out.ranges.length < MAX_CHECKS) {
    out.ranges.push({where, range: comp.range.trim()});
  }

  // Field names only mean something against one dataset: the component's single data prop, bound to a source.
  const bound = Object.entries(props).filter(([, prop]) => prop.kind === 'data').map(([key]) => comp[key]).filter(isBinding).map(value => value['@path']);
  const dsKey = bound.length === 1 && bound[0]!.startsWith(`${PATHS.ds}/`) ? bound[0]!.slice(PATHS.ds.length + 1).split('/')[0] : undefined;
  if (!dsKey) return;
  const names: string[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const value = comp[key];
    if (prop.kind !== 'str' || typeof value !== 'string') continue;
    if (name === 'DataTable' && key === 'columns') names.push(...parseColumns(value).map(column => column.key));
    else if (/\bfield/i.test(prop.doc)) names.push(...value.split(/[\s,]+/).filter(Boolean).map(field => field.replace(/^-/, '')));
  }
  const wanted = [...new Set(names.filter(Boolean))];
  if (wanted.length > 0 && out.fields.length < MAX_CHECKS) out.fields.push({where, key: dsKey, names: wanted});
}

function expandComponent(comp: WireComponent, registry: SourceRegistry, out: Expansion): void {
  const def = COMPONENT_BY_NAME.get(comp.component);
  if (!def) return;
  const where = (prop: string) => `${def.name}#${comp.id}.${prop}`;
  for (const [key, prop] of Object.entries(def.props) as Array<[string, Prop]>) {
    if (prop.kind !== 'data') continue;
    const value = comp[key];
    let text: string | undefined;
    if (value === undefined) text = prop.source;
    else if (typeof value === 'string') {
      const first = value.trim().split(/\s+/)[0] ?? '';
      if (resolveSource(first, registry)) text = value;
      else if (!allowsString(prop)) {
        out.problems.push(looksLikeRef(value)
          ? problem('E_SOURCE', `${where(key)}: unknown source "${oneLine(first, 60)}". Nearest: ${nearest(first, sourceNames(registry)).join(' ')}`, {component: def.name})
          : problem('E_SOURCE', `${where(key)}: "${oneLine(value, 60)}" is not a source ref. Write a ref ('files.list src top=20'), a $/path or inline ${prop.shape ?? 'data'}.`, {component: def.name}));
        continue;
      }
    }
    if (text === undefined) continue;
    const checked = checkRef(text, registry, where(key));
    if ('problem' in checked) { out.problems.push({...checked.problem, component: def.name}); continue; }
    const dsKey = datasetKey(checked.ref);
    if (!out.refs.has(dsKey)) out.refs.set(dsKey, checked.ref);
    comp[key] = {'@path': `${PATHS.ds}/${dsKey}`};
    const kinds = kindsFor(prop.shape);
    if (kinds && !kinds.has(checked.meta.kind)) {
      out.warnings.push(`${def.name}#${comp.id}: ${checked.meta.name} returns ${KIND_NOUN[checked.meta.kind]}, but ${def.name} draws ${[...kinds].map(kind => KIND_NOUN[kind]).join(' or ')} (${prop.shape}). The plate will show an error.`);
    }
  }
  collectChecks(comp, def.name, def.props as Record<string, Prop>, out);
  if (def.name === 'Split' && typeof comp.ratio === 'string') comp.ratio = splitRatio(comp.ratio);
  if ((def.name === 'Flowchart' || def.name === 'SequenceDiagram') && typeof comp.src === 'string') {
    const parsed = def.name === 'Flowchart' ? parseFlow(comp.src) : parseSequence(comp.src);
    if (!parsed.ok) {
      for (const error of parsed.errors) out.problems.push(problem('E_NOTATION', `${where('src')} statement ${error.statement}: ${error.message}`, {component: def.name}));
    }
  }
  if (def.name === 'DataTable' && typeof comp.columns === 'string') {
    for (const error of checkColumns(comp.columns)) out.problems.push(problem('E_ENUM', `${where('columns')} column ${error.statement}: ${error.message}`, {component: def.name}));
  }
}

const RESERVED = [PATHS.ds, PATHS.meta];
const reservedPath = (path: string): string | undefined => RESERVED.find(root => path === root || path.startsWith(root + '/'));

function checkPaths(message: A2uiMessage, out: Expansion): void {
  const refuse = (path: string) =>
    out.problems.push(problem('E_PATH', `$${path} cannot be assigned: /ds and /meta are written by the server. Name a source in a data argument instead.`));
  if ('updateDataModel' in message) {
    const path = message.updateDataModel.path ?? '/';
    const unsafe = pathProblem(path);
    if (unsafe) out.problems.push(unsafe);
    else if (path === '/' || path === '') out.problems.push(problem('E_PATH', '$/ cannot be assigned as a whole: assign $/name=value.'));
    else if (reservedPath(path)) refuse(path);
  } else if ('createSurface' in message) {
    for (const key of Object.keys(message.createSurface.dataModel ?? {})) if (reservedPath(`/${key}`)) refuse(`/${key}`);
  }
}

/** Expands every message in place and collects every problem found (the caller reports the first five). */
export function expandMessages(messages: A2uiMessage[], registry: SourceRegistry): Expansion {
  const out: Expansion = {refs: new Map(), problems: [], warnings: [], files: [], ranges: [], fields: []};
  for (const message of messages) {
    checkPaths(message, out);
    for (const comp of componentsOf(message)) expandComponent(comp, registry, out);
  }
  return out;
}

function lookup(data: unknown, path: string): unknown {
  let node = data;
  for (const segment of path.split('/').filter(Boolean)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

function collectBindings(value: unknown, into: Set<string>): void {
  if (isBinding(value)) { into.add(value['@path']); return; }
  if (Array.isArray(value)) for (const item of value) collectBindings(item, into);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) collectBindings(item, into);
}

/**
 * Absolute bindings of these components that resolve to nothing in `data` (the agent's data after the call). /ds,
 * /meta and /ui are the server's and the viewer's, so they are never reported. Formatted as `$/path`.
 */
export function unboundPaths(components: Iterable<WireComponent>, data: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const comp of components) for (const [key, value] of Object.entries(comp)) if (key !== 'id' && key !== 'component') collectBindings(value, paths);
  return [...paths]
    .filter(path => path.startsWith('/') && !/^\/(ds|meta|ui)(\/|$)/.test(path) && lookup(data, path) === undefined)
    .map(path => `$${path}`);
}

/** Dataset keys the components bind (every {"@path": "/ds/<key>"} in a data prop). */
export function boundKeys(components: Iterable<WireComponent>): Set<string> {
  const keys = new Set<string>();
  for (const comp of components) {
    const def = COMPONENT_BY_NAME.get(comp.component);
    if (!def) continue;
    for (const [key, prop] of Object.entries(def.props) as Array<[string, Prop]>) {
      const value = comp[key];
      if (prop.kind !== 'data' || !isBinding(value) || !value['@path'].startsWith(PATHS.ds + '/')) continue;
      const dsKey = value['@path'].slice(PATHS.ds.length + 1).split('/')[0];
      if (dsKey) keys.add(dsKey);
    }
  }
  return keys;
}
