// Layered layout for the node-link diagrams, and the orthogonal routes that follow from it. Pure: the React side
// (useLayout.ts) decides when to run it.
//
// What is ours and what is dagre's:
//   1. Parts that nothing connects are laid out one by one and packed into the shape of the stage.
//   2. Ranks are ours: dependency depth, sources pulled next to what they feed, and (for Graph) ranks that would make
//      the picture far longer across the flow than the stage is are wrapped into more ranks.
//   3. Edges that span several ranks run through waypoints. Edges that leave one node, or arrive at one node, share
//      their waypoints, so a hub has one trunk instead of twenty parallel lines.
//   4. dagre orders every rank (fewest crossings, clusters kept together) and places nodes across the flow.
//   5. The gaps between ranks are ours again: every turn gets a track of its own in the gap, edges only share a
//      track when they share an end (a star is unambiguous, a merged trunk is not), tracks are ordered for the
//      fewest crossings, and a gap is as wide as its tracks need.
// Everything is computed for a left-to-right flow; a top-to-bottom diagram is laid out transposed and turned back.
import {Graph, layout as dagreLayout} from '@dagrejs/dagre';
import {
  LANE, boundsOf, centerOf, inset, routeEdge, routeLoop, simplify, straightSided,
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
const VIA_SEP = 6;
/** Distance between two tracks in a gap... */
const TRACK = 7;
/** ...until the gap would grow past this; then the tracks move closer together, down to TRACK_MIN. */
const GAP_MAX = 112;
/** Closer than this, two parallel runs read as one line. */
const TRACK_MIN = 4;
/** From a rank to the first track: an arrow head, an elbow and the padding of a group frame. */
const TRACK_MARGIN = 16;
/** Two turns may share a track when this much lies between them. */
const TRACK_CLEAR = 12;
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
const pairKey = (a: string, b: string) => `${a}\u0001${b}`;

interface FlowNode { id: string; w: number; h: number; shape?: Shape; group?: string }
interface FlowEdge { key: string; from: string; to: string; label?: {w: number; h: number}; fromPort?: number; toPort?: number }
interface FlowOptions { nodesep: number; ranksep: number; wrap: boolean; aspect: number }
interface Block { boxes: Map<string, Box>; routes: Map<string, Route>; bounds: Box }

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
}

function layoutPart(nodes: readonly FlowNode[], edges: readonly FlowEdge[], groups: ReadonlyMap<string, LayoutGroup>, o: FlowOptions): Block {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const first = nodes[0]!;
  if (nodes.length === 1) {
    const box = {x: 0, y: 0, w: first.w, h: first.h};
    return {boxes: new Map([[first.id, box]]), routes: new Map(), bounds: box};
  }
  const dag = toDag(nodes.map(node => node.id), edges.map(edge => [edge.from, edge.to] as const));
  const rank = chooseRanks(byId, dag, o);

  // ---- every edge from its lower rank to its higher one
  const clampPort = (node: FlowNode, offset: number) => Math.max(-(node.h / 2 - 3), Math.min(node.h / 2 - 3, offset));
  const links: Link[] = edges.map(edge => {
    const rev = rank.get(edge.to)! < rank.get(edge.from)!;
    const ported = edge.fromPort !== undefined || edge.toPort !== undefined;
    const lane = rev && !ported ? LANE : 0;
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
  let loose = links.filter(link => span(link) >= 2);
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
  for (const link of links) {
    if (!paths.has(link)) paths.set(link, [segment(NODE + link.lo, NODE + link.hi, 1, `d${link.loOff}:${link.hiOff}`)]);
    const firstSegment = paths.get(link)![0]!;
    const label = link.edge.label;
    if (label) firstSegment.label = {w: Math.max(firstSegment.label?.w ?? 0, label.w), h: Math.max(firstSegment.label?.h ?? 0, label.h)};
  }

  // ---- dagre: order within the ranks and positions across the flow
  // Nodes are padded by half the node gap and dagre's own gap is zero, so an edge passing between two nodes of a
  // rank uses the gap that is there instead of adding to it.
  const pad = o.nodesep / 2;
  const run = (compound: boolean) => {
    const g = new Graph({compound, multigraph: true});
    g.setGraph({rankdir: 'LR', nodesep: 0, ranksep: o.ranksep, edgesep: VIA_SEP, marginx: 0, marginy: 0});
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
    dagreLayout(g);
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
    place.set(NODE + node.id, {band, y: p.y});
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
  for (const link of links) {
    link.stations = [NODE + link.lo];
    for (const s of paths.get(link)!) link.stations.push(...inner.get(s.id)!, s.w);
  }

  // ---- hops: one per pair of neighbouring stations, shared by every edge that runs through both
  const hops = new Map<string, Hop>();
  const labelRoom = new Array<number>(merged.length).fill(0);
  const fallback = new Set<Link>();
  for (const link of links) {
    const ys = link.stations.map(id => place.get(id)!.y);
    ys[0] = ys[0]! + link.loOff;
    ys[ys.length - 1] = ys.at(-1)! + link.hiOff;
    const lo = byId.get(link.lo)!;
    const hi = byId.get(link.hi)!;
    // Two nodes that are almost level: meet in the middle with one straight line instead of a cramped double bend.
    if (link.stations.length === 2 && !link.ported && straightSided(lo.shape) && straightSided(hi.shape)) {
      const step = ys[1]! - ys[0]!;
      const slack = Math.min(lo.h / 2 - 4 - Math.abs(link.loOff), hi.h / 2 - 4 - Math.abs(link.hiOff));
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
    if (link.edge.label && !fallback.has(link)) labelRoom[link.hops[0]!.channel] = Math.max(labelRoom[link.hops[0]!.channel]!, link.edge.label.w + 20);
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
    const gap = Math.max(o.ranksep, TRACK_MARGIN * 2 + lanes * pitch, labelRoom[band]!);
    const middle = start[band]! + width[band]! + gap / 2;
    for (const net of nets) for (const hop of net.hops) hop.x = middle + (net.track - lanes / 2) * pitch;
    if (band + 1 < merged.length) start[band + 1] = start[band]! + width[band]! + gap;
  }

  // ---- geometry
  const boxes = new Map<string, Box>();
  for (const node of nodes) {
    const p = place.get(NODE + node.id)!;
    boxes.set(node.id, {x: start[p.band]! + (width[p.band]! - node.w) / 2, y: p.y - node.h / 2, w: node.w, h: node.h});
  }
  const routes = new Map<string, Route>();
  for (const link of links) {
    const a = boxes.get(link.lo)!;
    const b = boxes.get(link.hi)!;
    let points: Point[];
    let label: Point | undefined;
    if (fallback.has(link) || link.hops.length === 0) {
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
      // The label sits where the edge leaves its source: on the first turn, or in the first gap of a straight run.
      if (link.edge.label) {
        const gapFrom = start[firstHop.channel]! + width[firstHop.channel]!;
        const gapTo = firstHop.channel + 1 < merged.length ? start[firstHop.channel + 1]! : gapFrom + o.ranksep;
        label = firstHop.x !== undefined ? {x: firstHop.x, y: (firstHop.y0 + firstHop.y1) / 2} : {x: (Math.max(gapFrom, head.x) + Math.min(gapTo, tail.x)) / 2, y: firstHop.y0};
      }
    }
    routes.set(link.edge.key, {points: link.rev ? points.reverse() : points, label});
  }
  const all: Point[] = [];
  for (const route of routes.values()) for (const point of route.points) all.push(point);
  const drawn = boundsOf(boxes.values(), all)!;
  const framed = grouped ? {x: drawn.x - FRAME_PAD, y: drawn.y - FRAME_PAD, w: drawn.w + FRAME_PAD * 2, h: drawn.h + FRAME_PAD * 2} : drawn;
  return {boxes, routes, bounds: framed};
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
  for (const edge of spec.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    if (edge.from === edge.to) loops.push(edge);
    else edges.push({...edge, label: edge.label ? (flip ? {w: edge.label.h, h: edge.label.w} : edge.label) : undefined});
  }
  const options: FlowOptions = {nodesep: spec.nodesep ?? 24, ranksep: spec.ranksep ?? 56, wrap: spec.wrap === true, aspect: flip ? 1 / aspect : aspect};

  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const partOf = new Map<string, number>();
  const parts = partsOf(nodes, edges, groups);
  parts.forEach((ids, i) => { for (const id of ids) partOf.set(id, i); });
  const partEdges: FlowEdge[][] = parts.map(() => []);
  for (const edge of edges) partEdges[partOf.get(edge.from)!]!.push(edge);
  const blocks = parts.map((ids, i) => layoutPart(ids.map(id => nodeById.get(id)!), partEdges[i]!, groups, options));
  const origins = pack(blocks, options.aspect);

  const boxes = new Map<string, Box>();
  const routes = new Map<string, Route>();
  blocks.forEach((block, i) => {
    const dx = origins[i]!.x - block.bounds.x;
    const dy = origins[i]!.y - block.bounds.y;
    const move = (p: Point): Point => (flip ? {x: p.y + dy, y: p.x + dx} : {x: p.x + dx, y: p.y + dy});
    for (const [id, box] of block.boxes) {
      const moved = {x: box.x + dx, y: box.y + dy, w: box.w, h: box.h};
      boxes.set(id, flip ? flipBox(moved) : moved);
    }
    for (const [key, route] of block.routes) routes.set(key, {points: route.points.map(move), label: route.label ? move(route.label) : undefined});
  });
  for (const edge of loops) {
    const box = boxes.get(edge.from);
    if (!box) continue;
    const points = routeLoop(box, dir);
    routes.set(edge.key, {points, label: edge.label ? points[2] : undefined});
  }
  // Keep the order nodes were given in: callers iterate the map.
  const ordered = new Map<string, Box>();
  for (const node of spec.nodes) {
    const box = boxes.get(node.id);
    if (box) ordered.set(node.id, box);
  }
  return {dir, boxes: ordered, routes};
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
