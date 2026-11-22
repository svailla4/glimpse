// Geometry the diagrams still draw themselves once ELK has placed and routed everything (decision diagram-engine-in-worker): the shapes
// edges end on, the marks at their ends, elbows, and the nearest node in a direction for the arrow keys. Pure
// functions, no DOM. Routing is ELK's (graph.ts), except for an edge whose node the reader dragged somewhere no
// layout kept a way free: routeAround() finds it an orthogonal way past the other nodes and frames, and freeSpot()
// moves a dropped node off whatever it landed on.

export interface Point { x: number; y: number }
/** Top-left corner and size. */
export interface Box { x: number; y: number; w: number; h: number }
/** Flow direction: left to right, right to left, top to bottom, bottom to top. */
export type Dir = 'LR' | 'RL' | 'TB' | 'BT';
export type Shape = 'rect' | 'diamond' | 'pill' | 'store' | 'circle';
/** What is drawn where an edge meets a node. */
export type Mark = 'arrow' | 'one' | 'many' | 'none';

export const ELBOW = 6;
export const HEAD = 7;

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const n = (v: number) => String(Math.round(v * 10) / 10);

export const centerOf = (b: Box): Point => ({x: b.x + b.w / 2, y: b.y + b.h / 2});
/** True when the flow runs along x. */
export const isAcross = (dir: Dir) => dir === 'LR' || dir === 'RL';

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

/**
 * How far inside its bounding box the outline of a shape is, for a line that enters the box through a side at
 * `offset` from the middle of that side. `vertical`: the line runs up or down (it enters the top or the bottom).
 */
export function outlineInset(box: Box, shape: Shape | undefined, offset: number, vertical: boolean): number {
  const half = vertical ? box.w / 2 : box.h / 2;
  const depth = vertical ? box.h / 2 : box.w / 2;
  const t = Math.min(1, Math.abs(offset) / Math.max(1, half));
  if (shape === 'diamond') return depth * t;
  if (shape === 'circle') return depth * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
  if (shape === 'pill') {
    // The round ends are on the short sides.
    const r = Math.min(box.w, box.h) / 2;
    const rounded = vertical ? box.h > box.w : box.w >= box.h;
    if (!rounded) return 0;
    const d = Math.abs(offset);
    return d >= r ? r : r - Math.sqrt(r * r - d * d);
  }
  return 0;
}

/**
 * The route with its first and last points moved onto the outline of the shapes they meet (a diamond, a circle, the
 * round end of a pill): ELK ends edges on the bounding box. Only an end that arrives straight through a side moves,
 * along its own last segment, so the route stays orthogonal.
 */
export function clipToShapes(points: readonly Point[], from: {box: Box; shape?: Shape}, to: {box: Box; shape?: Shape}): Point[] {
  if (points.length < 2) return [...points];
  const out = points.map(p => ({...p}));
  const pull = (end: Point, next: Point, node: {box: Box; shape?: Shape}) => {
    if (!node.shape || node.shape === 'rect' || node.shape === 'store') return;
    const {box} = node;
    const c = centerOf(box);
    const vertical = near(end.x, next.x) && !near(end.y, next.y);
    const horizontal = near(end.y, next.y) && !near(end.x, next.x);
    if (vertical) {
      const top = Math.abs(end.y - box.y) < Math.abs(end.y - (box.y + box.h));
      const inset = outlineInset(box, node.shape, end.x - c.x, true);
      end.y = top ? box.y + inset : box.y + box.h - inset;
    } else if (horizontal) {
      const left = Math.abs(end.x - box.x) < Math.abs(end.x - (box.x + box.w));
      const inset = outlineInset(box, node.shape, end.y - c.y, false);
      end.x = left ? box.x + inset : box.x + box.w - inset;
    }
  };
  pull(out[0]!, out[1]!, from);
  pull(out.at(-1)!, out.at(-2)!, to);
  return out;
}

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

/** True when two boxes overlap by more than `slack` px each way. */
export const overlaps = (a: Box, b: Box, slack = 0) =>
  a.x + a.w - slack > b.x && b.x + b.w - slack > a.x && a.y + a.h - slack > b.y && b.y + b.h - slack > a.y;

/** The box grown by `m` on every side. */
export const inflate = (b: Box, m: number): Box => ({x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2});

// ---------------------------------------------------------------- routing round what is in the way

/** Room an edge keeps from a node or frame it passes, and the stub it leaves and enters a node by. */
const CLEAR = 10;
const STUB = 16;

/** True when the orthogonal segment p-q enters the inside of `box` (more than a pixel past its border). */
function segmentCrosses(p: Point, q: Point, box: Box): boolean {
  return Math.max(p.x, q.x) > box.x + 1 && Math.min(p.x, q.x) < box.x + box.w - 1 && Math.max(p.y, q.y) > box.y + 1 && Math.min(p.y, q.y) < box.y + box.h - 1;
}

/** How many of the boxes a route enters. */
export function crossings(points: readonly Point[], boxes: readonly Box[]): number {
  let n = 0;
  for (const box of boxes) {
    for (let i = 1; i < points.length; i++) {
      if (segmentCrosses(points[i - 1]!, points[i]!, box)) {
        n++;
        break;
      }
    }
  }
  return n;
}

const pathLength = (points: readonly Point[]) => {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.abs(points[i]!.x - points[i - 1]!.x) + Math.abs(points[i]!.y - points[i - 1]!.y);
  return total;
};

/** Where an edge leaves (or enters) a box by one of its sides: the side's middle, or a row's height for a port. */
interface End { at: Point; out: Point }
function endsOf(box: Box, port: number | undefined, sides: ReadonlyArray<'left' | 'right' | 'top' | 'bottom'>): End[] {
  const c = centerOf(box);
  return sides.map(side => {
    const y = port !== undefined ? box.y + port : c.y;
    switch (side) {
      case 'left': return {at: {x: box.x, y}, out: {x: -1, y: 0}};
      case 'right': return {at: {x: box.x + box.w, y}, out: {x: 1, y: 0}};
      case 'top': return {at: {x: c.x, y: box.y}, out: {x: 0, y: -1}};
      default: return {at: {x: c.x, y: box.y + box.h}, out: {x: 0, y: 1}};
    }
  });
}

/** Orthogonal joins of two stubs: one bend, two bends through the middle, or a lane at `lane` across both. */
function joins(p: Point, q: Point, lanesX: readonly number[], lanesY: readonly number[]): Point[][] {
  const out: Point[][] = [[p, {x: q.x, y: p.y}, q], [p, {x: p.x, y: q.y}, q]];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  out.push([p, {x: mx, y: p.y}, {x: mx, y: q.y}, q], [p, {x: p.x, y: my}, {x: q.x, y: my}, q]);
  for (const x of lanesX) out.push([p, {x, y: p.y}, {x, y: q.y}, q]);
  for (const y of lanesY) out.push([p, {x: p.x, y}, {x: q.x, y}, q]);
  return out;
}

export interface Obstacles {
  /** Nodes the edge must not cross: every node but its two ends. */
  nodes: readonly Box[];
  /** Frames of groups neither end is in: crossing one is better avoided, crossing a node more so. */
  frames?: readonly Box[];
}

/**
 * An orthogonal route from box `a` to box `b` for an edge that cannot keep ELK's route (one of its nodes was dragged):
 * of the routes that leave and enter by a side (`fromPort`/`toPort`: a table row's height, on the left or right
 * side only) and join with one or two bends, or by a lane just outside everything in the way, the one that crosses
 * the fewest nodes, then the fewest frames, then the shortest with the fewest bends. When every such route still
 * crosses a node, a grid search round the obstacles near the two ends is tried.
 */
export function routeAround(a: Box, b: Box, obstacles: Obstacles, ports: {fromPort?: number; toPort?: number} = {}): Point[] {
  const all: ReadonlyArray<'left' | 'right' | 'top' | 'bottom'> = ['right', 'left', 'bottom', 'top'];
  const fromEnds = endsOf(a, ports.fromPort, ports.fromPort !== undefined ? ['right', 'left'] : all);
  const toEnds = endsOf(b, ports.toPort, ports.toPort !== undefined ? ['left', 'right'] : all);
  const frames = obstacles.frames ?? [];
  const nodes = obstacles.nodes;
  const score = (points: readonly Point[]) => {
    const own = crossings(points.slice(1, -1), [a, b]);
    return crossings(points, nodes) * 100000 + own * 50000 + crossings(points, frames) * 2000 + pathLength(points) + points.length * 24;
  };
  let best: Point[] = [];
  let bestScore = Infinity;
  const consider = (points: Point[]) => {
    const route = simplify(points);
    const s = score(route);
    if (s < bestScore) {
      best = route;
      bestScore = s;
    }
  };
  for (const from of fromEnds) {
    for (const to of toEnds) {
      const p = {x: from.at.x + from.out.x * STUB, y: from.at.y + from.out.y * STUB};
      const q = {x: to.at.x + to.out.x * STUB, y: to.at.y + to.out.y * STUB};
      // Lanes just outside what the straight joins run into, on either side.
      const blocking = [...nodes, ...frames].filter(box => joins(p, q, [], []).some(j => crossings(j, [box]) > 0));
      const around = [a, b, ...blocking];
      const lanesX = [Math.min(...around.map(box => box.x)) - CLEAR, Math.max(...around.map(box => box.x + box.w)) + CLEAR];
      const lanesY = [Math.min(...around.map(box => box.y)) - CLEAR, Math.max(...around.map(box => box.y + box.h)) + CLEAR];
      for (const box of blocking) {
        lanesX.push(box.x - CLEAR, box.x + box.w + CLEAR);
        lanesY.push(box.y - CLEAR, box.y + box.h + CLEAR);
      }
      for (const join of joins(p, q, lanesX, lanesY)) consider([from.at, ...join, to.at]);
    }
  }
  if (crossings(best, nodes) > 0 || crossings(best.slice(1, -1), [a, b]) > 0) {
    const searched = gridRoute(a, b, fromEnds, toEnds, nodes);
    if (searched && score(searched) < bestScore) best = searched;
  }
  return best;
}

/** Above this many obstacles near the two ends the grid search is not tried (it stays within a few ms below). */
const GRID_MAX = 40;

/** A binary min-heap of (priority, value) pairs. */
class Heap {
  private readonly items: Array<[number, number]> = [];
  get size(): number {
    return this.items.length;
  }
  push(priority: number, value: number): void {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (items[up]![0] <= items[i]![0]) break;
      [items[up], items[i]] = [items[i]!, items[up]!];
      i = up;
    }
  }
  pop(): [number, number] {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l]![0] < items[m]![0]) m = l;
        if (r < items.length && items[r]![0] < items[m]![0]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The shortest orthogonal route with the fewest bends between the stubs of two boxes, over the grid of lines just
 * outside every obstacle near them; undefined when there is none or too much is in the way.
 */
function gridRoute(a: Box, b: Box, fromEnds: readonly End[], toEnds: readonly End[], nodes: readonly Box[]): Point[] | undefined {
  const span = boundsOf([a, b])!;
  const reach = Math.max(160, span.w / 2, span.h / 2);
  const area = inflate(span, reach);
  const near = nodes.filter(box => overlaps(box, area)).map(box => inflate(box, CLEAR - 2));
  if (near.length > GRID_MAX) return undefined;
  const walls = [...near, inflate(a, CLEAR - 2), inflate(b, CLEAR - 2)];
  const xs = new Set<number>();
  const ys = new Set<number>();
  const starts = fromEnds.map(end => ({end, p: {x: end.at.x + end.out.x * STUB, y: end.at.y + end.out.y * STUB}}));
  const goals = toEnds.map(end => ({end, p: {x: end.at.x + end.out.x * STUB, y: end.at.y + end.out.y * STUB}}));
  for (const {p} of [...starts, ...goals]) {
    xs.add(p.x);
    ys.add(p.y);
  }
  for (const box of walls) {
    xs.add(box.x - 2).add(box.x + box.w + 2);
    ys.add(box.y - 2).add(box.y + box.h + 2);
  }
  const X = [...xs].sort((u, v) => u - v);
  const Y = [...ys].sort((u, v) => u - v);
  const inside = (x: number, y: number) => walls.some(box => x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h);
  const blocked = (p: Point, q: Point) => walls.some(box => segmentCrosses(p, q, box));
  const key = (i: number, j: number, d: number) => (i * Y.length + j) * 4 + d;
  const ix = new Map(X.map((x, i) => [x, i]));
  const iy = new Map(Y.map((y, j) => [y, j]));
  // Dijkstra over (point, heading); a bend costs as much as 24 px of line.
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const queue = new Heap();
  const push = (k: number, d: number, from: number | undefined) => {
    if (d >= (dist.get(k) ?? Infinity)) return;
    dist.set(k, d);
    if (from !== undefined) prev.set(k, from);
    queue.push(d, k);
  };
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (const {p, end} of starts) {
    const i = ix.get(p.x);
    const j = iy.get(p.y);
    if (i === undefined || j === undefined || inside(p.x, p.y)) continue;
    const d = steps.findIndex(([dx, dy]) => dx === end.out.x && dy === end.out.y);
    push(key(i, j, d), 0, undefined);
  }
  const goalAt = new Map<number, End>();
  for (const {p, end} of goals) {
    const i = ix.get(p.x);
    const j = iy.get(p.y);
    if (i !== undefined && j !== undefined) goalAt.set(i * Y.length + j, end);
  }
  let found: number | undefined;
  while (queue.size > 0) {
    const [d, k] = queue.pop();
    if (d > (dist.get(k) ?? Infinity)) continue;
    const cell = Math.floor(k / 4);
    const heading = k % 4;
    const i = Math.floor(cell / Y.length);
    const j = cell % Y.length;
    const goal = goalAt.get(cell);
    // Arrive heading into the target's side (opposite to the way its stub leaves it).
    if (goal && steps[heading]![0] === -goal.out.x && steps[heading]![1] === -goal.out.y) {
      found = k;
      break;
    }
    steps.forEach(([dx, dy], h) => {
      const ni = i + dx;
      const nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length) return;
      const p = {x: X[i]!, y: Y[j]!};
      const q = {x: X[ni]!, y: Y[nj]!};
      if (inside(q.x, q.y) || blocked(p, q)) return;
      push(key(ni, nj, h), d + Math.abs(q.x - p.x) + Math.abs(q.y - p.y) + (h === heading ? 0 : 24), k);
    });
  }
  if (found === undefined) return undefined;
  const cells: Point[] = [];
  for (let k: number | undefined = found; k !== undefined; k = prev.get(k)) {
    const cell = Math.floor(k / 4);
    cells.push({x: X[Math.floor(cell / Y.length)]!, y: Y[cell % Y.length]!});
  }
  cells.reverse();
  const first = cells[0]!;
  const last = cells.at(-1)!;
  const from = starts.find(s => s.p.x === first.x && s.p.y === first.y)!.end;
  const to = goals.find(g => g.p.x === last.x && g.p.y === last.y)!.end;
  return simplify([from.at, ...cells, to.at]);
}

/** How close outside a frame's line a stretch of edge runs to read as a second line of that frame. */
const HUG = 24;

/**
 * True when a route runs just outside a group frame, along one of its sides, for half that side or more: ELK routes an
 * edge between parts of the drawing round a group's frame, and drawn at full strength such an edge reads as a second
 * frame (a2ui focus graph: dark lines on all four sides of the frame).
 */
export function runsAlongFrame(points: readonly Point[], frames: Iterable<Box>): boolean {
  const list = [...frames];
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const horizontal = Math.abs(p.y - q.y) < 0.5;
    const vertical = Math.abs(p.x - q.x) < 0.5;
    if (!horizontal && !vertical) continue;
    for (const f of list) {
      if (horizontal) {
        const near = (p.y > f.y - HUG && p.y < f.y + 2) || (p.y > f.y + f.h - 2 && p.y < f.y + f.h + HUG);
        const along = Math.min(Math.max(p.x, q.x), f.x + f.w) - Math.max(Math.min(p.x, q.x), f.x);
        if (near && along >= f.w / 2) return true;
      } else {
        const near = (p.x > f.x - HUG && p.x < f.x + 2) || (p.x > f.x + f.w - 2 && p.x < f.x + f.w + HUG);
        const along = Math.min(Math.max(p.y, q.y), f.y + f.h) - Math.max(Math.min(p.y, q.y), f.y);
        if (near && along >= f.h / 2) return true;
      }
    }
  }
  return false;
}

/** The middle of the longest stretch of a route: where a label goes on a route ELK did not draw. */
export function longestStretchMiddle(points: readonly Point[]): Point {
  let best = points[0] ?? {x: 0, y: 0};
  let longest = -1;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const length = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    if (length > longest) {
      longest = length;
      best = {x: (p.x + q.x) / 2, y: (p.y + q.y) / 2};
    }
  }
  return best;
}

/**
 * The place nearest `box` where it overlaps none of `blockers` (each kept `gap` px away) and `fits` agrees: `box` itself
 * when it is free, else a place beside one of the blockers, or beside two (moved twice). Undefined when none is found.
 */
export function freeSpot(box: Box, blockers: readonly Box[], gap: number, fits: (at: Box) => boolean = () => true): Box | undefined {
  const free = (at: Box) => !blockers.some(other => overlaps(inflate(other, gap - 0.5), at)) && fits(at);
  if (free(box)) return box;
  const beside = (from: Box): Box[] => blockers.filter(other => overlaps(inflate(other, gap * 4), from)).flatMap(other => [
    {...from, x: other.x - gap - from.w},
    {...from, x: other.x + other.w + gap},
    {...from, y: other.y - gap - from.h},
    {...from, y: other.y + other.h + gap},
  ]);
  const distance = (at: Box) => Math.hypot(at.x - box.x, at.y - box.y);
  let tried = beside(box);
  for (let round = 0; round < 3 && tried.length > 0; round++) {
    const ok = tried.filter(free).sort((p, q) => distance(p) - distance(q));
    if (ok.length > 0) return ok[0];
    // Moved beside one blocker it may sit on another: try beside those too, nearest first.
    tried = tried.sort((p, q) => distance(p) - distance(q)).slice(0, 12).flatMap(beside);
  }
  return undefined;
}
