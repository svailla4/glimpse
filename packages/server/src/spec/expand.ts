// Expansion (design 2.2 step 4): compiled messages are rewritten in place so that every data prop naming a source
// becomes a /ds binding, and the things only Glimpse can judge are checked: source refs, the Mermaid-style notation
// (inline, or written to the path a src binds), column shorthand and reserved data paths. Pure apart from the in-place rewrite of messages nobody else holds yet.
import {
  acceptsArg, checkColumns, COMPONENT_BY_NAME, datasetKey, fieldsFor, formatRef, looksLikeRef, parseColumns, parseFlow, parseRef, parseSequence, PATHS,
  shapeKinds, SOURCES, type A2uiMessage, type Field, type Prop, type SourceMeta, type SourceRef, type WireComponent,
} from '@glimpse/catalog';
import {AS_ROWS, NODE_FIELDS, readsAsRows} from '../session/datasets.ts';
import {resolveSource, type SourceRegistry} from '../sources/registry.ts';
import type {Seed} from './compile.ts';
import {closeMatch, nearest, oneLine, problem, type Problem} from './errors.ts';
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
  /** What expansion corrected, as the text of `fixed` lines (field names, decision D15). */
  fixes: string[];
  /**
   * Finding V071: the paths the spec writes (literal file props, path targets of refs), as written, for the session to
   * look up the inventory's spelling of the ones written in another case; expanding again with those names uses them.
   */
  paths: string[];
}

/** The inventory's names of paths a spec wrote in another case ('readme.md' -> 'README.md'), keyed by the text written. */
export type PathNames = ReadonlyMap<string, string>;

const KIND_NOUN: Record<SourceMeta['kind'], string> = {rows: 'rows', tree: 'a tree', graph: 'a graph', record: 'a record'};

/**
 * Finding V009: a data prop bound to a source of another kind, said with the component that draws that kind, so the
 * retry is one step: `DataTable#t: diff.impact returns a graph, which DataTable cannot draw: use Graph('diff.impact')`.
 */
function kindWarning(component: string, id: string, meta: SourceMeta, kinds: ReadonlySet<SourceMeta['kind']>): string {
  const instead = meta.kind === 'graph' ? `Graph('${meta.name}')` : meta.kind === 'tree' ? `FileTree('${meta.name}') or Treemap('${meta.name}')`
    : meta.kind === 'record' ? `KeyValue('${meta.name}')` : `DataTable('${meta.name}')`;
  const asRows = meta.kind === 'graph' && kinds.has('rows') ? ` (query{ref:'${meta.name}'} lists its nodes as rows)` : '';
  return `${component}#${id}: ${meta.name} returns ${KIND_NOUN[meta.kind]}, which ${component} cannot draw: use ${instead}${asRows}. The plate will show an error.`;
}

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
  // `as=rows` reads a graph source as rows of its nodes (finding V009); every other name is the source's to accept.
  const unknown = Object.keys(ref.args).find(name => !acceptsArg(meta, name) && !(name === AS_ROWS.key && readsAsRows(meta, ref)));
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

/** Sources whose positional target is a path (a range, for diff.*, is never a case variant of a file). */
const PATH_TARGET = new Set(['path', 'path|range']);

/** Finding V071: a path the spec wrote, recorded, and under the inventory's name when the session found one (one fix). */
function named(written: string, out: Expansion, names: PathNames | undefined): string {
  if (out.paths.length < MAX_CHECKS && !out.paths.includes(written)) out.paths.push(written);
  const name = names?.get(written);
  if (name === undefined || name === written) return written;
  const fix = `path '${oneLine(written, 80)}' -> '${oneLine(name, 80)}'`;
  if (!out.fixes.includes(fix)) out.fixes.push(fix);
  return name;
}

/** The literal files a component names (its file prop, a CodeTour's stops), under the inventory's names. */
function nameFiles(comp: WireComponent, name: string, props: Record<string, Prop>, out: Expansion, names: PathNames | undefined): void {
  const one = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const meant = named(value.trim(), out, names);
    return meant === value.trim() ? undefined : meant;
  };
  if ('file' in props) {
    const meant = one(comp.file);
    if (meant !== undefined) comp.file = meant;
  }
  if (name === 'CodeTour' && Array.isArray(comp.data)) {
    for (const stop of comp.data) {
      if (typeof stop !== 'object' || stop === null) continue;
      const meant = one((stop as {file?: unknown}).file);
      if (meant !== undefined) (stop as {file?: unknown}).file = meant;
    }
  }
}

// ---------------------------------------------------------------- field names (decision D15)
/**
 * What people write for a field, and the fields it may stand for, in order of preference: the first one the dataset
 * has wins. Keys are lower case with everything but letters and digits removed. Gathered from the field names cold
 * sessions guessed (churn, lines, language, date on a weekly source, size, ...).
 */
const FIELD_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  churn: ['commits', 'changes'], changes: ['commits'], commit: ['commits'], commitcount: ['commits'], ncommits: ['commits'], numcommits: ['commits'], edits: ['commits'],
  count: ['commits', 'files', 'importers', 'weight', 'loc', 'size'], n: ['commits', 'files', 'importers', 'weight'], total: ['commits', 'files', 'loc', 'weight'], number: ['commits', 'files'],
  date: ['date', 'week', 'last', 'first'], day: ['date', 'week'], time: ['date', 'week', 'last'], when: ['date', 'last', 'week'], timestamp: ['date', 'last', 'week'], datetime: ['date', 'last', 'week'], ts: ['date', 'last', 'week'],
  week: ['week', 'date'], month: ['week', 'date'], period: ['week', 'date'], bucket: ['week', 'date'],
  lines: ['loc', 'sloc'], line: ['loc', 'sloc', 'text'], linecount: ['loc', 'sloc'], linesofcode: ['loc', 'sloc'], sloc: ['sloc', 'loc'], loc: ['loc', 'sloc'], size: ['loc', 'sloc', 'bytes', 'size'], length: ['loc', 'sloc'],
  bytes: ['bytes'], filesize: ['bytes'],
  language: ['lang'], languages: ['lang'], filetype: ['lang'], ext: ['lang'], extension: ['lang'],
  file: ['path', 'file', 'a'], filename: ['path', 'file'], filepath: ['path', 'file'], name: ['name', 'path', 'file', 'module', 'author', 'package', 'lang', 'symbol'], label: ['path', 'name', 'module', 'author', 'lang', 'package'],
  author: ['author', 'owner'], user: ['author', 'owner'], committer: ['author', 'owner'], who: ['author', 'owner'], person: ['author', 'owner'], contributor: ['author', 'owner'], owner: ['owner', 'author'],
  module: ['module', 'dir', 'path', 'package'], dir: ['dir', 'module', 'path'], directory: ['dir', 'module', 'path'], folder: ['dir', 'module', 'path'], package: ['package', 'name', 'module'], area: ['module', 'dir'], component: ['module', 'dir'],
  complexity: ['complexity'], cc: ['complexity'], cyclomatic: ['complexity'], indentation: ['complexity'], depth: ['complexity'],
  message: ['subject', 'text'], msg: ['subject', 'text'], title: ['subject', 'text', 'name'], summary: ['subject', 'text'], description: ['subject', 'text'],
  hash: ['sha', 'id'], commithash: ['sha'], commitid: ['sha'], rev: ['sha'], revision: ['sha'],
  percent: ['pct', 'ownership', 'degree'], percentage: ['pct', 'ownership', 'degree'], share: ['pct', 'ownership'], ratio: ['pct', 'degree'],
  risk: ['score'], hotspot: ['score'], status: ['status', 'kind'], state: ['status'], type: ['kind', 'status', 'lang', 'ecosystem'],
  importers: ['importers'], dependents: ['importers'], fanin: ['importers'], deps: ['deps'], dependencies: ['deps', 'importers'],
  source: ['from'], src: ['from'], target: ['to'], dst: ['to'], dest: ['to'], imports: ['weight'], edges: ['weight'],
  added: ['add'], additions: ['add'], insertions: ['add'], deleted: ['del'], deletions: ['del'], removed: ['del'],
  content: ['text'], authors: ['authors'], contributors: ['authors'], people: ['authors'], files: ['files'], filecount: ['files'], nfiles: ['files'],
  updated: ['last'], modified: ['last'], lastchange: ['last'], lastcommit: ['last'], latest: ['last'], created: ['first'],
  cochanges: ['shared'], coupling: ['degree', 'shared'], strength: ['degree'],
};

/**
 * Keys rows of these sources carry beyond the fields their SourceMeta declares (those are the default columns, not
 * every key), found by running each rows source on a real repository. A name in this list is a field like any other.
 */
const UNDECLARED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'git.log': ['add', 'del', 'refs'],
  'git.churn': ['first'],
  'git.hotspots': ['isTest'],
  'diff.files': ['add', 'del', 'isTest'],
  'code.symbols': ['endLine', 'depth', 'exported'],
  'code.todos': ['owner'],
};

/** Every field rows of this ref carry: the declared ones (for the variant its arguments select) and the undeclared. */
function knownFields(meta: SourceMeta, ref: SourceRef): Field[] | undefined {
  const declared = fieldsFor(meta, ref.args).fields;
  if (!declared || declared.length === 0) return undefined;
  // The undeclared keys are those of the source's own rows, not of a variant an argument selects (by=module).
  const extra = declared !== meta.fields ? [] : (UNDECLARED_FIELDS[meta.name] ?? []).filter(key => !declared.some(field => field.key === key));
  return [...declared, ...extra.map(key => ({key}))];
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The field of `fields` a written name stands for: the same name in another case, a field's label, a synonym the
 * dataset has, a plural or a near miss. Undefined when nothing fits.
 */
export function meantField(name: string, fields: readonly Field[]): string | undefined {
  const keys = fields.map(field => field.key);
  if (keys.includes(name)) return name;
  const wanted = squash(name);
  if (!wanted) return undefined;
  return keys.find(key => squash(key) === wanted)
    ?? fields.find(field => field.label !== undefined && squash(field.label) === wanted)?.key
    ?? (Object.hasOwn(FIELD_SYNONYMS, wanted) ? FIELD_SYNONYMS[wanted]!.find(key => keys.includes(key)) : undefined)
    ?? keys.find(key => squash(key) === wanted.replace(/s$/, '') || squash(key) === `${wanted}s`)
    ?? closeMatch(name, keys);
}

/** Field-valued props of a component: a plain string prop documented as naming a field, and DataTable's columns. */
const isFieldProp = (component: string, key: string, prop: Prop): boolean =>
  prop.kind === 'str' && (/\bfield/i.test(prop.doc) || (component === 'DataTable' && key === 'columns'));

/** The field names a component's field props spell, as written (DataTable columns by key, sort without its sign). */
function writtenFields(comp: WireComponent, name: string, props: Record<string, Prop>): string[] {
  const names: string[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const value = comp[key];
    if (typeof value !== 'string' || !isFieldProp(name, key, prop)) continue;
    if (name === 'DataTable' && key === 'columns') names.push(...value.trim().split(/\s+/).map(token => /^[^:=]*/.exec(token)![0]));
    else names.push(...value.split(/[\s,]+/).map(field => field.replace(/^-/, '')));
  }
  return names.filter(Boolean);
}

/**
 * A ref of a source with variants, as the variant the component's fields name: BarChart('git.churn', x='module')
 * asks for rows by module, which `git.churn by=module` returns and plain git.churn does not. Said as a fix.
 */
function variantMeant(comp: WireComponent, name: string, props: Record<string, Prop>, meta: SourceMeta, ref: SourceRef, out: Expansion): SourceRef {
  if (meta.kind !== 'rows' || !meta.variants || fieldsFor(meta, ref.args).fields !== meta.fields) return ref;
  const own = new Set((knownFields(meta, ref) ?? []).map(field => field.key));
  const asked = writtenFields(comp, name, props).filter(field => !own.has(field));
  for (const [selector, variant] of Object.entries(meta.variants)) {
    const keys = new Set(variant.fields.map(field => field.key));
    const eq = selector.indexOf('=');
    if (eq <= 0 || !asked.some(field => keys.has(field)) || Object.hasOwn(ref.args, selector.slice(0, eq))) continue;
    const chosen: SourceRef = {...ref, args: {...ref.args, [selector.slice(0, eq)]: selector.slice(eq + 1)}};
    out.fixes.push(`${name} '${formatRef(ref)}' -> '${formatRef(chosen)}' (it has the field ${asked.find(field => keys.has(field))})`);
    return chosen;
  }
  return ref;
}

/**
 * Decision D15: every field a component bound to a source names is one the source returns. An exact name stays; a
 * name the author plainly meant is rewritten (`ScatterPlot.x 'churn' -> 'commits'`); anything else is dropped so the
 * component draws its default encoding (`... 'zzz' dropped (fields: a b c)`). Never an empty plate for a guess.
 */
function repairFields(comp: WireComponent, name: string, props: Record<string, Prop>, fields: readonly Field[], out: Expansion): void {
  const keys = fields.map(field => field.key);
  const dropped = (key: string, written: string) => out.fixes.push(`${name}.${key} '${oneLine(written, 40)}' dropped (fields: ${keys.join(' ')})`);
  const moved = (key: string, written: string, meant: string) => out.fixes.push(`${name}.${key} '${oneLine(written, 40)}' -> '${meant}'`);
  for (const [key, prop] of Object.entries(props)) {
    const value = comp[key];
    if (typeof value !== 'string' || !isFieldProp(name, key, prop) || value.trim() === '') continue;
    let next: string | undefined;
    if (name === 'DataTable' && key === 'columns') {
      const columns: string[] = [];
      for (const token of value.trim().split(/\s+/)) {
        const head = /^[^:=]*/.exec(token)![0];
        const meant = head ? meantField(head, fields) : undefined;
        if (meant === undefined) { dropped(key, head || token); continue; }
        if (meant !== head) moved(key, head, meant);
        columns.push(meant + token.slice(head.length));
      }
      next = columns.join(' ');
    } else if (key === 'sort') {
      // 'field', '-field', or the SQL habit 'field desc'.
      const parsed = /^(-?)\s*(\S+)(?:\s+(asc|desc))?$/i.exec(value.trim());
      const meant = parsed ? meantField(parsed[2]!, fields) : undefined;
      if (!parsed || meant === undefined) { dropped(key, value); next = ''; }
      else {
        next = `${parsed[1] === '-' || parsed[3]?.toLowerCase() === 'desc' ? '-' : ''}${meant}`;
        if (next !== value) moved(key, value, next);
      }
    } else {
      // A prop documented as taking several fields (space separated) keeps those it can; the others take one.
      const several = /space separated/i.test(prop.doc);
      const names = several ? value.split(/[\s,]+/).filter(Boolean) : [value.trim()];
      const kept: string[] = [];
      for (const written of names) {
        const meant = meantField(written, fields);
        if (meant === undefined) { dropped(key, written); continue; }
        if (meant !== written) moved(key, written, meant);
        if (!kept.includes(meant)) kept.push(meant);
      }
      next = kept.join(' ');
    }
    if (next === '') delete comp[key];
    else comp[key] = next;
  }
}

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

/**
 * Finding V006: `Graph('deps.files', focus='src/spec')` names the path the source needs in focus=. A source whose
 * path target is required and missing takes the focus as its target, said as a fix; the focus goes, because the
 * graph of that target is already drawn around it (a directory is drawn as its modules, where no node has its name).
 */
function focusAsTarget(comp: WireComponent, name: string, text: string, registry: SourceRegistry, out: Expansion): string {
  const focus = typeof comp.focus === 'string' ? comp.focus.trim() : '';
  if (focus === '' || /\s/.test(focus)) return text;
  const ref = parseRef(text);
  const meta = resolveSource(ref.source, registry)?.meta;
  if (!meta?.targetRequired || meta.target !== 'path' || ref.target) return text;
  const chosen: SourceRef = {...ref, target: focus};
  delete comp.focus;
  out.fixes.push(`${name} '${formatRef(ref)}' -> '${formatRef(chosen)}' (focus= names its ${meta.target})`);
  return formatRef(chosen);
}

function expandComponent(comp: WireComponent, registry: SourceRegistry, out: Expansion, names: PathNames | undefined): void {
  const def = COMPONENT_BY_NAME.get(comp.component);
  if (!def) return;
  const where = (prop: string) => `${def.name}#${comp.id}.${prop}`;
  /** The fields of the sources the component's data props are bound to, one entry per bound data prop. */
  const boundFields: Array<readonly Field[] | undefined> = [];
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
    text = focusAsTarget(comp, def.name, text, registry, out);
    const checked = checkRef(text, registry, where(key));
    if ('problem' in checked) { out.problems.push({...checked.problem, component: def.name}); continue; }
    let ref = variantMeant(comp, def.name, def.props as Record<string, Prop>, checked.meta, checked.ref, out);
    if (ref.target && PATH_TARGET.has(checked.meta.target ?? '')) {
      const target = named(ref.target, out, names);
      if (target !== ref.target) ref = {...ref, target};
    }
    const kinds = shapeKinds(prop.shape);
    // Finding V009: a component that draws rows, bound to a graph source, draws the graph's nodes as rows.
    const asRows = checked.meta.kind === 'graph' && (prop.shape ?? '').split('|')[0] === 'Rows';
    if (asRows && !readsAsRows(checked.meta, ref)) {
      ref = {...ref, args: {...ref.args, [AS_ROWS.key]: AS_ROWS.value}};
      out.fixes.push(`${def.name} '${formatRef(checked.ref)}' -> '${formatRef(ref)}' (its nodes as rows; Graph('${formatRef(checked.ref)}') draws the graph)`);
    }
    const dsKey = datasetKey(ref);
    if (!out.refs.has(dsKey)) out.refs.set(dsKey, ref);
    comp[key] = {'@path': `${PATHS.ds}/${dsKey}`};
    boundFields.push(asRows ? NODE_FIELDS : checked.meta.kind === 'rows' ? knownFields(checked.meta, ref) : undefined);
    if (!asRows && kinds && !kinds.has(checked.meta.kind)) out.warnings.push(kindWarning(def.name, comp.id, checked.meta, kinds));
  }
  // The columns as written are checked first: a kind that does not exist is the author's to fix, whatever the field.
  if (def.name === 'DataTable' && typeof comp.columns === 'string') {
    for (const error of checkColumns(comp.columns)) out.problems.push(problem('E_ENUM', `${where('columns')} column ${error.statement}: ${error.message}`, {component: def.name}));
  }
  const fields = boundFields.length === 1 ? boundFields[0] : undefined;
  if (fields && fields.length > 0) repairFields(comp, def.name, def.props as Record<string, Prop>, fields, out);
  nameFiles(comp, def.name, def.props as Record<string, Prop>, out, names);
  collectChecks(comp, def.name, def.props as Record<string, Prop>, out);
  if (def.name === 'Split' && typeof comp.ratio === 'string') comp.ratio = splitRatio(comp.ratio);
  if (typeof comp.src === 'string') checkSource(def.name, comp.src, where('src'), out);
}

/**
 * Flowchart.src and SequenceDiagram.src, written inline or through the data model: what cannot be read is an
 * E_NOTATION per statement, a slip the parser repaired (a block left open) a `fixed` line.
 */
function checkSource(component: string, src: string, where: string, out: Expansion): void {
  if (component !== 'Flowchart' && component !== 'SequenceDiagram') return;
  const parsed = component === 'Flowchart' ? parseFlow(src) : parseSequence(src);
  if (!parsed.ok) {
    for (const error of parsed.errors) out.problems.push(problem('E_NOTATION', `${where} statement ${error.statement}: ${error.message}`, {component}));
    return;
  }
  for (const fix of parsed.fixes ?? []) out.fixes.push(`${where} line ${fix.line}: ${fix.message}`);
}

const decodeSegments = (path: string): string[] => path.split('/').filter(Boolean).map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
const isContainer = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The value at `rest` (segments) inside `root`, when there is one. */
function valueIn(root: unknown, rest: readonly string[]): {value: unknown} | undefined {
  let node = root;
  for (const segment of rest) {
    if (!isContainer(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return {value: node};
}

/**
 * Every value this call's messages write at `segments`, in message order: the new surface's data model, a write to
 * the path itself, or a write to an ancestor whose value holds it. A write below the path is not one.
 */
function valuesAt(messages: readonly A2uiMessage[], segments: readonly string[]): unknown[] {
  const values: unknown[] = [];
  for (const message of messages) {
    let found: {value: unknown} | undefined;
    if ('createSurface' in message) {
      found = message.createSurface.dataModel ? valueIn(message.createSurface.dataModel, segments) : undefined;
    } else if ('updateDataModel' in message) {
      const update = message.updateDataModel;
      const at = decodeSegments(update.path ?? '/');
      if (at.length === 0 || at.length > segments.length || at.some((segment, i) => segment !== segments[i])) continue;
      found = valueIn(update.value, segments.slice(at.length));
    }
    if (found) values.push(found.value);
  }
  return values;
}

/**
 * A diagram src bound to a path this call writes (`$/seq='sequenceDiagram ...'` read by `SequenceDiagram($/seq)`) is
 * checked like an inline one, whether the component is in this call or in the stored view the call patches.
 */
function checkBoundSources(messages: readonly A2uiMessage[], out: Expansion, seed: Seed | undefined): void {
  const own = messages.flatMap(componentsOf);
  const ownIds = new Set(own.map(comp => comp.id));
  for (const comp of [...own, ...(seed?.components ?? []).filter(stored => !ownIds.has(stored.id))]) {
    if (comp.component !== 'Flowchart' && comp.component !== 'SequenceDiagram') continue;
    const src = comp.src;
    if (!isBinding(src) || !/^\/(?!(ds|meta|ui)(\/|$))/.test(src['@path'])) continue;
    for (const value of valuesAt(messages, decodeSegments(src['@path']))) {
      if (typeof value === 'string') checkSource(comp.component, value, `$${src['@path']} (${comp.component}#${comp.id}.src)`, out);
    }
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

/**
 * Expands every message in place and collects every problem found (the caller reports the first five). `names` are
 * the inventory's spellings the session found for paths an earlier expansion of the same call recorded (V071).
 * `seed` is the stored view a patch applies to: a diagram of it may read its src from a path this call writes.
 */
export function expandMessages(messages: A2uiMessage[], registry: SourceRegistry, names?: PathNames, seed?: Seed): Expansion {
  const out: Expansion = {refs: new Map(), problems: [], warnings: [], files: [], ranges: [], fields: [], fixes: [], paths: []};
  for (const message of messages) {
    checkPaths(message, out);
    for (const comp of componentsOf(message)) expandComponent(comp, registry, out, names);
  }
  checkBoundSources(messages, out, seed);
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
