// Graph: a node-link diagram of modules, files or packages on the dot grid (design 5.6).
import type * as C from '@glimpse/catalog';
import {PATHS, parseFileLoc, type EntityRef, type GraphData, type GraphEdge, type GraphGroup, type GraphNode, type SurfaceMeta} from '@glimpse/catalog';
import {useCallback, useMemo, type ReactNode} from 'react';
import {DataGate, Empty, Redline, catVar, fmtNum, useDataset, useHostActions, usePath, type GlView} from '../../kit/index.ts';
import {Diagram, MONO_11, UI_12, fitText, type DiagramEdge, type DiagramGroup, type DiagramNode, type Dir, type NodeFlags} from './edgekit/index.ts';
import css from './Graph.module.css';

const NODE_W = 168;
const NODE_H = 28;
const NODE_H_SUB = 40;
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

interface NodeDraw {
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

function GraphBody(p: {id: string; data: unknown; dsKey?: string; dir: Dir; focus?: string; depth: number; sized: boolean}) {
  const {id, data, focus, depth} = p;
  const slots = usePath<SurfaceMeta['slots']>(PATHS.metaSlots);
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

  const model = useMemo(() => {
    if (!shown || shown.graph.nodes.length > MAX_NODES) return undefined;
    const {graph} = shown;
    const maxFan = Math.max(1, ...graph.nodes.map(node => Math.max(node.fanIn ?? 0, node.fanOut ?? 0)));
    const maxWeight = Math.max(0, ...graph.edges.map(edge => edge.weight ?? 0));
    const nodes: Array<DiagramNode<NodeDraw>> = graph.nodes.map(node => {
      const status = node.status ? STATUS[node.status] : undefined;
      const slot = (node.slotKey !== undefined && (slots?.module?.[node.slotKey] || slots?.lang?.[node.slotKey])) || 0;
      const room = NODE_W - 13 - 8 - (node.cycle ? 36 : 0) - (status ? 14 : 0);
      const facts = [
        node.sub,
        node.cycle ? 'in a cycle' : undefined,
        status?.label,
        node.fanIn !== undefined ? `${fmtNum(node.fanIn)} in` : undefined,
        node.fanOut !== undefined ? `${fmtNum(node.fanOut)} out` : undefined,
      ].filter(Boolean);
      return {
        id: node.id,
        w: NODE_W,
        h: node.sub ? NODE_H_SUB : NODE_H,
        group: node.group,
        entity: entityOf(node),
        label: node.label,
        detail: facts.join(' · ') || undefined,
        drillable: p.dsKey !== undefined && (node.kind === 'cluster' || node.kind === 'dir'),
        data: {
          name: fitText(node.label, room, UI_12),
          sub: node.sub ? fitText(node.sub, NODE_W - 13 - 8, MONO_11) : undefined,
          spine: status?.ink ?? catVar(slot),
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
        detail: facts.filter(Boolean).join(' · ') || undefined,
      };
    });
    const groups: DiagramGroup[] = graph.groups;
    return {nodes, edges, groups};
  }, [shown, slots, p.dsKey]);

  const dsKey = p.dsKey;
  const onDrill = useCallback((node: DiagramNode<NodeDraw>) => {
    if (dsKey !== undefined) host.drill(dsKey, node.id);
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
    shown.focused ? `focus ${focus} · ${count(depth, 'hop', 'hops')}` : undefined,
    focus !== undefined && focus !== '' && !shown.focused ? `focus "${fitText(focus, 120, MONO_11)}" not found` : undefined,
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
      sized={p.sized}
      ariaLabel={ariaLabel}
      note={summary.join(' · ')}
      focus={shown.focused ? focus : undefined}
      renderNode={drawNode}
      onDrill={onDrill}
    />
  );
}

export const GraphView: GlView<typeof C.Graph> = ({id, props}) => {
  const state = useDataset<GraphData>(props.data);
  const depth = Math.max(1, Math.min(4, Math.round(props.depth ?? 1)));
  return (
    <DataGate state={state} id={`Graph#${id}`}>
      {data => <GraphBody id={id} data={data} dsKey={state.ds?.$ds} dir={props.dir === 'TB' ? 'TB' : 'LR'} focus={props.focus || undefined} depth={depth} sized={props.size != null} />}
    </DataGate>
  );
};
