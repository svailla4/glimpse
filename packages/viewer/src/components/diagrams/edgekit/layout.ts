// Layered layout with dagre, and the orthogonal routes that follow from it. Pure: the React side (useLayout.ts)
// decides when to run it.
import {Graph, layout as dagreLayout} from '@dagrejs/dagre';
import {
  bandsOf, channelBetween, inBand, labelAnchor, routeEdge, routeLoop,
  type Box, type Dir, type Point, type Shape,
} from './geometry.ts';

export interface LayoutNode { id: string; w: number; h: number; shape?: Shape; group?: string }
export interface LayoutEdge {
  /** Unique within the diagram. */
  key: string;
  from: string;
  to: string;
  /** Size of the label plate, when the edge has a label: the layout keeps room for it. */
  label?: {w: number; h: number};
  fromPort?: number;
  toPort?: number;
}
export interface LayoutGroup { id: string; parent?: string }
export interface LayoutSpec {
  dir: Dir;
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  groups?: readonly LayoutGroup[];
  nodesep?: number;
  ranksep?: number;
}

export interface Route {
  /** Corner points, source to target. */
  points: Point[];
  /** Centre of the label plate. */
  label?: Point;
}
export interface Laid {
  boxes: Map<string, Box>;
  routes: Map<string, Route>;
}

/** Everything the layout depends on, as one string: equal signatures give equal layouts. */
export function signatureOf(spec: LayoutSpec): string {
  const parts: string[] = [spec.dir, String(spec.nodesep ?? ''), String(spec.ranksep ?? '')];
  for (const node of spec.nodes) parts.push(`${node.id}\u0001${node.w}x${node.h}\u0001${node.shape ?? ''}\u0001${node.group ?? ''}`);
  parts.push('\u0002');
  for (const edge of spec.edges) parts.push(`${edge.from}\u0001${edge.to}\u0001${edge.label ? `${edge.label.w}x${edge.label.h}` : ''}\u0001${edge.fromPort ?? ''}\u0001${edge.toPort ?? ''}`);
  parts.push('\u0002');
  for (const group of spec.groups ?? []) parts.push(`${group.id}\u0001${group.parent ?? ''}`);
  return parts.join('\u0003');
}

const NODE = 'n:';
const GROUP = 'g:';

function runDagre(spec: LayoutSpec, compound: boolean): {boxes: Map<string, Box>; edges: Map<string, {points: Point[]; label?: Point}>} {
  const g = new Graph({compound, multigraph: true});
  g.setGraph({rankdir: spec.dir, nodesep: spec.nodesep ?? 24, ranksep: spec.ranksep ?? 56, edgesep: 12, marginx: 0, marginy: 0});
  g.setDefaultEdgeLabel(() => ({}));
  const known = new Set<string>();
  for (const node of spec.nodes) {
    known.add(node.id);
    g.setNode(NODE + node.id, {width: node.w, height: node.h});
  }
  if (compound) {
    const groups = new Map((spec.groups ?? []).map(group => [group.id, group]));
    const used = new Set<string>();
    for (const node of spec.nodes) {
      // Walk up the ancestors once per group; `used` stops both repeats and parent cycles.
      for (let id = node.group; id !== undefined && groups.has(id) && !used.has(id); id = groups.get(id)!.parent) used.add(id);
    }
    for (const id of used) g.setNode(GROUP + id, {});
    for (const id of used) {
      const parent = groups.get(id)!.parent;
      if (parent !== undefined && used.has(parent) && !isAncestor(groups, id, parent)) g.setParent(GROUP + id, GROUP + parent);
    }
    for (const node of spec.nodes) if (node.group !== undefined && used.has(node.group)) g.setParent(NODE + node.id, GROUP + node.group);
  }
  for (const edge of spec.edges) {
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to)) continue;
    g.setEdge(NODE + edge.from, NODE + edge.to, edge.label ? {width: edge.label.w, height: edge.label.h, labelpos: 'c'} : {}, edge.key);
  }
  dagreLayout(g);

  const boxes = new Map<string, Box>();
  for (const node of spec.nodes) {
    const at = g.node(NODE + node.id) as {x?: number; y?: number} | undefined;
    boxes.set(node.id, {x: (at?.x ?? 0) - node.w / 2, y: (at?.y ?? 0) - node.h / 2, w: node.w, h: node.h});
  }
  const edges = new Map<string, {points: Point[]; label?: Point}>();
  for (const edge of spec.edges) {
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to)) continue;
    const out = g.edge(NODE + edge.from, NODE + edge.to, edge.key) as {points?: Point[]; x?: number; y?: number} | undefined;
    const points = (out?.points ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    const label = edge.label && typeof out?.x === 'number' && typeof out.y === 'number' ? {x: out.x, y: out.y} : undefined;
    edges.set(edge.key, {points, label});
  }
  return {boxes, edges};
}

/** True when `candidate` is `id` itself or sits below it, so making it the parent of `id` would close a loop. */
function isAncestor(groups: ReadonlyMap<string, LayoutGroup>, id: string, candidate: string): boolean {
  const seen = new Set<string>();
  for (let at: string | undefined = candidate; at !== undefined && !seen.has(at); at = groups.get(at)?.parent) {
    if (at === id) return true;
    seen.add(at);
  }
  return false;
}

/**
 * Positions every node and routes every edge. Edges run with the flow from the middle of one side to the middle of
 * the next rank's facing side, turning in the gap between ranks; long edges keep the layout's waypoints inside the
 * ranks they cross. Throws when dagre cannot lay the graph out at all.
 */
export function layoutDiagram(spec: LayoutSpec): Laid {
  const grouped = spec.nodes.some(node => node.group !== undefined) && (spec.groups?.length ?? 0) > 0;
  let raw: ReturnType<typeof runDagre>;
  try {
    raw = runDagre(spec, grouped);
  } catch (error) {
    // dagre's cluster support fails on some nestings; the flat layout still draws every node and edge.
    if (!grouped) throw error;
    raw = runDagre(spec, false);
  }
  const {boxes} = raw;
  const bands = bandsOf(boxes.values(), spec.dir);
  const channel = channelBetween(bands);
  const shapes = new Map(spec.nodes.map(node => [node.id, node.shape]));
  const main = (p: Point) => (spec.dir === 'LR' ? p.x : p.y);

  const routes = new Map<string, Route>();
  for (const edge of spec.edges) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) continue;
    if (edge.from === edge.to) {
      const points = routeLoop(a, spec.dir);
      routes.set(edge.key, {points, label: edge.label ? points[2] : undefined});
      continue;
    }
    const laid = raw.edges.get(edge.key);
    // dagre puts one point on every rank an edge crosses. The ones inside a rank of nodes steer the edge around
    // those nodes; the ones in the gaps (and the two on the node borders) are replaced by the orthogonal turns.
    const via = (laid?.points ?? []).slice(1, -1).filter(p => inBand(bands, main(p)));
    const points = routeEdge(a, b, {
      dir: spec.dir, via, channel,
      fromShape: shapes.get(edge.from), toShape: shapes.get(edge.to), fromPort: edge.fromPort, toPort: edge.toPort,
    });
    routes.set(edge.key, {points, label: edge.label ? labelAnchor(points, spec.dir, laid?.label) : undefined});
  }
  return {boxes, routes};
}
