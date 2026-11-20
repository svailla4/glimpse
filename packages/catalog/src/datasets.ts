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
/** "3,7-9" -> [[3,3],[7,9]] */
export function parseLineRanges(spec: string | undefined): Array<[number, number]> {
  if (!spec) return [];
  const out: Array<[number, number]> = [];
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (m) out.push([Number(m[1]), Number(m[2] ?? m[1])]);
  }
  return out;
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
export type KeyValueData = Record<string, unknown> | Array<{k: string; v: unknown}>;
export type ChipItem = string | {label: string; tone?: Tone; slotKey?: string};
export interface LayerItem { name: string; note?: string; items: Array<string | {label: string; file?: FileLoc; note?: string}> }
export interface ErColumn { name: string; type?: string; pk?: boolean; fk?: boolean; nullable?: boolean }
export interface ErTable { name: string; file?: FileLoc; columns: ErColumn[] }
export interface ErData { tables: ErTable[]; relations?: Array<{from: string; to: string; label?: string; card?: '1-1' | '1-n' | 'n-1' | 'n-n'}> }
export interface TourStop { file: FileLoc; title?: string; note: string }
export interface CodeNote { line: number; endLine?: number; text: string; kind?: 'note' | 'warn' | 'risk' }

// rows produced by specific sources (documented field sets)
export interface CommitRow { sha: string; subject: string; author: string; date: string; add?: number; del?: number; files?: number; refs?: string[] }
export interface SymbolRow { name: string; kind: 'fn' | 'class' | 'method' | 'type' | 'iface' | 'const' | 'var' | 'enum' | 'mod'; line: number; endLine?: number; depth: number; exported: boolean }
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
