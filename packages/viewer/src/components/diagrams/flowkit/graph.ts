// What a diagram asks ELK for, and what it does with the answer (decision D19). Pure functions on the page side
// (about 1 ms at the 150-node cap); ELK itself runs in the worker (elk.ts).
//   toElk(spec)        nodes, edges and groups -> an ELK JSON graph: layered, orthogonal edges, one run over the
//                      whole hierarchy (a group is a compound node, sized around its children; an edge that leaves a
//                      group is routed by the same pass, so it never cuts through a group it does not belong to),
//                      fixed ports for table columns, edge labels placed on their edges. Cycles are broken where the
//                      caller's order says (a loop back to the first state runs upwards, not the main path). Parts
//                      that share no edge and no group are laid out apart and packed in rows, the largest first
//                      (isolated modules no longer stack in the first layer). A long flow can be wrapped into rows
//                      of a given shape (`wrap`).
//   fromElk(laid, spec) the laid-out graph -> absolute boxes, group frames and edge routes in one coordinate space
import type {ElkExtendedEdge, ElkLabel, ElkNode, ElkPort, LayoutOptions} from 'elkjs/lib/elk-api.js';
import {boundsOf, clipToShapes, type Box, type Dir, type Point, type Shape} from './geometry.ts';

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
  shape?: Shape;
  group?: string;
}
export interface LayoutEdge {
  /** Unique within the diagram. */
  key: string;
  from: string;
  to: string;
  /** Size of the label plate, when the edge has a label. */
  label?: {w: number; h: number};
  /** Where on its node the edge attaches, from the top of the node (a column row of a table): a fixed port. */
  fromPort?: number;
  toPort?: number;
}
export interface LayoutGroup {
  id: string;
  parent?: string;
  /** The width its label needs: the frame is never narrower. */
  minWidth?: number;
}
export interface LayoutSpec {
  dir: Dir;
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  groups?: readonly LayoutGroup[];
  /** Between nodes of one layer, and between layers. */
  nodeGap?: number;
  layerGap?: number;
  /**
   * True for a dense diagram: the edges that leave (or enter) a node by the same side share their first (or last)
   * stretch, and edges run closer together, so many edges do not each take a lane of their own across the drawing.
   */
  dense?: boolean;
  /**
   * Width over height to wrap the flow to: a chain too long for its plate is cut between layers and the pieces are
   * placed one under the other (left to right) or side by side (top to bottom), each still in the flow's direction.
   */
  wrap?: number;
  /** With `wrap`: cut also where several edges cross (only for a diagram without cycles; see layeredOptions). */
  wrapAny?: boolean;
  /** Width over height that parts with no edge between them are packed to. Default 1.6. */
  aspect?: number;
}

export interface Route {
  /** Corner points, source to target, in diagram coordinates. */
  points: Point[];
  /** The label plate, top-left corner and size, where ELK put it. */
  label?: Box;
}
export interface Laid {
  dir: Dir;
  /** Everything drawn: nodes, frames, routes and labels. */
  bounds: Box;
  boxes: Map<string, Box>;
  /** Group frames, outer groups first. */
  frames: Map<string, Box>;
  routes: Map<string, Route>;
}

/** Room above a group's members for its label, and around them. */
export const GROUP_PAD = {top: 28, side: 12, bottom: 12};

const ELK_DIR: Record<Dir, string> = {LR: 'RIGHT', RL: 'LEFT', TB: 'DOWN', BT: 'UP'};
const ROOT = '\u0000root';

/** The groups that hold at least one node (directly or through a nested group), each with a parent that exists and no parent cycles. */
function liveGroups(spec: LayoutSpec): Map<string, string | undefined> {
  const byId = new Map((spec.groups ?? []).map(group => [group.id, group]));
  const parentOf = new Map<string, string | undefined>();
  for (const group of byId.values()) {
    // A parent chain that comes back to the group is cut where it does.
    let parent = group.parent !== undefined && byId.has(group.parent) && group.parent !== group.id ? group.parent : undefined;
    const seen = new Set([group.id]);
    for (let at = parent; at !== undefined; at = byId.get(at)?.parent) {
      if (seen.has(at)) {
        parent = undefined;
        break;
      }
      seen.add(at);
    }
    parentOf.set(group.id, parent);
  }
  const live = new Map<string, string | undefined>();
  for (const node of spec.nodes) {
    for (let at = node.group; at !== undefined && parentOf.has(at) && !live.has(at); at = parentOf.get(at)) live.set(at, parentOf.get(at));
  }
  return live;
}

/** Prefix of the ids of the boxes that hold one connected part each when a diagram has several (opaque to callers). */
const PART = '\u0000c';
/** Between packed parts. */
const PART_GAP = 32;

/** The layered options of one run: the whole diagram, or one of its connected parts. */
function layeredOptions(spec: LayoutSpec, labelled: boolean): LayoutOptions {
  const nodeGap = spec.nodeGap ?? 24;
  const layerGap = spec.layerGap ?? 44;
  return {
    'elk.algorithm': 'layered',
    'elk.direction': ELK_DIR[spec.dir],
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    'elk.spacing.nodeNode': String(nodeGap),
    // A centre label is a layer of its own between the two layers its edge joins: with labels the gap on each side of
    // a label is half the usual one, so a labelled gap is the usual gap plus the label, not two gaps and the label
    // (a TB graph of eight nodes and seven labels was 62% taller than without them; now 24%).
    'elk.layered.spacing.nodeNodeBetweenLayers': String(labelled ? Math.round(layerGap / 2) : layerGap),
    'elk.spacing.edgeNode': spec.dense ? '10' : '14',
    'elk.spacing.edgeEdge': spec.dense ? '5' : '8',
    'elk.layered.spacing.edgeNodeBetweenLayers': spec.dense ? '10' : '14',
    'elk.layered.spacing.edgeEdgeBetweenLayers': spec.dense ? '5' : '8',
    ...(spec.dense ? {'elk.layered.mergeEdges': 'true'} : {}),
    'elk.spacing.edgeLabel': '3',
    'elk.spacing.componentComponent': String(Math.max(layerGap, 32)),
    'elk.edgeLabels.placement': 'CENTER',
    // Keep the caller's order where it costs no crossings: similar data lays out alike.
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    // A cycle is broken where the caller's order says: the edge that goes back to an earlier node runs against the
    // flow. ELK's default broke 'Idle -> Running -> Stopped -> Idle' at the first edge and drew Idle at the bottom.
    // (Not MODEL_ORDER: that one also turns round every edge, in a cycle or not, that runs to an earlier node.)
    'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
    // Cut only between layers that one edge alone joins: a chain wraps into rows that read on. Cut anywhere (wrapAny),
    // a chart with loops became a maze of edges running back across the rows; a diagram without cycles reads fine.
    ...(spec.wrap !== undefined && spec.wrap > 0
      ? {'elk.layered.wrapping.strategy': spec.wrapAny ? 'MULTI_EDGE' : 'SINGLE_EDGE', 'elk.aspectRatio': String(Math.round(spec.wrap * 100) / 100)}
      : {}),
  } satisfies LayoutOptions;
}

/**
 * The connected parts of a diagram, in node order, largest first: nodes joined by an edge, or in the same outermost
 * group, are in one part. Each part is a list of node indexes.
 */
function partsOf(spec: LayoutSpec, outermost: (node: LayoutNode) => string | undefined): number[][] {
  const index = new Map(spec.nodes.map((node, i) => [node.id, i]));
  const up = spec.nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (up[i] !== i) {
      up[i] = up[up[i]!]!;
      i = up[i]!;
    }
    return i;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) up[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const edge of spec.edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a !== undefined && b !== undefined) join(a, b);
  }
  const firstIn = new Map<string, number>();
  spec.nodes.forEach((node, i) => {
    const group = outermost(node);
    if (group === undefined) return;
    const first = firstIn.get(group);
    if (first === undefined) firstIn.set(group, i);
    else join(first, i);
  });
  const parts = new Map<number, number[]>();
  spec.nodes.forEach((_, i) => {
    const root = find(i);
    const list = parts.get(root);
    if (list) list.push(i);
    else parts.set(root, [i]);
  });
  // Largest first; a tie keeps the caller's order (the part of the earlier node first).
  return [...parts.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
}

/** The outermost group a node is drawn in, of the groups that hold a node. */
function outermostOf(groups: ReadonlyMap<string, string | undefined>): (node: LayoutNode) => string | undefined {
  return node => {
    let top: string | undefined;
    for (let at = node.group !== undefined && groups.has(node.group) ? node.group : undefined; at !== undefined; at = groups.get(at)) top = at;
    return top;
  };
}

/** True when following the edges from some node can lead back to it (a self-loop does not count). */
export function hasCycle(spec: Pick<LayoutSpec, 'nodes' | 'edges'>): boolean {
  const next = new Map<string, string[]>();
  for (const edge of spec.edges) if (edge.from !== edge.to) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const state = new Map<string, 1 | 2>();
  for (const node of spec.nodes) {
    if (state.has(node.id)) continue;
    // Depth first without recursion: a stack of (node, index of its next edge).
    const stack: Array<[string, number]> = [[node.id, 0]];
    state.set(node.id, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const out = next.get(top[0]) ?? [];
      if (top[1] >= out.length) {
        state.set(top[0], 2);
        stack.pop();
        continue;
      }
      const to = out[top[1]++]!;
      const seen = state.get(to);
      if (seen === 1) return true;
      if (seen === undefined) {
        state.set(to, 1);
        stack.push([to, 0]);
      }
    }
  }
  return false;
}

/** How many parts the diagram is laid out in: groups of nodes that share no edge and no group with the others. */
export function partCount(spec: LayoutSpec): number {
  return spec.nodes.length > 1 ? partsOf(spec, outermostOf(liveGroups(spec))).length : spec.nodes.length;
}

export function toElk(spec: LayoutSpec): ElkNode {
  const groups = liveGroups(spec);
  const outermost = outermostOf(groups);
  const parts = spec.nodes.length > 1 ? partsOf(spec, outermost) : [spec.nodes.map((_, i) => i)];
  const labelledEdge = (edge: LayoutEdge) => edge.label !== undefined;
  const single = parts.length <= 1;
  // One part: one layered run at the root. Several: each part with more than one node is a layered run of its own in a
  // box, and the root packs those boxes and the lone nodes in rows, the largest part first (ELK's own packing of
  // disconnected parts does not apply when the run includes the groups' children).
  const root: ElkNode = single
    ? {id: ROOT, layoutOptions: {...layeredOptions(spec, spec.edges.some(labelledEdge)), 'elk.json.edgeCoords': 'ROOT'}, children: [], edges: []}
    : {
      id: ROOT,
      layoutOptions: {
        'elk.algorithm': 'rectpacking',
        'elk.aspectRatio': String(Math.round((spec.aspect ?? 1.6) * 100) / 100),
        'elk.spacing.nodeNode': String(PART_GAP),
        'elk.padding': '[top=0,left=0,bottom=0,right=0]',
        // Edge sections and labels in root coordinates, whichever box or group an edge belongs to.
        'elk.json.edgeCoords': 'ROOT',
      } satisfies LayoutOptions,
      children: [],
    };
  const minWidth = new Map((spec.groups ?? []).map(group => [group.id, group.minWidth]));
  const elkGroups = new Map<string, ElkNode>();
  for (const id of groups.keys()) {
    const least = minWidth.get(id);
    elkGroups.set(id, {
      id,
      children: [],
      layoutOptions: {
        'elk.direction': ELK_DIR[spec.dir],
        'elk.padding': `[top=${GROUP_PAD.top},left=${GROUP_PAD.side},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.side}]`,
        ...(least !== undefined && least > 0
          ? {'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${Math.ceil(least)}, 0)`}
          : {}),
      },
    });
  }
  // Where each node's outermost element goes: the root, or the box of its part.
  const containerOf = new Map<string, ElkNode>();
  const loose = new Set<string>();
  if (!single) {
    parts.forEach((part, k) => {
      const ids = part.map(i => spec.nodes[i]!.id);
      const own = new Set(ids);
      const partEdges = spec.edges.filter(edge => own.has(edge.from));
      if (part.length === 1 && outermost(spec.nodes[part[0]!]!) === undefined && partEdges.length === 0) {
        // A lone node is packed as it is.
        loose.add(ids[0]!);
        return;
      }
      const box: ElkNode = {id: `${PART}${k}`, layoutOptions: layeredOptions(spec, partEdges.some(labelledEdge)), children: [], edges: []};
      root.children!.push(box);
      for (const id of ids) containerOf.set(id, box);
    });
  }
  const containerOfGroup = new Map<string, ElkNode>();
  for (const node of spec.nodes) {
    const top = outermost(node);
    if (top !== undefined && !containerOfGroup.has(top)) containerOfGroup.set(top, containerOf.get(node.id) ?? root);
  }
  const parentNode = (group: string | undefined) => (group !== undefined ? elkGroups.get(group) : undefined) ?? root;
  // Outer groups before inner ones does not matter to ELK; the order of the caller's list does (model order).
  for (const [id, parent] of groups) {
    const into = parent !== undefined ? parentNode(parent) : (containerOfGroup.get(id) ?? root);
    into.children!.push(elkGroups.get(id)!);
  }

  // Ports: one per side per row a relation attaches to. Their ids are opaque, so no node id can collide with one.
  const ports = new Map<string, {west: Map<number, string>; east: Map<number, string>}>();
  let portCount = 0;
  const portOf = (node: string, y: number, side: 'west' | 'east'): string => {
    let entry = ports.get(node);
    if (!entry) {
      entry = {west: new Map(), east: new Map()};
      ports.set(node, entry);
    }
    const known = entry[side].get(y);
    if (known !== undefined) return known;
    const id = `\u0000p${portCount++}`;
    entry[side].set(y, id);
    return id;
  };
  const sides = isForward(spec.dir) ? (['east', 'west'] as const) : (['west', 'east'] as const);
  const edges: ElkExtendedEdge[] = spec.edges.map((edge, i) => {
    const source = edge.fromPort !== undefined ? portOf(edge.from, edge.fromPort, sides[0]) : edge.from;
    const target = edge.toPort !== undefined ? portOf(edge.to, edge.toPort, sides[1]) : edge.to;
    const labels: ElkLabel[] | undefined = edge.label
      // On its edge, not beside it: a label option, which on the root does nothing.
      ? [{text: ' ', width: edge.label.w, height: edge.label.h, layoutOptions: {'elk.edgeLabels.inline': 'true'}}]
      : undefined;
    return {id: `\u0000e${i}`, sources: [source], targets: [target], ...(labels ? {labels} : {})};
  });

  for (const node of spec.nodes) {
    const elkNode: ElkNode = {id: node.id, width: node.w, height: node.h};
    const own = ports.get(node.id);
    if (own) {
      const list: ElkPort[] = [];
      for (const [y, id] of own.west) list.push({id, x: -1, y: y - 0.5, width: 1, height: 1, layoutOptions: {'elk.port.side': 'WEST'}});
      for (const [y, id] of own.east) list.push({id, x: node.w, y: y - 0.5, width: 1, height: 1, layoutOptions: {'elk.port.side': 'EAST'}});
      elkNode.ports = list;
      elkNode.layoutOptions = {'elk.portConstraints': 'FIXED_POS'};
    }
    const group = node.group !== undefined && groups.has(node.group) ? node.group : undefined;
    (group !== undefined ? parentNode(group) : (containerOf.get(node.id) ?? root)).children!.push(elkNode);
  }
  if (single) {
    // Every edge on the root: with INCLUDE_CHILDREN ELK finds the group an edge belongs to itself.
    root.edges = edges;
  } else {
    // Each edge in the box of its part (both its ends are in it).
    for (const [i, edge] of spec.edges.entries()) containerOf.get(edge.from)?.edges?.push(edges[i]!);
    // The lone nodes after the boxes, in the caller's order.
    root.children!.sort((a, b) => Number(loose.has(a.id)) - Number(loose.has(b.id)));
  }
  return root;
}

/** True when the flow runs left to right or top to bottom. */
const isForward = (dir: Dir) => dir === 'LR' || dir === 'TB';
const round = (v: number) => Math.round(v * 10) / 10;

export function fromElk(laid: ElkNode, spec: LayoutSpec): Laid {
  const boxes = new Map<string, Box>();
  const frames = new Map<string, Box>();
  const groupIds = new Set((spec.groups ?? []).map(group => group.id));
  const nodeIds = new Set(spec.nodes.map(node => node.id));
  const elkEdges: ElkExtendedEdge[] = [];
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const edge of (node.edges ?? []) as ElkExtendedEdge[]) elkEdges.push(edge);
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      const box = {x: round(x), y: round(y), w: round(child.width ?? 0), h: round(child.height ?? 0)};
      if (groupIds.has(child.id)) {
        frames.set(child.id, box);
        walk(child, x, y);
      } else if (!nodeIds.has(child.id) && child.id.startsWith(PART)) walk(child, x, y);
      else boxes.set(child.id, box);
    }
  };
  walk(laid, laid.x ?? 0, laid.y ?? 0);

  const byIndex = new Map(elkEdges.map(edge => [edge.id, edge]));
  const shapes = new Map(spec.nodes.map(node => [node.id, node.shape]));
  const routes = new Map<string, Route>();
  const points: Point[] = [];
  const labels: Box[] = [];
  spec.edges.forEach((edge, i) => {
    const elk = byIndex.get(`\u0000e${i}`);
    const sections = elk?.sections ?? [];
    if (sections.length === 0) return;
    const raw: Point[] = [];
    for (const section of sections) {
      for (const p of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
        const q = {x: round(p.x), y: round(p.y)};
        const last = raw.at(-1);
        if (!last || last.x !== q.x || last.y !== q.y) raw.push(q);
      }
    }
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    const route: Point[] = a && b && edge.fromPort === undefined && edge.toPort === undefined
      ? clipToShapes(raw, {box: a, shape: shapes.get(edge.from)}, {box: b, shape: shapes.get(edge.to)})
      : raw;
    const label = elk?.labels?.[0];
    const plate = edge.label && label && Number.isFinite(label.x) && Number.isFinite(label.y)
      ? {x: round(label.x!), y: round(label.y!), w: edge.label.w, h: edge.label.h}
      : undefined;
    routes.set(edge.key, plate ? {points: route, label: plate} : {points: route});
    points.push(...route);
    if (plate) labels.push(plate);
  });
  const bounds = boundsOf([...boxes.values(), ...frames.values(), ...labels], points) ?? {x: 0, y: 0, w: 0, h: 0};
  return {dir: spec.dir, bounds, boxes, frames, routes};
}

/** A key that is equal for two specs exactly when ELK would lay them out alike. */
export function signatureOf(spec: LayoutSpec): string {
  const parts: string[] = [spec.dir, String(spec.nodeGap ?? ''), String(spec.layerGap ?? ''), spec.dense ? 'dense' : '', String(spec.wrap ?? ''), spec.wrapAny ? 'any' : '', String(spec.aspect ?? '')];
  for (const node of spec.nodes) parts.push(`n${node.id}\u0001${node.w}\u0001${node.h}\u0001${node.shape ?? ''}\u0001${node.group ?? ''}`);
  for (const edge of spec.edges) {
    parts.push(`e${edge.key}\u0001${edge.from}\u0001${edge.to}\u0001${edge.label ? `${edge.label.w}x${edge.label.h}` : ''}\u0001${edge.fromPort ?? ''}\u0001${edge.toPort ?? ''}`);
  }
  for (const group of spec.groups ?? []) parts.push(`g${group.id}\u0001${group.parent ?? ''}\u0001${group.minWidth ?? ''}`);
  return parts.join('\u0002');
}

export {ROOT as ELK_ROOT_ID};
