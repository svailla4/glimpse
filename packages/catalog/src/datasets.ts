// packages/catalog/src/datasets.ts
// Shapes of everything analyzers produce and data-bound components consume. DOM-free, no runtime deps.

export type DatasetKind = 'rows' | 'tree' | 'graph' | 'record';

/** How a table cell / field is rendered and formatted. */
export type FieldKind =
  | 'text' | 'num' | 'bytes' | 'pct' | 'duration'
  | 'path' | 'symbol' | 'module' | 'author' | 'commit' | 'lang'
  | 'date' | 'bar' | 'heat' | 'spark' | 'chip' | 'delta' | 'code' | 'bool';

export interface Field {
  key: string;
  label?: string;
  kind?: FieldKind;
  unit?: string;
  /** 1 = always shown, 3 = dropped first on narrow plates. Default 2. */
  priority?: 1 | 2 | 3;
}

/** Default encodings so charts and tables render with zero configuration. */
export interface Roles {
  label?: string;   // category / entity field
  value?: string;   // primary measure
  x?: string;
  y?: string[];
  series?: string;
  size?: string;
  color?: string;
  date?: string;
}

export interface Truncation {
  total: number;
  returned: number;
  strategy: 'topN' | 'treecut' | 'window' | 'bucket' | 'neighborhood';
  by?: string;
}

/** Envelope stored at /ds/<key> in a surface data model. */
export interface Dataset<T = unknown> {
  /** Dataset key; the envelope lives at `/ds/${$ds}` and pages at GET /api/ds/${$ds}/rows. */
  $ds: string;
  kind: DatasetKind;
  status: 'pending' | 'ready' | 'error';
  /** Normalized source ref, e.g. "git.churn src/auth top=20". */
  source: string;
  /** Status line while pending ("git log - 3,412 commits"). */
  note?: string;
  data?: T;
  fields?: Field[];
  roles?: Roles;
  /** Item count before truncation. */
  total?: number;
  truncated?: Truncation;
  /** rows only: the full set can be paged/sorted/searched over HTTP. */
  pageable?: boolean;
  /** Depends on the working tree; re-run when /meta/rev changes. */
  wt?: boolean;
  /**
   * Set by the server while a viewer drill (gl_drill) has re-scoped this dataset.
   * `target` is the current scope; `up` is the target one level out ('' restores the spec's own scope).
   */
  drill?: {target: string; up: string};
  cache?: 'hit' | 'partial' | 'miss';
  elapsedMs?: number;
  warnings?: string[];
  error?: {code: string; message: string};
}

export function isDataset(v: unknown): v is Dataset {
  return typeof v === 'object' && v !== null && typeof (v as {$ds?: unknown}).$ds === 'string';
}

// ---------------------------------------------------------------- cell values
export type Row = Record<string, unknown>;
export type Rows = Row[];
/** `delta` cells. */
export interface DeltaCell { add: number; del: number }

// ---------------------------------------------------------------- entities and selection
export type EntityType = 'file' | 'dir' | 'module' | 'package' | 'symbol' | 'author' | 'commit' | 'node' | 'row';
/** Value of /ui/sel. One per surface. */
export interface EntityRef {
  type: EntityType;
  id: string;
  /** Repo-relative path when the entity lives in a file or directory. */
  path?: string;
  line?: number;
  endLine?: number;
  label?: string;
}

/** "path", "path#L10" or "path#L10-40". Repo-relative, forward slashes. */
export type FileLoc = string;
export interface ParsedFileLoc { path: string; line?: number; endLine?: number }

export function parseFileLoc(loc: string): ParsedFileLoc {
  const m = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(loc.trim());
  if (!m || !m[1]) return {path: loc.trim()};
  const out: ParsedFileLoc = {path: m[1]};
  if (m[2]) out.line = Number(m[2]);
  if (m[3]) out.endLine = Number(m[3]);
  return out;
}
export function formatFileLoc(l: ParsedFileLoc): FileLoc {
  if (l.line == null) return l.path;
  return l.endLine != null && l.endLine !== l.line ? `${l.path}#L${l.line}-${l.endLine}` : `${l.path}#L${l.line}`;
}
/** What a `mark` (CodeView, CodeBlock) reads as. */
export interface LineMarks {
  /** 1-based, `from <= to`, in the order written. */
  ranges: Array<[number, number]>;
  /** The parts that name no line, as written. */
  ignored: string[];
  /** The text with every part read by a guess written plainly ('lines 10–20; 30' -> '10-20,30'); absent when none was. */
  fixed?: string;
}

// '3', '7-9', 'L7-L9'; and, as guesses: '#L7', 'lines 7-9', '7:9', 'L7:L9', '7..9', '7–9', '7 to 9', '9-7'.
const MARK_PART = /^(#?)(?:(lines?)\s*)?L?(\d+)(?:\s*(-|–|—|:|\.\.\.?|to)\s*L?(\d+))?$/i;


// ---------------------------------------------------------------- [[path#L10-20]] refs in prose
// Text, Callout and Ask draw `[[path#L10-20]]` as a file link; the viewer draws them and the server checks the files
// they name, from these definitions. Spans are bounded (400 characters) so a text full of unmatched markers still
// scans in linear time.
/** One file ref: group 1 is the location, never blank at either end. Not global: build `new RegExp(FILE_REF.source, 'g')`. */
export const FILE_REF = /\[\[(?!\s)([^[\]\n]{1,400}?)(?<!\s)\]\]/;
/** An inline code span of Text, Callout and Ask: group 1 is the code. A ref inside it stays literal. */
export const CODE_SPAN = /`([^`\n]{1,400})`/;
const INLINE_SCAN = new RegExp(`${CODE_SPAN.source}|${FILE_REF.source}`, 'g');

/**
 * `text` with each `[[loc]]` file ref that is drawn as a link replaced by `[[swap(loc)]]`, or kept when `swap` returns
 * undefined. A ref inside an inline code span is literal text, not a link, and is never passed to `swap`.
 */
export function replaceFileRefs(text: string, swap: (loc: string) => string | undefined): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(INLINE_SCAN)) {
    const loc = match[match.length - 1];
    const next = loc === undefined ? undefined : swap(loc);
    if (next === undefined) continue;
    out += `${text.slice(last, match.index)}[[${next}]]`;
    last = match.index + match[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** The locations of the `[[path#L10]]` refs `text` draws as links, in order, as written (see replaceFileRefs). */
export function fileRefs(text: string): string[] {
  const found: string[] = [];
  replaceFileRefs(text, loc => void found.push(loc));
  return found;
}

/**
 * Decision no-invented-string-formats: `mark` is written the way file anchors are ('3,7-9', 'L7-9'). A part written another plain way is
 * read and the reading is returned in `fixed`; a part that names no line (lines start at 1) is returned in `ignored`,
 * so the server and the view can say so instead of marking nothing. The server and the viewer both read marks here.
 */
export function readLineMarks(spec: unknown): LineMarks {
  const out: LineMarks = {ranges: [], ignored: []};
  if (typeof spec === 'number' && Number.isInteger(spec) && spec > 0) out.ranges.push([spec, spec]);
  if (typeof spec !== 'string') return out;
  let guessed = spec.includes(';');
  const parts: string[] = [];
  for (const part of spec.split(/[,;]/)) {
    const text = part.trim();
    if (text === '') continue;
    const m = MARK_PART.exec(text);
    const a = m ? Number(m[3]) : 0;
    const b = m?.[5] !== undefined ? Number(m[5]) : a;
    if (!m || a < 1 || b < 1) {
      out.ignored.push(text);
      parts.push(text);
      continue;
    }
    const range: [number, number] = [Math.min(a, b), Math.max(a, b)];
    out.ranges.push(range);
    const guess = m[1] !== '' || m[2] !== undefined || (m[4] !== undefined && m[4] !== '-') || a > b;
    guessed ||= guess;
    parts.push(guess ? (range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`) : text);
  }
  if (guessed) out.fixed = parts.join(',');
  return out;
}

/** What is said of mark parts that name no line, by the server (a `warn` line) and by the view (W_MARK). */
export function ignoredMarksWarning(ignored: readonly string[]): string {
  const shown = ignored.slice(0, 3).map(text => `'${text.length > 24 ? `${text.slice(0, 23)}…` : text}'`).join(', ');
  return `mark ${shown}${ignored.length > 3 ? ` and ${ignored.length - 3} more` : ''} ignored: write 'L10-20' or '3,7-9'`;
}

// ---------------------------------------------------------------- tree
export interface DirNode {
  name: string;
  /** Repo-relative; "" for the root. */
  path: string;
  dir: boolean;
  files: number;
  loc: number;
  bytes: number;
  /** Dominant language (dir) or language (file). */
  lang?: string;
  commits?: number;
  /** Days since the last commit touching it. */
  age?: number;
  complexity?: number;
  /** diff.* trees */
  add?: number;
  del?: number;
  status?: 'A' | 'M' | 'D' | 'R';
  children?: DirNode[];
  /** Rollup of children cut by the budget: rendered as "(N more)". */
  more?: {files: number; loc: number};
}

// ---------------------------------------------------------------- graph
export interface GraphNode {
  id: string;
  label: string;
  sub?: string;
  kind?: 'file' | 'dir' | 'cluster' | 'package' | 'external' | 'symbol';
  /** Group (container) id. */
  group?: string;
  /** Key into /meta/slots.module (or .lang) for the category spine. */
  slotKey?: string;
  files?: number;
  loc?: number;
  fanIn?: number;
  fanOut?: number;
  cycle?: boolean;
  status?: 'added' | 'modified' | 'deleted' | 'affected';
  /** FileLoc opened/selected when the node is activated. */
  file?: FileLoc;
}
export interface GraphEdge {
  from: string;
  to: string;
  weight?: number;
  label?: string;
  kind?: 'solid' | 'dashed';
  cycle?: boolean;
}
export interface GraphGroup { id: string; label: string; parent?: string }
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: GraphGroup[];
  /** Granularity, shown in the plate note. */
  level?: 'module' | 'file' | 'package';
}

// ---------------------------------------------------------------- small inline shapes (agent-authored or analyzer rows)
export type Format = 'num' | 'compact' | 'bytes' | 'pct' | 'duration';
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
export interface StatItem { label: string; value: number | string; unit?: string; delta?: number; spark?: number[]; format?: Format; tone?: Tone }
export type StepStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
export interface StepItem { title: string; note?: string; status?: StepStatus; file?: FileLoc }
export interface ListItem { title: string; sub?: string; value?: number | string; file?: FileLoc; tone?: Tone }
/** An object of pairs, or one item per pair: {label, value} like Stats, {key, value} or {k, v}. */
export type KeyValueData = Record<string, unknown> | Array<{label: string; value: unknown} | {key: string; value: unknown} | {k: string; v: unknown}>;
export type ChipItem = string | {label: string; tone?: Tone; slotKey?: string};
/** `name` is canonical; Layers also reads the layer's name from `label` or `title`. */
export interface LayerItem { name: string; note?: string; items: Array<string | {label: string; file?: FileLoc; note?: string}> }
/**
 * `fk` is true, or names the column it points at ('users.id', or just 'users'); `ref` is a synonym for the string
 * form. The string form also draws the relation, so `relations` can be left out.
 */
export interface ErColumn { name: string; type?: string; pk?: boolean; fk?: boolean | string; ref?: string; nullable?: boolean }
export interface ErTable { name: string; file?: FileLoc; columns: ErColumn[] }
/** `from` and `to` are 'table.column' (or a bare table name). */
export interface ErRelation { from: string; to: string; label?: string; card?: '1-1' | '1-n' | 'n-1' | 'n-n' }
/** ERDiagram also accepts the bare table list (ErTable[]); relations then come from the columns' `fk`. */
export interface ErData { tables: ErTable[]; relations?: ErRelation[] }
export interface TourStop { file: FileLoc; title?: string; note: string }
export interface CodeNote { line: number; endLine?: number; text: string; kind?: 'note' | 'warn' | 'risk' }

// rows produced by specific sources (documented field sets)
export interface CommitRow { sha: string; subject: string; author: string; date: string; add?: number; del?: number; files?: number; refs?: string[] }
/** `heading` is a Markdown heading: a README has an outline too. */
export interface SymbolRow { name: string; kind: 'fn' | 'class' | 'method' | 'type' | 'iface' | 'const' | 'var' | 'enum' | 'mod' | 'heading'; line: number; endLine?: number; depth: number; exported: boolean }
export interface HotspotRow { path: string; commits: number; complexity: number; sloc: number; score: number; owner: string; isTest: boolean }
export interface ChurnRow { path: string; commits: number; authors: number; owner: string; ownership: number; first: string; last: string }
export interface LangRow { lang: string; files: number; loc: number; pct: number }
/** `delta` repeats add and del as the DeltaCell the `delta` column of diff.files renders ('+12 −4'). */
export interface DiffFileRow { path: string; from?: string; status: 'A' | 'M' | 'D' | 'R'; add: number; del: number; delta: DeltaCell; lang?: string; isTest: boolean }

// ---------------------------------------------------------------- data model layout
export const PATHS = {
  ds: '/ds',
  uiSel: '/ui/sel',
  uiFile: '/ui/file',
  meta: '/meta',
  metaRev: '/meta/rev',
  metaSlots: '/meta/slots',
} as const;

/** Value of /meta, written by the server on every surface. */
export interface SurfaceMeta {
  repo: {name: string; root: string; branch?: string; head?: string; dirty: boolean; shallow?: boolean};
  /** Bumped when the working tree or HEAD changes; components that read files/diffs refetch. */
  rev: number;
  /** Stable categorical colour slot (1..8) per entity key. 0 or missing = "other". */
  slots: {lang: Record<string, number>; module: Record<string, number>; author: Record<string, number>};
  generatedAt: string;
}
