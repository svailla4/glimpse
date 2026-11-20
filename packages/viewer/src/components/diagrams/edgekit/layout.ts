// Layered layout for the node-link diagrams, and the orthogonal routes that follow from it. Pure: the React side
// (useLayout.ts) decides when to run it.
//
// What is ours and what is dagre's:
//   1. Parts that nothing connects are laid out one by one and packed into the shape of the stage.
//   2. Ranks are ours: dependency depth, sources pulled next to what they feed, and (for Graph) ranks that would make
//      the picture far longer across the flow than the stage is are wrapped into more ranks.
//   3. Edges that span several ranks run through waypoints. Edges that leave one node, or arrive at one node, share
//      their waypoints, so a hub has one trunk instead of twenty parallel lines; nothing else is bundled. Without
//      `wrap` (Flowchart, ERDiagram) an edge back against the flow goes round the side instead, in a corridor of its
//      own between junctions that stand beside its two ends. Edges between the same two nodes take a lane each.
//   4. dagre's own ranking is replaced by ours and its ordering by ordering.ts (fewest crossings, every cluster in
//      one piece in every rank, passing edges kept beside a cluster); dagre places nodes across the flow.
//   5. The gaps between ranks are ours again: every turn gets a track of its own in the gap, edges only share a
//      track when they share an end (a star is unambiguous, a merged trunk is not), tracks are ordered for the
//      fewest crossings, and a gap is as wide as its tracks need.
//   6. Labels are placed last, on a stretch of line their edge has to itself (never on a trunk it shares), where they
//      cover no node, no other label and as few other lines as can be. A self-loop is a handle on a side of its node
//      across the flow, in room kept for it, so it never runs along the edges that turn in the gaps between ranks.
// Everything is computed for a left-to-right flow; a top-to-bottom diagram is laid out transposed and turned back.
// At the 150-node cap a dense graph takes well under a second (it took seconds with dagre's network simplex), and
// useLayout.ts runs large layouts in a worker.
import {Graph, layout as dagreLayout, type GraphLabel} from '@dagrejs/dagre';
import {
  LANE, LOOP_HALF, LOOP_REACH, boundsOf, centerOf, inset, loopLabel, nearestOn, routeEdge, routeLoop, sideInset, simplify, straightSided,
  type Box, type Dir, type Point, type Shape,
} from './geometry.ts';
import {clusterOrder, keepRanks, type ChainOf, type OrderHooks} from './ordering.ts';

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
  /** Flow direction. Left out, the layout picks the one that fills a stage of `aspect` best. */
  dir?: Dir;
  /** Width over height of the stage the diagram is drawn on. Default 1.6. */
  aspect?: number;
  /** True: ranks much longer than the stage is across the flow are wrapped into more ranks (Graph). */
  wrap?: boolean;
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  groups?: readonly LayoutGroup[];
  /** Free space between two nodes of one rank. Default 24. */
  nodesep?: number;
  /** Smallest gap between two ranks; a gap grows with the turns it holds. Default 56. */
  ranksep?: number;
}

export interface Route {
  /** Corner points, source to target. */
  points: Point[];
  /** Centre of the label plate. */
  label?: Point;
}
export interface Laid {
  /** The direction the diagram flows in: the one asked for, or the one chosen for the stage. */
  dir: Dir;
  boxes: Map<string, Box>;
  routes: Map<string, Route>;
}

const DEFAULT_ASPECT = 1.6;
/** Stage shapes are rounded to these steps, so a resize by a few pixels is not a new layout. */
const ASPECT_STEPS = [0.4, 0.55, 0.75, 1, 1.3, 1.6, 2, 2.5, 3.2, 4];

/** The aspect a layout is computed for: the nearest step. */
export function aspectStep(aspect: number | undefined): number {
  if (aspect === undefined || !Number.isFinite(aspect) || aspect <= 0) return DEFAULT_ASPECT;
  let best = ASPECT_STEPS[0]!;
  for (const step of ASPECT_STEPS) if (Math.abs(Math.log(step / aspect)) < Math.abs(Math.log(best / aspect))) best = step;
  return best;
}

/** Everything the layout depends on, as one string: equal signatures give equal layouts. */
export function signatureOf(spec: LayoutSpec): string {
  const parts: string[] = [spec.dir ?? `auto@${aspectStep(spec.aspect)}`, spec.wrap ? `wrap@${aspectStep(spec.aspect)}` : '', String(spec.nodesep ?? ''), String(spec.ranksep ?? '')];
  for (const node of spec.nodes) parts.push(`${node.id}\u0001${node.w}x${node.h}\u0001${node.shape ?? ''}\u0001${node.group ?? ''}`);
  parts.push('\u0002');
  for (const edge of spec.edges) parts.push(`${edge.from}\u0001${edge.to}\u0001${edge.label ? `${edge.label.w}x${edge.label.h}` : ''}\u0001${edge.fromPort ?? ''}\u0001${edge.toPort ?? ''}`);
  parts.push('\u0002');
  for (const group of spec.groups ?? []) parts.push(`${group.id}\u0001${group.parent ?? ''}`);
  return parts.join('\u0003');
}

// ---------------------------------------------------------------- constants (flow space: main axis x, cross axis y)
const NODE = 'n:';
const GROUP = 'g:';
const VIA = 'v:';
/** Space a passing edge takes in a rank: between two of them, and added to the gap between the nodes it passes. */
const VIA_SEP = 8;
/** Distance between two tracks in a gap... */
const TRACK = 7;
/** ...until the gap would grow past this; then the tracks move closer together, down to TRACK_MIN. */
const GAP_MAX = 144;
/** Closer than this, two parallel runs read as one line. */
const TRACK_MIN = 6;
/** From a rank to the first track: an arrow head, an elbow and the padding of a group frame. */
const TRACK_MARGIN = 16;
/** Two turns may share a track when this much lies between them. */
const TRACK_CLEAR = 40;
/** Between the label of a straight run and the elbow of a trunk that joins it, or the end of the gap. */
const LABEL_SPACE = 8;
/** Between two edges that join the same two nodes the same way. */
const PARALLEL = 10;
/** Between two side loops that leave (or enter) one side of a node. */
const STUB_SEP = 10;
/** Room a self-loop takes across the flow, beyond its node: its reach, and the gap to its label. */
const LOOP_ROOM = LOOP_REACH + 4;
/** Space between the parts of a diagram that nothing connects. */
const BLOCK_GAP = 32;
/** Room a group frame takes around its members (Diagram draws it). */
const FRAME_PAD = 12;
/** Wrapping ranks has to buy at least this much scale before the natural ranks are given up. */
const WRAP_GAIN = 1.2;
/** A top-to-bottom flow has to fit this much better than left-to-right before it is chosen. */
const TB_GAIN = 1.15;
/** Above this many nodes the direction is not weighed: left to right. */
const AUTO_DIR_NODES = 60;
/** The stage height a direction is chosen for; only the shape of the real stage is known to the layout. */
const STAGE_HEIGHT = 420;

const flipBox = (b: Box): Box => ({x: b.y, y: b.x, w: b.h, h: b.w});

/** The middle of the longest segment of a route: where a label reads as belonging to the whole of it. */
function longestMiddle(points: readonly Point[]): Point {
  let best = 0;
  let at = points[0] ?? {x: 0, y: 0};
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (length > best) {
      best = length;
      at = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
    }
  }
  return at;
}
const pairKey = (a: string, b: string) => `${a}\u0001${b}`;

/** `grow`: room kept on both sides across the flow (for a self-loop and its label), not part of the drawn box. */
interface FlowNode { id: string; w: number; h: number; shape?: Shape; group?: string; grow?: number }
interface FlowEdge { key: string; from: string; to: string; label?: {w: number; h: number}; fromPort?: number; toPort?: number }
/** `flip`: laid out transposed (a top-to-bottom diagram). */
interface FlowOptions { nodesep: number; ranksep: number; wrap: boolean; aspect: number; flip: boolean }
/** Where the self-loop of a node goes (routeLoop): the side across the flow, and how far along it. */
interface LoopPlace { side: -1 | 1; shift: number }
interface Block { boxes: Map<string, Box>; routes: Map<string, Route>; bounds: Box; loops: Map<string, LoopPlace> }

// ---------------------------------------------------------------- ranks
interface Dag { ids: string[]; succ: Map<string, string[]>; pred: Map<string, string[]> }

/** The edges as a DAG: each pair once, edges that close a cycle turned round. */
function toDag(ids: readonly string[], pairs: ReadonlyArray<readonly [string, string]>): Dag {
  const out = new Map<string, string[]>(ids.map(id => [id, []]));
  const indegree = new Map<string, number>(ids.map(id => [id, 0]));
  const seen = new Set<string>();
  for (const [a, b] of pairs) {
    if (a === b || seen.has(pairKey(a, b)) || !out.has(a) || !out.has(b)) continue;
    seen.add(pairKey(a, b));
    out.get(a)!.push(b);
    indegree.set(b, indegree.get(b)! + 1);
  }
  // Depth-first from the real sources; an edge back to a node on the current path closes a cycle.
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const starts = [...ids.filter(id => indegree.get(id) === 0), ...ids];
  for (const start of starts) {
    if (state.has(start)) continue;
    const stack: Array<{id: string; next: number}> = [{id: start, next: 0}];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack.at(-1)!;
      const targets = out.get(top.id)!;
      if (top.next >= targets.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const to = targets[top.next++]!;
      const at = state.get(to);
      if (at === 1) back.add(pairKey(top.id, to));
      else if (at === undefined) {
        state.set(to, 1);
        stack.push({id: to, next: 0});
      }
    }
  }
  const succ = new Map<string, string[]>(ids.map(id => [id, []]));
  const pred = new Map<string, string[]>(ids.map(id => [id, []]));
  const added = new Set<string>();
  for (const key of seen) {
    const [a, b] = key.split('\u0001') as [string, string];
    const [from, to] = back.has(key) ? [b, a] : [a, b];
    if (added.has(pairKey(from, to))) continue;
    added.add(pairKey(from, to));
    succ.get(from)!.push(to);
    pred.get(to)!.push(from);
  }
  return {ids: [...ids], succ, pred};
}

/** Longest path from the sources, then every source pulled next to the nearest node it feeds. */
function naturalRanks(dag: Dag): Map<string, number> {
  const rank = new Map<string, number>();
  const waiting = new Map<string, number>(dag.ids.map(id => [id, dag.pred.get(id)!.length]));
  const order: string[] = [];
  const ready = dag.ids.filter(id => waiting.get(id) === 0);
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!;
    order.push(id);
    let at = 0;
    for (const p of dag.pred.get(id)!) at = Math.max(at, rank.get(p)! + 1);
    rank.set(id, at);
    for (const s of dag.succ.get(id)!) {
      const left = waiting.get(s)! - 1;
      waiting.set(s, left);
      if (left === 0) ready.push(s);
    }
  }
  for (const id of dag.ids) if (!rank.has(id)) rank.set(id, 0);
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const succ = dag.succ.get(id)!;
    if (dag.pred.get(id)!.length > 0 || succ.length === 0) continue;
    rank.set(id, Math.min(...succ.map(s => rank.get(s)!)) - 1);
  }
  return compactRanks(rank);
}

/** Ranks renumbered from 0 without gaps. */
function compactRanks(rank: Map<string, number>): Map<string, number> {
  const used = [...new Set(rank.values())].sort((a, b) => a - b);
  const index = new Map(used.map((value, i) => [value, i]));
  return new Map([...rank].map(([id, value]) => [id, index.get(value)!]));
}

/** No rank holds more than `cap` nodes: nodes with room move to a neighbouring rank, the rest open a new one. */
function wrapRanks(dag: Dag, natural: ReadonlyMap<string, number>, cap: number): Map<string, number> {
  const rank = new Map(natural);
  const members = (r: number) => dag.ids.filter(id => rank.get(id) === r);
  const size = (r: number) => members(r).length;
  let last = Math.max(0, ...rank.values());
  for (let r = 0; r <= last; r++) {
    // Guard against a pathological input: every pass moves at least one node, so this ends.
    for (let guard = 0; size(r) > cap && guard < dag.ids.length; guard++) {
      const here = members(r);
      let moved = false;
      // A node none of whose neighbours sits in the next rank can step forward when there is room.
      for (const id of here) {
        if (size(r) <= cap) break;
        const free = dag.succ.get(id)!.every(s => rank.get(s)! > r + 1);
        if (free && r + 1 <= last && size(r + 1) < cap) {
          rank.set(id, r + 1);
          moved = true;
        }
      }
      if (size(r) <= cap) break;
      if (moved) continue;
      // Open a rank after this one and send the overflow there: first the nodes that feed more than they are fed.
      for (const id of dag.ids) if (rank.get(id)! > r) rank.set(id, rank.get(id)! + 1);
      last++;
      const pull = (id: string) => dag.succ.get(id)!.length - dag.pred.get(id)!.length;
      const overflow = [...here].sort((a, b) => pull(b) - pull(a)).slice(0, Math.min(cap, here.length - cap));
      for (const id of overflow) rank.set(id, r + 1);
    }
  }
  return compactRanks(rank);
}

/** A cheap guess of the size of a layering, good enough to compare two of them. */
function estimate(nodes: ReadonlyMap<string, FlowNode>, dag: Dag, rank: ReadonlyMap<string, number>, o: FlowOptions): {along: number; across: number} {
  const ranks = Math.max(0, ...rank.values()) + 1;
  const thick = new Array<number>(ranks).fill(0);
  const stack = new Array<number>(ranks).fill(0);
  // Per rank, the nodes whose edges pass it; per gap (after a rank), the nodes whose edges turn in it.
  const passing: Array<Set<string>> = Array.from({length: ranks}, () => new Set());
  const turning: Array<Set<string>> = Array.from({length: ranks}, () => new Set());
  for (const [id, r] of rank) {
    const node = nodes.get(id)!;
    thick[r] = Math.max(thick[r]!, node.w);
    stack[r] = stack[r]! + node.h + o.nodesep;
    for (const s of dag.succ.get(id)!) {
      const to = rank.get(s)!;
      for (let at = r; at < to; at++) {
        turning[at]!.add(id);
        if (at > r) passing[at]!.add(id);
      }
    }
  }
  let along = 0;
  let across = 0;
  for (let r = 0; r < ranks; r++) {
    const gap = Math.min(Math.max(GAP_MAX, o.ranksep), Math.max(o.ranksep, TRACK_MARGIN * 2 + Math.max(0, turning[r]!.size - 1) * TRACK));
    along += thick[r]! + (r + 1 < ranks ? gap : 0);
    across = Math.max(across, stack[r]! + passing[r]!.size * VIA_SEP);
  }
  return {along, across};
}

/** How large a picture of this size is drawn on a stage of the given shape. */
const scaleFor = (size: {along: number; across: number}, aspect: number) => Math.min(aspect / Math.max(1, size.along), 1 / Math.max(1, size.across));

function chooseRanks(nodes: ReadonlyMap<string, FlowNode>, dag: Dag, o: FlowOptions): Map<string, number> {
  const natural = naturalRanks(dag);
  if (!o.wrap) return natural;
  const counts = new Map<number, number>();
  for (const r of natural.values()) counts.set(r, (counts.get(r) ?? 0) + 1);
  const widest = Math.max(0, ...counts.values());
  let best = natural;
  let bestScale = scaleFor(estimate(nodes, dag, natural, o), o.aspect) * WRAP_GAIN;
  for (let cap = widest - 1; cap >= 2; cap--) {
    const wrapped = wrapRanks(dag, natural, cap);
    const scale = scaleFor(estimate(nodes, dag, wrapped, o), o.aspect);
    if (scale > bestScale) {
      best = wrapped;
      bestScale = scale;
    }
  }
  return best;
}

// ---------------------------------------------------------------- tracks
interface Hop {
  /** The gap it turns in: the one after this band. */
  channel: number;
  left: string;
  right: string;
  y0: number;
  y1: number;
  /** Main-axis position of the turn, once tracks are assigned. Straight hops have none. */
  x?: number;
}
interface Net { lefts: number[]; rights: number[]; lo: number; hi: number; hops: Hop[]; track: number }

/**
 * Splits the turns of one gap into stars: turns that share an end share a trunk, and nothing else does. The end with
 * the most turns takes its star first.
 */
function starsOf(hops: readonly Hop[]): Net[] {
  const nets: Net[] = [];
  let rest = [...hops];
  while (rest.length > 0) {
    const tally = new Map<string, number>();
    let best = '';
    let bestCount = 0;
    for (const hop of rest) {
      for (const key of [`L${hop.left}`, `R${hop.right}`]) {
        const count = (tally.get(key) ?? 0) + 1;
        tally.set(key, count);
        if (count > bestCount) {
          best = key;
          bestCount = count;
        }
      }
    }
    const mine = rest.filter(hop => (best[0] === 'L' ? hop.left : hop.right) === best.slice(1));
    rest = rest.filter(hop => !mine.includes(hop));
    const lefts = [...new Set(mine.map(hop => hop.y0))];
    const rights = [...new Set(mine.map(hop => hop.y1))];
    nets.push({lefts, rights, lo: Math.min(...lefts, ...rights), hi: Math.max(...lefts, ...rights), hops: mine, track: 0});
  }
  return nets;
}

/** What it costs to put the trunk of `a` before (nearer the source rank than) the trunk of `b`. */
function costBefore(a: Net, b: Net): number {
  let cost = 0;
  // The runs from a's trunk on to the next rank cross b's trunk; the runs from the source rank to b's trunk cross a's.
  for (const y of a.rights) if (y > b.lo + 0.5 && y < b.hi - 0.5) cost++;
  for (const y of b.lefts) if (y > a.lo + 0.5 && y < a.hi - 0.5) cost++;
  // Worse than a crossing: two runs on one line between the two trunks, which reads as one edge.
  for (const y of a.rights) for (const z of b.lefts) if (Math.abs(y - z) < 3) cost += 8;
  return cost;
}

/** Orders the trunks of one gap for the fewest crossings and lets trunks that are clear of each other share a track. */
function assignTracks(nets: Net[]): number {
  nets.sort((a, b) => a.lo + a.hi - (b.lo + b.hi));
  for (let pass = 0, swapped = true; swapped && pass < nets.length; pass++) {
    swapped = false;
    for (let i = 0; i + 1 < nets.length; i++) {
      const a = nets[i]!;
      const b = nets[i + 1]!;
      if (costBefore(b, a) < costBefore(a, b)) {
        nets[i] = b;
        nets[i + 1] = a;
        swapped = true;
      }
    }
  }
  let tracks = 0;
  nets.forEach((net, i) => {
    let track = 0;
    for (let j = 0; j < i; j++) {
      const other = nets[j]!;
      if (other.lo - TRACK_CLEAR <= net.hi && net.lo - TRACK_CLEAR <= other.hi) track = Math.max(track, other.track + 1);
    }
    net.track = track;
    tracks = Math.max(tracks, track + 1);
  });
  return tracks;
}

// ---------------------------------------------------------------- one connected part
interface Link {
  edge: FlowEdge;
  /** The end in the lower rank and the end in the higher one; `rev` when the edge points against the flow. */
  lo: string;
  hi: string;
  rev: boolean;
  loOff: number;
  hiOff: number;
  ported: boolean;
  /** Node, then every point the edge passes on its way (kept-free points in the ranks it crosses, junctions), then node. */
  stations: string[];
  hops: Hop[];
  /**
   * A loop back against the flow, drawn around the side (Flowchart, ERDiagram): its two side junctions, which stand
   * beside its ends in their ranks, so it leaves one node from the side, runs in a corridor of its own and comes
   * back into the other from the side.
   */
  side?: {lo: string; hi: string};
}

function layoutPart(nodes: readonly FlowNode[], edges: readonly FlowEdge[], groups: ReadonlyMap<string, LayoutGroup>, o: FlowOptions): Block {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const first = nodes[0]!;
  const defaultSide: -1 | 1 = o.flip ? 1 : -1;
  if (nodes.length === 1) {
    const grow = first.grow ?? 0;
    const box = {x: 0, y: grow, w: first.w, h: first.h - grow * 2};
    return {boxes: new Map([[first.id, box]]), routes: new Map(), bounds: {x: 0, y: 0, w: first.w, h: first.h}, loops: new Map(grow > 0 ? [[first.id, {side: defaultSide, shift: 0}]] : [])};
  }
  const dag = toDag(nodes.map(node => node.id), edges.map(edge => [edge.from, edge.to] as const));
  const rank = chooseRanks(byId, dag, o);

  // ---- every edge from its lower rank to its higher one
  const half = (node: FlowNode) => node.h / 2 - (node.grow ?? 0);
  const clampPort = (node: FlowNode, offset: number) => Math.max(-(half(node) - 3), Math.min(half(node) - 3, offset));
  const links: Link[] = edges.map(edge => {
    const rev = rank.get(edge.to)! < rank.get(edge.from)!;
    const ported = edge.fromPort !== undefined || edge.toPort !== undefined;
    const lane = rev && !ported && o.wrap ? LANE : 0;
    const lo = rev ? edge.to : edge.from;
    const hi = rev ? edge.from : edge.to;
    return {
      edge, lo, hi, rev, ported,
      loOff: clampPort(byId.get(lo)!, (rev ? edge.toPort : edge.fromPort) ?? lane),
      hiOff: clampPort(byId.get(hi)!, (rev ? edge.fromPort : edge.toPort) ?? lane),
      stations: [],
      hops: [],
    };
  });
  // Edges between the same two nodes in the same direction each get a lane of their own, a little apart.
  const parallel = new Map<string, Link[]>();
  for (const link of links) {
    if (link.ported) continue;
    const key = `${link.lo}\u0001${link.hi}\u0001${link.rev}`;
    const list = parallel.get(key);
    if (list) list.push(link);
    else parallel.set(key, [link]);
  }
  for (const list of parallel.values()) {
    list.forEach((link, k) => {
      const off = (k - (list.length - 1) / 2) * PARALLEL;
      link.loOff = clampPort(byId.get(link.lo)!, link.loOff + off);
      link.hiOff = clampPort(byId.get(link.hi)!, link.hiOff + off);
    });
  }

  // ---- trunks for the edges that span more than one rank
  // Edges that leave one node (or arrive at one node) and span several ranks share a trunk: it runs from the node
  // to a junction one rank before each target (after each source), where an edge branches off. A trunk is one long
  // dagre edge between junctions, so dagre keeps room for it in the ranks it crosses and pulls it straight.
  interface Segment { id: string; v: string; w: string; minlen: number; weight: number; label?: {w: number; h: number}; group?: string }
  const segments = new Map<string, Segment>();
  const junctions = new Map<string, string | undefined>();
  const segment = (v: string, w: string, minlen: number, name: string, group?: string): Segment => {
    const id = `${v}\u0001${w}\u0001${name}`;
    let found = segments.get(id);
    if (!found) {
      found = {id, v, w, minlen, weight: 0, group};
      segments.set(id, found);
    }
    found.weight++;
    return found;
  };
  const paths = new Map<Link, Segment[]>();
  const span = (link: Link) => rank.get(link.hi)! - rank.get(link.lo)!;
  const outKey = (link: Link) => `o${link.lo}\u0001${link.loOff}`;
  const inKey = (link: Link) => `i${link.hi}\u0001${link.hiOff}`;
  const sameGroup = (members: readonly Link[]) => {
    const group = byId.get(members[0]!.lo)!.group;
    return group !== undefined && members.every(link => byId.get(link.lo)!.group === group && byId.get(link.hi)!.group === group) ? group : undefined;
  };
  let trunkCount = 0;
  const openTrunk = (members: Link[], fanOut: boolean) => {
    const name = `t${trunkCount++}`;
    const group = sameGroup(members);
    if (members.length === 1) {
      const link = members[0]!;
      paths.set(link, [segment(NODE + link.lo, NODE + link.hi, span(link), name, group)]);
      return;
    }
    const junction = (r: number) => {
      const id = `${VIA}${name}:${r}`;
      junctions.set(id, group);
      return id;
    };
    if (fanOut) {
      const source = NODE + members[0]!.lo;
      const from = rank.get(members[0]!.lo)!;
      const stops = [...new Set(members.map(link => rank.get(link.hi)! - 1))].sort((a, b) => a - b);
      for (const link of members) {
        const path: Segment[] = [];
        let at = source;
        let atRank = from;
        for (const stop of stops) {
          if (stop > rank.get(link.hi)! - 1) break;
          path.push(segment(at, junction(stop), stop - atRank, name, group));
          at = junction(stop);
          atRank = stop;
        }
        path.push(segment(at, NODE + link.hi, 1, name, group));
        paths.set(link, path);
      }
    } else {
      const target = NODE + members[0]!.hi;
      const to = rank.get(members[0]!.hi)!;
      const stops = [...new Set(members.map(link => rank.get(link.lo)! + 1))].sort((a, b) => a - b);
      for (const link of members) {
        const first = rank.get(link.lo)! + 1;
        const path: Segment[] = [segment(NODE + link.lo, junction(first), 1, name, group)];
        let at = junction(first);
        let atRank = first;
        for (const stop of stops) {
          if (stop <= first) continue;
          path.push(segment(at, junction(stop), stop - atRank, name, group));
          at = junction(stop);
          atRank = stop;
        }
        path.push(segment(at, target, to - atRank, name, group));
        paths.set(link, path);
      }
    }
  };
  // Loops back against the flow, where they are drawn around the side: a corridor of their own, from a junction
  // beside one end to a junction beside the other.
  const anchors = new Map<string, string>();
  if (!o.wrap) {
    let sideCount = 0;
    for (const link of links) {
      if (!link.rev || link.ported) continue;
      const name = `s${sideCount++}`;
      const lo = `${VIA}${name}:${rank.get(link.lo)!}`;
      const hi = `${VIA}${name}:${rank.get(link.hi)!}`;
      junctions.set(lo, byId.get(link.lo)!.group);
      junctions.set(hi, byId.get(link.hi)!.group);
      anchors.set(lo, NODE + link.lo);
      anchors.set(hi, NODE + link.hi);
      link.side = {lo, hi};
      paths.set(link, [segment(lo, hi, span(link), name)]);
    }
  }
  let loose = links.filter(link => span(link) >= 2 && !link.side);
  while (loose.length > 0) {
    const tally = new Map<string, Link[]>();
    let best: Link[] = [];
    let bestKey = '';
    for (const link of loose) {
      for (const key of [outKey(link), inKey(link)]) {
        const members = tally.get(key) ?? [];
        if (members.length === 0) tally.set(key, members);
        members.push(link);
        if (members.length > best.length) {
          best = members;
          bestKey = key;
        }
      }
    }
    if (best.length < 2) break;
    openTrunk(best, bestKey.startsWith('o'));
    loose = loose.filter(link => !paths.has(link));
  }
  for (const link of loose) openTrunk([link], true);
  for (const link of links) if (!paths.has(link)) paths.set(link, [segment(NODE + link.lo, NODE + link.hi, 1, `d${link.loOff}:${link.hiOff}`)]);
  // A label names one edge, so it goes where no other edge runs: the first segment of its own after the trunk it
  // shares (a fan-out names its branches, not their common stem; V005).
  const labelSegment = new Map<Link, Segment>();
  for (const link of links) {
    const label = link.edge.label;
    if (!label) continue;
    const path = paths.get(link)!;
    const ordered = link.rev ? [...path].reverse() : path;
    const own = ordered.find(s => s.weight === 1) ?? ordered[0]!;
    labelSegment.set(link, own);
    own.label = {w: Math.max(own.label?.w ?? 0, label.w), h: Math.max(own.label?.h ?? 0, label.h)};
  }

  // ---- dagre: order within the ranks and positions across the flow
  // Nodes are padded by half the node gap and dagre's own gap is zero, so an edge passing between two nodes of a
  // rank uses the gap that is there instead of adding to it.
  const pad = o.nodesep / 2;
  // A junction's id ends in the rank it stands in.
  const fixedRank = (id: string): number | undefined =>
    id.startsWith(NODE) ? rank.get(id.slice(NODE.length)) : id.startsWith(VIA) ? Number(id.slice(id.lastIndexOf(':') + 1)) : undefined;
  // A trunk's junctions and the points dagre keeps free for its segments are one chain; a lone edge's points another.
  const chainOf: ChainOf = (id, edge) => {
    if (id.startsWith(VIA)) return id.slice(VIA.length, id.lastIndexOf(':'));
    if (!edge) return undefined;
    const name = edge.name?.split('\u0001')[2] ?? '';
    return name.startsWith('t') || name.startsWith('s') ? name : `${edge.v}\u0001${edge.w}\u0001${name}`;
  };
  const order: OrderHooks = {chainOf, anchorOf: id => anchors.get(id)};
  const run = (compound: boolean) => {
    const g = new Graph({compound, multigraph: true});
    g.setGraph({rankdir: 'LR', nodesep: 0, ranksep: o.ranksep, edgesep: VIA_SEP, marginx: 0, marginy: 0});
    // Our ranks, not dagre's network simplex (dagre 3 takes a function; its types only list the built-in names).
    g.graph().ranker = keepRanks(fixedRank) as unknown as GraphLabel['ranker'];
    g.setDefaultEdgeLabel(() => ({}));
    for (const node of nodes) g.setNode(NODE + node.id, {width: node.w, height: node.h + pad * 2});
    for (const id of junctions.keys()) g.setNode(id, {width: 0, height: VIA_SEP});
    if (compound) {
      const used = new Set<string>();
      for (const node of nodes) {
        // Walk up the ancestors once per group; `used` stops both repeats and parent cycles.
        for (let id = node.group; id !== undefined && groups.has(id) && !used.has(id); id = groups.get(id)!.parent) used.add(id);
      }
      for (const id of used) g.setNode(GROUP + id, {});
      for (const id of used) {
        const parent = groups.get(id)!.parent;
        if (parent !== undefined && used.has(parent) && !isAncestor(groups, id, parent)) g.setParent(GROUP + id, GROUP + parent);
      }
      for (const node of nodes) if (node.group !== undefined && used.has(node.group)) g.setParent(NODE + node.id, GROUP + node.group);
      for (const [id, group] of junctions) if (group !== undefined && used.has(group)) g.setParent(id, GROUP + group);
    }
    for (const s of segments.values()) {
      g.setEdge(s.v, s.w, {minlen: s.minlen, weight: s.weight, ...(s.label ? {width: s.label.w, height: s.label.h, labelpos: 'c'} : {})}, s.id);
    }
    dagreLayout(g, {customOrder: graph => clusterOrder(graph as never, order)});
    return g;
  };
  const grouped = nodes.some(node => node.group !== undefined && groups.has(node.group));
  let g: Graph;
  try {
    g = run(grouped);
  } catch (error) {
    // dagre's cluster support fails on some nestings; the flat layout still draws every node and edge.
    if (!grouped) throw error;
    g = run(false);
  }

  // ---- bands: the stretch of the main axis each rank takes
  const at = (id: string): Point => {
    const node = g.node(id) as {x?: number; y?: number} | undefined;
    return {x: node?.x ?? 0, y: node?.y ?? 0};
  };
  // Centres of one rank agree to a fraction of a pixel; ranks are tens of pixels apart.
  const merged: number[] = [];
  for (const x of [...nodes.map(node => at(NODE + node.id).x), ...[...junctions.keys()].map(id => at(id).x)].sort((a, b) => a - b)) {
    if (merged.length === 0 || x - merged.at(-1)! > 2) merged.push(x);
  }
  const bandOf = (x: number): number | undefined => {
    let best = 0;
    for (let i = 1; i < merged.length; i++) if (Math.abs(merged[i]! - x) < Math.abs(merged[best]! - x)) best = i;
    return Math.abs(merged[best]! - x) <= 2 ? best : undefined;
  };
  const width = new Array<number>(merged.length).fill(0);
  const place = new Map<string, {band: number; y: number}>();
  for (const node of nodes) {
    const p = at(NODE + node.id);
    const band = bandOf(p.x) ?? 0;
    width[band] = Math.max(width[band]!, node.w);
    place.set(NODE + node.id, {band, y: Math.round(p.y)});
  }
  for (const id of junctions.keys()) {
    const p = at(id);
    place.set(id, {band: bandOf(p.x) ?? 0, y: p.y});
  }
  // The points dagre kept free for a long segment, one in each rank it crosses.
  const inner = new Map<string, string[]>();
  for (const s of segments.values()) {
    const ids: string[] = [];
    if (s.minlen > 1) {
      const from = place.get(s.v)!.band;
      const to = place.get(s.w)!.band;
      const points = ((g.edge(s.v, s.w, s.id) as {points?: Point[]} | undefined)?.points ?? []).slice(1, -1);
      let lastBand = from;
      for (const p of points) {
        const band = Number.isFinite(p.x) && Number.isFinite(p.y) ? bandOf(p.x) : undefined;
        if (band === undefined || band <= lastBand || band >= to) continue;
        const id = `${s.id}\u0001${band}`;
        place.set(id, {band, y: p.y});
        ids.push(id);
        lastBand = band;
      }
    }
    inner.set(s.id, ids);
  }
  // The segment each hop of a link belongs to, hop by hop.
  const hopSegments = new Map<Link, Segment[]>();
  for (const link of links) {
    link.stations = [link.side?.lo ?? NODE + link.lo];
    const of: Segment[] = [];
    for (const s of paths.get(link)!) {
      const ids = inner.get(s.id)!;
      link.stations.push(...ids, s.w);
      for (let i = 0; i <= ids.length; i++) of.push(s);
    }
    hopSegments.set(link, of);
  }
  /** The hop a link's label goes on: the first of its label segment, in the direction of the edge. */
  const labelHop = (link: Link): Hop | undefined => {
    const own = labelSegment.get(link);
    const of = hopSegments.get(link)!;
    const at = link.hops.map((hop, i) => (of[i] === own ? hop : undefined)).filter((hop): hop is Hop => hop !== undefined);
    return (link.rev ? at.at(-1) : at[0]) ?? (link.rev ? link.hops.at(-1) : link.hops[0]);
  };

  // ---- hops: one per pair of neighbouring stations, shared by every edge that runs through both
  const hops = new Map<string, Hop>();
  const labelRoom = new Array<number>(merged.length).fill(0);
  // Per gap: whether a label sits on a turn, and the labels of straight runs; where along the flow those go.
  const labelOnTurn = new Array<boolean>(merged.length).fill(false);
  const straightLabels: Array<Array<{hop: Hop; w: number}>> = merged.map(() => []);
  const straightLabelAt = new Map<Hop, number>();
  const fallback = new Set<Link>();
  for (const link of links) {
    const ys = link.stations.map(id => place.get(id)!.y);
    if (!link.side) {
      ys[0] = ys[0]! + link.loOff;
      ys[ys.length - 1] = ys.at(-1)! + link.hiOff;
    }
    const lo = byId.get(link.lo)!;
    const hi = byId.get(link.hi)!;
    // Two nodes that are almost level: meet in the middle with one straight line instead of a cramped double bend.
    if (link.stations.length === 2 && !link.ported && !link.side && straightSided(lo.shape) && straightSided(hi.shape)) {
      const slack = Math.min(half(lo) - 4 - Math.abs(link.loOff), half(hi) - 4 - Math.abs(link.hiOff));
      const step = ys[1]! - ys[0]!;
      if (Math.abs(step) > 0.5 && Math.abs(step) / 2 <= slack) {
        ys[0] = ys[0]! + step / 2;
        ys[1] = ys[0]!;
      }
    }
    for (let i = 0; i + 1 < link.stations.length; i++) {
      const from = place.get(link.stations[i]!)!;
      const to = place.get(link.stations[i + 1]!)!;
      if (to.band <= from.band) {
        fallback.add(link);
        break;
      }
      const left = `${link.stations[i]!}\u0001${ys[i]!}`;
      const right = `${link.stations[i + 1]!}\u0001${ys[i + 1]!}`;
      let hop = hops.get(pairKey(left, right));
      if (!hop) {
        hop = {channel: from.band, left, right, y0: ys[i]!, y1: ys[i + 1]!};
        hops.set(pairKey(left, right), hop);
      }
      link.hops.push(hop);
    }
    const hop = link.edge.label && !fallback.has(link) ? labelHop(link) : undefined;
    if (hop) {
      labelRoom[hop.channel] = Math.max(labelRoom[hop.channel]!, link.edge.label!.w + 20);
      if (Math.abs(hop.y1 - hop.y0) > 0.5) labelOnTurn[hop.channel] = true;
      else straightLabels[hop.channel]!.push({hop, w: link.edge.label!.w});
    }
  }

  // ---- tracks and the width of every gap
  const turning: Hop[][] = merged.map(() => []);
  for (const hop of hops.values()) if (Math.abs(hop.y1 - hop.y0) > 0.5) turning[hop.channel]!.push(hop);
  const start = new Array<number>(merged.length).fill(0);
  for (let band = 0; band < merged.length; band++) {
    const nets = starsOf(turning[band]!);
    const tracks = assignTracks(nets);
    const lanes = Math.max(0, tracks - 1);
    // A crowded gap does not push the ranks apart without limit: past GAP_MAX its tracks close up instead.
    const pitch = lanes === 0 ? 0 : Math.max(TRACK_MIN, Math.min(TRACK, (Math.max(GAP_MAX, o.ranksep) - TRACK_MARGIN * 2) / lanes));
    const spread = lanes * pitch;
    const offsetOf = (net: Net) => net.track * pitch - spread / 2;
    // A straight run with a label shares its line with the trunks that leave from its start (up to their track) and
    // those that join it at its end (from theirs): its label goes on the stretch between, which has to hold it.
    const straight = straightLabels[band]!.map(({hop, w}) => {
      let after = -Infinity;
      let before = Infinity;
      for (const net of nets) {
        if (net.hops.some(other => other.left === hop.left)) after = Math.max(after, offsetOf(net));
        if (net.hops.some(other => other.right === hop.right)) before = Math.min(before, offsetOf(net));
      }
      return {hop, room: w + LABEL_SPACE * 2, after, before};
    });
    const joinedAtEnd = straight.filter(s => s.before < Infinity && s.after === -Infinity);
    const joinedAtStart = straight.filter(s => s.after > -Infinity && s.before === Infinity);
    let gap = Math.max(o.ranksep, TRACK_MARGIN * 2 + spread, labelRoom[band]!);
    // The tracks move to the far side of the gap from such a label, unless a label on a turn needs them in the middle.
    let shift = 0;
    const roomOf = (list: typeof straight) => Math.max(0, ...list.map(s => s.room));
    if (!labelOnTurn[band] && joinedAtEnd.length > 0 && joinedAtStart.length === 0) {
      gap = Math.max(gap, roomOf(joinedAtEnd) + TRACK_MARGIN + spread);
      shift = gap / 2 - TRACK_MARGIN - spread / 2;
    } else if (!labelOnTurn[band] && joinedAtStart.length > 0 && joinedAtEnd.length === 0) {
      gap = Math.max(gap, roomOf(joinedAtStart) + TRACK_MARGIN + spread);
      shift = -(gap / 2 - TRACK_MARGIN - spread / 2);
    } else {
      for (const s of joinedAtEnd) gap = Math.max(gap, 2 * (s.room - s.before));
      for (const s of joinedAtStart) gap = Math.max(gap, 2 * (s.room + s.after));
    }
    const middle = start[band]! + width[band]! + gap / 2;
    for (const net of nets) for (const hop of net.hops) hop.x = middle + shift + offsetOf(net);
    for (const s of straight) {
      const lo = Math.max(-gap / 2, s.after + shift);
      const hi = Math.min(gap / 2, s.before + shift);
      if (hi > lo) straightLabelAt.set(s.hop, middle + (lo + hi) / 2);
    }
    if (band + 1 < merged.length) start[band + 1] = start[band]! + width[band]! + gap;
  }

  // ---- geometry
  const boxes = new Map<string, Box>();
  for (const node of nodes) {
    const p = place.get(NODE + node.id)!;
    const grow = node.grow ?? 0;
    boxes.set(node.id, {x: Math.round(start[p.band]! + (width[p.band]! - node.w) / 2), y: p.y - node.h / 2 + grow, w: node.w, h: node.h - grow * 2});
  }
  // Where the side loops leave and enter their nodes: across the flow, a little apart when several share a side.
  const stubs = new Map<string, number>();
  const stubCount = new Map<string, number>();
  const sideKey = (node: string, junction: string) => `${node}\u0001${place.get(junction)!.y < place.get(NODE + node)!.y ? 'top' : 'bottom'}`;
  for (const link of links) {
    if (!link.side) continue;
    for (const [node, junction] of [[link.lo, link.side.lo], [link.hi, link.side.hi]] as const) {
      const key = sideKey(node, junction);
      stubs.set(`${link.edge.key}\u0001${node}\u0001${junction}`, stubCount.get(key) ?? 0);
      stubCount.set(key, (stubCount.get(key) ?? 0) + 1);
    }
  }
  // A self-loop stands on a side across the flow that no loop back leaves from; when both are taken, beyond them.
  const loops = new Map<string, LoopPlace>();
  for (const node of nodes) {
    if (!node.grow) continue;
    const taken = (side: -1 | 1) => stubCount.get(`${node.id}\u0001${side < 0 ? 'top' : 'bottom'}`) ?? 0;
    const side: -1 | 1 = taken(defaultSide) > taken(-defaultSide as -1 | 1) ? (-defaultSide as -1 | 1) : defaultSide;
    const stubs = taken(side);
    loops.set(node.id, {side, shift: stubs === 0 ? 0 : ((stubs - 1) / 2) * STUB_SEP + STUB_SEP / 2 + LOOP_HALF});
  }
  /** From the side of `node` that faces the junction to the junction's line: two points. */
  const stub = (link: Link, node: string, junction: string, toY: number): Point[] => {
    const box = boxes.get(node)!;
    const k = stubs.get(`${link.edge.key}\u0001${node}\u0001${junction}`) ?? 0;
    const m = stubCount.get(sideKey(node, junction)) ?? 1;
    const dx = Math.max(-(box.w / 2 - 6), Math.min(box.w / 2 - 6, (k - (m - 1) / 2) * STUB_SEP));
    const x = box.x + box.w / 2 + dx;
    const top = toY < box.y + box.h / 2;
    const cut = sideInset(box, byId.get(node)!.shape, dx, o.flip);
    return [{x, y: top ? box.y + cut : box.y + box.h - cut}, {x, y: toY}];
  };
  const routes = new Map<string, Route>();
  for (const link of links) {
    const a = boxes.get(link.lo)!;
    const b = boxes.get(link.hi)!;
    let points: Point[];
    let label: Point | undefined;
    if (link.side && !fallback.has(link) && link.hops.length > 0) {
      const out: Point[] = stub(link, link.lo, link.side.lo, link.hops[0]!.y0);
      for (const hop of link.hops) if (hop.x !== undefined) out.push({x: hop.x, y: hop.y0}, {x: hop.x, y: hop.y1});
      out.push(...stub(link, link.hi, link.side.hi, link.hops.at(-1)!.y1).reverse());
      points = simplify(out);
      label = link.edge.label ? longestMiddle(points) : undefined;
    } else if (fallback.has(link) || link.hops.length === 0) {
      points = routeEdge(a, b, {dir: 'LR', fromShape: byId.get(link.lo)!.shape, toShape: byId.get(link.hi)!.shape});
      label = link.edge.label ? centerOf(boundsOf([], points)!) : undefined;
    } else {
      const firstHop = link.hops[0]!;
      const lastHop = link.hops.at(-1)!;
      const head = {x: a.x + a.w - inset(a, byId.get(link.lo)!.shape, firstHop.y0 - centerOf(a).y), y: firstHop.y0};
      const tail = {x: b.x + inset(b, byId.get(link.hi)!.shape, lastHop.y1 - centerOf(b).y), y: lastHop.y1};
      const out: Point[] = [head];
      for (const hop of link.hops) if (hop.x !== undefined) out.push({x: hop.x, y: hop.y0}, {x: hop.x, y: hop.y1});
      out.push(tail);
      points = simplify(out);
      // The label sits on the first stretch the edge has to itself: on its turn, or in the middle of the gap.
      const own = link.edge.label ? labelHop(link) : undefined;
      if (own) {
        const gapFrom = start[own.channel]! + width[own.channel]!;
        const gapTo = own.channel + 1 < merged.length ? start[own.channel + 1]! : gapFrom + o.ranksep;
        label = own.x !== undefined
          ? {x: own.x, y: (own.y0 + own.y1) / 2}
          : {x: straightLabelAt.get(own) ?? (Math.max(gapFrom, head.x) + Math.min(gapTo, tail.x)) / 2, y: own.y0};
      }
    }
    routes.set(link.edge.key, {points: link.rev ? points.reverse() : points, label});
  }
  const all: Point[] = [];
  for (const route of routes.values()) for (const point of route.points) all.push(point);
  // A node with a self-loop takes the room kept for the loop and its label too.
  const kept = nodes.map(node => {
    const box = boxes.get(node.id)!;
    const grow = node.grow ?? 0;
    return grow > 0 ? {x: box.x, y: box.y - grow, w: box.w, h: box.h + grow * 2} : box;
  });
  const drawn = boundsOf(kept, all)!;
  const framed = grouped ? {x: drawn.x - FRAME_PAD, y: drawn.y - FRAME_PAD, w: drawn.w + FRAME_PAD * 2, h: drawn.h + FRAME_PAD * 2} : drawn;
  return {boxes, routes, bounds: framed, loops};
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

// ---------------------------------------------------------------- parts and packing
/** The node ids of each connected part: joined by an edge, or by sitting in the same group. */
function partsOf(nodes: readonly FlowNode[], edges: readonly FlowEdge[], groups: ReadonlyMap<string, LayoutGroup>): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let at = id; at !== root;) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const join = (a: string, b: string) => {
    for (const id of [a, b]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(a), find(b));
  };
  for (const node of nodes) {
    parent.set(NODE + node.id, NODE + node.id);
    const seen = new Set<string>();
    let below = NODE + node.id;
    for (let id = node.group; id !== undefined && groups.has(id) && !seen.has(id); id = groups.get(id)!.parent) {
      seen.add(id);
      join(below, GROUP + id);
      below = GROUP + id;
    }
  }
  for (const edge of edges) join(NODE + edge.from, NODE + edge.to);
  const parts = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(NODE + node.id);
    const list = parts.get(root);
    if (list) list.push(node.id);
    else parts.set(root, [node.id]);
  }
  return [...parts.values()];
}

/**
 * Packs the parts into rows, tallest first; within a row, parts shorter than the row stack in columns. Of the row
 * lengths tried, the one whose outline is drawn largest on the stage wins. Returns where each part goes.
 */
function pack(blocks: readonly Block[], aspect: number): Point[] {
  const order = blocks.map((_, i) => i).sort((a, b) => blocks[b]!.bounds.h - blocks[a]!.bounds.h || blocks[b]!.bounds.w - blocks[a]!.bounds.w);
  const arrange = (limit: number) => {
    const at: Point[] = new Array(blocks.length);
    let rowY = 0;
    let rowH = 0;
    let colX = 0;
    let colW = 0;
    let colY = 0;
    let width = 0;
    for (const i of order) {
      const {w, h} = blocks[i]!.bounds;
      const startsRow = rowH === 0;
      if (!startsRow && colY > 0 && colY + h > rowH) {
        // The column is full: start the next one.
        colX += colW + BLOCK_GAP;
        colW = 0;
        colY = 0;
      }
      if (!startsRow && colY === 0 && colX > 0 && colX + w > limit) {
        rowY += rowH + BLOCK_GAP;
        rowH = 0;
        colX = 0;
      }
      if (rowH === 0) rowH = h;
      at[i] = {x: colX, y: rowY + colY};
      colW = Math.max(colW, w);
      colY += h + BLOCK_GAP;
      width = Math.max(width, colX + colW);
      if (colY > rowH) {
        colX += colW + BLOCK_GAP;
        colW = 0;
        colY = 0;
      }
    }
    return {at, along: width, across: rowY + rowH};
  };
  const limits = new Set<number>();
  let sum = 0;
  for (const i of order) {
    sum += blocks[i]!.bounds.w + BLOCK_GAP;
    limits.add(sum);
  }
  let best: ReturnType<typeof arrange> | undefined;
  for (const limit of limits) {
    const tried = arrange(limit);
    if (!best || scaleFor(tried, aspect) > scaleFor(best, aspect) * 1.001) best = tried;
  }
  return best?.at ?? [];
}

// ---------------------------------------------------------------- the whole diagram
function layoutIn(spec: LayoutSpec, dir: Dir, aspect: number): Laid {
  const flip = dir === 'TB';
  const groups = new Map((spec.groups ?? []).map(group => [group.id, group]));
  const known = new Set(spec.nodes.map(node => node.id));
  const nodes: FlowNode[] = spec.nodes.map(node => ({
    id: node.id, shape: node.shape,
    w: flip ? node.h : node.w,
    h: flip ? node.w : node.h,
    group: node.group !== undefined && groups.has(node.group) ? node.group : undefined,
  }));
  const edges: FlowEdge[] = [];
  const loops: LayoutEdge[] = [];
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  for (const edge of spec.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    const label = edge.label ? (flip ? {w: edge.label.h, h: edge.label.w} : edge.label) : undefined;
    if (edge.from === edge.to) {
      loops.push(edge);
      // A self-loop runs across the flow beside its node, with its label: keep that room on both sides.
      const node = nodeById.get(edge.from)!;
      const grow = Math.max(node.grow ?? 0, LOOP_ROOM + (label ? label.h : 0));
      node.h += (grow - (node.grow ?? 0)) * 2;
      node.grow = grow;
    } else edges.push({...edge, label});
  }
  const options: FlowOptions = {nodesep: spec.nodesep ?? 24, ranksep: spec.ranksep ?? 56, wrap: spec.wrap === true, aspect: flip ? 1 / aspect : aspect, flip};

  const partOf = new Map<string, number>();
  const parts = partsOf(nodes, edges, groups);
  parts.forEach((ids, i) => { for (const id of ids) partOf.set(id, i); });
  const partEdges: FlowEdge[][] = parts.map(() => []);
  for (const edge of edges) partEdges[partOf.get(edge.from)!]!.push(edge);
  const blocks = parts.map((ids, i) => layoutPart(ids.map(id => nodeById.get(id)!), partEdges[i]!, groups, options));
  const origins = pack(blocks, options.aspect);

  const boxes = new Map<string, Box>();
  const routes = new Map<string, Route>();
  const loopPlaces = new Map<string, LoopPlace>();
  blocks.forEach((block, i) => {
    const dx = origins[i]!.x - block.bounds.x;
    const dy = origins[i]!.y - block.bounds.y;
    const move = (p: Point): Point => (flip ? {x: p.y + dy, y: p.x + dx} : {x: p.x + dx, y: p.y + dy});
    for (const [id, box] of block.boxes) {
      const moved = {x: box.x + dx, y: box.y + dy, w: box.w, h: box.h};
      boxes.set(id, flip ? flipBox(moved) : moved);
    }
    for (const [key, route] of block.routes) routes.set(key, {points: route.points.map(move), label: route.label ? move(route.label) : undefined});
    for (const [id, place] of block.loops) loopPlaces.set(id, place);
  });
  const shapeOf = new Map(spec.nodes.map(node => [node.id, node.shape]));
  for (const edge of loops) {
    const box = boxes.get(edge.from);
    if (!box) continue;
    const points = routeLoop(box, dir, {shape: shapeOf.get(edge.from), ...loopPlaces.get(edge.from)});
    routes.set(edge.key, {points, label: edge.label ? loopLabel(points, edge.label) : undefined});
  }
  placeLabels(spec.edges, boxes, routes);
  // Keep the order nodes were given in: callers iterate the map.
  const ordered = new Map<string, Box>();
  for (const node of spec.nodes) {
    const box = boxes.get(node.id);
    if (box) ordered.set(node.id, box);
  }
  return {dir, boxes: ordered, routes};
}

// ---------------------------------------------------------------- labels
/** Where along its route a label may sit: the middle of a segment first, then further out. */
const LABEL_STOPS = [0.5, 0.35, 0.65, 0.2, 0.8];
/** Space kept between a label plate and a node or another label. */
const LABEL_CLEAR = 3;

/** What a label costs where it would name a stretch of line that another edge runs along too: either could be meant. */
const SHARED_COST = 150;

const overlaps = (a: Box, b: Box, clear: number) =>
  a.x < b.x + b.w + clear && b.x < a.x + a.w + clear && a.y < b.y + b.h + clear && b.y < a.y + a.h + clear;
/** True when `p` lies on the line through `points` (within 1.5 px). */
function onRoute(points: readonly Point[], p: Point): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (p.x >= Math.min(a.x, b.x) - 1.5 && p.x <= Math.max(a.x, b.x) + 1.5 && p.y >= Math.min(a.y, b.y) - 1.5 && p.y <= Math.max(a.y, b.y) + 1.5) return true;
  }
  return false;
}
/** How much of the segment a-b runs inside `box`: 0 when it misses it, a little when it crosses, more when it runs along. */
function runInside(box: Box, a: Point, b: Point): number {
  const x0 = Math.max(Math.min(a.x, b.x), box.x);
  const x1 = Math.min(Math.max(a.x, b.x), box.x + box.w);
  const y0 = Math.max(Math.min(a.y, b.y), box.y);
  const y1 = Math.min(Math.max(a.y, b.y), box.y + box.h);
  return x1 < x0 || y1 < y0 ? -1 : Math.max(x1 - x0, y1 - y0);
}

/**
 * Moves every edge label to a place on its own route where it covers no node, no other label and no arrow head, and
 * as few other edges as can be: the middles of its segments first, then further along them, then beside the line.
 * The layout's own place wins whenever it is clear. Labels are placed in order; a label with no clear place keeps
 * the least crowded one.
 */
function placeLabels(edges: readonly LayoutEdge[], boxes: ReadonlyMap<string, Box>, routes: Map<string, Route>): void {
  const labelled = edges.filter(edge => edge.label && routes.get(edge.key)?.label);
  if (labelled.length === 0) return;
  const nodeBoxes = [...boxes.values()];
  const placed: Box[] = [];
  const others = [...routes.entries()].map(([key, route]) => ({key, points: route.points, bounds: boundsOf([], route.points)!}));
  for (const edge of labelled) {
    const route = routes.get(edge.key)!;
    const {w, h} = edge.label!;
    const plate = (c: Point): Box => ({x: c.x - w / 2, y: c.y - h / 2, w, h});
    const tip = route.points.at(-1)!;
    const tail = route.points[0]!;
    const preferred = route.label!;
    const cost = (c: Point): number => {
      const box = plate(c);
      let total = Math.hypot(c.x - preferred.x, c.y - preferred.y) / 200;
      // The stretch of its own line nearest the label is what a reader takes it to name: no other edge may run there.
      const named = nearestOn(route.points, c);
      for (const other of others) {
        if (other.key !== edge.key && overlaps({x: named.x, y: named.y, w: 0, h: 0}, other.bounds, 1.5) && onRoute(other.points, named)) total += SHARED_COST;
      }
      for (const node of nodeBoxes) if (overlaps(box, node, LABEL_CLEAR)) total += 1000;
      for (const other of placed) if (overlaps(box, other, LABEL_CLEAR)) total += 1000;
      // The ends of its own line: the arrow head and where it leaves.
      if (overlaps(box, {x: tip.x - 6, y: tip.y - 6, w: 12, h: 12}, 0) || overlaps(box, {x: tail.x - 3, y: tail.y - 3, w: 6, h: 6}, 0)) total += 200;
      for (const other of others) {
        if (other.key === edge.key || !overlaps(box, other.bounds, 0)) continue;
        const pts = other.points;
        let worst = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
          const run = runInside(box, pts[i]!, pts[i + 1]!);
          // Running along another edge's line would say the label is that edge's too; crossing it only hides a bit.
          if (run >= 0) worst = Math.max(worst, run > Math.min(w, h) + 4 ? 100 : 20);
        }
        total += worst;
      }
      return total;
    };
    let best = preferred;
    let bestCost = cost(preferred);
    if (bestCost >= 1) {
      const pts = route.points;
      for (let i = 0; i + 1 < pts.length && bestCost >= 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length < 12) continue;
        const along = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
        for (const t of LABEL_STOPS) {
          const on = {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
          // On the line, then beside it on either side.
          const shift = along ? h / 2 + 3 : w / 2 + 3;
          for (const c of [on, along ? {x: on.x, y: on.y - shift} : {x: on.x - shift, y: on.y}, along ? {x: on.x, y: on.y + shift} : {x: on.x + shift, y: on.y}]) {
            const value = cost(c) + (c === on ? 0 : 0.5);
            if (value < bestCost) {
              best = c;
              bestCost = value;
            }
          }
        }
      }
    }
    routes.set(edge.key, {points: route.points, label: best});
    placed.push(plate(best));
  }
}

/** Width and height of everything a layout drew. */
function extentOf(laid: Laid): {along: number; across: number} {
  const points: Point[] = [];
  for (const route of laid.routes.values()) for (const point of route.points) points.push(point);
  const bounds = boundsOf(laid.boxes.values(), points);
  return {along: bounds?.w ?? 0, across: bounds?.h ?? 0};
}

/**
 * Positions every node and routes every edge. Edges run with the flow from the middle of one side to the middle of
 * the next rank's facing side and turn in the gap between ranks, each turn on a track of its own; edges that span
 * several ranks pass the ranks between through waypoints the layout kept free. Without `dir` the diagram flows the
 * way that is drawn largest on a stage of `aspect`. Throws when dagre cannot lay the graph out at all.
 */
export function layoutDiagram(spec: LayoutSpec): Laid {
  const aspect = aspectStep(spec.aspect);
  if (spec.dir) return layoutIn(spec, spec.dir, aspect);
  // The zoom a stage of ordinary height shows a layout at; nothing is drawn above full size.
  const shown = (size: {along: number; across: number}) => Math.min(1, (STAGE_HEIGHT * aspect - 48) / Math.max(1, size.along), (STAGE_HEIGHT - 64) / Math.max(1, size.across));
  const across = layoutIn(spec, 'LR', aspect);
  const scale = shown(extentOf(across));
  // Left to right is what people expect: it stays unless top to bottom is drawn clearly larger.
  // A diagram this large is not seen whole either way; the second layout would only cost time.
  if (spec.nodes.length < 2 || spec.nodes.length > AUTO_DIR_NODES || scale >= 1) return across;
  const down = layoutIn(spec, 'TB', aspect);
  return shown(extentOf(down)) > scale * TB_GAIN ? down : across;
}
