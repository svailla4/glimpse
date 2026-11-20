// The node-link stage Graph, Flowchart and ERDiagram draw on: layout, the dot grid, pan and zoom, orthogonal edges,
// selection, keyboard traversal, draggable nodes with remembered positions and the "Re-layout" control. A component
// turns its data into nodes, edges and groups and supplies the drawing of one node; everything else is here.
import {formatFileLoc, type EntityRef} from '@glimpse/catalog';
import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import {Drafting, Icon, PlateAside, Redline, entityClipText, useHostActions, useSelection, useSize, useTooltip} from '../../../kit/index.ts';
import css from './edgekit.module.css';
import {
  boundsOf, centerOf, labelAnchor, markPath, nearestInDirection, roundedPath, routeEdge, routeLoop,
  type Box, type Dir, type Mark, type Point, type Shape,
} from './geometry.ts';
import type {Laid, LayoutSpec, Route} from './layout.ts';
import {useNodePositions} from './positions.ts';
import {MONO_11, fitText, textWidth} from './text.ts';
import {useLayout} from './useLayout.ts';

export interface DiagramNode<T = unknown> {
  id: string;
  w: number;
  h: number;
  shape?: Shape;
  group?: string;
  /** What selecting the node writes to the surface selection. */
  entity: EntityRef;
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
export interface DiagramGroup { id: string; label: string; parent?: string }
export interface NodeFlags { selected: boolean; focus: boolean }

export interface DiagramProps<T> {
  /** Component id and name, for actions, storage keys and error text. */
  id: string;
  name: string;
  nodes: ReadonlyArray<DiagramNode<T>>;
  edges: readonly DiagramEdge[];
  groups?: readonly DiagramGroup[];
  dir: Dir;
  /** True when the cell has a size: the stage fills it. Otherwise it is as tall as its content, up to 420 px. */
  sized: boolean;
  ariaLabel: string;
  /** Marginal note for the plate header: counts, what was left out. */
  note?: string;
  /** Node to centre and mark as the focus. */
  focus?: string;
  /** Draws one node in a box of its size with the origin at the top-left corner. Must be a stable function. */
  renderNode: (node: DiagramNode<T>, flags: NodeFlags) => ReactNode;
  onDrill?: (node: DiagramNode<T>) => void;
  /** Called on a plain click before it selects; return true when the click was used up. */
  onNodeClick?: (node: DiagramNode<T>, target: Element) => boolean;
  nodesep?: number;
  ranksep?: number;
}

interface View { x: number; y: number; k: number }

const PAD = 24;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
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
const ARROWS: Record<string, readonly [number, number]> = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Same entity, a file inside the selected directory, or the selected file itself (design 5.1). */
export function matchesSelection(selected: EntityRef | null, entity: EntityRef): boolean {
  if (!selected) return false;
  if (selected.type === entity.type && selected.id === entity.id) return true;
  if (entity.type !== 'file' || !entity.path) return false;
  if (selected.type === 'dir') {
    const dir = (selected.path ?? selected.id).replace(/\/+$/, '');
    return dir === '' || entity.path.startsWith(dir + '/');
  }
  return selected.type === 'file' && (selected.path ?? selected.id) === entity.path;
}

function labelPlate(label: string): {text: string; w: number; h: number} {
  const text = fitText(label, LABEL_MAX_WIDTH, MONO_11);
  return {text, w: Math.ceil(textWidth(text, MONO_11)) + 10, h: 16};
}

interface GroupBox { id: string; label: string; box: Box }

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
    return box ? [{id: group.id, label: group.label, box}] : [];
  });
}

function fitView(bounds: Box | undefined, width: number, height: number, focus?: Point): View {
  if (!bounds || width <= 0 || height <= 0) return {x: 0, y: 0, k: 1};
  const room = Math.min((width - PAD * 2) / Math.max(1, bounds.w), (height - PAD * 2) / Math.max(1, bounds.h));
  let k = clamp(room, MIN_ZOOM, 1);
  let centre = centerOf(bounds);
  // Too large to read as a whole: open on the focus instead.
  if (focus && k < 0.6) {
    k = 0.6;
    centre = focus;
  }
  return {k, x: width / 2 - centre.x * k, y: height / 2 - centre.y * k};
}

// ---------------------------------------------------------------- marks
const NodeShell = memo(function NodeShell(p: {
  node: DiagramNode<any>; x: number; y: number; selected: boolean; dim: boolean; active: boolean; focus: boolean;
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
      {p.render(node, {selected: p.selected, focus: p.focus})}
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
    >
      <path className={css.hit} d={d} />
      <path className={css.line} d={d} strokeWidth={width} />
      {end || start ? <path className={css.mark} d={start + end} /> : null}
    </g>
  );
});

const EdgeLabel = memo(function EdgeLabel(p: {edgeKey: string; at: Point; text: string; w: number; h: number; hot: boolean; dim: boolean}) {
  return (
    <g className={css.label} transform={`translate(${Math.round(p.at.x)} ${Math.round(p.at.y)})`} data-edge-label={p.edgeKey} data-hot={p.hot || undefined} data-dim={p.dim || undefined}>
      <rect className={css.labelPlate} x={-p.w / 2} y={-p.h / 2} width={p.w} height={p.h} />
      <text className={css.labelText} y={0.5}>{p.text}</text>
    </g>
  );
});

// ---------------------------------------------------------------- stage
function Stage<T>(p: DiagramProps<T> & {laid: Laid; plates: ReadonlyMap<string, {text: string; w: number; h: number}>}) {
  const {nodes, edges, groups, dir, laid, plates, id} = p;
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useSize(boxRef);
  const tooltip = useTooltip();
  const {selected, select} = useSelection(id);
  const host = useHostActions(id);
  const store = useNodePositions(id);

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const edgeByKey = useMemo(() => new Map(edges.map(edge => [edge.key, edge])), [edges]);

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
      const points = loop
        ? routeLoop(a, dir)
        : routeEdge(a, b, {dir, fromShape: byId.get(edge.from)?.shape, toShape: byId.get(edge.to)?.shape, fromPort: edge.fromPort, toPort: edge.toPort});
      out.set(edge.key, {points, label: edge.label ? (loop ? points[2] : labelAnchor(points, dir)) : undefined});
    }
    return out;
  }, [laid, moved, boxes, edges, dir, byId]);

  const frames = useMemo(() => frameGroups(groups, nodes, boxes), [groups, nodes, boxes]);
  const extent = useCallback(
    (nodeBoxes: ReadonlyMap<string, Box>, edgeRoutes: ReadonlyMap<string, Route>, groupFrames: readonly GroupBox[]) => {
      const points: Point[] = [];
      for (const route of edgeRoutes.values()) for (const point of route.points) points.push(point);
      return boundsOf([...nodeBoxes.values(), ...groupFrames.map(frame => frame.box)], points);
    },
    [],
  );
  const autoBounds = useMemo(() => extent(laid.boxes, laid.routes, frameGroups(groups, nodes, laid.boxes)), [extent, laid, groups, nodes]);

  // ---- viewport
  const naturalHeight = useMemo(() => {
    if (!autoBounds) return MIN_NATURAL_HEIGHT;
    const k = size.width > 0 ? clamp((size.width - PAD * 2) / Math.max(1, autoBounds.w), MIN_ZOOM, 1) : 1;
    return clamp(Math.ceil(autoBounds.h * k) + PAD * 2, MIN_NATURAL_HEIGHT, MAX_NATURAL_HEIGHT);
  }, [autoBounds, size.width]);
  const width = size.width;
  const height = p.sized ? size.height : naturalHeight;
  const focusBox = p.focus !== undefined ? laid.boxes.get(p.focus) : undefined;
  const fitted = useMemo(() => fitView(autoBounds, width, height, focusBox ? centerOf(focusBox) : undefined), [autoBounds, width, height, focusBox]);
  // null: follow the fitted view (and the size of the cell). A pan, a zoom or a reset pins the view.
  const [pinned, setPinned] = useState<{laid: Laid; view: View} | null>(null);
  const view = pinned && pinned.laid === laid ? pinned.view : fitted;
  const [glide, setGlide] = useState(false);
  const [panning, setPanning] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  const setView = useCallback((next: View, animate: boolean) => {
    setGlide(animate);
    setPinned({laid, view: next});
  }, [laid]);
  const zoomAt = useCallback((sx: number, sy: number, factor: number, animate: boolean) => {
    const from = viewRef.current;
    const k = clamp(from.k * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = k / from.k;
    setView({k, x: sx - (sx - from.x) * ratio, y: sy - (sy - from.y) * ratio}, animate);
  }, [setView]);
  const fit = useCallback(() => {
    setGlide(true);
    setPinned(moved.size === 0 ? null : {laid, view: fitView(extent(boxes, routes, frames), width, height)});
  }, [moved, laid, extent, boxes, routes, frames, width, height]);
  const reset = useCallback(() => {
    const bounds = extent(boxes, routes, frames);
    const centre = bounds ? centerOf(bounds) : {x: 0, y: 0};
    setView({k: 1, x: width / 2 - centre.x, y: height / 2 - centre.y}, true);
  }, [extent, boxes, routes, frames, width, height, setView]);

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

  // ---- selection
  const selectedIds = useMemo(() => {
    const ids = new Set<string>();
    if (selected) for (const node of nodes) if (matchesSelection(selected, node.entity)) ids.add(node.id);
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

  const reading = useCallback(() => {
    const main = (box: Box) => (dir === 'LR' ? box.x : box.y);
    const cross = (box: Box) => (dir === 'LR' ? box.y : box.x);
    return [...boxesRef.current.entries()].sort((a, b) => main(a[1]) - main(b[1]) || cross(a[1]) - cross(b[1])).map(([nodeId]) => nodeId);
  }, [dir]);

  const openNode = useCallback((node: DiagramNode<T>) => {
    const {path, line, endLine} = node.entity;
    if (path) host.open(formatFileLoc({path, line, endLine}));
  }, [host]);

  // ---- pointer: drag a node, drag the background, click
  const gesture = useRef<{pointer: number; x: number; y: number; view: View; moved: boolean; node?: {id: string; centre: Point}} | null>(null);
  const lastClick = useRef<{id: string; at: number} | null>(null);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const nodeId = (event.target as Element).closest?.('[data-node]')?.getAttribute('data-node');
    const box = nodeId != null ? boxes.get(nodeId) : undefined;
    gesture.current = {
      pointer: event.pointerId, x: event.clientX, y: event.clientY, view: viewRef.current, moved: false,
      node: nodeId != null && box ? {id: nodeId, centre: centerOf(box)} : undefined,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) {
      const target = event.target as Element;
      const nodeId = target.closest?.('[data-node]')?.getAttribute('data-node');
      const node = nodeId != null ? byId.get(nodeId) : undefined;
      const edgeKey = node ? null : target.closest?.('[data-edge-key]')?.getAttribute('data-edge-key');
      const edge = edgeKey != null ? edgeByKey.get(edgeKey) : undefined;
      if (node) tooltip.show(<Tip title={node.label} detail={node.detail} />, event.clientX, event.clientY);
      else if (edge) tooltip.show(<Tip title={`${byId.get(edge.from)?.label ?? edge.from} → ${byId.get(edge.to)?.label ?? edge.to}`} detail={edge.detail ?? edge.label} />, event.clientX, event.clientY);
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
    const node = g.node && !cancelled ? byId.get(g.node.id) : undefined;
    if (!node) return;
    setActiveId(node.id);
    if (p.onNodeClick?.(node, event.target as Element)) return;
    const now = performance.now();
    const last = lastClick.current;
    if (last && last.id === node.id && now - last.at < DOUBLE_CLICK_MS && node.drillable && p.onDrill) {
      lastClick.current = null;
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
        const start = (p.focus !== undefined && byId.has(p.focus) ? p.focus : undefined) ?? selectedIds.values().next().value ?? reading()[0];
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
    else if (event.key === '+' || event.key === '=') zoomAt(width / 2, height / 2, 1.25, true);
    else if (event.key === '-' || event.key === '_') zoomAt(width / 2, height / 2, 0.8, true);
    else if (event.key === '0') fit();
    else if (event.key === '1') reset();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // ---- layers (memoised so a pan repaints nothing but the viewport transform)
  const ready = width > 0 && height > 0;
  const groupLayer = useMemo(() => frames.map(frame => {
    const text = fitText(frame.label, Math.max(24, frame.box.w - 24), {size: 10.5, mono: true});
    const tabWidth = Math.ceil(textWidth(text.toUpperCase(), {size: 10.5, mono: true}) * 1.05) + 12;
    return (
      <g key={frame.id} className={css.group} data-group={frame.id} transform={`translate(${frame.box.x} ${frame.box.y})`}>
        <rect className={css.groupBox} width={frame.box.w} height={frame.box.h} />
        <rect className={css.groupTab} x={8} y={-7} width={tabWidth} height={14} />
        <text className={css.groupText} x={14} y={0.5}>{text}</text>
      </g>
    );
  }), [frames]);

  const edgeLayer = useMemo(() => {
    const drawn: Array<{edge: DiagramEdge; route: Route; hot: boolean}> = [];
    for (const edge of edges) {
      const route = routes.get(edge.key);
      if (route && route.points.length >= 2) drawn.push({edge, route, hot: selectedIds.has(edge.from) || selectedIds.has(edge.to)});
    }
    // Highlighted edges are painted last, on top of the ones they cross.
    drawn.sort((a, b) => Number(a.hot) - Number(b.hot));
    return {
      lines: drawn.map(({edge, route, hot}) => <EdgeShell key={edge.key} edge={edge} route={route} hot={hot} dim={lit !== null && !hot} />),
      labels: drawn.flatMap(({edge, route, hot}) => {
        const plate = plates.get(edge.key);
        return plate && route.label
          ? [<EdgeLabel key={edge.key} edgeKey={edge.key} at={route.label} text={plate.text} w={plate.w} h={plate.h} hot={hot} dim={lit !== null && !hot} />]
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
        focus={node.id === p.focus}
        render={renderNode}
      />
    );
  }), [nodes, boxes, selectedIds, lit, activeId, p.focus, renderNode]);

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
      <div ref={boxRef} className={css.root} style={p.sized ? undefined : {height: naturalHeight}}>
        <svg
          ref={svgRef}
          className={css.canvas}
          role="img"
          aria-label={p.ariaLabel}
          tabIndex={0}
          data-panning={panning || undefined}
          style={{backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x - grid / 2}px ${view.y - grid / 2}px`}}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={event => endGesture(event, false)}
          onPointerCancel={event => endGesture(event, true)}
          onPointerLeave={() => { if (!gesture.current) tooltip.hide(); }}
          onKeyDown={onKeyDown}
        >
          {ready ? (
            <g className={css.viewport} data-glide={glide || undefined} style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`}}>
              <g>{groupLayer}</g>
              <g>{edgeLayer.lines}</g>
              <g>{edgeLayer.labels}</g>
              <g>{nodeLayer}</g>
            </g>
          ) : null}
        </svg>
        <div className={css.controls}>
          <span className={css.zoom}>{Math.round(view.k * 100)}%</span>
          <button type="button" className={css.control} tabIndex={-1} aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAt(width / 2, height / 2, 0.8, true)}><Icon name="zoom-out" /></button>
          <button type="button" className={css.control} tabIndex={-1} aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt(width / 2, height / 2, 1.25, true)}><Icon name="zoom-in" /></button>
          <button type="button" className={css.control} tabIndex={-1} aria-label="Fit to view" title="Fit to view (0)" onClick={fit}><Icon name="fit" /></button>
          <button type="button" className={css.control} tabIndex={-1} aria-label="Actual size" title="Actual size (1)" onClick={reset}><Icon name="reset" /></button>
        </div>
        <div className={css.live} aria-live="polite">{active ? [active.label, active.detail].filter(Boolean).join(', ') : ''}</div>
      </div>
    </div>
  );
}

/** What the diagram puts in the plate header: its marginal note, then its controls. Nothing when both are absent. */
function Aside(p: {note?: string; children?: ReactNode}) {
  if (!p.note && !p.children) return null;
  return (
    <PlateAside>
      {p.note ? <span className={css.note} data-gl-note="">{p.note}</span> : null}
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
 * Lays the diagram out and draws it. While a large layout is computed it shows the drafting frame; a layout that
 * cannot be computed is a redline.
 */
export function Diagram<T>(p: DiagramProps<T>): ReactNode {
  const {nodes, edges, groups, dir, nodesep, ranksep} = p;
  const plates = useMemo(() => {
    const out = new Map<string, {text: string; w: number; h: number}>();
    for (const edge of edges) if (edge.label) out.set(edge.key, labelPlate(edge.label));
    return out;
  }, [edges]);
  const spec = useMemo<LayoutSpec>(() => ({
    dir, nodesep, ranksep,
    nodes: nodes.map(node => ({id: node.id, w: node.w, h: node.h, shape: node.shape, group: node.group})),
    edges: edges.map(edge => {
      const plate = plates.get(edge.key);
      return {key: edge.key, from: edge.from, to: edge.to, label: plate ? {w: plate.w, h: plate.h} : undefined, fromPort: edge.fromPort, toPort: edge.toPort};
    }),
    groups: groups?.map(group => ({id: group.id, parent: group.parent})),
  }), [nodes, edges, groups, dir, nodesep, ranksep, plates]);
  const layout = useLayout(spec);

  if (layout.status === 'pending') {
    return (
      <div className={css.shell} data-sized={p.sized || undefined}>
        <Aside note={p.note} />
        <div className={css.root} data-pending="">
          <Drafting label={`laying out ${nodes.length} nodes`} />
        </div>
      </div>
    );
  }
  if (layout.status === 'error') return <Redline code="E_LAYOUT" id={`${p.name}#${p.id}`} message={`the diagram could not be laid out: ${layout.message}`} />;
  return <Stage {...p} laid={layout.laid} plates={plates} />;
}
