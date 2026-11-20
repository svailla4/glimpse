// packages/catalog/src/sources.ts
// Source registry METADATA (names, args, fields, budgets). The server implements `run`; the viewer and the
// docs generator only need this table. A source ref is the string form the agent writes in a data prop.
//
// Who validates what in a ref (the seam between the spec pipeline and the sources):
// - The spec pipeline (expand, and the query tool) rejects, before anything runs: a name that is not a source
//   (E_SOURCE), a missing target when `targetRequired` is set, and an argument NAME for which acceptsArg() is false
//   (both E_ARGS, with the source's ref signature). It never judges a target or an argument VALUE.
// - The source itself judges values: a `top` that is not a positive integer or a malformed `since` is
//   SourceError('E_ARGS'); a path outside the root, a bad range or an unknown symbol is SourceError('E_TARGET').
//   Those become an error envelope for that dataset only. A source ignores argument names it does not know.
// - `top=N` works on EVERY rows source, listed in `args` or not: the source returns at most min(N, budget) rows.
//   `since=` works only where it is listed.
import type {DatasetKind, Field, Roles} from './datasets.ts';

export interface SourceMeta {
  name: string;
  kind: DatasetKind;
  /** One line for docs. */
  doc: string;
  /**
   * Meaning of the positional target, if any. It is documentation, not a validation rule: the source decides whether
   * a given target is acceptable. 'path|range' (git.log) takes a repo path or a change range ('main..HEAD', 'wt',
   * 'staged'); the source tells them apart.
   */
  target?: 'path' | 'range' | 'symbol' | 'path|range';
  targetRequired?: boolean;
  /** Extra key=value args (name -> doc). `since` is listed where supported; `top` works on every rows source (see acceptsArg). */
  args?: Record<string, string>;
  /** rows: default columns in display order. */
  fields?: Field[];
  roles?: Roles;
  /** Name of the data shape in datasets.ts. */
  shape: string;
  /** Max items bound into the data model. */
  budget: number;
  pageable?: boolean;
  /**
   * Computed from the working tree, so it reflects uncommitted edits and is re-run when /meta/rev changes. True for
   * every files.*, repo.*, deps.*, code.* and diff.* source, and for the git.* sources that join history with the
   * working tree (git.hotspots: complexity, sloc and generated flags; git.timeline: module names); the other git.*
   * sources follow HEAD only.
   */
  wt?: boolean;
}

const f = (key: string, kind?: Field['kind'], label?: string, priority?: Field['priority']): Field =>
  ({key, ...(kind ? {kind} : {}), ...(label ? {label} : {}), ...(priority ? {priority} : {})});

export const SOURCES: readonly SourceMeta[] = [
  // files
  {name: 'files.tree', kind: 'tree', shape: 'DirNode', budget: 1500, target: 'path', wt: true,
    doc: 'Directory tree with files, loc, bytes, lang, commits, age, complexity.'},
  {name: 'files.list', kind: 'rows', shape: 'Rows', budget: 500, pageable: true, target: 'path', wt: true,
    doc: 'One row per file. complexity = summed indentation depth.', args: {top: 'row limit'},
    fields: [f('path', 'path', 'File', 1), f('lang', 'lang'), f('loc', 'num', 'LOC', 1), f('bytes', 'bytes', undefined, 3), f('commits', 'bar'), f('complexity', 'heat', 'Indentation', 3)],
    roles: {label: 'path', value: 'loc'}},
  {name: 'files.langs', kind: 'rows', shape: 'LangRow[]', budget: 40, wt: true,
    doc: 'Language mix.',
    fields: [f('lang', 'lang', 'Language', 1), f('files', 'num'), f('loc', 'num', 'LOC', 1), f('pct', 'pct', '%')],
    roles: {label: 'lang', value: 'loc', x: 'lang', y: ['loc']}},
  // repo
  {name: 'repo.kpis', kind: 'rows', shape: 'StatItem[]', budget: 8, wt: true,
    doc: 'Files, LOC, languages, modules (packages declared by manifests when 2+, else directories holding source), file cycles (lazy import() excluded), commits (30d), contributors.'},
  {name: 'repo.stack', kind: 'rows', shape: 'ChipItem[]', budget: 24, wt: true,
    doc: 'Detected languages, frameworks and tools as chips.'},
  {name: 'repo.packages', kind: 'rows', shape: 'Rows', budget: 500, wt: true,
    doc: 'Manifests: ecosystem, name, version, dir, dependency count.',
    fields: [f('name', 'text', 'Package', 1), f('ecosystem', 'chip'), f('version', 'code'), f('dir', 'path'), f('deps', 'num')]},
  {name: 'repo.scripts', kind: 'rows', shape: 'Rows', budget: 200, wt: true,
    doc: 'Runnable scripts per package.',
    fields: [f('package', 'text'), f('script', 'code', undefined, 1), f('command', 'code', undefined, 1)]},
  // deps
  // A graph source, so `top` is listed: by default the graph is cut to what a plate can show legibly (decision D7).
  {name: 'deps.modules', kind: 'graph', shape: 'GraphData', budget: 150, target: 'path', wt: true,
    doc: "Import graph by module: 24 nodes by default (20 modules, up to 4 external packages); smaller directories fold into their parent's rest node ('x/*', '(other)' at the root). A small scope is drawn file by file.",
    args: {top: 'nodes in total: default 24, at most 48 by module, 150 file by file', focus: 'node id to centre', depth: 'hops around focus'}},
  {name: 'deps.files', kind: 'graph', shape: 'GraphData', budget: 150, target: 'path', targetRequired: true, wt: true,
    doc: 'Imports and importers of one file (ego network).', args: {depth: 'hops, default 1'}},
  {name: 'deps.cycles', kind: 'rows', shape: 'Rows', budget: 50, wt: true,
    doc: 'Import cycles between files.', fields: [f('id', 'num', '#'), f('size', 'num', 'Files', 1), f('members', 'text', undefined, 1)]},
  {name: 'deps.external', kind: 'rows', shape: 'Rows', budget: 500, wt: true, args: {top: 'row limit'},
    doc: 'External packages by importer count.',
    fields: [f('package', 'text', undefined, 1), f('importers', 'bar', undefined, 1), f('ecosystem', 'chip')],
    roles: {label: 'package', value: 'importers', x: 'package', y: ['importers']}},
  {name: 'deps.matrix', kind: 'rows', shape: 'Rows', budget: 1600, wt: true,
    doc: 'Module-to-module import counts (from, to, weight).',
    fields: [f('from', 'module'), f('to', 'module'), f('weight', 'num')], roles: {x: 'to', y: ['from'], value: 'weight'}},
  // git
  {name: 'git.log', kind: 'rows', shape: 'CommitRow[]', budget: 200, pageable: true, target: 'path|range', args: {top: 'row limit', since: 'e.g. 90d'},
    doc: 'Commits, newest first; of a path, or of a range such as main..HEAD.',
    fields: [f('sha', 'commit', undefined, 1), f('subject', 'text', undefined, 1), f('author', 'author'), f('date', 'date', undefined, 1), f('files', 'num', undefined, 3)]},
  {name: 'git.activity', kind: 'rows', shape: 'Rows', budget: 400, target: 'path', args: {since: 'default 365d'},
    doc: 'Commits per day.', fields: [f('date', 'date'), f('commits', 'num')], roles: {date: 'date', value: 'commits', x: 'date', y: ['commits']}},
  {name: 'git.timeline', kind: 'rows', shape: 'Rows', budget: 1600, target: 'path', wt: true, args: {since: 'default 365d'},
    doc: "Commits per week per module; a commit counts once, under the module most of its files are in. Series may include '(root)' (top-level files) and '(removed)' (directories gone since). 200 buckets max, else months.",
    fields: [f('week', 'date'), f('module', 'module', 'Main module'), f('commits', 'num', 'Commits by main module')], roles: {x: 'week', y: ['commits'], series: 'module'}},
  {name: 'git.churn', kind: 'rows', shape: 'ChurnRow[]', budget: 500, pageable: true, target: 'path', args: {top: 'row limit', since: 'e.g. 90d', by: 'file (default) or module: one row per module of deps.modules'},
    doc: 'Commits, authors and ownership per file; first and last are ISO commit times.',
    fields: [f('path', 'path', 'File', 1), f('commits', 'bar', undefined, 1), f('authors', 'num'), f('owner', 'author'), f('ownership', 'pct', undefined, 3), f('last', 'date')],
    roles: {label: 'path', value: 'commits', x: 'path', y: ['commits']}},
  {name: 'git.hotspots', kind: 'rows', shape: 'HotspotRow[]', budget: 500, pageable: true, target: 'path', wt: true, args: {top: 'row limit', since: 'e.g. 90d'},
    doc: 'Churn x complexity ranking. complexity = summed indentation depth; sloc = non-blank lines; isTest flags tests.',
    fields: [f('path', 'path', 'File', 1), f('commits', 'bar', undefined, 1), f('complexity', 'bar', 'Indentation', 1), f('sloc', 'num', 'Lines', 3), f('score', 'heat'), f('owner', 'author')],
    roles: {label: 'path', value: 'score', x: 'commits', y: ['complexity'], size: 'sloc'}},
  {name: 'git.authors', kind: 'rows', shape: 'Rows', budget: 200, target: 'path', args: {top: 'row limit', since: 'e.g. 90d'},
    doc: 'Commits and files touched per author (names only); last is an ISO commit time.',
    fields: [f('author', 'author', undefined, 1), f('commits', 'bar', undefined, 1), f('files', 'num'), f('last', 'date')],
    roles: {label: 'author', value: 'commits', x: 'author', y: ['commits']}},
  {name: 'git.coupling', kind: 'rows', shape: 'Rows', budget: 200, target: 'path',
    doc: 'Files that change together: shared = commits touching both (commits over 30 files ignored), degree = % of the less-changed file\'s commits.',
    fields: [f('a', 'path', 'File', 1), f('b', 'path', 'Changes with', 1), f('shared', 'num'), f('degree', 'pct')]},
  // change range
  {name: 'diff.stats', kind: 'rows', shape: 'StatItem[]', budget: 8, target: 'range', wt: true,
    doc: 'Files changed, lines added/removed, commits, tests touched.'},
  // Every row carries `add` and `del` (numbers, for charts and sorting) AND `delta: {add, del}` (the `delta` cell).
  {name: 'diff.files', kind: 'rows', shape: 'DiffFileRow[]', budget: 500, target: 'range', wt: true,
    doc: 'Changed files with status and +/- counts.',
    fields: [f('path', 'path', 'File', 1), f('status', 'chip'), f('delta', 'delta', '+/-', 1), f('lang', 'lang', undefined, 3)],
    roles: {label: 'path', value: 'add'}},
  {name: 'diff.tree', kind: 'tree', shape: 'DirNode', budget: 1500, target: 'range', wt: true,
    doc: 'Changed files as a tree with add/del per node.'},
  {name: 'diff.impact', kind: 'graph', shape: 'GraphData', budget: 150, target: 'range', wt: true,
    doc: 'Changed files plus their direct importers (blast radius).'},
  // code
  {name: 'code.symbols', kind: 'rows', shape: 'SymbolRow[]', budget: 2000, target: 'path', targetRequired: true, wt: true,
    doc: 'Symbol outline of one file; of a Markdown file, its headings.',
    fields: [f('name', 'symbol', undefined, 1), f('kind', 'chip'), f('line', 'num')]},
  {name: 'code.refs', kind: 'rows', shape: 'Rows', budget: 500, target: 'symbol', targetRequired: true, wt: true,
    doc: 'Word-boundary matches of an identifier (git grep).',
    fields: [f('file', 'path', 'Where', 1), f('text', 'code', undefined, 1)]},
  // `file` is a FileLoc with the line ('src/a.ts#L12'). roles.label lets List and the charts title a row by its text.
  {name: 'code.todos', kind: 'rows', shape: 'Rows', budget: 500, target: 'path', wt: true, args: {top: 'row limit'},
    doc: 'TODO / FIXME / HACK comments.',
    fields: [f('tag', 'chip'), f('file', 'path', 'Where', 1), f('text', 'text', undefined, 1)],
    roles: {label: 'text'}},
];

export const SOURCE_BY_NAME: ReadonlyMap<string, SourceMeta> = new Map(SOURCES.map(s => [s.name, s]));

/**
 * True when `name` is an argument a ref of this source may carry: one listed in `meta.args`, or `top` on any rows
 * source. The spec pipeline answers E_ARGS for any other name; argument values are the source's business.
 */
export function acceptsArg(meta: SourceMeta, name: string): boolean {
  return Object.hasOwn(meta.args ?? {}, name) || (name === 'top' && meta.kind === 'rows');
}

export interface SourceRef {
  source: string;
  /** Positional target: a path scope, a git range or a symbol. */
  target?: string;
  args: Record<string, string>;
}

/** 'git.churn src/auth top=20 since=90d' -> {source:'git.churn', target:'src/auth', args:{top:'20', since:'90d'}} */
export function parseRef(text: string): SourceRef {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const ref: SourceRef = {source: parts[0] ?? '', args: {}};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0 && /^[a-z][A-Za-z0-9_]*$/.test(part.slice(0, eq))) ref.args[part.slice(0, eq)] = part.slice(eq + 1);
    else ref.target = ref.target ? `${ref.target} ${part}` : part;
  }
  return ref;
}

/** Canonical text: source, target, args sorted by key. */
export function formatRef(ref: SourceRef): string {
  const args = Object.keys(ref.args).sort().map(k => `${k}=${ref.args[k]}`);
  return [ref.source, ...(ref.target ? [ref.target] : []), ...args].join(' ');
}

/** True for a string that should be treated as a source ref (first word is `word.word`). */
export function looksLikeRef(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]+\.[a-z]+(\s|$)/.test(value.trim());
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Data-model key: 'git_churn' for a bare source, 'git_churn_1a2b3c' when it has a target or args. */
export function datasetKey(ref: SourceRef): string {
  const base = ref.source.replace(/\./g, '_');
  const rest = formatRef(ref).slice(ref.source.length).trim();
  return rest ? `${base}_${fnv1a(rest).slice(0, 6)}` : base;
}
