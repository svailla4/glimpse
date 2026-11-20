// Graph: a node-link diagram of modules, files or packages on the dot grid (design 5.6).
import type * as C from '@glimpse/catalog';
import {parseFileLoc, type EntityRef, type GraphData, type GraphEdge, type GraphGroup, type GraphNode} from '@glimpse/catalog';
import {useCallback, useMemo, type ReactNode} from 'react';
import {DataGate, Empty, Redline, elidePath, fmtNum, useCatSlots, useDataset, useHostActions, type GlView} from '../../kit/index.ts';
import {Diagram, MONO_11, UI_12, fitText, textWidth, type DiagramEdge, type DiagramGroup, type DiagramNode, type Dir, type Face, type NodeFlags} from './edgekit/index.ts';
import css from './Graph.module.css';

/** Nodes of one graph share a width: what the longest label needs, between these two. */
const NODE_W_MIN = 112;
const NODE_W_MAX = 168;
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
const NODESEP = 16;
const RANKSEP = 40;
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
 * `…/core/web_core`, not `typescript/co…`.
 */
export function fitLabel(text: string, maxWidth: number, face: Face): string {
  if (textWidth(text, face) <= maxWidth) return text;
  // A path, not a sentence that happens to hold a slash ("12 files, 3 in/out").
  if (text.includes('/') && !text.includes(' ')) {
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

/** A face size that is at least `px` on screen at zoom `k`, rounded up so no serialisation takes it below. */
const faceFor = (px: number, k: number) => Math.ceil((px / k) * 100) / 100;

/** The directory a node stands for, when it stands for one: a module ('src/auth', 'src/*' for the rest of src) or a directory. */
function placeOf(node: CleanNode): string | undefined {
  if (node.kind !== 'cluster' && node.kind !== 'dir') return undefined;
  if (node.id === '(root)' || node.id === '.') return '';
  return (node.id.endsWith('/*') ? node.id.slice(0, -2) : node.id).replace(/\/+$/, '');
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

interface NodeDraw {
  /** The full label, for the cut a zoomed-out node makes itself. */
  label: string;
  rawSub?: string;
  name: string;
  sub?: string;
  spine: string;
  external: boolean;
  cycle: boolean;
  status?: {glyph: string; label: string; ink: string};
  fanIn: number;
  fanOut: number;
}

function drawNode(node: DiagramNode<NodeDraw>, flags: NodeFlags): ReactNode {
  const d = node.data;
  if (flags.lod !== 'full') {
    // Zoomed out: the name (and the second line while two still fit) in a face that stays 10 px or more on screen;
    // further out the box and its spine.
    const size = faceFor(FAR_LABEL, flags.k);
    const subSize = faceFor(FAR_SUB, flags.k);
    const mark = 7 / flags.k;
    const spine = flags.lod === 'box' ? 10 : 5;
    const x = spine + 5;
    const room = node.w - x - 4;
    const twoLines = flags.lod === 'name' && d.rawSub !== undefined && size + subSize + 6 / flags.k <= node.h;
    return (
      <g className={css.body} data-lod={flags.lod} data-selected={flags.selected || undefined} data-focus={flags.focus || undefined} data-external={d.external || undefined}>
        <rect className={css.box} width={node.w} height={node.h} />
        <rect className={css.spine} width={spine} height={node.h} style={{fill: d.spine}} />
        {flags.lod === 'name' ? (
          <text className={css.far} x={x} y={twoLines ? node.h / 2 - subSize / 2 - 1 / flags.k : node.h / 2} style={{fontSize: size}}>
            {fitLabel(d.label, room - (d.cycle ? mark + 4 : 0), {size})}
          </text>
        ) : null}
        {twoLines ? <text className={css.farSub} x={x} y={node.h / 2 + size / 2 + 1 / flags.k} style={{fontSize: subSize}}>{fitSub(d.rawSub!, room, {size: subSize, mono: true})}</text> : null}
        {d.cycle ? <rect className={css.cycleMark} x={node.w - mark - 3} y={twoLines ? node.h / 2 - subSize / 2 - 1 / flags.k - mark / 2 : (node.h - mark) / 2} width={mark} height={mark} /> : null}
      </g>
    );
  }
  const statusX = node.w - 8;
  const cycleX = statusX - (d.status ? 14 : 0);
  return (
    <g className={css.body} data-selected={flags.selected || undefined} data-focus={flags.focus || undefined} data-external={d.external || undefined}>
      <rect className={css.box} width={node.w} height={node.h} />
      <rect className={css.spine} width={4} height={node.h} style={{fill: d.spine}} />
      <text className={css.name} x={13} y={d.sub ? 17 : node.h / 2 + 4}>{d.name}</text>
      {d.sub ? <text className={css.sub} x={13} y={31}>{d.sub}</text> : null}
      {d.cycle ? <text className={css.cycle} x={cycleX} y={13}>CYCLE</text> : null}
      {d.status ? <text className={css.status} x={statusX} y={14} style={{fill: d.status.ink}}>{d.status.glyph}</text> : null}
      {d.fanIn > 0 ? <rect className={css.fanIn} x={4} y={node.h - 3} width={d.fanIn} height={3} /> : null}
      {d.fanOut > 0 ? <rect className={css.fanOut} x={node.w - d.fanOut} y={node.h - 3} width={d.fanOut} height={3} /> : null}
    </g>
  );
}

function GraphBody(p: {id: string; data: unknown; dsKey?: string; dir?: Dir; focus?: string; depth: number; sized: boolean}) {
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

  // Spine inks (design rule D6): a key the session knows keeps its ink, the rest take the free ones in order.
  const slotKeys = useMemo(() => (shown ? shown.graph.nodes.flatMap(node => (node.slotKey !== undefined ? [node.slotKey] : [])) : []), [shown]);
  const cat = useCatSlots(SPINE_SLOTS, slotKeys);

  const model = useMemo(() => {
    if (!shown || shown.graph.nodes.length > MAX_NODES) return undefined;
    const {graph} = shown;
    const maxFan = Math.max(1, ...graph.nodes.map(node => Math.max(node.fanIn ?? 0, node.fanOut ?? 0)));
    const maxWeight = Math.max(0, ...graph.edges.map(edge => edge.weight ?? 0));
    const marks = (node: CleanNode) => (node.cycle ? 36 : 0) + (node.status ? 14 : 0);
    // One width for the graph: what its longest name asks for, so short names make a compact picture. In a larger
    // graph a second line that is longer is cut at a separator instead of widening every node.
    const roomy = graph.nodes.length <= ROOMY_UNTIL;
    let width = NODE_W_MIN;
    for (const node of graph.nodes) {
      width = Math.max(width, LABEL_X + textWidth(node.label, UI_12) + marks(node) + LABEL_END, roomy && node.sub ? LABEL_X + textWidth(node.sub, MONO_11) + LABEL_END : 0);
      if (width >= NODE_W_MAX) break;
    }
    width = Math.min(NODE_W_MAX, Math.ceil(width / 4) * 4);
    const compact = graph.nodes.length > COMPACT_FROM;
    const nodes: Array<DiagramNode<NodeDraw>> = graph.nodes.map(node => {
      const status = node.status ? STATUS[node.status] : undefined;
      const room = width - LABEL_X - LABEL_END - marks(node);
      const place = placeOf(node);
      const facts = [
        node.sub,
        node.cycle ? 'in a cycle' : undefined,
        status?.label,
        node.fanIn !== undefined ? `${fmtNum(node.fanIn)} in` : undefined,
        node.fanOut !== undefined ? `${fmtNum(node.fanOut)} out` : undefined,
      ].filter(Boolean);
      return {
        id: node.id,
        w: width,
        h: node.sub && !compact ? NODE_H_SUB : NODE_H,
        group: node.group,
        entity: entityOf(node),
        // A module or directory node stands for everything under its directory, whatever file it opens.
        match: place !== undefined ? {type: node.kind === 'dir' ? 'dir' : 'module', id: node.id, path: place} : undefined,
        label: node.label,
        detail: facts.join(' · ') || undefined,
        drillable: p.dsKey !== undefined && (node.kind === 'cluster' || node.kind === 'dir'),
        data: {
          label: node.label,
          rawSub: compact ? undefined : node.sub,
          name: fitLabel(node.label, room, UI_12),
          sub: node.sub && !compact ? fitSub(node.sub, width - LABEL_X - LABEL_END, MONO_11) : undefined,
          spine: status?.ink ?? cat.color(node.slotKey),
          external: node.kind === 'external',
          cycle: node.cycle === true,
          status,
          fanIn: Math.round(((node.fanIn ?? 0) / maxFan) * FAN_BAR),
          fanOut: Math.round(((node.fanOut ?? 0) / maxFan) * FAN_BAR),
        },
      };
    });
    const edges: DiagramEdge[] = graph.edges.map((edge, i) => {
      const share = maxWeight > 0 && edge.weight !== undefined ? edge.weight / maxWeight : 0;
      const facts = [edge.label, edge.weight !== undefined ? `weight ${fmtNum(edge.weight)}` : undefined, edge.cycle ? 'part of a cycle' : undefined, edge.dashed ? 'dynamic' : undefined];
      return {
        key: String(i),
        from: edge.from,
        to: edge.to,
        label: edge.label,
        dashed: edge.dashed,
        cycle: edge.cycle,
        width: share > 2 / 3 ? 2.25 : share > 1 / 3 ? 1.5 : 1,
        faint: maxWeight > 0 && graph.edges.length > FAINT_FROM && share <= 1 / 3 && !edge.cycle,
        detail: facts.filter(Boolean).join(' · ') || undefined,
      };
    });
    const groups: DiagramGroup[] = graph.groups.map(group => ({...group, drillable: p.dsKey !== undefined && group.id.startsWith(DIR_GROUP) && group.id.length > DIR_GROUP.length}));
    return {nodes, edges, groups};
  }, [shown, cat, p.dsKey]);

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
  if (graph.nodes.length === 0) return <Empty message="no nodes to draw" />;
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
  const summary = [
    count(graph.nodes.length, one, many),
    count(graph.edges.length, 'edge', 'edges'),
    cycles > 0 ? `${fmtNum(cycles)} in cycles` : undefined,
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
    `Graph, ${count(graph.nodes.length, one, many)}, ${count(graph.edges.length, 'edge', 'edges')}`,
    cycles > 0 ? `${cycles} in cycles` : undefined,
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
      wrap
      lod
      nodesep={NODESEP}
      ranksep={RANKSEP}
      sized={p.sized}
      ariaLabel={ariaLabel}
      note={summary.join(' · ')}
      focus={shown.focused ? focus : undefined}
      anchor={busiest && (busiest.fanIn ?? 0) + (busiest.fanOut ?? 0) > 0 ? busiest.id : hubOf(graph)}
      renderNode={drawNode}
      onDrill={onDrill}
      onDrillGroup={onDrillGroup}
    />
  );
}

export const GraphView: GlView<typeof C.Graph> = ({id, props}) => {
  const state = useDataset<GraphData>(props.data);
  const depth = Math.max(1, Math.min(4, Math.round(props.depth ?? 1)));
  return (
    <DataGate state={state} id={`Graph#${id}`}>
      {data => <GraphBody id={id} data={data} dsKey={state.ds?.$ds} dir={props.dir === 'TB' || props.dir === 'LR' ? props.dir : undefined} focus={props.focus || undefined} depth={depth} sized={props.size != null} />}
    </DataGate>
  );
};
