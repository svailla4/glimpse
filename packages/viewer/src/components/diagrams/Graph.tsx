// Graph: a node-link diagram of modules, files or packages on the dot grid (design 5.6).
import type * as C from '@glimpse/catalog';
import {parseFileLoc, type EntityRef, type GraphData, type GraphEdge, type GraphGroup, type GraphNode} from '@glimpse/catalog';
import {useCallback, useMemo, type ReactNode} from 'react';
import {
  DataGate, Empty, Redline, elidePath, emptyCodeOf, fmtNum, useCatSlots, useDataset, useHostActions, useReportState, type GlView,
} from '../../kit/index.ts';
import {
  Diagram, FULL_ZOOM, MONO_11, UI_12, fitText, textWidth, zoomStep,
  type DiagramEdge, type DiagramGroup, type DiagramNode, type Dir, type Face, type NodeFlags,
} from './flowkit/index.ts';
import css from './Graph.module.css';

/**
 * Nodes of one graph share a width (what the longest label needs, between the first two), and a node whose name needs
 * more is wider, up to NODE_W_WIDE: a name is cut only past that.
 */
const NODE_W_MIN = 112;
const NODE_W_MAX = 168;
const NODE_W_WIDE = 240;
const NODE_H = 28;
const NODE_H_SUB = 40;
/** From the spine to the label, and from the label to the right edge. */
const LABEL_X = 13;
const LABEL_END = 8;
/** On-screen size of the labels a node keeps when the stage is zoomed out. */
const FAR_LABEL = 10.5;
const FAR_SUB = 10;
/** Graphs with more nodes than this draw one-line nodes (the second line is in the tooltip), so the picture stays compact. */
export const COMPACT_FROM = 32;
/** Up to this many nodes there is room to spare: a second line may widen the nodes instead of being cut. */
const ROOMY_UNTIL = 12;
/** Tighter than the diagram default, so a module graph fills its plate at a readable zoom. */
const NODE_GAP = 16;
const LAYER_GAP = 40;
/** With more edges than this, the lightest third is drawn in the rule colour so the heavy ones lead. */
const FAINT_FROM = 40;
/** Group ids the dependency sources give directory groups: the rest is the directory a drill goes to. */
const DIR_GROUP = 'dir:';
/** Above this the picture stops being readable; the data should be scoped instead (design 5.6). */
export const MAX_NODES = 150;
/** Edges beyond this are dropped, lightest first. */
export const MAX_EDGES = 600;
const FAN_BAR = 56;

const STATUS: Record<NonNullable<GraphNode['status']>, {glyph: string; label: string; ink: string}> = {
  added: {glyph: '+', label: 'added', ink: 'var(--gl-good)'},
  modified: {glyph: '~', label: 'modified', ink: 'var(--gl-serious)'},
  deleted: {glyph: '−', label: 'deleted', ink: 'var(--gl-critical)'},
  affected: {glyph: '›', label: 'affected', ink: 'var(--gl-info)'},
};
const LEVEL_NOUN: Record<string, readonly [string, string]> = {module: ['module', 'modules'], file: ['file', 'files'], package: ['package', 'packages']};

const count = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const numberOf = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

interface CleanNode extends Omit<GraphNode, 'fanIn' | 'fanOut' | 'loc' | 'files'> { fanIn?: number; fanOut?: number; loc?: number; files?: number }
interface CleanEdge { from: string; to: string; weight?: number; label?: string; dashed: boolean; cycle: boolean }
export interface CleanGraph {
  nodes: CleanNode[];
  edges: CleanEdge[];
  groups: GraphGroup[];
  level?: string;
  /** What was left out, for the marginal note. */
  dropped: {duplicates: number; dangling: number; invalid: number};
}

/**
 * Coerces whatever was bound into a drawable graph: ids become strings, numbers are parsed, nodes without an id
 * and repeated ids are dropped, and so are edges whose ends do not exist. Returns a message when the value is not
 * a graph at all.
 */
export function cleanGraph(data: unknown): CleanGraph | string {
  if (!isRecord(data)) return `expected {nodes, edges}, received ${describe(data)}`;
  if (!Array.isArray(data.nodes)) return `expected nodes to be an array, received ${describe(data.nodes)}`;
  if (data.edges !== undefined && data.edges !== null && !Array.isArray(data.edges)) return `expected edges to be an array, received ${describe(data.edges)}`;
  const dropped = {duplicates: 0, dangling: 0, invalid: 0};

  const groups: GraphGroup[] = [];
  const groupIds = new Set<string>();
  for (const raw of Array.isArray(data.groups) ? data.groups : []) {
    const id = isRecord(raw) ? idOf(raw.id) : undefined;
    if (!isRecord(raw) || id === undefined || groupIds.has(id)) continue;
    groupIds.add(id);
    groups.push({id, label: typeof raw.label === 'string' && raw.label ? raw.label : id, parent: idOf(raw.parent)});
  }

  const nodes: CleanNode[] = [];
  const ids = new Set<string>();
  for (const raw of data.nodes) {
    const id = isRecord(raw) ? idOf(raw.id) : undefined;
    if (!isRecord(raw) || id === undefined) {
      dropped.invalid++;
      continue;
    }
    if (ids.has(id)) {
      dropped.duplicates++;
      continue;
    }
    ids.add(id);
    const group = idOf(raw.group);
    nodes.push({
      id,
      label: typeof raw.label === 'string' && raw.label ? raw.label : id,
      sub: typeof raw.sub === 'string' && raw.sub ? raw.sub : undefined,
      kind: typeof raw.kind === 'string' ? (raw.kind as GraphNode['kind']) : undefined,
      group: group !== undefined && groupIds.has(group) ? group : undefined,
      slotKey: idOf(raw.slotKey),
      files: numberOf(raw.files),
      loc: numberOf(raw.loc),
      fanIn: numberOf(raw.fanIn),
      fanOut: numberOf(raw.fanOut),
      cycle: raw.cycle === true,
      status: typeof raw.status === 'string' && raw.status in STATUS ? (raw.status as GraphNode['status']) : undefined,
      file: typeof raw.file === 'string' && raw.file ? raw.file : undefined,
    });
  }

  const edges: CleanEdge[] = [];
  const seen = new Set<string>();
  for (const raw of (data.edges as unknown[] | undefined) ?? []) {
    const from = isRecord(raw) ? idOf(raw.from) : undefined;
    const to = isRecord(raw) ? idOf(raw.to) : undefined;
    if (!isRecord(raw) || from === undefined || to === undefined || !ids.has(from) || !ids.has(to)) {
      dropped.dangling++;
      continue;
    }
    const key = `${from}\u0001${to}`;
    if (seen.has(key)) {
      dropped.duplicates++;
      continue;
    }
    seen.add(key);
    edges.push({
      from, to,
      weight: numberOf(raw.weight),
      label: typeof raw.label === 'string' && raw.label ? raw.label : undefined,
      dashed: (raw as Partial<GraphEdge>).kind === 'dashed',
      cycle: raw.cycle === true,
    });
  }
  return {nodes, edges, groups, level: typeof data.level === 'string' ? data.level : undefined, dropped};
}

/** The nodes within `depth` hops of `focus` (edges in either direction) and the edges among them. */
export function neighbourhood(graph: CleanGraph, focus: string, depth: number): CleanGraph {
  const adjacent = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adjacent.get(a);
    if (list) list.push(b);
    else adjacent.set(a, [b]);
  };
  for (const edge of graph.edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  const keep = new Set([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adjacent.get(id) ?? []) {
        if (keep.has(other)) continue;
        keep.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return {
    ...graph,
    nodes: graph.nodes.filter(node => keep.has(node.id)),
    edges: graph.edges.filter(edge => keep.has(edge.from) && keep.has(edge.to)),
  };
}

function entityOf(node: CleanNode): EntityRef {
  const loc = node.file ? parseFileLoc(node.file) : undefined;
  const where = loc ? {path: loc.path, ...(loc.line != null ? {line: loc.line} : {}), ...(loc.endLine != null ? {endLine: loc.endLine} : {})} : {};
  switch (node.kind) {
    case 'file': return {type: 'file', id: loc?.path ?? node.id, path: node.id, ...where, label: node.label};
    case 'dir': return {type: 'dir', id: node.id, path: node.id, label: node.label};
    case 'cluster': return {type: 'module', id: node.id, ...where, label: node.label};
    case 'package':
    case 'external': return {type: 'package', id: node.id, label: node.label};
    case 'symbol': return {type: 'symbol', id: node.id, ...where, label: node.label};
    default: return {type: 'node', id: node.id, ...where, label: node.label};
  }
}

/**
 * A label cut to `maxWidth`. A path gives up its directories first and keeps its last segment (design rule D12):
 * `…/core/web_core`, not `typescript/co…`. A package name (`@angular/core`) is a name, not a path: it is cut at the
 * end, so it never passes for one (`@angular/co…`, not `…/core`).
 */
export function fitLabel(text: string, maxWidth: number, face: Face, pkg = false): string {
  if (textWidth(text, face) <= maxWidth) return text;
  // A path, not a sentence that happens to hold a slash ("12 files, 3 in/out").
  if (!pkg && text.includes('/') && !text.includes(' ')) {
    // Nothing longer than this many of the narrowest glyphs can fit.
    for (let max = Math.min(text.length - 1, Math.floor(maxWidth / (0.34 * face.size))); max >= 4; max--) {
      const cut = elidePath(text, max);
      if (textWidth(cut, face) <= maxWidth) return cut;
    }
  }
  return fitText(text, maxWidth, face);
}

/**
 * A second line cut to `maxWidth` at a separator when one leaves enough: '366 files, 129k loc' becomes '366 files',
 * not '366 files, 12…'.
 */
export function fitSub(text: string, maxWidth: number, face: Face): string {
  if (textWidth(text, face) <= maxWidth) return text;
  const cuts = [...text.matchAll(/[,;:·]\s/g)].map(match => match.index).reverse();
  for (const at of cuts) {
    const head = text.slice(0, at).trimEnd();
    if (head !== '' && textWidth(head, face) <= maxWidth) return head;
  }
  return fitLabel(text, maxWidth, face);
}

/**
 * Labels that two or more nodes would show alike get the shortest stretch of their path that tells them apart
 * (`state/types.ts` and `catalog/types.ts`), where `name` gives the text a node would show. Returns the new full
 * labels by node id (nodes that are already distinct are left out), and the ids whose path labels end alike
 * (`.github/scripts`, `typescript/scripts`): those keep the start of their path when they are cut, at any zoom.
 */
export function distinctLabels(
  nodes: ReadonlyArray<{id: string; label: string; file?: string; pkg?: boolean}>, name: (label: string, pkg: boolean) => string,
): {labels: Map<string, string>; ends: Set<string>} {
  const out = new Map<string, string>();
  const byName = new Map<string, Array<(typeof nodes)[number]>>();
  for (const node of nodes) {
    const shown = name(node.label, node.pkg === true);
    const list = byName.get(shown);
    if (list) list.push(node);
    else byName.set(shown, [node]);
  }
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    // Their paths, from the id (a module or a file) or the file a node opens; the label's own last word ends them.
    const paths = same.map(node => {
      const path = (node.file ? parseFileLoc(node.file).path : node.id).replace(/^[a-z]+:/, '').replace(/\/\*$/, '').split('/').filter(Boolean);
      const last = node.label.split('/').filter(Boolean).at(-1);
      return last !== undefined && path.at(-1) !== last ? [...path, last] : path;
    });
    const longest = Math.max(...paths.map(path => path.length));
    for (let k = 2; k <= longest; k++) {
      const labels = paths.map(path => path.slice(-k).join('/'));
      if (new Set(labels).size < labels.length) continue;
      same.forEach((node, i) => { if (labels[i] !== node.label) out.set(node.id, labels[i]!); });
      break;
    }
  }
  const byLast = new Map<string, string[]>();
  for (const node of nodes) {
    const label = out.get(node.id) ?? node.label;
    if (node.pkg || !label.includes('/')) continue;
    const last = label.split('/').filter(Boolean).at(-1) ?? label;
    byLast.set(last, [...(byLast.get(last) ?? []), node.id]);
  }
  const ends = new Set<string>();
  for (const ids of byLast.values()) if (ids.length > 1) for (const id of ids) ends.add(id);
  return {labels: out, ends};
}

/** A path label cut to `maxWidth` keeping both ends: its first segment (what tells it apart) and its last. */
function fitBothEnds(text: string, maxWidth: number, face: Face): string {
  if (textWidth(text, face) <= maxWidth) return text;
  const parts = text.split('/');
  if (parts.length < 2) return fitText(text, maxWidth, face);
  const tail = parts.length === 2 ? `/${parts[1]!}` : `/…/${parts.at(-1)!}`;
  const room = maxWidth - textWidth(tail, face);
  if (room < textWidth('ab…', face)) return fitLabel(text, maxWidth, face);
  return `${fitText(parts[0]!, room, face)}${tail}`.replace('……', '…');
}

/** A face size that is at least `px` on screen at zoom `k`, rounded up so no serialisation takes it below. */
const faceFor = (px: number, k: number) => Math.ceil((px / k) * 100) / 100;

/** The directory a node stands for, when it stands for one: a module ('src/auth', 'src/*' for the rest of src) or a directory. */
function placeOf(node: CleanNode): string | undefined {
  if (node.kind !== 'cluster' && node.kind !== 'dir') return undefined;
  if (node.id === '(root)' || node.id === '.') return '';
  return (node.id.endsWith('/*') ? node.id.slice(0, -2) : node.id).replace(/\/+$/, '');
}

/**
 * The node ids most like `focus`, best first: the longest run of leading path segments in common, then those that
 * hold the focus's last segment. For the report of a focus that matches no node.
 */
export function nearestIds(ids: readonly string[], focus: string, max = 3): string[] {
  const want = focus.replace(/\/+$/, '').split('/');
  const last = want.at(-1) ?? '';
  const scored = ids.map(id => {
    const parts = id.split('/');
    let common = 0;
    while (common < Math.min(parts.length, want.length) && parts[common] === want[common]) common++;
    return {id, score: common * 2 + (last !== '' && id.includes(last) ? 1 : 0)};
  });
  return scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.length - b.id.length).slice(0, max).map(item => item.id);
}

/** The node with the most edges: where a graph too large to read as a whole opens. */
function hubOf(graph: CleanGraph): string | undefined {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) for (const end of [edge.from, edge.to]) degree.set(end, (degree.get(end) ?? 0) + 1);
  let best: string | undefined;
  for (const node of graph.nodes) if ((degree.get(node.id) ?? 0) > (best !== undefined ? (degree.get(best) ?? 0) : 0)) best = node.id;
  return best;
}

/**
 * True when `focus` names the scope the graph is already drawn for and not one of its nodes: a group of the graph,
 * or a directory every module in it lies under. Such a focus needs no "not found" note.
 */
function isScope(graph: CleanGraph, focus: string): boolean {
  const dir = focus.replace(/\/+$/, '');
  if (graph.groups.some(group => group.id === dir || group.id === DIR_GROUP + dir)) return true;
  const inside = graph.nodes.filter(node => node.kind !== 'external' && node.kind !== 'package');
  return inside.length > 0 && inside.every(node => node.id === dir || node.id.startsWith(`${dir}/`));
}

/** The /meta/slots tables a spine key is looked up in, first hit wins. */
const SPINE_SLOTS = ['module', 'lang'] as const;

/** How a label is cut: a path from the front, a package name at the end, a disambiguated path at both ends. */
type Cut = 'path' | 'name' | 'ends';
const SEPARATOR = /[./\-_ ]/;

/**
 * `text` cut to `maxWidth` keeping what follows `from` (the part that tells it from a node whose name starts alike):
 * 'surface-group…​.test.ts', not 'surface-group-model…' for two nodes. The start gives way first, then the kept tail
 * from its own start.
 */
export function fitKeepingTail(text: string, maxWidth: number, face: Face, from: number): string {
  if (textWidth(text, face) <= maxWidth) return text;
  const tail = text.slice(from);
  const chars = [...tail];
  if (textWidth(`…${tail}`, face) > maxWidth) {
    for (let i = 1; i < chars.length; i++) {
      const kept = `…${chars.slice(i).join('')}`;
      if (textWidth(kept, face) <= maxWidth) return kept;
    }
    return fitText(text, maxWidth, face);
  }
  const head = [...text.slice(0, from)];
  for (let n = head.length; n >= 1; n--) {
    const cut = `${head.slice(0, n).join('')}…${tail}`;
    if (textWidth(cut, face) <= maxWidth) return cut;
  }
  return `…${tail}`;
}

/** Names that share at least this many leading characters could be cut alike. */
const SHARED_START = 6;

/**
 * For names (not paths: a path is cut from the front) that start like another node's, where each one's own part
 * starts: at the last separator ('.', '-', '_', space) within the longest start it shares with another. A cut keeps
 * that part, at any zoom, so two nodes never read alike ('surface-components-mo…' twice). Keyed by node id.
 */
export function tailsOf(nodes: ReadonlyArray<{id: string; label: string}>): Map<string, number> {
  const out = new Map<string, number>();
  const names = nodes.filter(node => !node.label.includes('/'));
  for (const node of names) {
    let common = 0;
    for (const other of names) {
      if (other === node || other.label === node.label) continue;
      let i = 0;
      while (i < Math.min(node.label.length, other.label.length) && node.label[i] === other.label[i]) i++;
      common = Math.max(common, i);
    }
    if (common < SHARED_START) continue;
    let from = common;
    while (from > 0 && !SEPARATOR.test(node.label[from - 1]!)) from--;
    // Back to the separator itself, so '.test.ts' keeps its dot.
    out.set(node.id, Math.max(0, from - 1));
  }
  return out;
}

const cutLabel = (text: string, maxWidth: number, face: Face, cut: Cut, keepFrom?: number) =>
  keepFrom !== undefined
    ? fitKeepingTail(text, maxWidth, face, keepFrom)
    : cut === 'ends' ? fitBothEnds(text, maxWidth, face) : fitLabel(text, maxWidth, face, cut === 'name');

interface NodeDraw {
  /** The full label, for the cut a zoomed-out node makes itself. */
  label: string;
  cut: Cut;
  /** Where the part that tells this name from a like one starts: a cut keeps it (tailsOf). */
  keepFrom?: number;
  /** Width of the marks (cycle, status) beside the name at full detail. */
  marks: number;
  rawSub?: string;
  name: string;
  /** The width `name` was cut for. */
  cutFor: number;
  sub?: string;
  spine: string;
  external: boolean;
  cycle: boolean;
  status?: {glyph: string; label: string; ink: string};
  fanIn: number;
  fanOut: number;
}

/** A zoomed-out name says which node it is when it keeps this many characters (or all of a shorter one). */
export const NAME_KEEP = 8;
/** Where a zoomed-out name starts (spine and gap) and how much it leaves at the right edge. */
const FAR_X = 10;
const FAR_END = 4;
/** The cycle mark of a zoomed-out node: its size on screen, and its gap. */
const FAR_MARK = 7;
const FAR_MARK_GAP = 4;

/**
 * The zoom from which every node's zoomed-out name (drawNode at NodeFlags.lod 'name') keeps the name its full face
 * shows, or NAME_KEEP characters of it: further out, module names were cut to 'com…' and 'expre…' at 10 px. Faces
 * are sized for the zoom rounded down to 5%, so this is a whole step.
 */
export function nameZoom(nodes: ReadonlyArray<{w: number; data: Pick<NodeDraw, 'name' | 'cycle'>}>): number {
  let need = 0;
  for (const node of nodes) {
    const chars = [...node.data.name.replace(/…$/, '')];
    const kept = chars.length > NAME_KEEP ? `${chars.slice(0, NAME_KEEP).join('')}…` : node.data.name;
    const mark = node.data.cycle ? 1 : 0;
    // A name of `em` ems drawn FAR_LABEL px on screen, and the mark, in what the node has beside its spine.
    const em = textWidth(kept, {size: 1});
    need = Math.max(need, (FAR_LABEL * em + FAR_MARK * mark) / Math.max(1, node.w - FAR_X - FAR_END - FAR_MARK_GAP * mark));
  }
  return Math.ceil(need * 20 - 1e-6) / 20;
}

/**
 * For a graph its writer drew (inline data, not a source): the zoom from which every node's zoomed-out face shows its
 * whole name, and its second line too. A name the writer chose is not cut to tell nodes apart, as nameZoom allows; a
 * graph that cannot open whole at this zoom is wrapped, turned or panned instead (measurement: an eleven-node chain
 * opened at 46%, 'glimpse.co…', 'Worker san…', the second lines gone).
 */
export function wholeZoom(nodes: ReadonlyArray<{w: number; h: number; data: Pick<NodeDraw, 'label' | 'rawSub' | 'cycle'>}>): number {
  let need = 0;
  for (const node of nodes) {
    const d = node.data;
    const mark = d.cycle ? 1 : 0;
    need = Math.max(need, (FAR_LABEL * textWidth(d.label, {size: 1}) + FAR_MARK * mark) / Math.max(1, node.w - FAR_X - FAR_END - FAR_MARK_GAP * mark));
    if (d.rawSub !== undefined) {
      need = Math.max(need, (FAR_LABEL + FAR_SUB + 6) / node.h, (FAR_SUB * textWidth(d.rawSub, {size: 1, mono: true})) / Math.max(1, node.w - FAR_X - FAR_END));
    }
  }
  return Math.ceil(need * 20 - 1e-6) / 20;
}

function drawNode(node: DiagramNode<NodeDraw>, flags: NodeFlags): ReactNode {
  const d = node.data;
  if (flags.lod !== 'full') {
    // Zoomed out: the name (and the second line while two still fit) in a face that stays 10 px or more on screen;
    // further out the box and its spine.
    const size = faceFor(FAR_LABEL, flags.k);
    const subSize = faceFor(FAR_SUB, flags.k);
    const mark = FAR_MARK / flags.k;
    const spine = flags.lod === 'box' ? 10 : FAR_X - 5;
    const x = FAR_X;
    const room = node.w - x - FAR_END;
    const twoLines = flags.lod === 'name' && d.rawSub !== undefined && size + subSize + 6 / flags.k <= node.h;
    return (
      <g className={css.body} data-lod={flags.lod} data-selected={flags.selected || undefined} data-focus={flags.focus || undefined} data-external={d.external || undefined}>
        <rect className={css.box} width={node.w} height={node.h} />
        <rect className={css.spine} width={spine} height={node.h} style={{fill: d.spine}} />
        {flags.lod === 'name' ? (
          <text className={css.far} x={x} y={twoLines ? node.h / 2 - subSize / 2 - 1 / flags.k : node.h / 2} style={{fontSize: size}}>
            {cutLabel(d.label, room - (d.cycle ? mark + FAR_MARK_GAP : 0), {size}, d.cut, d.keepFrom)}
          </text>
        ) : null}
        {twoLines ? <text className={css.farSub} x={x} y={node.h / 2 + size / 2 + 1 / flags.k} style={{fontSize: subSize}}>{fitSub(d.rawSub!, room, {size: subSize, mono: true})}</text> : null}
        {d.cycle ? <rect className={css.cycleMark} x={node.w - mark - 3} y={twoLines ? node.h / 2 - subSize / 2 - 1 / flags.k - mark / 2 : (node.h - mark) / 2} width={mark} height={mark} /> : null}
      </g>
    );
  }
  const statusX = node.w - 8;
  const cycleX = statusX - (d.status ? 14 : 0);
  // A node the diagram made wider than its name was cut for (Diagram's widen) cuts it again for its width.
  const name = node.w === d.cutFor ? d.name : cutLabel(d.label, node.w - LABEL_X - LABEL_END - d.marks, UI_12, d.cut, d.keepFrom);
  return (
    <g className={css.body} data-selected={flags.selected || undefined} data-focus={flags.focus || undefined} data-external={d.external || undefined}>
      <rect className={css.box} width={node.w} height={node.h} />
      <rect className={css.spine} width={4} height={node.h} style={{fill: d.spine}} />
      <text className={css.name} x={13} y={d.sub ? 17 : node.h / 2 + 4}>{name}</text>
      {d.sub ? <text className={css.sub} x={13} y={31}>{d.sub}</text> : null}
      {d.cycle ? <text className={css.cycle} x={cycleX} y={13}>CYCLE</text> : null}
      {d.status ? <text className={css.status} x={statusX} y={14} style={{fill: d.status.ink}}>{d.status.glyph}</text> : null}
      {d.fanIn > 0 ? <rect className={css.fanIn} x={4} y={node.h - 3} width={d.fanIn} height={3} /> : null}
      {d.fanOut > 0 ? <rect className={css.fanOut} x={node.w - d.fanOut} y={node.h - 3} width={d.fanOut} height={3} /> : null}
    </g>
  );
}

/**
 * The width a node needs to show its whole name, and its whole second line, at `zoom`: its full face from FULL_ZOOM up,
 * else its 'name' face (whose second line is drawn when the node is tall enough for two).
 */
function widenNode(node: DiagramNode<NodeDraw>, zoom: number): number {
  const d = node.data;
  if (zoom >= FULL_ZOOM) {
    // At full detail no wider than NODE_W_WIDE, as in a small graph: past that a name is cut.
    return Math.min(NODE_W_WIDE, Math.ceil(Math.max(LABEL_X + textWidth(d.label, UI_12) + d.marks + LABEL_END, d.rawSub ? LABEL_X + textWidth(d.rawSub, MONO_11) + LABEL_END : 0)));
  }
  const k = zoomStep(zoom);
  const mark = d.cycle ? FAR_MARK / k + FAR_MARK_GAP : 0;
  const size = faceFor(FAR_LABEL, k);
  const subSize = faceFor(FAR_SUB, k);
  const twoLines = d.rawSub !== undefined && size + subSize + 6 / k <= node.h;
  return Math.ceil(Math.max(FAR_X + textWidth(d.label, {size}) + mark, twoLines ? FAR_X + textWidth(d.rawSub!, {size: subSize, mono: true}) : 0) + FAR_END + 2);
}

function GraphBody(p: {
  id: string; data: unknown; dsKey?: string; dir?: Dir; focus?: string; depth: number;
  /** What to say, and report, when the data has no nodes (decision D14): the source's reason makes it I_EMPTY. */
  empty: {code: string; message: string; detail?: string};
  /** The source cut the graph: it drew `returned` of `total` (modules for deps.modules, decision D16). */
  cut?: {returned: number; total: number};
}) {
  const {id, data, focus, depth} = p;
  const host = useHostActions(id);

  const clean = useMemo(() => cleanGraph(data), [data]);
  const shown = useMemo(() => {
    if (typeof clean === 'string') return undefined;
    const focused = focus !== undefined && focus !== '' && clean.nodes.some(node => node.id === focus);
    const graph = focused ? neighbourhood(clean, focus, depth) : clean;
    // Too many edges turn into a hatch: keep the heaviest.
    const edges = graph.edges.length > MAX_EDGES
      ? [...graph.edges].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, MAX_EDGES)
      : graph.edges;
    return {graph: {...graph, edges}, focused, hiddenEdges: graph.edges.length - edges.length};
  }, [clean, focus, depth]);

  // A focus that names no node (and not the scope the graph is drawn for) is drawn as the whole graph, and the
  // model hears it (decision D14): W_FOCUS, with the ids closest to what it asked for.
  const missingFocus = useMemo(() => {
    if (!shown || shown.focused || focus === undefined || focus === '' || isScope(shown.graph, focus)) return undefined;
    const nearest = nearestIds(shown.graph.nodes.map(node => node.id), focus);
    return `focus "${focus}" matches no node${nearest.length > 0 ? `; nearest: ${nearest.join(', ')}` : ''}`;
  }, [shown, focus]);
  useReportState(missingFocus !== undefined ? 'W_FOCUS' : undefined, missingFocus ?? '');

  // Spine inks (design rule D6): a key the session knows keeps its ink, the rest take the free ones in order.
  const slotKeys = useMemo(() => (shown ? shown.graph.nodes.flatMap(node => (node.slotKey !== undefined ? [node.slotKey] : [])) : []), [shown]);
  const cat = useCatSlots(SPINE_SLOTS, slotKeys);

  // No source behind it and no analyzer's kinds of node: the writer drew this graph (inline data). The names are
  // theirs: drawn whole, never shortened like a path or rewritten to tell two apart.
  const authored = p.dsKey === undefined && typeof clean !== 'string' && clean.nodes.every(node => node.kind === undefined);
  const model = useMemo(() => {
    if (!shown || shown.graph.nodes.length > MAX_NODES) return undefined;
    const {graph} = shown;
    const maxFan = Math.max(1, ...graph.nodes.map(node => Math.max(node.fanIn ?? 0, node.fanOut ?? 0)));
    const maxWeight = Math.max(0, ...graph.edges.map(edge => edge.weight ?? 0));
    const marks = (node: CleanNode) => (node.cycle ? 42 : 0) + (node.status ? 14 : 0);
    // A second line that only repeats the frame the node is drawn in ('…/src/state' in the src/state group) is left
    // out: the name gets the node to itself.
    const groupPath = new Map(graph.groups.map(group => [group.id, group.label]));
    const subOf = (node: CleanNode) => {
      if (!node.sub || node.group === undefined) return node.sub;
      const path = node.sub.replace(/\/+$/, '');
      return path === groupPath.get(node.group) || `${DIR_GROUP}${path}` === node.group ? undefined : node.sub;
    };
    // One width for the graph: what its longest name asks for, so short names make a compact picture. In a larger
    // graph a second line that is longer is cut at a separator instead of widening every node.
    const roomy = graph.nodes.length <= ROOMY_UNTIL;
    const compact = graph.nodes.length > COMPACT_FROM;
    const need = (label: string, node: CleanNode, withSub: boolean) => {
      const sub = subOf(node);
      return Math.max(LABEL_X + textWidth(label, UI_12) + marks(node) + LABEL_END, withSub && sub ? LABEL_X + textWidth(sub, MONO_11) + LABEL_END : 0);
    };
    let width = NODE_W_MIN;
    for (const node of graph.nodes) {
      width = Math.max(width, need(node.label, node, roomy));
      if (width >= NODE_W_MAX) break;
    }
    width = Math.min(NODE_W_MAX, Math.ceil(width / 4) * 4);
    // Two nodes that would read alike (two '…/scripts', two 'types.ts') say which is which (V048). Names the writer
    // typed (no source behind the graph) are theirs: never rewritten, never shortened like a path.
    const isPkg = (node: CleanNode) => node.kind === 'external' || node.kind === 'package';
    const distinct = authored
      ? {labels: new Map<string, string>(), ends: new Set<string>()}
      : distinctLabels(
        graph.nodes.map(node => ({id: node.id, label: node.label, file: node.file, pkg: isPkg(node)})),
        (label, pkg) => fitLabel(label, NODE_W_WIDE - LABEL_X - LABEL_END, UI_12, pkg),
      );
    // In a small graph a node whose name or second line needs more than the shared width is wider, up to NODE_W_WIDE.
    // A larger one keeps the shared width (wider nodes would make it open further out) and the diagram widens its
    // nodes into the width the plate has to spare (widenNode): 'create_compliance_rep…' and cut second lines no more.
    const widthOf = new Map(graph.nodes.map(node => {
      const label = distinct.labels.get(node.id) ?? node.label;
      return [node.id, roomy ? Math.min(NODE_W_WIDE, Math.max(width, Math.ceil(need(label, node, true) / 4) * 4)) : width];
    }));
    const cutOf = (node: CleanNode): Cut => (authored || isPkg(node) ? 'name' : distinct.ends.has(node.id) ? 'ends' : 'path');
    const roomOf = (node: CleanNode) => widthOf.get(node.id)! - LABEL_X - LABEL_END - marks(node);
    // Names that start alike keep, when cut, the part that tells them apart ('surface-group…​.test.ts').
    const tails = tailsOf(graph.nodes.map(node => ({id: node.id, label: distinct.labels.get(node.id) ?? node.label})));
    const nodes: Array<DiagramNode<NodeDraw>> = graph.nodes.map(node => {
      const status = node.status ? STATUS[node.status] : undefined;
      const w = widthOf.get(node.id)!;
      const room = roomOf(node);
      const place = placeOf(node);
      const label = distinct.labels.get(node.id) ?? node.label;
      const cut = cutOf(node);
      const sub = subOf(node);
      const facts = [
        node.sub,
        node.cycle ? 'in a cycle' : undefined,
        status?.label,
        node.fanIn !== undefined ? `${fmtNum(node.fanIn)} in` : undefined,
        node.fanOut !== undefined ? `${fmtNum(node.fanOut)} out` : undefined,
      ].filter(Boolean);
      return {
        id: node.id,
        w,
        h: sub && !compact ? NODE_H_SUB : NODE_H,
        group: node.group,
        entity: entityOf(node),
        // A module or directory node stands for everything under its directory, whatever file it opens.
        match: place !== undefined ? {type: node.kind === 'dir' ? 'dir' : 'module', id: node.id, path: place} : undefined,
        label: node.label,
        detail: facts.join(' · ') || undefined,
        drillable: p.dsKey !== undefined && place !== undefined,
        data: {
          label,
          cut,
          keepFrom: tails.get(node.id),
          marks: marks(node),
          rawSub: compact ? undefined : sub,
          name: cutLabel(label, room, UI_12, cut, tails.get(node.id)),
          cutFor: w,
          sub: sub && !compact ? fitSub(sub, w - LABEL_X - LABEL_END, MONO_11) : undefined,
          spine: status?.ink ?? cat.color(node.slotKey),
          external: node.kind === 'external',
          cycle: node.cycle === true,
          status,
          fanIn: Math.round(((node.fanIn ?? 0) / maxFan) * FAN_BAR),
          fanOut: Math.round(((node.fanOut ?? 0) / maxFan) * FAN_BAR),
        },
      };
    });
    // An edge between two frames runs round them, close to their lines: drawn heavy it reads as a second frame. Such
    // an edge is at most of middle weight, and a light one (weight 1) is drawn in the rule colour.
    const groupOfNode = new Map(graph.nodes.map(node => [node.id, node.group]));
    const framed = graph.groups.length > 0;
    const edges: DiagramEdge[] = graph.edges.map((edge, i) => {
      const share = maxWeight > 0 && edge.weight !== undefined ? edge.weight / maxWeight : 0;
      const across = framed && groupOfNode.get(edge.from) !== groupOfNode.get(edge.to);
      const facts = [edge.label, edge.weight !== undefined ? `weight ${fmtNum(edge.weight)}` : undefined, edge.cycle ? 'part of a cycle' : undefined, edge.dashed ? 'dynamic' : undefined];
      const width = share > 2 / 3 ? 2.25 : share > 1 / 3 ? 1.5 : 1;
      return {
        key: String(i),
        from: edge.from,
        to: edge.to,
        label: edge.label,
        dashed: edge.dashed,
        cycle: edge.cycle,
        width: across ? Math.min(1.5, width) : width,
        faint: !edge.cycle && ((maxWeight > 0 && graph.edges.length > FAINT_FROM && share <= 1 / 3) || (across && (edge.weight ?? 1) <= 1 && graph.edges.length > FAINT_FROM / 2)),
        detail: facts.filter(Boolean).join(' · ') || undefined,
      };
    });
    const groups: DiagramGroup[] = graph.groups.map(group => ({...group, drillable: p.dsKey !== undefined && group.id.startsWith(DIR_GROUP) && group.id.length > DIR_GROUP.length}));
    return {nodes, edges, groups, lodZoom: authored ? Math.max(nameZoom(nodes), wholeZoom(nodes)) : nameZoom(nodes)};
  }, [shown, cat, p.dsKey, authored]);

  // Drilling only asks the host for another scope; the plate's scope row (DataGate) is the way back (design rule D1).
  const dsKey = p.dsKey;
  const onDrill = useCallback((node: DiagramNode<NodeDraw>) => {
    if (dsKey !== undefined) host.drill(dsKey, node.id);
  }, [host, dsKey]);
  const onDrillGroup = useCallback((group: DiagramGroup) => {
    if (dsKey !== undefined) host.drill(dsKey, group.id.slice(DIR_GROUP.length));
  }, [host, dsKey]);

  if (typeof clean === 'string' || !shown) return <Redline code="E_SHAPE" id={`Graph#${id}`} message={typeof clean === 'string' ? clean : 'not a graph'} />;
  const {graph} = shown;
  if (graph.nodes.length === 0) return <Empty message={p.empty.message} detail={p.empty.detail} code={p.empty.code} />;
  if (!model) {
    return (
      <Redline
        code="E_TOO_LARGE"
        id={`Graph#${id}`}
        message={`${fmtNum(graph.nodes.length)} nodes is more than a diagram can show (${MAX_NODES}). Scope it: a path, as in Graph('deps.modules src/auth'), or focus= with depth=.`}
      />
    );
  }

  const [one, many] = LEVEL_NOUN[graph.level ?? ''] ?? ['node', 'nodes'];
  const cycles = graph.nodes.filter(node => node.cycle).length;
  const {dropped} = graph;
  // What a cut dataset drew of how many is said once, here, in the graph's own unit: '20 of 54 modules' (decision
  // D16; the gate's own 'showing ...' note is off). The external packages a module or file graph adds are counted
  // apart: they are not modules, and the Modules KPI beside the graph does not count them.
  const packages = LEVEL_NOUN[graph.level ?? ''] && graph.level !== 'package' ? graph.nodes.filter(node => node.kind === 'external').length : 0;
  const own = count(graph.nodes.length - packages, one, many);
  const extra = packages > 0 ? count(packages, 'package', 'packages') : undefined;
  const summary = [
    p.cut && p.cut.total > p.cut.returned ? `${fmtNum(p.cut.returned)} of ${count(p.cut.total, one, many)}` : own,
    extra,
    count(graph.edges.length, 'edge', 'edges'),
    // Which level the cycle marks are at, as the Cycles KPI says (decision D16).
    cycles > 0 ? `${count(cycles, one, many)} in cycles` : undefined,
    shown.focused && focus !== undefined ? `focus ${elidePath(focus, 32)} · ${count(depth, 'hop', 'hops')}` : undefined,
    focus !== undefined && focus !== '' && !shown.focused && !isScope(graph, focus) ? `focus "${fitLabel(focus, 120, MONO_11)}" not found` : undefined,
    dropped.dangling > 0 ? `${count(dropped.dangling, 'dangling edge', 'dangling edges')} dropped` : undefined,
    dropped.duplicates > 0 ? `${count(dropped.duplicates, 'duplicate', 'duplicates')} dropped` : undefined,
    dropped.invalid > 0 ? `${count(dropped.invalid, 'node without id', 'nodes without id')} dropped` : undefined,
    shown.hiddenEdges > 0 ? `${count(shown.hiddenEdges, 'light edge', 'light edges')} hidden` : undefined,
  ].filter(Boolean);
  let busiest: CleanNode | undefined;
  for (const node of graph.nodes) if (!busiest || (node.fanIn ?? 0) + (node.fanOut ?? 0) > (busiest.fanIn ?? 0) + (busiest.fanOut ?? 0)) busiest = node;
  const ariaLabel = [
    `Graph, ${[own, extra].filter(Boolean).join(', ')}, ${count(graph.edges.length, 'edge', 'edges')}`,
    cycles > 0 ? `${count(cycles, one, many)} in cycles` : undefined,
    busiest && (busiest.fanIn ?? 0) + (busiest.fanOut ?? 0) > 0 ? `most connected ${busiest.label}` : undefined,
    shown.focused ? `focused on ${focus}` : undefined,
  ].filter(Boolean).join(', ');

  return (
    <Diagram
      id={id}
      name="Graph"
      nodes={model.nodes}
      edges={model.edges}
      groups={model.groups}
      dir={p.dir}
      lod
      lodZoom={model.lodZoom}
      nodeGap={NODE_GAP}
      layerGap={LAYER_GAP}
      ariaLabel={ariaLabel}
      note={summary.join(' · ')}
      focus={shown.focused ? focus : undefined}
      anchor={busiest && (busiest.fanIn ?? 0) + (busiest.fanOut ?? 0) > 0 ? busiest.id : hubOf(graph)}
      renderNode={drawNode}
      widen={widenNode}
      onDrill={onDrill}
      onDrillGroup={onDrillGroup}
    />
  );
}

/** What the source drew of how many, when it says it cut the graph (`truncated`). */
function cutOf(state: {truncated?: {returned: number; total: number}}): {returned: number; total: number} | undefined {
  const cut = state.truncated;
  return cut && Number.isFinite(cut.total) && Number.isFinite(cut.returned) && cut.total > cut.returned ? {returned: cut.returned, total: cut.total} : undefined;
}

/** The first line of a text, or undefined. */
const firstLine = (text: unknown) => (typeof text === 'string' && text.trim() !== '' ? text.trim().split('\n', 1)[0] : undefined);

export const GraphView: GlView<typeof C.Graph> = ({id, props}) => {
  const state = useDataset<GraphData>(props.data);
  const depth = Math.max(1, Math.min(4, Math.round(props.depth ?? 1)));
  // A graph with no nodes: the source's reason ('no import cycles') is a truthful answer, nothing else is.
  const reason = state.ds ? (firstLine(state.ds.note) ?? (Array.isArray(state.ds.warnings) ? state.ds.warnings.map(firstLine).find(Boolean) : undefined)) : undefined;
  const empty = reason !== undefined ? {code: emptyCodeOf(state), message: reason, detail: state.ds?.source} : {code: 'W_EMPTY', message: 'no nodes to draw'};
  return (
    <DataGate state={state} id={`Graph#${id}`} marginal={false}>
      {data => (
        <GraphBody
          {...(cutOf(state) ? {cut: cutOf(state)} : {})}
          id={id}
          data={data}
          dsKey={state.ds?.$ds}
          dir={props.dir === 'TB' || props.dir === 'LR' ? props.dir : undefined}
          focus={props.focus || undefined}
          depth={depth}
          empty={empty}
        />
      )}
    </DataGate>
  );
};
