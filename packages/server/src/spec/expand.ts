// Expansion (design 2.2 step 4): compiled messages are rewritten in place so that every data prop naming a source
// becomes a /ds binding, and the things only Glimpse can judge are checked: source refs, diagram data, DataTable
// columns, reserved data paths, and what a Slider binds and where a call computes nothing (decision D25). Pure apart
// from the in-place rewrite of messages nobody else holds yet.
import {
  acceptsArg, callReads, callsIn, columnKey, explainValue, isCall, COMPONENT_BY_NAME, datasetKey, fieldsFor, formatRef, looksLikeRef, normalizeCols, parseFileLoc,
  parseRef, PATHS, readColumns, replaceFileRefs, shapeKinds, shorthandTokens, SOURCES, tokenKey, type A2uiMessage, type Field, type Prop,
  type SourceMeta, type SourceRef, type WireComponent,
} from '@glimpse/catalog';
import {ignoredMarksWarning, readLineMarks} from '@glimpse/catalog';
import {AS_ROWS, NODE_FIELDS, readsAsRows} from '../session/datasets.ts';
import {resolveSource, type SourceRegistry} from '../sources/registry.ts';
import {asDrawn, AUTHORED, inlinePaths, isBinding, lookup, SERVER_PATH, TEXT_DIAGRAMS} from './authored.ts';
import {closeMatch, nearest, oneLine, problem, type Problem} from './errors.ts';
import {pathProblem} from './guard.ts';

// The data model helpers live with the authored-data checks (authored.ts); the session and the store read them here.
export {lookup} from './authored.ts';

export interface Expansion {
  /** Source refs the call names, by dataset key, in order of first use. */
  refs: Map<string, SourceRef>;
  problems: Problem[];
  /** What is certain to draw wrong although the spec is valid, as `Name#id: text` (a `warn` line each). */
  warnings: string[];
  /** Literal files named by components (CodeView, FileRef, a CodeTour stop, a [[path]] ref ...): the session checks they exist. */
  files: FileCheck[];
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

/**
 * A file to check, and the part that names it. `nested` marks one named inside a component's data (a Flowchart node's
 * or a Layers item's file, decision D24): the session checks those after the rest, so a plate whose own file is
 * missing is reported before the links inside a diagram, under the cap on warning lines.
 */
export interface FileCheck { where: string; file: string; nested?: true }

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

/**
 * Split's ratio as Split draws it, said (D22): a share rewritten to 'a:b' is a `fixed` line, and a value Split cannot
 * read (it then opens the panes half and half) is a `warn` line.
 */
function splitRatioChecked(comp: WireComponent, out: Expansion): void {
  const written = String(comp.ratio);
  const meant = splitRatio(written);
  if (meant !== written) {
    comp.ratio = meant;
    out.fixes.push(`Split.ratio '${oneLine(written, 24)}' -> '${meant}'`);
  }
  if (!/^\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?$/.test(meant.trim()) && !/^\d+(?:\.\d+)?%?$/.test(meant.trim())) {
    out.warnings.push(`Split#${comp.id}: ratio '${oneLine(written, 24)}' is not a ratio: opened half and half. Write '1:2'.`);
  }
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

/**
 * Grid's cols as Grid reads it (normalizeCols, shared with the viewer): a guess ('2fr 1fr', '50% 50%', 'two') is
 * written as '2:1', '1:1' or '2' with a `fixed` line; what cannot be read is drawn as equal columns, said in a `warn`.
 */
function gridCols(comp: WireComponent, out: Expansion): void {
  if (typeof comp.cols !== 'string' || comp.cols.trim() === '') return;
  const written = comp.cols;
  const meant = normalizeCols(written);
  if (meant === undefined) {
    out.warnings.push(`Grid#${comp.id}: cols '${oneLine(written, 40)}' is not a count or a ratio: drawn as equal columns. Write '3' or '2:1'.`);
    return;
  }
  const fix = `Grid.cols '${oneLine(written, 40)}' -> '${meant}'`;
  if (meant !== written.replace(/\s+/g, '') && !out.fixes.includes(fix)) out.fixes.push(fix);
  comp.cols = meant;
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
/** A value the tab resolves itself: a binding or a function call. */
const isDynamic = (value: unknown): boolean => isBinding(value) || (typeof value === 'object' && value !== null && '@call' in value);

export function componentsOf(message: A2uiMessage): WireComponent[] {
  if ('createSurface' in message) return message.createSurface.components;
  if ('updateComponents' in message) return message.updateComponents.components;
  return [];
}

/** Most files, ranges and field lists one call has checked. */
export const MAX_CHECKS = 64;

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

/** The text prop that draws `[[path#L10]]` refs as file links (shared/inline.tsx), by component. */
const PROSE: Readonly<Record<string, string>> = {Text: 'text', Callout: 'text', Ask: 'prompt'};

/**
 * The `[[path#L10]]` refs of a literal text, checked as a file prop is (the session says which name no file) and
 * written under the inventory's name in the text (V071). A ref to a directory (`[[src/auth/]]`) is not a file to check.
 */
function proseRefs(comp: WireComponent, name: string, out: Expansion, names: PathNames | undefined): void {
  const prop = PROSE[name];
  const text = prop ? comp[prop] : undefined;
  if (!prop || typeof text !== 'string') return;
  const where = `${name}#${comp.id}`;
  const next = replaceFileRefs(text, written => {
    if (parseFileLoc(written).path.endsWith('/')) return undefined;
    const meant = named(written, out, names);
    if (out.files.length < MAX_CHECKS && !out.files.some(entry => entry.where === where && entry.file === meant)) out.files.push({where, file: meant});
    return meant === written ? undefined : meant;
  });
  if (next !== text) comp[prop] = next;
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

/** DataTable's columns: a list or the shorthand string, read by readColumns (catalog notation.ts). */
const isColumns = (component: string, key: string): boolean => component === 'DataTable' && key === 'columns';

/** Field-valued props of a component: a plain string prop documented as naming a field, and DataTable's columns. */
const isFieldProp = (component: string, key: string, prop: Prop): boolean =>
  isColumns(component, key) || (prop.kind === 'str' && /\bfield/i.test(prop.doc));

/** The field names a component's field props spell, as written (DataTable columns by key, sort without its sign). */
function writtenFields(comp: WireComponent, name: string, props: Record<string, Prop>): string[] {
  const names: string[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const value = comp[key];
    if (isColumns(name, key)) names.push(...readColumns(value).fields.map(column => column.key));
    else if (typeof value === 'string' && isFieldProp(name, key, prop)) names.push(...value.split(/[\s,]+/).map(field => field.replace(/^-/, '')));
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
    if (isColumns(name, key) && Array.isArray(value)) {
      // The list form: an entry keeps its own spelling ('key', {field: ...}); one with no key is the columns check's.
      const columns = value.flatMap(item => {
        const named = columnKey(item);
        if (!named) return [item];
        const meant = meantField(named.key, fields);
        if (meant === undefined) { dropped(key, named.key); return []; }
        if (meant === named.key) return [item];
        moved(key, named.key, meant);
        return [named.prop === '' ? meant : {...(item as Record<string, unknown>), [named.prop]: meant}];
      });
      if (columns.length === 0) delete comp[key];
      else comp[key] = columns;
      continue;
    }
    if (typeof value !== 'string' || !isFieldProp(name, key, prop) || value.trim() === '') continue;
    let next: string | undefined;
    if (isColumns(name, key)) {
      const columns: string[] = [];
      for (const token of shorthandTokens(value)) {
        const head = tokenKey(token);
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
    if (isColumns(name, key)) names.push(...readColumns(value).fields.map(column => column.key));
    else if (prop.kind === 'str' && typeof value === 'string' && /\bfield/i.test(prop.doc)) names.push(...value.split(/[\s,]+/).filter(Boolean).map(field => field.replace(/^-/, '')));
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

/**
 * Decision D22: a literal `mark` (CodeView, CodeBlock) is read here. A part written another plain way ('lines 10-20',
 * '10..20', '20-10') is rewritten as a fix; a part that names no line is a `warn` line (the tab notes it too).
 */
function checkMark(comp: WireComponent, name: string, out: Expansion): void {
  if (typeof comp.mark !== 'string') return;
  const read = readLineMarks(comp.mark);
  if (read.fixed !== undefined) {
    out.fixes.push(`${name}#${comp.id}: mark '${oneLine(comp.mark, 60)}' -> '${oneLine(read.fixed, 60)}'`);
    comp.mark = read.fixed;
  }
  if (read.ignored.length > 0) out.warnings.push(`${name}#${comp.id}: ${ignoredMarksWarning(read.ignored)}`);
}

/** A value for a message: JSON, at most 40 characters (as explainValue writes the values it names). */
const shown = (value: unknown): string => {
  const text = typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
  return text.length > 40 ? text.slice(0, 39) + '…' : text;
};

/**
 * Decision D25: a Slider edits the data at the $/path its value binds, so that value is a binding to a path of the
 * model's own. A literal or a call is refused with the two statements to write instead; a relative path, and one
 * under /ui (the viewer's) or /ds and /meta (the server's), likewise. min not below max draws no range: a `warn`.
 */
function checkSlider(comp: WireComponent, out: Expansion): void {
  const at = `Slider#${comp.id}.value`;
  const value = comp.value;
  if (!isBinding(value)) {
    const what = isCall(value) ? 'a call' : shown(value);
    const seed = typeof value === 'number' && Number.isFinite(value) ? value : 50000;
    out.problems.push(problem('E_TYPE', `${at}: ${what} is not a $/path. A Slider edits data: write $/w={seats:${seed}} and Slider('Seats',$/w/seats).`, {component: 'Slider'}));
    return;
  }
  const path = value['@path'];
  if (!path.startsWith('/')) {
    out.problems.push(problem('E_TYPE', `${at}: bind an absolute $/path, e.g. $/w/seats.`, {component: 'Slider'}));
    return;
  }
  if (SERVER_PATH.test(path)) {
    const owner = /^\/ui(?:\/|$)/.test(path) ? 'the viewer (/ds and /meta to the server)' : 'the server (/ui to the viewer)';
    out.problems.push(problem('E_PATH', `${at}: $${oneLine(path, 60)} belongs to ${owner}; bind a path of your own, e.g. $/w/seats.`, {component: 'Slider'}));
    return;
  }
  if (typeof comp.min === 'number' && typeof comp.max === 'number' && !(comp.min < comp.max)) {
    out.warnings.push(`Slider#${comp.id}: min ${comp.min} is not below max ${comp.max}, so no range is drawn`);
  }
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
    // Text where a diagram takes data (the Mermaid these components once read): say what they take now.
    if (typeof value === 'string' && TEXT_DIAGRAMS.has(def.name)) {
      const cleaned = AUTHORED[def.name]!(value);
      if (!cleaned.ok) out.problems.push(problem('E_SHAPE', `${where(key)}: ${cleaned.error}`, {component: def.name}));
      continue;
    }
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
  // An entry with no key is left out and named; the rest draws. Columns bound to a $/path are the viewer's to report.
  const columns = comp.columns;
  if (def.name === 'DataTable' && columns !== undefined && !isBinding(columns) && !(typeof columns === 'object' && columns !== null && '@call' in columns)) {
    for (const {column, type, message} of readColumns(columns).problems) {
      const at = `${where('columns')}${column > 0 ? ` column ${column}` : ''}`;
      if (type === 'kind') out.problems.push(problem('E_ENUM', `${at}: ${message}`, {component: def.name}));
      else if (type === 'shape') out.problems.push(problem('E_SHAPE', `${at}: ${message}`, {component: def.name}));
      else out.warnings.push(`${at}: ${type === 'dropped' ? 'not drawn: ' : ''}${message}`);
    }
  }
  const fields = boundFields.length === 1 ? boundFields[0] : undefined;
  if (fields && fields.length > 0) repairFields(comp, def.name, def.props as Record<string, Prop>, fields, out);
  nameFiles(comp, def.name, def.props as Record<string, Prop>, out, names);
  collectChecks(comp, def.name, def.props as Record<string, Prop>, out);
  proseRefs(comp, def.name, out, names);
  if ('mark' in def.props) checkMark(comp, def.name, out);
  if (def.name === 'Split' && typeof comp.ratio === 'string') splitRatioChecked(comp, out);
  if (def.name === 'Grid') gridCols(comp, out);
  if (def.name === 'Slider') checkSlider(comp, out);
  // Decision D25: a call in an action is run by the tab as an action and computes a number nobody sees.
  for (const [key, prop] of Object.entries(def.props) as Array<[string, Prop]>) {
    const call = prop.kind === 'action' ? (comp[key] as {functionCall?: unknown} | undefined)?.functionCall : undefined;
    if (isCall(call)) out.problems.push(problem('E_TYPE', `${where(key)}: ${oneLine(call['@call'], 40)}(...) computes a number; an action is Event('name',{...}).`, {component: def.name}));
  }
  // Inline authored data (decision D24, authored.ts): what is not the shape at all is refused, the rest draws and says
  // what it corrected or left out, and the files it names are checked like file props. It is read as the tab reads it,
  // each call computed (decision D25, asDrawn). Data bound to a $/path, or with $/paths inside it, is checked against
  // the data model after the call (diagramNotes).
  const authored = AUTHORED[def.name];
  if (authored && comp.data !== undefined && typeof comp.data !== 'string' && !isDynamic(comp.data) && inlinePaths(comp.data).length === 0) {
    const cleaned = authored(asDrawn(comp.data)?.value);
    if (!cleaned.ok) out.problems.push(problem('E_SHAPE', `${where('data')}: ${cleaned.error}`, {component: def.name}));
    else {
      out.fixes.push(...cleaned.fixes.map(fix => `${def.name}#${comp.id}: ${fix}`));
      out.warnings.push(...cleaned.dropped.map(drop => `${def.name}#${comp.id}: not drawn: ${drop}`));
      for (const {at, file} of cleaned.ast.files) if (out.files.length < MAX_CHECKS) out.files.push({where: `${def.name}#${comp.id} ${at}`, file, nested: true});
    }
  }
}

const RESERVED = [PATHS.ds, PATHS.meta];
const reservedPath = (path: string): string | undefined => RESERVED.find(root => path === root || path.startsWith(root + '/'));

const pointerOf = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** Where the outermost calls in a data value are, as JSON pointers under `base`. */
function callsInData(value: unknown, base: string, into: string[]): void {
  if (isCall(value)) { into.push(base); return; }
  if (isBinding(value) || typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) callsInData(item, `${base}/${pointerOf(key)}`, into);
}

function checkPaths(message: A2uiMessage, out: Expansion, calls: string[]): void {
  const refuse = (path: string) =>
    out.problems.push(problem('E_PATH', `$${path} cannot be assigned: /ds and /meta are written by the server. Name a source in a data argument instead.`));
  if ('updateDataModel' in message) {
    const path = message.updateDataModel.path ?? '/';
    const unsafe = pathProblem(path);
    if (unsafe) out.problems.push(unsafe);
    else if (path === '/' || path === '') out.problems.push(problem('E_PATH', '$/ cannot be assigned as a whole: assign $/name=value.'));
    else if (reservedPath(path)) refuse(path);
    else callsInData(message.updateDataModel.value, path.replace(/\/+$/, ''), calls);
  } else if ('createSurface' in message) {
    for (const [key, value] of Object.entries(message.createSurface.dataModel ?? {})) {
      if (reservedPath(`/${key}`)) refuse(`/${key}`);
      else callsInData(value, `/${pointerOf(key)}`, calls);
    }
  }
}

/**
 * Expands every message in place and collects every problem found (the caller reports the first five). `names` are
 * the inventory's spellings the session found for paths an earlier expansion of the same call recorded (V071).
 */
export function expandMessages(messages: A2uiMessage[], registry: SourceRegistry, names?: PathNames): Expansion {
  const out: Expansion = {refs: new Map(), problems: [], warnings: [], files: [], ranges: [], fields: [], fixes: [], paths: []};
  const calls: string[] = [];
  for (const message of messages) {
    checkPaths(message, out, calls);
    for (const comp of componentsOf(message)) expandComponent(comp, registry, out, names);
  }
  // Decision D25: A2UI computes calls in component arguments only; one in the data model stays a raw object there.
  if (calls.length > 0) {
    const more = calls.length > 1 ? ` (and ${calls.length - 1} more)` : '';
    out.warnings.push(`$${oneLine(calls[0]!, 80)}: a call in data is not computed; write it in a component argument, e.g. Stats([{label:'x',value:mul($/a,2)}]).${more}`);
  }
  return out;
}

const topOf = (path: string) => (path.split('/').filter(Boolean)[0] ?? '').replace(/~1/g, '/').replace(/~0/g, '~');

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Review S5: how a Slider's number lies outside its own limits ('outside 0..100', 'below min 10'), or undefined. */
function outsideRange(value: number, min: unknown, max: unknown): string | undefined {
  const low = finite(min) ? min : undefined;
  const high = finite(max) ? max : undefined;
  if (low !== undefined && high !== undefined) return low < high && (value < low || value > high) ? `outside ${low}..${high}` : undefined;
  if (low !== undefined && value < low) return `below min ${low}`;
  if (high !== undefined && value > high) return `above max ${high}`;
  return undefined;
}

/**
 * Decision D25: the calls of the components a call defines, and of those reading a path whose top segment it wrote,
 * computed against the data after the call. One that gives no number (division by zero, an operand that is not a
 * number, a result too large) is a `warn` line: `Stat#rps: value: div: b = $/w/secs is 0 (division by zero)`. An
 * operand not set is left to the unbound line; a relative one is said (review S6). A Slider whose path holds
 * something other than a number, or a number outside its own min..max (review S5), is said too.
 */
export function calcNotes(
  components: Iterable<WireComponent>, data: Record<string, unknown>, defined: ReadonlySet<string>, written: ReadonlySet<string>,
): string[] {
  const read = (path: string) => lookup(data, path);
  const lines: string[] = [];
  for (const comp of components) {
    const where = `${comp.component}#${comp.id}`;
    const calls = callsIn(comp);
    const bound = comp.component === 'Slider' && isBinding(comp.value) ? comp.value['@path'] : undefined;
    const slider = bound !== undefined && bound.startsWith('/') && !SERVER_PATH.test(bound) ? bound : undefined;
    const inScope = defined.has(comp.id) || (slider !== undefined && written.has(topOf(slider)))
      || calls.some(({call}) => [...callReads(call)].some(path => written.has(topOf(path))));
    if (!inScope) continue;
    if (slider !== undefined) {
      const value = read(slider);
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) lines.push(`${where}: $${oneLine(slider, 80)} is ${shown(value)}, not a number`);
      else if (typeof value === 'number') {
        const range = outsideRange(value, comp.min, comp.max);
        if (range) lines.push(`${where}: $${oneLine(slider, 80)} is ${value}, ${range}`);
      }
    }
    for (const {at, call} of calls) {
      const got = explainValue(call, read);
      if ('problem' in got && got.reason !== 'not set') lines.push(`${where}: ${at}: ${got.problem}`);
    }
  }
  return lines;
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
    .filter(path => path.startsWith('/') && !SERVER_PATH.test(path) && lookup(data, path) === undefined)
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
