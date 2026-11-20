// Orthogonal edge geometry shared by Graph, Flowchart and ERDiagram. Pure functions, no DOM.
// Routing is written once for a left-to-right flow (main axis x, cross axis y); a top-to-bottom diagram is routed
// in the transposed space and transposed back.

export interface Point { x: number; y: number }
/** Top-left corner and size. */
export interface Box { x: number; y: number; w: number; h: number }
export type Dir = 'LR' | 'TB';
export type Shape = 'rect' | 'diamond' | 'pill' | 'store' | 'circle';
/** What is drawn where an edge meets a node. */
export type Mark = 'arrow' | 'one' | 'many' | 'none';

/** Room two facing sides need before an edge can leave one and enter the other with a dogleg between them. */
const CLEARANCE = 24;
/** Sideways shift of an edge that runs against the flow, so `a -> b` and `b -> a` stay two lines. */
const LANE = 8;
export const ELBOW = 6;
export const HEAD = 7;

const flipPoint = (p: Point): Point => ({x: p.y, y: p.x});
const flipBox = (b: Box): Box => ({x: b.y, y: b.x, w: b.h, h: b.w});
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

export const centerOf = (b: Box): Point => ({x: b.x + b.w / 2, y: b.y + b.h / 2});

/** How far the outline of a shape sits inside its bounding box, on a main-axis side, at `offset` from the centre line. */
function inset(box: Box, shape: Shape | undefined, offset: number): number {
  const d = Math.abs(offset);
  if (d === 0) return 0;
  if (shape === 'diamond') return box.h > 0 ? (box.w / 2) * Math.min(1, d / (box.h / 2)) : 0;
  if (shape === 'circle') {
    const r = box.w / 2;
    return d >= r ? r : r - Math.sqrt(r * r - d * d);
  }
  return 0;
}

const straightSided = (shape: Shape | undefined) => shape === undefined || shape === 'rect' || shape === 'store';

/** Drops repeated points and the middle of three points on one line. */
export function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && near(last.x, p.x) && near(last.y, p.y)) continue;
    const before = out.at(-2);
    if (last && before && ((near(before.x, last.x) && near(last.x, p.x)) || (near(before.y, last.y) && near(last.y, p.y)))) out.pop();
    out.push(p);
  }
  return out;
}

export interface RouteOptions {
  dir: Dir;
  /** Waypoints from the layout, source to target (a long edge steering around the ranks it crosses). */
  via?: readonly Point[];
  /** Main-axis position of the cross segment between two main-axis positions. Default: halfway. */
  channel?: (from: number, to: number) => number;
  fromShape?: Shape;
  toShape?: Shape;
  /** Cross-axis offsets from the box centres (a column row of a table). An edge with a port never takes a lane. */
  fromPort?: number;
  toPort?: number;
}

function routeLR(a: Box, b: Box, o: RouteOptions): Point[] {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const forward = b.x - (a.x + a.w) >= CLEARANCE;
  const backward = !forward && a.x - (b.x + b.w) >= CLEARANCE;
  if (forward || backward) {
    const ported = o.fromPort !== undefined || o.toPort !== undefined;
    const lane = backward && !ported ? LANE : 0;
    const port = (box: Box, offset: number) => Math.max(-(box.h / 2 - 3), Math.min(box.h / 2 - 3, offset));
    let fromOffset = port(a, o.fromPort ?? lane);
    let toOffset = port(b, o.toPort ?? lane);
    // Two nodes that are almost level: meet in the middle with one straight line instead of a cramped double bend.
    if (!ported && (o.via?.length ?? 0) === 0 && straightSided(o.fromShape) && straightSided(o.toShape)) {
      const step = bc.y + toOffset - (ac.y + fromOffset);
      const slack = Math.min(a.h / 2 - 4 - Math.abs(fromOffset), b.h / 2 - 4 - Math.abs(toOffset));
      if (Math.abs(step) > 0.5 && Math.abs(step) / 2 <= slack) {
        fromOffset += step / 2;
        toOffset -= step / 2;
      }
    }
    const start: Point = {
      x: forward ? a.x + a.w - inset(a, o.fromShape, fromOffset) : a.x + inset(a, o.fromShape, fromOffset),
      y: ac.y + fromOffset,
    };
    const end: Point = {
      x: forward ? b.x + inset(b, o.toShape, toOffset) : b.x + b.w - inset(b, o.toShape, toOffset),
      y: bc.y + toOffset,
    };
    const out: Point[] = [start];
    // An edge against the flow keeps its lane all the way, so it stays one straight run next to the waypoints.
    const via = lane === 0 ? (o.via ?? []) : (o.via ?? []).map(p => ({x: p.x, y: p.y + lane}));
    for (const q of [...via, end]) {
      const p = out.at(-1)!;
      if (near(p.y, q.y)) {
        out.push({x: q.x, y: p.y});
        continue;
      }
      const lo = Math.min(p.x, q.x);
      const hi = Math.max(p.x, q.x);
      const wanted = (o.channel ? o.channel(p.x, q.x) : (p.x + q.x) / 2) + lane * Math.sign(q.y - p.y);
      const x = hi - lo > 4 ? Math.max(lo + 2, Math.min(hi - 2, wanted)) : (lo + hi) / 2;
      out.push({x, y: p.y}, {x, y: q.y}, {x: q.x, y: q.y});
    }
    return simplify(out);
  }
  const below = b.y - (a.y + a.h) >= CLEARANCE;
  const above = !below && a.y - (b.y + b.h) >= CLEARANCE;
  if (below || above) {
    const start: Point = {x: ac.x, y: below ? a.y + a.h : a.y};
    const end: Point = {x: bc.x, y: below ? b.y : b.y + b.h};
    const y = (start.y + end.y) / 2;
    return simplify([start, {x: start.x, y}, {x: end.x, y}, end]);
  }
  // The boxes touch or overlap: nothing sensible to route, so join the borders along the centre line.
  return [borderPoint(a, bc), borderPoint(b, ac)];
}

/** Where the segment from the centre of `box` towards `to` crosses its border. */
function borderPoint(box: Box, to: Point): Point {
  const c = centerOf(box);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
  return {x: c.x + dx * Math.min(1, t), y: c.y + dy * Math.min(1, t)};
}

/**
 * Corner points of an orthogonal edge from box `a` to box `b`. With the flow it leaves the far side of `a` and
 * enters the near side of `b` at their middles, so edges of one node share a trunk; against the flow it runs the
 * other way round, one lane over. Boxes stacked across the flow connect through their facing sides.
 */
export function routeEdge(a: Box, b: Box, options: RouteOptions): Point[] {
  if (options.dir === 'LR') return routeLR(a, b, options);
  const flipped = routeLR(flipBox(a), flipBox(b), {...options, via: options.via?.map(flipPoint)});
  return flipped.map(flipPoint);
}

/** An edge from a node to itself: a small loop off the far corner. */
export function routeLoop(box: Box, dir: Dir): Point[] {
  const b = dir === 'LR' ? box : flipBox(box);
  const c = centerOf(b);
  const reach = Math.min(16, b.w / 2 - 4);
  const points: Point[] = [
    {x: b.x + b.w, y: c.y - Math.min(6, b.h / 2 - 2)},
    {x: b.x + b.w + 18, y: c.y - Math.min(6, b.h / 2 - 2)},
    {x: b.x + b.w + 18, y: b.y - 14},
    {x: c.x + reach, y: b.y - 14},
    {x: c.x + reach, y: b.y},
  ];
  return dir === 'LR' ? points : points.map(flipPoint);
}

// ---------------------------------------------------------------- ranks
export interface Band { from: number; to: number }

/** The stretches of the main axis that nodes occupy (one per rank after a layered layout), in order. */
export function bandsOf(boxes: Iterable<Box>, dir: Dir): Band[] {
  const spans: Band[] = [];
  for (const b of boxes) spans.push(dir === 'LR' ? {from: b.x, to: b.x + b.w} : {from: b.y, to: b.y + b.h});
  spans.sort((p, q) => p.from - q.from);
  const out: Band[] = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last && span.from <= last.to + 0.5) last.to = Math.max(last.to, span.to);
    else out.push({...span});
  }
  return out;
}

export function inBand(bands: readonly Band[], at: number): boolean {
  let lo = 0;
  let hi = bands.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const band = bands[mid]!;
    if (at < band.from - 0.5) hi = mid - 1;
    else if (at > band.to + 0.5) lo = mid + 1;
    else return true;
  }
  return false;
}

/** A `channel` for routeEdge that puts cross segments in the middle of the free gap between two ranks. */
export function channelBetween(bands: readonly Band[]): (from: number, to: number) => number {
  return (from, to) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let i = 0; i + 1 < bands.length; i++) {
      const gapFrom = bands[i]!.to;
      const gapTo = bands[i + 1]!.from;
      if (gapTo <= lo) continue;
      if (gapFrom >= hi) break;
      const middle = (gapFrom + gapTo) / 2;
      if (middle > lo && middle < hi) return middle;
    }
    return (lo + hi) / 2;
  };
}

// ---------------------------------------------------------------- paths
const n = (v: number) => String(Math.round(v * 10) / 10);
const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** SVG path through the points with `radius` elbows (shorter where a segment is too short for two of them). */
export function roundedPath(points: readonly Point[], radius = ELBOW): string {
  const first = points[0];
  if (!first) return '';
  let d = `M${n(first.x)} ${n(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const cur = points[i]!;
    const next = points[i + 1];
    if (!next) {
      d += `L${n(cur.x)} ${n(cur.y)}`;
      break;
    }
    const prev = points[i - 1]!;
    const before = dist(prev, cur);
    const after = dist(cur, next);
    const r = Math.min(radius, before / 2, after / 2);
    if (r < 0.5) {
      d += `L${n(cur.x)} ${n(cur.y)}`;
      continue;
    }
    const ax = cur.x - ((cur.x - prev.x) / before) * r;
    const ay = cur.y - ((cur.y - prev.y) / before) * r;
    const bx = cur.x + ((next.x - cur.x) / after) * r;
    const by = cur.y + ((next.y - cur.y) / after) * r;
    d += `L${n(ax)} ${n(ay)}Q${n(cur.x)} ${n(cur.y)} ${n(bx)} ${n(by)}`;
  }
  return d;
}

/**
 * The mark at the end of an edge, as an SVG path: `tip` is where the edge meets the node, `from` the corner before
 * it. `arrow` is an open chevron, `one` a bar across the line, `many` a crow's foot opening onto the node.
 */
export function markPath(mark: Mark, tip: Point | undefined, from: Point | undefined): string {
  if (!tip || !from || mark === 'none') return '';
  const length = dist(from, tip);
  if (length === 0) return '';
  const ux = (tip.x - from.x) / length;
  const uy = (tip.y - from.y) / length;
  const at = (along: number, across: number) => `${n(tip.x - ux * along - uy * across)} ${n(tip.y - uy * along + ux * across)}`;
  if (mark === 'arrow') return `M${at(HEAD, 3.5)}L${at(0, 0)}L${at(HEAD, -3.5)}`;
  if (mark === 'one') return `M${at(8, 5)}L${at(8, -5)}`;
  return `M${at(0, 5)}L${at(10, 0)}L${at(0, -5)}`;
}

/** The point halfway along a polyline. */
export function midpoint(points: readonly Point[]): Point {
  const first = points[0];
  if (!first) return {x: 0, y: 0};
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = dist(a, b);
    if (len >= left && len > 0) return {x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len};
    left -= len;
  }
  return points.at(-1) ?? first;
}

/** The point of a polyline closest to `p`. */
export function nearestOn(points: readonly Point[], p: Point): Point {
  let best = points[0] ?? p;
  let bestDistance = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = {x: a.x + dx * t, y: a.y + dy * t};
    const d = dist(p, q);
    if (d < bestDistance) {
      bestDistance = d;
      best = q;
    }
  }
  return best;
}

/**
 * Where an edge's label goes: the middle of a segment that runs across the flow (the stretch an edge shares least
 * with its siblings, which leave and arrive along the flow), the one nearest to `hint` when the layout suggests a
 * place. A straight edge takes the hint itself, or its own middle.
 */
export function labelAnchor(points: readonly Point[], dir: Dir, hint?: Point): Point {
  let best: Point | undefined;
  let bestScore = -Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const across = dir === 'LR' ? near(a.x, b.x) && !near(a.y, b.y) : near(a.y, b.y) && !near(a.x, b.x);
    if (!across) continue;
    const middle = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
    const score = hint ? -dist(middle, hint) : dist(a, b);
    if (score > bestScore) {
      bestScore = score;
      best = middle;
    }
  }
  return best ?? (hint ? nearestOn(points, hint) : midpoint(points));
}

/**
 * The node whose centre is nearest in one direction (`dx`, `dy` is a unit step along an axis), for arrow-key
 * traversal: distance along the direction counts once, distance across it twice.
 */
export function nearestInDirection(boxes: ReadonlyMap<string, Box>, from: string, dx: number, dy: number): string | undefined {
  const origin = boxes.get(from);
  if (!origin) return undefined;
  const c = centerOf(origin);
  let best: string | undefined;
  let bestScore = Infinity;
  for (const [id, box] of boxes) {
    if (id === from) continue;
    const q = centerOf(box);
    const along = (q.x - c.x) * dx + (q.y - c.y) * dy;
    if (along <= 0.5) continue;
    const across = Math.abs((q.x - c.x) * dy) + Math.abs((q.y - c.y) * dx);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** The smallest box around boxes and points, or undefined when there is nothing. */
export function boundsOf(boxes: Iterable<Box>, points: Iterable<Point> = []): Box | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return Number.isFinite(x0) ? {x: x0, y: y0, w: x1 - x0, h: y1 - y0} : undefined;
}
