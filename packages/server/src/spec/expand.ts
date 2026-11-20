// Expansion (design 2.2 step 4): compiled messages are rewritten in place so that every data prop naming a source
// becomes a /ds binding, and the things only Glimpse can judge are checked: source refs, the Mermaid-style notation,
// column shorthand and reserved data paths. Pure apart from the in-place rewrite of messages nobody else holds yet.
import {
  acceptsArg, checkColumns, COMPONENT_BY_NAME, datasetKey, looksLikeRef, parseFlow, parseRef, parseSequence, PATHS, SOURCES,
  type A2uiMessage, type Prop, type SourceMeta, type SourceRef, type WireComponent,
} from '@glimpse/catalog';
import {resolveSource, type SourceRegistry} from '../sources/registry.ts';
import {nearest, oneLine, problem, type Problem} from './errors.ts';

export interface Expansion {
  /** Source refs the call names, by dataset key, in order of first use. */
  refs: Map<string, SourceRef>;
  problems: Problem[];
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
  }
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
    if (path === '/' || path === '') out.problems.push(problem('E_PATH', '$/ cannot be assigned as a whole: assign $/name=value.'));
    else if (reservedPath(path)) refuse(path);
  } else if ('createSurface' in message) {
    for (const key of Object.keys(message.createSurface.dataModel ?? {})) if (reservedPath(`/${key}`)) refuse(`/${key}`);
  }
}

/** Expands every message in place and collects every problem found (the caller reports the first five). */
export function expandMessages(messages: A2uiMessage[], registry: SourceRegistry): Expansion {
  const out: Expansion = {refs: new Map(), problems: []};
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
