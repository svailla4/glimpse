// The node-link stage Graph, Flowchart and ERDiagram draw on: layout, the dot grid, pan and zoom, orthogonal edges,
// selection, keyboard traversal, draggable nodes with remembered positions and the "Re-layout" control. A component
// turns its data into nodes, edges and groups and supplies the drawing of one node; everything else is here.
//
// What opens (design rules D7, D18). The layout is made for the shape of the stage. When all of it can be drawn with
// readable labels it is fitted and centred, never above 100%; an unsized stage first grows (up to GROW_CAP) to show
// it whole. When it cannot, the stage opens at a readable zoom on the focus (or the anchor: the busiest node), placed
// so that no node is cut at an edge or under the overview inset, which shows where that is beside "n of m in view"
// (nodes shown whole); "Fit to view" still shows everything. Readable means 10 px on screen for the smallest text
// that shrinks with the zoom (`minText`, edge labels); below a readable zoom nodes that can (NodeFlags.lod) switch to
// fewer, larger labels, and the stage opens no further out than keeps those names telling the nodes apart (`lodZoom`).
import {formatFileLoc, type EntityRef} from '@glimpse/catalog';
import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import {Drafting, Icon, PlateAside, Redline, entityClipText, matchSelection, useHostActions, useSelection, useSize, useTooltip} from '../../../kit/index.ts';
import css from './edgekit.module.css';
import {
  boundsOf, centerOf, labelAnchor, loopLabel, markPath, nearestInDirection, roundedPath, routeAround, routeLoop,
  type Box, type Dir, type Mark, type Point, type Shape,
} from './geometry.ts';
import type {Laid, LayoutSpec, Route} from './layout.ts';
import {useNodePositions} from './positions.ts';
import {MONO_11, fitText, textWidth, wrapText} from './text.ts';
import {useLayout} from './useLayout.ts';

export interface DiagramNode<T = unknown> {
  id: string;
  w: number;
  h: number;
  shape?: Shape;
  group?: string;
  /** What selecting the node writes to the surface selection. */
  entity: EntityRef;
  /**
   * What the node stands for when a selection made elsewhere is matched against it, when that is not `entity`: a
   * module node selects its main file but stands for its whole directory. Of the nodes that hold the selection only
   * the innermost lights up.
   */
  match?: Pick<EntityRef, 'type' | 'id' | 'path'>;
  /** Name, for the tooltip and for assistive technology. */
  label: string;
  /** One more line for the tooltip and for assistive technology. */
  detail?: string;
  /** True when a double-click (or Shift+Enter) on the node calls onDrill. */
  drillable?: boolean;
  data: T;
}
export interface DiagramEdge {
  /** Unique within the diagram. */
  key: string;
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  cycle?: boolean;
  /** Drawn in the rule colour: one of many light edges that should not compete with the heavy ones. */
  faint?: boolean;
  /** Stroke width in px. Default 1. */
  width?: number;
  /** Cross-axis offsets from the node centres where the edge attaches (a column row of a table). */
  fromPort?: number;
  toPort?: number;
  /** Default none. */
  startMark?: Mark;
  /** Default arrow. */
  endMark?: Mark;
  /** Tooltip line. */
  detail?: string;
}
export interface DiagramGroup {
  id: string;
  label: string;
  parent?: string;
  /** True when a double-click on the frame's label calls onDrillGroup. */
  drillable?: boolean;
}
/** How much of a node is worth drawing at the current zoom: everything, its name alone in a larger face, or its box. */
export type Detail = 'full' | 'name' | 'box';
export interface NodeFlags {
  selected: boolean;
  focus: boolean;
  /** 'full' unless the diagram was given `lod`. */
  lod: Detail;
  /** Zoom to size 'name' text for: a label of `10.5 / k` px is 10.5 px or a little more on screen. 1 at 'full'. */
  k: number;
}

export interface DiagramProps<T> {
  /** Component id and name, for actions, storage keys and error text. */
  id: string;
  name: string;
  nodes: ReadonlyArray<DiagramNode<T>>;
  edges: readonly DiagramEdge[];
  groups?: readonly DiagramGroup[];
  /** Flow direction. Left out, the layout picks the one that suits the shape of the stage. */
  dir?: Dir;
  /** True: ranks far longer than the stage are wrapped into more ranks. */
  wrap?: boolean;
  /** True when the cell has a size: the stage fills it. Otherwise it is as tall as its content, up to 420 px. */
  sized: boolean;
  ariaLabel: string;
  /** Marginal note for the plate header: counts, what was left out. */
  note?: string;
  /** Node to centre and mark as the focus. */
  focus?: string;
  /** Node the stage opens on when the diagram is too large to read as a whole. Default: where the flow starts. */
  anchor?: string;
  /** True when renderNode draws the levels of detail of NodeFlags.lod; the stage may then open further out. */
  lod?: boolean;
  /**
   * With `lod`: the zoom from which every node's 'name' face still says which node it is (a name cut to three letters
   * does not). The stage opens no further out. Default LOD_ZOOM; at most FULL_ZOOM.
   */
  lodZoom?: number;
  /**
   * The smallest text the diagram draws at 100%, in px (edge labels are 11). Without levels of detail the stage never
   * opens further out than the zoom that keeps it at 10 px on screen. Default 11.
   */
  minText?: number;
  /** Draws one node in a box of its size with the origin at the top-left corner. Must be a stable function. */
  renderNode: (node: DiagramNode<T>, flags: NodeFlags) => ReactNode;
  onDrill?: (node: DiagramNode<T>) => void;
  onDrillGroup?: (group: DiagramGroup) => void;
  /** Called on a plain click before it selects; return true when the click was used up. */
  onNodeClick?: (node: DiagramNode<T>, target: Element) => boolean;
  nodesep?: number;
  ranksep?: number;
}

interface View { x: number; y: number; k: number }

const PAD = 24;
/** Under a fitted diagram: the zoom controls sit there. */
const PAD_BOTTOM = 40;
/** As far out as the zoom controls go, unless everything only fits further out. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
/** 12 px labels are 10 px on screen: where a diagram too large to read whole opens. */
export const READABLE_ZOOM = 0.84;
/**
 * From here up a node with levels of detail draws its own faces (an 11 px second line is 10 px on screen); below it
 * draws the larger faces of NodeFlags.lod, which stay 10 px or more.
 */
export const FULL_ZOOM = 0.91;
/** Group labels (10.5 px) keep their own size down to here, and are drawn larger below. */
const GROUP_FULL_ZOOM = 0.96;
/** With levels of detail a node still holds a 10 px name (of eight letters or more) down to here. */
export const LOD_ZOOM = 0.4;
/** A focused diagram is shown whole only down to this zoom; further out it opens on the focus and its neighbours. */
const FOCUS_WHOLE_ZOOM = 0.7;
/** On-screen text is never smaller than this when a diagram opens (design rule D18). */
const MIN_SCREEN_TEXT = 10;
const DEFAULT_MIN_TEXT = 11;
/** An unsized diagram grows its plate up to this height to be shown whole at a readable zoom. */
const GROW_CAP = 640;
/** Edge labels longer than this wrap onto a second line. */
const LABEL_WRAP = 112;
const LABEL_LINE = 13;
const DRAG_THRESHOLD = 4;
const NUDGE = 16;
const PAN_STEP = 48;
const MAX_NATURAL_HEIGHT = 420;
const MIN_NATURAL_HEIGHT = 120;
const LABEL_MAX_WIDTH = 168;
const GROUP_PAD = 10;
/** A little more room at the top, where the label sits on the frame line. */
const GROUP_PAD_TOP = 12;
const DOUBLE_CLICK_MS = 400;
/** A pan never moves the last of the diagram further than this from the edge of the stage. */
const KEEP_IN_VIEW = 56;
/** The overview inset is at most this large, and at most about a quarter of the stage each way. */
const OVERVIEW_W = 132;
const OVERVIEW_H = 84;
/** Below this many nodes the stage itself is the overview. */
const OVERVIEW_MIN_NODES = 6;
/** A stage narrower than this has no room for the "n of m in view" line beside the inset and the controls. */
const IN_VIEW_MIN_WIDTH = 520;
const ARROWS: Record<string, readonly [number, number]> = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
const NO_LAYOUT: Laid = {dir: 'LR', boxes: new Map(), routes: new Map()};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The zoom at which text of `px` is `MIN_SCREEN_TEXT` on screen, rounded up to a whole percent. */
export const readableZoom = (px: number) => Math.ceil((MIN_SCREEN_TEXT / px) * 100) / 100;

/** A label plate: one line, or two when the label is long, each cut to fit. */
export function labelPlate(label: string): {lines: string[]; w: number; h: number} {
  const lines = textWidth(label, MONO_11) <= LABEL_WRAP ? [fitText(label, LABEL_MAX_WIDTH, MONO_11)] : wrapText(label, LABEL_WRAP, 2, MONO_11);
  const w = Math.max(...lines.map(line => textWidth(line, MONO_11)));
  return {lines, w: Math.ceil(w) + 10, h: 16 + (lines.length - 1) * LABEL_LINE};
}

interface GroupBox { id: string; label: string; drillable: boolean; box: Box }

/** Group frames around their members' boxes, outer groups first. A group without visible members has no frame. */
function frameGroups(groups: readonly DiagramGroup[] | undefined, nodes: ReadonlyArray<DiagramNode>, boxes: ReadonlyMap<string, Box>): GroupBox[] {
  if (!groups || groups.length === 0) return [];
  const byId = new Map(groups.map(group => [group.id, group]));
  const content = new Map<string, Box[]>();
  for (const node of nodes) {
    const box = node.group !== undefined ? boxes.get(node.id) : undefined;
    if (!box || !byId.has(node.group!)) continue;
    const list = content.get(node.group!);
    if (list) list.push(box);
    else content.set(node.group!, [box]);
  }
  const depthOf = (id: string): number => {
    let depth = 0;
    const seen = new Set([id]);
    for (let at = byId.get(id)?.parent; at !== undefined && byId.has(at) && !seen.has(at); at = byId.get(at)?.parent) {
      seen.add(at);
      depth++;
    }
    return depth;
  };
  const framed = new Map<string, Box>();
  // Deepest groups first, so a parent can wrap the frames of its children.
  const order = groups.map(group => ({group, depth: depthOf(group.id)})).sort((a, b) => b.depth - a.depth);
  for (const {group, depth} of order) {
    const inner = boundsOf(content.get(group.id) ?? []);
    if (!inner) continue;
    const box = {x: inner.x - GROUP_PAD, y: inner.y - GROUP_PAD_TOP, w: inner.w + GROUP_PAD * 2, h: inner.h + GROUP_PAD + GROUP_PAD_TOP};
    framed.set(group.id, box);
    const parent = group.parent;
    if (depth > 0 && parent !== undefined && byId.has(parent)) {
      const list = content.get(parent);
      if (list) list.push(box);
      else content.set(parent, [box]);
    }
  }
  return order.reverse().flatMap(({group}) => {
    const box = framed.get(group.id);
    return box ? [{id: group.id, label: group.label, drillable: group.drillable === true, box}] : [];
  });
}

// ---------------------------------------------------------------- views
/** The zoom at which `bounds` fills a stage of this size, with the padding a fitted diagram keeps. May exceed 1. */
export function fitScale(bounds: Box | undefined, width: number, height: number): number {
  if (!bounds || width <= 0 || height <= 0) return 1;
  return Math.max(0.01, Math.min((width - PAD * 2) / Math.max(1, bounds.w), (height - PAD - PAD_BOTTOM) / Math.max(1, bounds.h)));
}

/** `bounds` centred in the part of the stage a fitted diagram uses. */
function centred(bounds: Box, width: number, height: number, k: number): View {
  const centre = centerOf(bounds);
  return {k, x: width / 2 - centre.x * k, y: (PAD + height - PAD_BOTTOM) / 2 - centre.y * k};
}

/** The view pulled back so the stage shows the diagram and not the void beside it; a side that fits is centred. */
function settle(view: View, bounds: Box, width: number, height: number): View {
  const fitted = centred(bounds, width, height, view.k);
  const x = bounds.w * view.k <= width - PAD * 2 ? fitted.x : clamp(view.x, width - PAD - (bounds.x + bounds.w) * view.k, PAD - bounds.x * view.k);
  const y = bounds.h * view.k <= height - PAD - PAD_BOTTOM ? fitted.y : clamp(view.y, height - PAD_BOTTOM - (bounds.y + bounds.h) * view.k, PAD - bounds.y * view.k);
  return {k: view.k, x, y};
}

/** True when `box` lies wholly in the part of the stage that `view` shows above the controls. */
function shows(view: View, box: Box, width: number, height: number): boolean {
  const left = box.x * view.k + view.x;
  const top = box.y * view.k + view.y;
  return left >= 0 && top >= 0 && left + box.w * view.k <= width && top + box.h * view.k <= height - PAD_BOTTOM;
}

/** True when the stage shows `box` whole, or as much of it as the stage can hold: not cut off at an edge. */
export function seen(view: View, box: Box, width: number, height: number): boolean {
  const left = box.x * view.k + view.x;
  const top = box.y * view.k + view.y;
  const w = box.w * view.k;
  const h = box.h * view.k;
  return Math.min(left + w, width) - Math.max(left, 0) >= Math.min(w, width) - 1 && Math.min(top + h, height) - Math.max(top, 0) >= Math.min(h, height) - 1;
}

/** The corner the overview inset takes, with its margin and padding: where the box an opening view is about should not be. */
function insetOf(width: number, height: number): {w: number; h: number} {
  return {w: Math.min(OVERVIEW_W, width * 0.26) + 18, h: Math.min(OVERVIEW_H, height * 0.3) + 18};
}

/** True when `box` is on the stage and clear of the overview inset. */
function showsClear(view: View, box: Box, width: number, height: number): boolean {
  if (!shows(view, box, width, height)) return false;
  const inset = insetOf(width, height);
  return box.x * view.k + view.x >= inset.w || (box.y + box.h) * view.k + view.y <= height - inset.h;
}

/** How far past the edge of the stage a node is moved when an opening view takes it off rather than cut it. */
const EDGE_CLEAR = 8;

const areaOf = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * `view` moved as little as it takes so that no node is cut where the stage stops showing it, at its edges or under
 * the overview inset (a node half shown reads as the diagram going on there): on each axis, of the moves that take a
 * cut node wholly into view or wholly out of it, the one that leaves the fewest cut, keeps every node the view showed
 * whole and the anchor clear of the inset, and moves least.
 */
function unslice(view: View, boxes: readonly Box[], anchor: Box, width: number, height: number): View {
  const stage = {x: 0, y: 0, w: width, h: height};
  const corner = boxes.length >= OVERVIEW_MIN_NODES ? insetOf(width, height) : undefined;
  const inset = corner ? {x: 0, y: height - corner.h, w: corner.w, h: corner.h} : undefined;
  const onScreen = (v: View, box: Box): Box => ({x: box.x * v.k + v.x, y: box.y * v.k + v.y, w: box.w * v.k, h: box.h * v.k});
  const isCut = (s: Box) => {
    const visible = areaOf(s, stage) - (inset ? areaOf(s, inset) : 0);
    return visible > 1 && visible < s.w * s.h - 1;
  };
  const cut = (v: View) => boxes.reduce((n, box) => n + (isCut(onScreen(v, box)) ? 1 : 0), 0);
  const whole = (v: View) => boxes.reduce((n, box) => n + (shows(v, box, width, height) ? 1 : 0), 0);
  let best = view;
  for (const axis of ['x', 'y'] as const) {
    const base = best;
    const keep = whole(base);
    const moves = new Set<number>();
    for (const box of boxes) {
      const s = onScreen(base, box);
      if (!isCut(s)) continue;
      const [a, b] = axis === 'x' ? [s.x, s.x + s.w] : [s.y, s.y + s.h];
      // The lines where showing stops on this axis: the stage's edges, and the inset's when the node runs under it.
      const lines = [0, axis === 'x' ? width : height];
      if (inset && areaOf(s, inset) > 0) lines.push(axis === 'x' ? inset.w : inset.y);
      for (const line of lines) if (a < line && b > line) moves.add(line + EDGE_CLEAR - a).add(line - EDGE_CLEAR - b);
    }
    let fewest = cut(base);
    let least = 0;
    for (const d of moves) {
      const v = {...base, [axis]: base[axis] + d};
      if (!showsClear(v, anchor, width, height) || whole(v) < keep) continue;
      const n = cut(v);
      if (n < fewest || (n === fewest && Math.abs(d) < Math.abs(least))) {
        best = v;
        fewest = n;
        least = d;
      }
    }
  }
  return best;
}

/**
 * The view a diagram opens with. `floor` is the zoom below which its labels stop being readable: when everything
 * fits at or above it, everything is shown (never above 100%). Otherwise the stage opens on `region` (a focus and
 * its neighbours) when that is readable whole, between `readable` and 100%; else at `readable` (READABLE_ZOOM unless
 * the diagram's text needs more) on the stretch of the diagram that shows the most of `boxes` whole with `anchor`
 * among them, so the first view is full of graph. A view that is not the whole diagram is then moved so that it cuts
 * no node at its edges or under the inset, where a move can do that without losing a node it showed (unslice).
 */
export function openingView(
  bounds: Box | undefined, width: number, height: number, floor: number, boxes: Iterable<Box>, anchor?: Box, region?: Box, readable = READABLE_ZOOM,
): {view: View; whole: boolean} {
  if (!bounds || width <= 0 || height <= 0) return {view: {x: 0, y: 0, k: 1}, whole: true};
  const fit = fitScale(bounds, width, height);
  if (fit >= floor || !anchor) return {view: centred(bounds, width, height, Math.min(1, fit)), whole: true};
  const all = [...boxes];
  const around = region ? fitScale(region, width, height) : 0;
  if (region && around >= readable) return {view: unslice(settle(centred(region, width, height, Math.min(1, around)), bounds, width, height), all, anchor, width, height), whole: false};
  const k = Math.min(1, readable);
  const home = centerOf(anchor);
  let best = settle(centred(anchor, width, height, k), bounds, width, height);
  let bestCount = showsClear(best, anchor, width, height) ? all.filter(box => shows(best, box, width, height)).length : -1;
  let bestDistance = 0;
  for (const box of all) {
    const centre = centerOf(box);
    const view = settle(centred(box, width, height, k), bounds, width, height);
    if (!showsClear(view, anchor, width, height)) continue;
    const count = all.filter(other => shows(view, other, width, height)).length;
    const distance = Math.hypot(centre.x - home.x, centre.y - home.y);
    if (count > bestCount || (count === bestCount && distance < bestDistance)) {
      best = view;
      bestCount = count;
      bestDistance = distance;
    }
  }
  return {view: unslice(best, all, anchor, width, height), whole: false};
}

/** `k` rounded down to a step of 5% (0.7 stays 0.7, which a plain floor of 0.7 * 20 does not). */
const zoomStep = (k: number) => Math.max(0.1, Math.floor(k * 20 + 1e-6) / 20);

/** What nodes draw at zoom `k`, and the zoom their larger labels are sized for (steps of 5%, so a pinch is not a redraw per frame). */
export function detailAt(k: number, lod: boolean): {lod: Detail; k: number} {
  if (!lod || k >= FULL_ZOOM) return {lod: 'full', k: 1};
  return {lod: k >= LOD_ZOOM ? 'name' : 'box', k: zoomStep(k)};
}

// ---------------------------------------------------------------- marks
const NodeShell = memo(function NodeShell(p: {
  node: DiagramNode<any>; x: number; y: number; selected: boolean; dim: boolean; active: boolean; focus: boolean; lod: Detail; k: number;
  render: (node: DiagramNode<any>, flags: NodeFlags) => ReactNode;
}) {
  const {node} = p;
  return (
    <g
      className={css.node}
      transform={`translate(${p.x} ${p.y})`}
      data-node={node.id}
      data-selected={p.selected || undefined}
      data-dim={p.dim || undefined}
      data-active={p.active || undefined}
      data-focus={p.focus || undefined}
    >
      {p.render(node, {selected: p.selected, focus: p.focus, lod: p.lod, k: p.k})}
      <rect className={css.ring} x={-4} y={-4} width={node.w + 8} height={node.h + 8} />
    </g>
  );
});

const EdgeShell = memo(function EdgeShell(p: {edge: DiagramEdge; route: Route; hot: boolean; dim: boolean}) {
  const {edge, hot} = p;
  const {points} = p.route;
  const d = roundedPath(points);
  const width = hot ? Math.max(1.5, edge.width ?? 1) : (edge.width ?? 1);
  const end = markPath(edge.endMark ?? 'arrow', points.at(-1), points.at(-2));
  const start = markPath(edge.startMark ?? 'none', points[0], points[1]);
  return (
    <g
      className={css.edge}
      data-edge={`${edge.from}->${edge.to}`}
      data-edge-key={edge.key}
      data-hot={hot || undefined}
      data-dim={p.dim || undefined}
      data-cycle={edge.cycle || undefined}
      data-dashed={edge.dashed || undefined}
      data-faint={(edge.faint && !hot) || undefined}
    >
      <path className={css.hit} d={d} />
      <path className={css.line} d={d} strokeWidth={width} />
      {end || start ? <path className={css.mark} d={start + end} /> : null}
    </g>
  );
});

const EdgeLabel = memo(function EdgeLabel(p: {edgeKey: string; at: Point; lines: readonly string[]; w: number; h: number; hot: boolean; dim: boolean}) {
  return (
    <g className={css.label} transform={`translate(${Math.round(p.at.x)} ${Math.round(p.at.y)})`} data-edge-label={p.edgeKey} data-hot={p.hot || undefined} data-dim={p.dim || undefined}>
      <rect className={css.labelPlate} x={-p.w / 2} y={-p.h / 2} width={p.w} height={p.h} />
      <text className={css.labelText}>
        {p.lines.map((line, i) => <tspan key={i} x={0} y={0.5 + (i - (p.lines.length - 1) / 2) * LABEL_LINE}>{line}</tspan>)}
      </text>
    </g>
  );
});

/** The whole diagram in a corner, with the part the stage shows; a press or a drag on it moves the stage there. */
const Overview = memo(function Overview(p: {
  bounds: Box; boxes: ReadonlyMap<string, Box>; selected: ReadonlySet<string>; view: View; width: number; height: number;
  onGo: (world: Point) => void;
}) {
  const {bounds, view} = p;
  const scale = Math.min(Math.min(OVERVIEW_W, p.width * 0.26) / Math.max(1, bounds.w), Math.min(OVERVIEW_H, p.height * 0.3) / Math.max(1, bounds.h));
  const go = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    p.onGo({x: bounds.x + (event.clientX - rect.left) / scale, y: bounds.y + (event.clientY - rect.top) / scale});
  };
  return (
    <svg
      className={css.overview}
      width={Math.max(24, Math.round(bounds.w * scale))}
      height={Math.max(16, Math.round(bounds.h * scale))}
      viewBox={`${bounds.x} ${bounds.y} ${Math.max(1, bounds.w)} ${Math.max(1, bounds.h)}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-overview=""
      onPointerDown={event => {
        if (event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // the pointer is already gone
        }
        go(event);
      }}
      onPointerMove={event => { if (event.buttons & 1) go(event); }}
    >
      {[...p.boxes].map(([id, box]) => (
        <rect key={id} className={css.overviewNode} data-selected={p.selected.has(id) || undefined} x={box.x} y={box.y} width={box.w} height={box.h} />
      ))}
      <rect className={css.overviewView} x={-view.x / view.k} y={-view.y / view.k} width={p.width / view.k} height={p.height / view.k} />
    </svg>
  );
});

/** What the diagram puts in the plate header: its marginal note, then its controls. Nothing when both are absent. */
function Aside(p: {note?: string; children?: ReactNode}) {
  if (!p.note && !p.children) return null;
  return (
    <PlateAside>
      {p.note ? <span className={css.note} data-gl-note="" title={p.note}>{p.note}</span> : null}
      {p.children}
    </PlateAside>
  );
}

function Tip(p: {title: string; detail?: string}) {
  return (
    <span className={css.tip}>
      <span className={css.tipTitle}>{p.title}</span>
      {p.detail ? <span className={css.tipDetail}>{p.detail}</span> : null}
    </span>
  );
}

/**
 * Lays the diagram out for the shape of its stage and draws it. Until the stage is measured, and while a large
 * layout is computed, it shows the drafting frame; a layout that cannot be computed is a redline.
 */
export function Diagram<T>(p: DiagramProps<T>): ReactNode {
  const {nodes, edges, groups, id} = p;
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useSize(boxRef);
  const tooltip = useTooltip();
  const {selected, select} = useSelection(id);
  const host = useHostActions(id);
  const store = useNodePositions(id);

  // ---- layout, for the shape of the stage
  const plates = useMemo(() => {
    const out = new Map<string, {lines: string[]; w: number; h: number}>();
    for (const edge of edges) if (edge.label) out.set(edge.key, labelPlate(edge.label));
    return out;
  }, [edges]);
  const width = size.width;
  // An unsized stage is as tall as its content needs, up to the family default: lay out for that.
  const stageHeight = p.sized ? size.height : MAX_NATURAL_HEIGHT;
  const aspect = width > 0 && stageHeight > 0 ? width / stageHeight : undefined;
  const spec = useMemo<LayoutSpec | undefined>(() => (aspect === undefined ? undefined : {
    dir: p.dir, aspect, wrap: p.wrap, nodesep: p.nodesep, ranksep: p.ranksep,
    nodes: nodes.map(node => ({id: node.id, w: node.w, h: node.h, shape: node.shape, group: node.group})),
    edges: edges.map(edge => {
      const plate = plates.get(edge.key);
      return {key: edge.key, from: edge.from, to: edge.to, label: plate ? {w: plate.w, h: plate.h} : undefined, fromPort: edge.fromPort, toPort: edge.toPort};
    }),
    groups: groups?.map(group => ({id: group.id, parent: group.parent})),
  }), [nodes, edges, groups, p.dir, p.wrap, p.nodesep, p.ranksep, plates, aspect]);
  const layout = useLayout(spec);
  const laid = layout.status === 'ready' ? layout.laid : NO_LAYOUT;
  const dir = laid.dir;

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const edgeByKey = useMemo(() => new Map(edges.map(edge => [edge.key, edge])), [edges]);
  const groupById = useMemo(() => new Map((groups ?? []).map(group => [group.id, group])), [groups]);
  // A tooltip belongs to a node or an edge of this data: when the data is replaced (a drill, a refresh) it goes.
  const shownNodes = useRef(nodes);
  useEffect(() => {
    if (shownNodes.current !== nodes) tooltip.hide();
    shownNodes.current = nodes;
  }, [nodes, tooltip]);

  // ---- geometry: the automatic layout, then the person's positions on top
  const {boxes, moved} = useMemo(() => {
    let out = laid.boxes;
    const ids = new Set<string>();
    for (const [nodeId, centre] of Object.entries(store.positions)) {
      const auto = laid.boxes.get(nodeId);
      if (!auto) continue;
      if (out === laid.boxes) out = new Map(laid.boxes);
      out.set(nodeId, {x: centre.x - auto.w / 2, y: centre.y - auto.h / 2, w: auto.w, h: auto.h});
      ids.add(nodeId);
    }
    return {boxes: out, moved: ids};
  }, [laid, store.positions]);

  const routes = useMemo(() => {
    if (moved.size === 0) return laid.routes;
    const out = new Map(laid.routes);
    for (const edge of edges) {
      if (!moved.has(edge.from) && !moved.has(edge.to)) continue;
      const a = boxes.get(edge.from);
      const b = boxes.get(edge.to);
      if (!a || !b) continue;
      const loop = edge.from === edge.to;
      // No layout kept a way free for a node the person put somewhere: take the route that runs through the fewest nodes.
      const others: Box[] = [];
      if (!loop) for (const [nodeId, box] of boxes) if (nodeId !== edge.from && nodeId !== edge.to) others.push(box);
      const points = loop
        ? routeLoop(a, dir, {shape: byId.get(edge.from)?.shape})
        : routeAround(a, b, {dir, fromShape: byId.get(edge.from)?.shape, toShape: byId.get(edge.to)?.shape, fromPort: edge.fromPort, toPort: edge.toPort}, others);
      const plate = plates.get(edge.key);
      out.set(edge.key, {points, label: edge.label ? (loop && plate ? loopLabel(points, plate) : labelAnchor(points, dir)) : undefined});
    }
    return out;
  }, [laid, moved, boxes, edges, dir, byId, plates]);

  const frames = useMemo(() => frameGroups(groups, nodes, boxes), [groups, nodes, boxes]);
  const extent = useCallback(
    (nodeBoxes: ReadonlyMap<string, Box>, edgeRoutes: ReadonlyMap<string, Route>, groupFrames: readonly GroupBox[]) => {
      const points: Point[] = [];
      const labels: Box[] = [];
      for (const [key, route] of edgeRoutes) {
        for (const point of route.points) points.push(point);
        // A label may sit beside its line: the whole plate is part of what is drawn.
        const plate = plates.get(key);
        if (plate && route.label) labels.push({x: route.label.x - plate.w / 2, y: route.label.y - plate.h / 2, w: plate.w, h: plate.h});
      }
      return boundsOf([...nodeBoxes.values(), ...groupFrames.map(frame => frame.box), ...labels], points);
    },
    [plates],
  );
  const autoBounds = useMemo(() => extent(laid.boxes, laid.routes, frameGroups(groups, nodes, laid.boxes)), [extent, laid, groups, nodes]);
  const bounds = useMemo(() => (moved.size === 0 ? autoBounds : extent(boxes, routes, frames)), [moved, autoBounds, extent, boxes, routes, frames]);

  // ---- viewport
  // Text that shrinks with the zoom (no levels of detail) is never opened below 10 px on screen (design rule D18).
  // Levels of detail keep node text readable further out; edge labels have none, so a diagram with any opens no
  // further out than keeps them at 10 px.
  const textFloor = readableZoom(p.minText ?? DEFAULT_MIN_TEXT);
  const scalesText = !p.lod || plates.size > 0;
  // Names drawn larger when zoomed out still have to fit their nodes well enough to tell them apart.
  const nameFloor = p.lod ? clamp(p.lodZoom ?? LOD_ZOOM, LOD_ZOOM, FULL_ZOOM) : 0;
  const floor = Math.max(scalesText ? textFloor : 0, nameFloor);
  const readable = Math.max(READABLE_ZOOM, floor);
  const naturalHeight = useMemo(() => {
    if (!autoBounds || width <= 0) return MIN_NATURAL_HEIGHT;
    const k = Math.min(1, (width - PAD * 2) / Math.max(1, autoBounds.w));
    // Too wide to read at the width it has: it opens zoomed in on a part of it, on a stage as tall as that needs.
    if (k < floor) return clamp(Math.ceil(autoBounds.h * readable) + PAD + PAD_BOTTOM, MIN_NATURAL_HEIGHT, GROW_CAP);
    // Otherwise the plate grows to show all of it at the zoom the width allows, up to a cap; past it the stage zooms out.
    return clamp(Math.ceil(autoBounds.h * k) + PAD + PAD_BOTTOM, MIN_NATURAL_HEIGHT, GROW_CAP);
  }, [autoBounds, width, floor, readable]);
  const height = p.sized ? size.height : naturalHeight;
  const ready = layout.status === 'ready' && width > 0 && height > 0;

  const focusId = p.focus !== undefined && laid.boxes.has(p.focus) ? p.focus : undefined;
  const anchorId = useMemo(() => {
    if (focusId !== undefined) return focusId;
    if (p.anchor !== undefined && laid.boxes.has(p.anchor)) return p.anchor;
    // Where the flow starts: the first node in reading order.
    let first: string | undefined;
    let firstBox: Box | undefined;
    for (const [nodeId, box] of laid.boxes) {
      const before = !firstBox || (laid.dir === 'LR' ? box.x - firstBox.x || box.y - firstBox.y : box.y - firstBox.y || box.x - firstBox.x) < 0;
      if (before) {
        first = nodeId;
        firstBox = box;
      }
    }
    return first;
  }, [focusId, p.anchor, laid]);
  const opening = useMemo(() => {
    const anchor = anchorId !== undefined ? laid.boxes.get(anchorId) : undefined;
    // An explicit focus is what was asked for: open on it and its neighbours as soon as the whole is not
    // comfortably readable. Without one, open where the most of the diagram can be read, the anchor among it.
    let region: Box | undefined;
    if (focusId !== undefined && anchor) {
      const near: Box[] = [anchor];
      for (const edge of edges) {
        const other = edge.from === focusId ? edge.to : edge.to === focusId ? edge.from : undefined;
        const box = other !== undefined ? laid.boxes.get(other) : undefined;
        if (box) near.push(box);
      }
      region = boundsOf(near);
    }
    return openingView(autoBounds, width, height, focusId !== undefined ? Math.max(floor, FOCUS_WHOLE_ZOOM) : floor, laid.boxes.values(), anchor, region, readable);
  }, [autoBounds, width, height, floor, readable, anchorId, focusId, laid, edges]);
  // null: follow the opening view (and the size of the cell). A pan, a zoom or a reset pins the view.
  const [pinned, setPinned] = useState<{laid: Laid; view: View} | null>(null);
  const view = pinned && pinned.laid === laid ? pinned.view : opening.view;
  const [glide, setGlide] = useState(false);
  const [panning, setPanning] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const fitAll = fitScale(bounds, width, height);
  const minZoom = Math.min(MIN_ZOOM, fitAll);

  /** A view never loses the diagram: some of it stays on the stage. */
  const within = useCallback((next: View): View => {
    const b = boundsRef.current;
    if (!b || width <= 0 || height <= 0) return next;
    const keepX = Math.min(KEEP_IN_VIEW, width / 3);
    const keepY = Math.min(KEEP_IN_VIEW, height / 3);
    return {
      k: next.k,
      x: clamp(next.x, keepX - (b.x + b.w) * next.k, width - keepX - b.x * next.k),
      y: clamp(next.y, keepY - (b.y + b.h) * next.k, height - keepY - b.y * next.k),
    };
  }, [width, height]);
  const setView = useCallback((next: View, animate: boolean) => {
    setGlide(animate);
    setPinned({laid, view: within(next)});
  }, [laid, within]);
  const zoomAt = useCallback((sx: number, sy: number, factor: number, animate: boolean) => {
    const from = viewRef.current;
    const k = clamp(from.k * factor, Math.min(minZoom, from.k), MAX_ZOOM);
    const ratio = k / from.k;
    setView({k, x: sx - (sx - from.x) * ratio, y: sy - (sy - from.y) * ratio}, animate);
  }, [setView, minZoom]);

  // ---- selection
  const selectedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selected) return ids;
    // Of the nodes that hold the selection (the module a selected file is in), only the innermost.
    let holders: string[] = [];
    let deepest = -1;
    for (const node of nodes) {
      const ref = node.match ?? node.entity;
      const how = matchSelection(selected, ref);
      if (how === 'exact' || how === 'within') ids.add(node.id);
      else if (how === 'contains') {
        const depth = (ref.path ?? ref.id).length;
        if (depth > deepest) {
          deepest = depth;
          holders = [node.id];
        } else if (depth === deepest) holders.push(node.id);
      }
    }
    if (ids.size === 0) for (const nodeId of holders) ids.add(nodeId);
    return ids;
  }, [selected, nodes]);
  // Everything that stays at full strength while something is selected: the selection and its neighbours.
  const lit = useMemo(() => {
    if (selectedIds.size === 0) return null;
    const ids = new Set(selectedIds);
    for (const edge of edges) {
      if (selectedIds.has(edge.from) || selectedIds.has(edge.to)) {
        ids.add(edge.from);
        ids.add(edge.to);
      }
    }
    return ids;
  }, [selectedIds, edges]);

  // ---- roving focus
  const [activeId, setActiveId] = useState<string>();
  const active = activeId !== undefined ? byId.get(activeId) : undefined;
  const reveal = useCallback((nodeId: string) => {
    const box = boxesRef.current.get(nodeId);
    if (!box || width <= 0 || height <= 0) return;
    const v = viewRef.current;
    const left = box.x * v.k + v.x;
    const top = box.y * v.k + v.y;
    const right = left + box.w * v.k;
    const bottom = top + box.h * v.k;
    const dx = left < 8 ? 8 - left : right > width - 8 ? width - 8 - right : 0;
    const dy = top < 8 ? 8 - top : bottom > height - 8 ? height - 8 - bottom : 0;
    if (dx !== 0 || dy !== 0) setView({k: v.k, x: v.x + dx, y: v.y + dy}, true);
  }, [width, height, setView]);
  const activate = useCallback((nodeId: string) => {
    setActiveId(nodeId);
    reveal(nodeId);
  }, [reveal]);

  /**
   * Where a zoom from the buttons or the keyboard holds still: the selected node, else the node the keyboard is on,
   * when it is on the stage; else the middle of the stage, pulled onto the diagram when the middle is empty.
   */
  const pivot = useCallback((): Point => {
    const v = viewRef.current;
    const onStage = (nodeId: string | undefined): Point | undefined => {
      const box = nodeId !== undefined ? boxesRef.current.get(nodeId) : undefined;
      if (!box) return undefined;
      const c = centerOf(box);
      const at = {x: c.x * v.k + v.x, y: c.y * v.k + v.y};
      return at.x >= 0 && at.x <= width && at.y >= 0 && at.y <= height ? at : undefined;
    };
    const chosen = onStage(selectedIds.values().next().value) ?? onStage(activeId);
    if (chosen) return chosen;
    const b = boundsRef.current;
    if (!b) return {x: width / 2, y: height / 2};
    return {
      x: clamp(width / 2, b.x * v.k + v.x, (b.x + b.w) * v.k + v.x),
      y: clamp(height / 2, b.y * v.k + v.y, (b.y + b.h) * v.k + v.y),
    };
  }, [width, height, selectedIds, activeId]);
  const zoomBy = useCallback((factor: number) => {
    const at = pivot();
    zoomAt(at.x, at.y, factor, true);
  }, [pivot, zoomAt]);
  const fit = useCallback(() => {
    setGlide(true);
    const b = boundsRef.current;
    // With nothing moved and everything in the opening view, "fit" is that view again and follows the cell.
    if (moved.size === 0 && opening.whole) setPinned(null);
    else if (b) setPinned({laid, view: centred(b, width, height, Math.min(1, fitScale(b, width, height)))});
  }, [moved, opening.whole, laid, width, height]);
  const reset = useCallback(() => {
    const at = pivot();
    const from = viewRef.current;
    const b = boundsRef.current;
    const next = {k: 1, x: at.x - (at.x - from.x) / from.k, y: at.y - (at.y - from.y) / from.k};
    setView(b ? settle(next, b, width, height) : next, true);
  }, [pivot, setView, width, height]);
  const goTo = useCallback((world: Point) => {
    const v = viewRef.current;
    setView({k: v.k, x: width / 2 - world.x * v.k, y: height / 2 - world.y * v.k}, false);
  }, [setView, width, height]);

  // Ctrl/Cmd + wheel (and a trackpad pinch, which arrives as one) zooms around the pointer; a plain wheel scrolls
  // the page. React registers wheel listeners as passive, so this one is attached by hand.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015), false);
    };
    svg.addEventListener('wheel', onWheel, {passive: false});
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const reading = useCallback(() => {
    const main = (box: Box) => (dir === 'LR' ? box.x : box.y);
    const cross = (box: Box) => (dir === 'LR' ? box.y : box.x);
    return [...boxesRef.current.entries()].sort((a, b) => main(a[1]) - main(b[1]) || cross(a[1]) - cross(b[1])).map(([nodeId]) => nodeId);
  }, [dir]);

  const openNode = useCallback((node: DiagramNode<T>) => {
    const {path, line, endLine} = node.entity;
    if (path) host.open(formatFileLoc({path, line, endLine}));
  }, [host]);

  // ---- pointer: drag a node, drag the background, click; two fingers pinch
  const gesture = useRef<{pointer: number; x: number; y: number; view: View; moved: boolean; node?: {id: string; centre: Point}; group?: string} | null>(null);
  const lastClick = useRef<{id: string; at: number} | null>(null);
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{distance: number; middle: Point; view: View} | null>(null);
  const stagePoint = (event: {clientX: number; clientY: number}): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    return {x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0)};
  };
  const pinchState = () => {
    const [a, b] = [...touches.current.values()];
    return a && b ? {distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), middle: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}} : undefined;
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, stagePoint(event));
      const two = touches.current.size === 2 ? pinchState() : undefined;
      if (two) {
        // A second finger: whatever the first one started (a pan, a node drag) becomes a pinch.
        if (gesture.current?.moved && gesture.current.node) store.commit();
        gesture.current = null;
        setPanning(false);
        pinch.current = {...two, view: viewRef.current};
        return;
      }
    }
    if (event.button !== 0) return;
    const target = event.target as Element;
    const nodeId = target.closest?.('[data-node]')?.getAttribute('data-node');
    const box = nodeId != null ? boxes.get(nodeId) : undefined;
    gesture.current = {
      pointer: event.pointerId, x: event.clientX, y: event.clientY, view: viewRef.current, moved: false,
      node: nodeId != null && box ? {id: nodeId, centre: centerOf(box)} : undefined,
      group: nodeId == null ? (target.closest?.('[data-group-handle]')?.getAttribute('data-group-handle') ?? undefined) : undefined,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) touches.current.set(event.pointerId, stagePoint(event));
    const from = pinch.current;
    const two = from ? pinchState() : undefined;
    if (from && two) {
      const k = clamp(from.view.k * (two.distance / from.distance), Math.min(minZoom, from.view.k), MAX_ZOOM);
      const ratio = k / from.view.k;
      setView({k, x: two.middle.x - (from.middle.x - from.view.x) * ratio, y: two.middle.y - (from.middle.y - from.view.y) * ratio}, false);
      return;
    }
    const g = gesture.current;
    if (!g) {
      const target = event.target as Element;
      const nodeId = target.closest?.('[data-node]')?.getAttribute('data-node');
      const node = nodeId != null ? byId.get(nodeId) : undefined;
      const edgeKey = node ? null : target.closest?.('[data-edge-key]')?.getAttribute('data-edge-key');
      const edge = edgeKey != null ? edgeByKey.get(edgeKey) : undefined;
      const groupId = node || edge ? null : target.closest?.('[data-group-handle]')?.getAttribute('data-group-handle');
      const group = groupId != null ? groupById.get(groupId) : undefined;
      if (node) tooltip.show(<Tip title={node.label} detail={node.detail} />, event.clientX, event.clientY);
      else if (edge) tooltip.show(<Tip title={`${byId.get(edge.from)?.label ?? edge.from} → ${byId.get(edge.to)?.label ?? edge.to}`} detail={edge.detail ?? edge.label} />, event.clientX, event.clientY);
      else if (group) tooltip.show(<Tip title={group.label} detail={group.drillable && p.onDrillGroup ? 'double-click to open' : undefined} />, event.clientX, event.clientY);
      else tooltip.hide();
      return;
    }
    // The button was released where the stage could not see it (outside, before the drag was captured).
    if (event.buttons === 0) {
      endGesture(event, true);
      return;
    }
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.moved = true;
      tooltip.hide();
      setGlide(false);
      if (!g.node) setPanning(true);
      // Keep receiving the drag when the pointer leaves the canvas.
      try {
        svgRef.current?.setPointerCapture?.(g.pointer);
      } catch {
        // the pointer is already gone
      }
    }
    if (g.node) store.move(g.node.id, {x: Math.round(g.node.centre.x + dx / g.view.k), y: Math.round(g.node.centre.y + dy / g.view.k)});
    else setView({k: g.view.k, x: g.view.x + dx, y: g.view.y + dy}, false);
  };
  const endGesture = (event: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) => {
    touches.current.delete(event.pointerId);
    if (pinch.current) {
      // Lifting one finger ends the pinch; the other one does not go on to pan or click.
      if (touches.current.size < 2) pinch.current = null;
      gesture.current = null;
      return;
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    setPanning(false);
    try {
      svgRef.current?.releasePointerCapture?.(g.pointer);
    } catch {
      // never captured
    }
    if (g.moved) {
      if (g.node) store.commit();
      return;
    }
    if (cancelled) return;
    const now = performance.now();
    const last = lastClick.current;
    const again = (key: string) => last !== null && last.id === key && now - last.at < DOUBLE_CLICK_MS;
    const group = g.group !== undefined ? groupById.get(g.group) : undefined;
    if (group) {
      if (again(`group:${group.id}`) && group.drillable && p.onDrillGroup) {
        lastClick.current = null;
        tooltip.hide();
        p.onDrillGroup(group);
      } else lastClick.current = {id: `group:${group.id}`, at: now};
      return;
    }
    const node = g.node ? byId.get(g.node.id) : undefined;
    if (!node) return;
    setActiveId(node.id);
    if (p.onNodeClick?.(node, event.target as Element)) return;
    if (again(node.id) && node.drillable && p.onDrill) {
      lastClick.current = null;
      tooltip.hide();
      p.onDrill(node);
      return;
    }
    lastClick.current = {id: node.id, at: now};
    if ((event.metaKey || event.ctrlKey) && node.entity.path) openNode(node);
    else select(node.entity);
  };

  // ---- keyboard
  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.metaKey || event.ctrlKey) return;
    const arrow = ARROWS[event.key];
    let handled = true;
    if (arrow) {
      const [dx, dy] = arrow;
      if (event.shiftKey) {
        setView({k: view.k, x: view.x - dx * PAN_STEP, y: view.y - dy * PAN_STEP}, true);
      } else if (event.altKey) {
        const box = active ? boxes.get(active.id) : undefined;
        if (active && box) {
          const centre = centerOf(box);
          store.move(active.id, {x: centre.x + dx * NUDGE, y: centre.y + dy * NUDGE});
          store.commit();
        }
      } else if (!active) {
        const start = focusId ?? selectedIds.values().next().value ?? (opening.whole ? undefined : anchorId) ?? reading()[0];
        if (start !== undefined) activate(start);
      } else {
        const next = nearestInDirection(boxes, active.id, dx, dy);
        if (next !== undefined) activate(next);
      }
    } else if (event.altKey) {
      handled = false;
    } else if (event.key === 'Home' || event.key === 'End') {
      const order = reading();
      const target = event.key === 'Home' ? order[0] : order.at(-1);
      if (target !== undefined) activate(target);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (!active) handled = false;
      else if (event.shiftKey && active.drillable && p.onDrill) p.onDrill(active);
      else select(active.entity);
    } else if (event.key === 'Escape') {
      if (selected) select(null);
      else handled = false;
    } else if (event.key === 'o' && active) openNode(active);
    else if (event.key === 'c' && active) void navigator.clipboard?.writeText(entityClipText(active.entity))?.catch(() => {});
    else if (event.key === '+' || event.key === '=') zoomBy(1.25);
    else if (event.key === '-' || event.key === '_') zoomBy(0.8);
    else if (event.key === '0') fit();
    else if (event.key === '1') reset();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // ---- layers (memoised so a pan repaints nothing but the viewport transform)
  const detail = detailAt(view.k, p.lod === true);
  // Frame labels keep a readable size when the stage is zoomed out, in the same 5% steps as node names.
  const far = view.k < GROUP_FULL_ZOOM ? zoomStep(view.k) : 1;
  const drillGroups = p.onDrillGroup !== undefined;
  const groupLayer = useMemo(() => frames.map(frame => {
    const grow = 1 / far;
    const face = {size: 10.5 * grow, mono: true};
    const text = fitText(frame.label, Math.max(24 * grow, frame.box.w - 24 * grow), face);
    const tabWidth = Math.ceil(textWidth(text.toUpperCase(), face) * 1.05) + 12 * grow;
    const handle = frame.drillable && drillGroups;
    return (
      <g key={frame.id} className={css.group} data-group={frame.id} data-drillable={handle || undefined} transform={`translate(${frame.box.x} ${frame.box.y})`}>
        <rect className={css.groupBox} width={frame.box.w} height={frame.box.h} />
        {handle ? <rect className={css.groupHit} data-group-handle={frame.id} width={frame.box.w} height={frame.box.h} /> : null}
        <rect className={css.groupTab} data-group-handle={frame.id} x={8 * grow} y={-7 * grow} width={tabWidth} height={14 * grow} />
        <text className={css.groupText} data-group-handle={frame.id} x={14 * grow} y={0.5} style={far < 1 ? {fontSize: face.size} : undefined}>{text}</text>
      </g>
    );
  }), [frames, far, drillGroups]);

  const edgeLayer = useMemo(() => {
    const drawn: Array<{edge: DiagramEdge; route: Route; hot: boolean}> = [];
    for (const edge of edges) {
      const route = routes.get(edge.key);
      if (route && route.points.length >= 2) drawn.push({edge, route, hot: selectedIds.has(edge.from) || selectedIds.has(edge.to)});
    }
    // Light edges first, highlighted edges last, on top of the ones they cross.
    drawn.sort((a, b) => Number(a.hot) - Number(b.hot) || Number(b.edge.faint === true) - Number(a.edge.faint === true));
    return {
      lines: drawn.map(({edge, route, hot}) => <EdgeShell key={edge.key} edge={edge} route={route} hot={hot} dim={lit !== null && !hot} />),
      labels: drawn.flatMap(({edge, route, hot}) => {
        const plate = plates.get(edge.key);
        return plate && route.label
          ? [<EdgeLabel key={edge.key} edgeKey={edge.key} at={route.label} lines={plate.lines} w={plate.w} h={plate.h} hot={hot} dim={lit !== null && !hot} />]
          : [];
      }),
    };
  }, [edges, routes, selectedIds, lit, plates]);

  const renderNode = p.renderNode as (node: DiagramNode<any>, flags: NodeFlags) => ReactNode;
  const nodeLayer = useMemo(() => nodes.map(node => {
    const box = boxes.get(node.id);
    if (!box) return null;
    return (
      <NodeShell
        key={node.id}
        node={node}
        x={box.x}
        y={box.y}
        selected={selectedIds.has(node.id)}
        dim={lit !== null && !lit.has(node.id)}
        active={node.id === activeId}
        focus={node.id === focusId}
        lod={detail.lod}
        k={detail.k}
        render={renderNode}
      />
    );
  }), [nodes, boxes, selectedIds, lit, activeId, focusId, renderNode, detail.lod, detail.k]);

  // ---- what of the diagram the stage shows
  let inView = 0;
  let whole = true;
  if (ready && bounds) {
    whole = bounds.x * view.k + view.x >= -1 && (bounds.x + bounds.w) * view.k + view.x <= width + 1
      && bounds.y * view.k + view.y >= -1 && (bounds.y + bounds.h) * view.k + view.y <= height + 1;
    // A node counts when the stage shows it whole (or as much of it as fits): one cut off at the edge is not in view.
    if (!whole) for (const box of boxes.values()) if (seen(view, box, width, height)) inView++;
  }

  let grid = 16 * view.k;
  while (grid < 10) grid *= 2;

  return (
    <div className={css.shell} data-sized={p.sized || undefined}>
      <Aside note={p.note}>
        {moved.size > 0 ? (
          <button type="button" className={css.relayout} onClick={store.clear} title="Forget the positions you dragged nodes to">
            <Icon name="refresh" /> Re-layout
          </button>
        ) : null}
      </Aside>
      <div
        ref={boxRef}
        className={css.root}
        data-pending={layout.status === 'pending' ? '' : undefined}
        data-failed={layout.status === 'error' ? '' : undefined}
        style={p.sized || layout.status !== 'ready' ? undefined : {height: naturalHeight}}
      >
        {layout.status === 'pending' ? <Drafting label={`laying out ${nodes.length} nodes`} /> : null}
        {layout.status === 'error' ? <Redline code="E_LAYOUT" id={`${p.name}#${p.id}`} message={`the diagram could not be laid out: ${layout.message}`} /> : null}
        {layout.status === 'ready' ? (
          <>
            <svg
              ref={svgRef}
              className={css.canvas}
              role="img"
              aria-label={p.ariaLabel}
              tabIndex={0}
              data-panning={panning || undefined}
              data-dir={dir}
              style={{backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x - grid / 2}px ${view.y - grid / 2}px`}}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={event => endGesture(event, false)}
              onPointerCancel={event => endGesture(event, true)}
              onPointerLeave={() => { if (!gesture.current) tooltip.hide(); }}
              onKeyDown={onKeyDown}
            >
              {ready ? (
                <g
                  className={css.viewport}
                  data-glide={glide || undefined}
                  data-far={view.k < 1 || undefined}
                  data-lod={detail.lod}
                  style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`}}
                >
                  <g>{groupLayer}</g>
                  <g>{edgeLayer.lines}</g>
                  <g>{edgeLayer.labels}</g>
                  <g>{nodeLayer}</g>
                </g>
              ) : null}
            </svg>
            {ready && !whole && bounds && nodes.length >= OVERVIEW_MIN_NODES ? (
              <Overview bounds={bounds} boxes={boxes} selected={selectedIds} view={view} width={width} height={height} onGo={goTo} />
            ) : null}
            <div className={css.controls}>
              {ready && !whole && width >= IN_VIEW_MIN_WIDTH ? <span className={css.inView} data-in-view="" title="Drag to pan; Fit to view shows everything">{inView} of {nodes.length} in view</span> : null}
              <span className={css.zoom}>{Math.round(view.k * 100)}%</span>
              <button type="button" className={css.control} tabIndex={-1} aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(0.8)}><Icon name="zoom-out" /></button>
              <button type="button" className={css.control} tabIndex={-1} aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.25)}><Icon name="zoom-in" /></button>
              <button type="button" className={css.control} tabIndex={-1} aria-label="Fit to view" title="Fit to view (0)" onClick={fit}><Icon name="fit" /></button>
              <button type="button" className={css.control} tabIndex={-1} aria-label="Actual size" title="Actual size (1)" onClick={reset}><Icon name="reset" /></button>
            </div>
            <div className={css.live} aria-live="polite">{active ? [active.label, active.detail].filter(Boolean).join(', ') : ''}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
