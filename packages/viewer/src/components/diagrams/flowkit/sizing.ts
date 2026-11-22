// How tall a diagram is and what it opens on (decision content-sized-plates). ELK gives the size of the drawing before anything is
// drawn, so this is one pass with no measuring loop. The diagram is a canvas with the controls bar under it:
//   - The canvas is as tall as the drawing at the scale that fits the width (never above 100%), and the whole is
//     clamped to [MIN_HEIGHT, cap], where cap is the size step's maximum (useSizeCap: 640 px without one).
//   - When the whole drawing fits the canvas at a zoom where its text is still readable (`floor`: 10 px on screen),
//     it opens fitted and centred, every node inside.
//   - Only otherwise does it open at the readable zoom on a window of it, never showing the void past the drawing; the
//     reader pans and zooms from there, with the minimap. The window is chosen in two dimensions: the one that shows
//     the most nodes whole, a node cut at an edge counting against it (so a node the window cannot hold is moved past
//     the edge rather than sliced), near the start of the flow and the anchor across it. A stretched, empty group
//     frame at the start of the drawing therefore no longer pins the view. The canvas then ends between two rows of
//     nodes instead of through one.
import type {Box, Dir, Point} from './geometry.ts';

/** Paper kept round a fitted drawing. */
export const PAD = 16;
/** The bar under the canvas that holds the zoom controls. */
export const CONTROLS = 32;
export const MIN_HEIGHT = 140;
/** On-screen text is never smaller than this when a diagram opens (design rule diagrams-open-readable). */
export const MIN_SCREEN_TEXT = 10;
/** 12 px text is 10 px on screen at this zoom (rounded up to a whole percent). */
export const READABLE_ZOOM = readableZoom(12);

export interface Viewport { x: number; y: number; zoom: number }
export interface Sizing {
  /** Height of the whole diagram, canvas and controls bar, px. */
  height: number;
  /** Height of the canvas, px. */
  canvas: number;
  /** fit: the whole drawing, centred. readable: a part of it, at a zoom where its text reads. */
  mode: 'fit' | 'readable';
  view: Viewport;
}

/** The zoom at which text of `px` is MIN_SCREEN_TEXT on screen, rounded up to a whole percent. */
export function readableZoom(px: number): number {
  return Math.ceil((MIN_SCREEN_TEXT / px) * 100 - 1e-9) / 100;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The zoom at which `bounds` fills a canvas of this size with the paper a fitted drawing keeps. May exceed 1. */
export function fitZoom(bounds: Box, width: number, canvas: number): number {
  return Math.max(0.01, Math.min((width - PAD * 2) / Math.max(1, bounds.w), (canvas - PAD * 2) / Math.max(1, bounds.h)));
}

/** `bounds` centred at `zoom` in a canvas of this size. */
export function centred(bounds: Box, width: number, canvas: number, zoom: number): Viewport {
  return {zoom, x: (width - bounds.w * zoom) / 2 - bounds.x * zoom, y: (canvas - bounds.h * zoom) / 2 - bounds.y * zoom};
}

/**
 * The view after a two-finger scroll of `dx`, `dy` screen px on a canvas of `width` x `canvas`: the drawing moves
 * against the scroll, as a page does, and never past the edges of `extent` (diagram coordinates). An axis on which
 * the extent fits the canvas, or is at its edge, does not move; a view already past an edge is not pulled back.
 */
export function scrolledView(view: Viewport, dx: number, dy: number, extent: Box, width: number, canvas: number): Viewport {
  const along = (at: number, d: number, start: number, size: number, room: number): number => {
    const lo = room - (start + size) * view.zoom;
    const hi = -start * view.zoom;
    return lo >= hi ? at : clamp(at - d, Math.min(lo, at), Math.max(hi, at));
  };
  return {zoom: view.zoom, x: along(view.x, dx, extent.x, extent.w, width), y: along(view.y, dy, extent.y, extent.h, canvas)};
}

export interface SizeInput {
  bounds: Box;
  /** Width the plate gives the drawing, px. */
  width: number;
  /** The plate's maximum height, px (useSizeCap). */
  cap: number;
  /** The zoom below which the diagram's text is no longer readable. */
  floor: number;
  /** The zoom a diagram too large to read whole opens at (at least `floor`). */
  readable: number;
  dir: Dir;
  /** Where a diagram opened in part is centred across the flow (a focus, the busiest node). */
  anchor?: Point;
  /** The node boxes: a view of a part is moved and its canvas ended so as to cut none of them. */
  boxes?: Iterable<Box>;
}

/** One axis of a part view: the drawing centred when it fits, else around `at`, never past its ends. */
function place(frame: number, start: number, size: number, zoom: number, at: number): number {
  if (size * zoom + PAD * 2 <= frame) return (frame - size * zoom) / 2 - start * zoom;
  return clamp(frame / 2 - at * zoom, frame - PAD - (start + size) * zoom, PAD - start * zoom);
}

/** One axis along the flow: the first layer at the edge the flow starts from (the far edge for RL and BT). */
function along(frame: number, start: number, size: number, zoom: number, reverse: boolean): number {
  if (size * zoom + PAD * 2 <= frame) return (frame - size * zoom) / 2 - start * zoom;
  return reverse ? frame - PAD - (start + size) * zoom : PAD - start * zoom;
}

export function sizeDiagram(input: SizeInput): Sizing {
  const {bounds, width, cap} = input;
  const high = Math.max(MIN_HEIGHT, cap);
  const fitWidth = Math.min(1, (width - PAD * 2) / Math.max(1, bounds.w));
  const height = Math.round(clamp(Math.ceil(bounds.h * fitWidth) + PAD * 2 + CONTROLS, MIN_HEIGHT, high));
  const fit = Math.min(1, fitZoom(bounds, width, height - CONTROLS));
  if (fit >= input.floor - 1e-6) return {height, canvas: height - CONTROLS, mode: 'fit', view: centred(bounds, width, height - CONTROLS, fit)};

  const across = input.dir === 'LR' || input.dir === 'RL';
  const boxList = input.boxes ? [...input.boxes] : undefined;
  const readable = Math.min(1, Math.max(input.readable, input.floor));
  // A flow across the plate ends at its right (left) edge: zoomed in a little, that edge falls between two layers.
  const zoom = across && boxList ? clearFarEdge(boxList, bounds, width, readable, input.dir === 'RL') : readable;
  const tall = Math.round(clamp(Math.ceil(bounds.h * zoom) + PAD * 2 + CONTROLS, MIN_HEIGHT, high));
  const canvas = tall - CONTROLS;
  const at = input.anchor ?? {x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2};
  const view: Viewport = {
    zoom,
    x: across ? along(width, bounds.x, bounds.w, zoom, input.dir === 'RL') : place(width, bounds.x, bounds.w, zoom, at.x),
    y: across ? place(canvas, bounds.y, bounds.h, zoom, at.y) : along(canvas, bounds.y, bounds.h, zoom, input.dir === 'BT'),
  };
  if (!boxList || boxList.length === 0) return {height: tall, canvas, mode: 'readable', view};
  const boxes = boxList;
  const limits = (frame: number, start: number, size: number): [number, number] =>
    size * zoom + PAD * 2 <= frame ? [view0(frame, start, size, zoom), view0(frame, start, size, zoom)] : [frame - PAD - (start + size) * zoom, PAD - start * zoom];
  const best = bestWindow(boxes, view, zoom, width, canvas, limits(width, bounds.x, bounds.w), limits(canvas, bounds.y, bounds.h), across, at, input.dir !== 'BT');
  view.x = best.x;
  view.y = best.y;
  // A flow that starts at the bottom would lose its start: it keeps the full canvas.
  const ended = input.dir === 'BT' ? canvas : endBetweenRows(boxes, view, canvas, width);
  return {height: ended + CONTROLS, canvas: ended, mode: 'readable', view};
}

/** The offset that centres a drawing that fits along one axis. */
const view0 = (frame: number, start: number, size: number, zoom: number) => (frame - size * zoom) / 2 - start * zoom;

/** Bit sets over the boxes, 32 to a word. */
const words = (n: number) => new Uint32Array(Math.max(1, Math.ceil(n / 32)));
function popAnd(a: Uint32Array, b: Uint32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let v = a[i]! & b[i]!;
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    n += Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }
  return n;
}

/**
 * Along one axis, at each candidate offset: the boxes shown whole, the boxes shown at all, the boxes cut by the far
 * end only, and whether the canvas can end above all of those (endBetweenRows: by a quarter of it at most).
 */
function axisSets(boxes: readonly Box[], axis: 'x' | 'y', zoom: number, frame: number, offsets: readonly number[]) {
  return offsets.map(offset => {
    const whole = words(boxes.length);
    const shown = words(boxes.length);
    const far = words(boxes.length);
    const spans: Array<[number, number]> = [];
    boxes.forEach((box, i) => {
      const a = (axis === 'x' ? box.x : box.y) * zoom + offset;
      const b = a + (axis === 'x' ? box.w : box.h) * zoom;
      spans.push([a, b]);
      const bit = 1 << (i & 31);
      const word = i >> 5;
      if (b > 0 && a < frame) shown[word]! |= bit;
      if (a >= -0.5 && b <= frame + 0.5) whole[word]! |= bit;
      else if (a >= -0.5 && a < frame - 0.5) far[word]! |= bit;
    });
    // (Every node counts here, also those off to the side: the window may end up showing them.)
    return {whole, shown, far, trims: axis === 'y' && endAbove(spans, frame) !== undefined};
  });
}

/**
 * Candidate offsets along one axis: each box against either edge, within the limits; or just past an edge, which may
 * show up to a quarter of the canvas of paper beyond the drawing (VOID) to move a node that cannot be shown whole out of
 * view instead of slicing it.
 */
function candidates(boxes: readonly Box[], axis: 'x' | 'y', zoom: number, frame: number, base: number, limits: [number, number]): number[] {
  const lo = Math.min(limits[0], limits[1]);
  const hi = Math.max(limits[0], limits[1]);
  const out = new Set<number>([Math.round(clamp(base, lo, hi))]);
  for (const box of boxes) {
    const a = (axis === 'x' ? box.x : box.y) * zoom;
    const b = a + (axis === 'x' ? box.w : box.h) * zoom;
    for (const offset of [PAD - a, frame - PAD - b, 8 - a, frame - 8 - b]) out.add(Math.round(clamp(offset, lo, hi)));
    for (const offset of [frame + 2 - a, -b - 2]) out.add(Math.round(clamp(offset, lo - frame * VOID, hi + frame * VOID)));
  }
  return [...out];
}

/** The most paper beyond the drawing a window may show to keep a node out of view rather than cut, a share of the canvas. */
const VOID = 0.25;

/**
 * The window a diagram too large to read whole opens on: of the offsets that put a node against an edge of the canvas
 * (or just past it), the pair that shows the most nodes whole. A node cut at an edge counts against a window as much
 * as a whole one counts for it (moved past the edge it is simply not shown yet), unless it is cut by the bottom edge
 * only and the canvas can end above it (`trim`: endBetweenRows). Moving away from the start of the flow costs a node
 * and a half per canvas length, away from the anchor across the flow three quarters of one; a window that shows the
 * anchor gains half.
 */
function bestWindow(
  boxes: readonly Box[], base: Viewport, zoom: number, width: number, canvas: number,
  xLimits: [number, number], yLimits: [number, number], across: boolean, anchor: Point, trim: boolean,
): {x: number; y: number} {
  const xs = candidates(boxes, 'x', zoom, width, base.x, xLimits);
  const ys = candidates(boxes, 'y', zoom, canvas, base.y, yLimits);
  const xSets = axisSets(boxes, 'x', zoom, width, xs);
  const ySets = axisSets(boxes, 'y', zoom, canvas, ys);
  const [alongW, acrossW] = [1.5, 0.75];
  // Paper past the drawing costs two nodes per canvas length.
  const beyond = (v: number, limits: [number, number]) => Math.max(0, Math.min(limits[0], limits[1]) - v, v - Math.max(limits[0], limits[1]));
  const xCost = xs.map(x => (Math.abs(x - base.x) / width) * (across ? alongW : acrossW) + (beyond(x, xLimits) / width) * 2);
  const yCost = ys.map(y => (Math.abs(y - base.y) / canvas) * (across ? acrossW : alongW) + (beyond(y, yLimits) / canvas) * 2);
  const xAnchor = xs.map(x => anchor.x * zoom + x >= 0 && anchor.x * zoom + x <= width);
  const yAnchor = ys.map(y => anchor.y * zoom + y >= 0 && anchor.y * zoom + y <= canvas);
  let best = {x: base.x, y: base.y};
  let bestScore = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const sx = xSets[i]!;
    for (let j = 0; j < ys.length; j++) {
      const sy = ySets[j]!;
      const whole = popAnd(sx.whole, sy.whole);
      const shown = popAnd(sx.shown, sy.shown);
      const lower = popAnd(sx.whole, sy.far);
      const ends = trim && sy.trims ? 0 : lower;
      const score = whole - (shown - whole - lower) - ends - xCost[i]! - yCost[j]! + (xAnchor[i] && yAnchor[j] ? 0.5 : 0);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = {x: xs[i]!, y: ys[j]!};
      }
    }
  }
  return best;
}

/**
 * The zoom, `readable` or a little more (never above 100%), at which a flow that starts at one side edge of the plate
 * cuts no node at the other: the next layer then begins just past the edge instead of through it.
 */
function clearFarEdge(boxes: readonly Box[], bounds: Box, width: number, readable: number, reverse: boolean): number {
  // Distance of each box's two ends from where the flow starts.
  const from = (box: Box): [number, number] => (reverse
    ? [bounds.x + bounds.w - (box.x + box.w), bounds.x + bounds.w - box.x]
    : [box.x - bounds.x, box.x + box.w - bounds.x]);
  const cuts = (zoom: number) => boxes.some(box => {
    const [a, b] = from(box);
    return a * zoom + PAD < width - 0.5 && b * zoom + PAD > width + 0.5;
  });
  if (bounds.w * readable + PAD * 2 <= width || !cuts(readable)) return readable;
  // Zoomed in, by a tenth at most, until a cut box starts just past the edge.
  const most = Math.min(1, readable * 1.1);
  const candidates = boxes.map(box => (width + 8 - PAD) / Math.max(1, from(box)[0])).filter(zoom => zoom > readable && zoom <= most).sort((a, b) => a - b);
  for (const zoom of candidates) if (!cuts(zoom)) return zoom;
  return readable;
}

/** The screen span of a box along one axis. */
const spanOf = (box: Box, view: Viewport, axis: 'x' | 'y'): [number, number] => {
  const start = (axis === 'x' ? box.x : box.y) * view.zoom + view[axis];
  return [start, start + (axis === 'x' ? box.w : box.h) * view.zoom];
};

/** How many boxes the two ends of a `frame` px canvas cut along `axis` at this view (the start alone: `far` false). */
export function cutAt(boxes: readonly Box[], view: Viewport, axis: 'x' | 'y', frame: number, far = true): number {
  let n = 0;
  for (const box of boxes) {
    const [a, b] = spanOf(box, view, axis);
    if ((a < -0.5 && b > 0.5) || (far && a < frame - 0.5 && b > frame + 0.5)) n++;
  }
  return n;
}

/**
 * The canvas height shortened so that it ends in the gap between two rows of nodes instead of through a node;
 * unchanged when no node is cut there, or when ending earlier would leave the diagram under MIN_HEIGHT or take more
 * than a quarter of the canvas.
 */
function endBetweenRows(boxes: readonly Box[], view: Viewport, canvas: number, width: number): number {
  // Only the nodes the canvas shows across matter: one off to the side is not cut by where the canvas ends.
  const spans = boxes.filter(box => {
    const [a, b] = spanOf(box, view, 'x');
    return b > 0 && a < width;
  }).map(box => spanOf(box, view, 'y'));
  return endAbove(spans, canvas) ?? canvas;
}

/**
 * Where a canvas `canvas` px tall ends so that it cuts none of the vertical `spans` (on screen): 8 px above the
 * highest one its end would cut, again until none is cut. Undefined when that takes more than a quarter of the canvas
 * or leaves the diagram under MIN_HEIGHT (a tall node, a table of many rows, is better cut than left out with that
 * much of the canvas); the canvas itself when nothing is cut.
 */
function endAbove(spans: ReadonlyArray<readonly [number, number]>, canvas: number): number | undefined {
  let line = canvas;
  for (let guard = 0; guard <= spans.length; guard++) {
    let top = Infinity;
    for (const [a, b] of spans) if (a < line - 0.5 && b > line + 0.5) top = Math.min(top, a);
    if (!Number.isFinite(top)) break;
    line = top - 8;
  }
  const ended = Math.min(canvas, Math.floor(line));
  return ended + CONTROLS >= MIN_HEIGHT && ended >= canvas * 0.75 ? ended : undefined;
}

/**
 * How well a layout reads at this width and cap: the zoom at which it is shown whole, or, when that is below the
 * readable floor, how much of it a readable view shows (a fraction, as a negative number below every whole fit).
 * Used to choose between two directions when the diagram does not prescribe one.
 */
export function scoreLayout(bounds: Box, width: number, cap: number, floor: number): number {
  const s = sizeDiagram({bounds, width, cap, floor, readable: floor, dir: 'LR'});
  if (s.mode === 'fit') return s.view.zoom;
  const shownW = Math.min(1, (width - PAD * 2) / (bounds.w * s.view.zoom));
  const shownH = Math.min(1, (s.canvas - PAD * 2) / (bounds.h * s.view.zoom));
  return shownW * shownH - 1;
}
