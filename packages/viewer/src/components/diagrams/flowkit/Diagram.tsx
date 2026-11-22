// The node-link stage Graph, Flowchart and ERDiagram draw on (decisions diagram-engine-in-worker, content-sized-plates): ELK lays the diagram out in a
// worker, React Flow draws it. A component turns its data into nodes, edges and groups and supplies the drawing of one
// node; everything else is here: the plate's height, the opening view, selection linking through /ui/sel, keyboard
// traversal, Cmd/Ctrl-click and `o` to open, `c` to copy, double-click to drill, dragging nodes with the positions
// remembered (glimpse.pos.v1) and the Re-layout control, the zoom controls and the minimap.
//
// Height and opening view (content-sized-plates, sizing.ts). The drawing is as tall as it is at the scale that fits the plate's width,
// never above 100%, between 140 px and the size step's maximum (useSizeCap). When all of it then shows at a zoom where
// its smallest text is 10 px on screen it opens fitted and centred; otherwise it opens at that readable zoom at the
// start of the flow, with pan, zoom and the minimap. A diagram without a direction is laid out both ways and drawn the
// way that reads larger at the plate's width.
import {formatFileLoc} from '@glimpse/catalog';
import {
  Background, BackgroundVariant, ControlButton, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, useViewport,
  type EdgeMouseHandler, type NodeMouseHandler, type OnMoveStart, type OnNodeDrag, type OnNodesChange,
} from '@xyflow/react';
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import {Drafting, Icon, PlateAside, Redline, entityClipText, matchSelection, useHostActions, useSelection, useSize, useSizeCap, useTooltip} from '../../../kit/index.ts';
import css from './flowkit.module.css';
import {
  boundsOf, centerOf, freeSpot, isAcross, longestStretchMiddle, nearestInDirection, overlaps, routeAround, runsAlongFrame,
  type Box, type Dir, type Point,
} from './geometry.ts';
import {GROUP_PAD, hasCycle, partCount, type Laid, type LayoutSpec} from './graph.ts';
import {
  DiagramContext, FULL_ZOOM, LABEL_LINE, LOD_ZOOM, edgeTypes, handlesOf, nodeTypes, portHandle, zoomStep,
  type BoxFlowNode, type DiagramContextValue, type DiagramEdge, type DiagramGroup, type DiagramNode, type FlowEdge,
  type FlowNode, type FrameFlowNode, type NodeFlags, type Plate,
} from './parts.tsx';
import {useNodePositions, type NodePositions, type Positions} from './positions.ts';
import {CONTROLS, MIN_HEIGHT, PAD, READABLE_ZOOM, centred, fitZoom, readableZoom, scoreLayout, sizeDiagram, type Sizing, type Viewport} from './sizing.ts';
import {MONO_11, fitText, textWidth, wrapText} from './text.ts';
import {useLayouts} from './useLayout.ts';

export interface DiagramProps<T> {
  /** Component id and name, for actions, storage keys and error text. */
  id: string;
  name: string;
  nodes: ReadonlyArray<DiagramNode<T>>;
  edges: readonly DiagramEdge[];
  groups?: readonly DiagramGroup[];
  /** Flow direction. Left out, the diagram is laid out both ways and drawn the way that reads larger at its width. */
  dir?: Dir;
  ariaLabel: string;
  /** Marginal note for the plate header: counts, what was left out. */
  note?: string;
  /** Node to mark as the focus; a diagram opened in part is centred on it. */
  focus?: string;
  /** Node a diagram opened in part is centred on across the flow when there is no focus. Default: the first node. */
  anchor?: string;
  /** True when renderNode draws the levels of detail of NodeFlags.lod; the stage may then open further out. */
  lod?: boolean;
  /**
   * With `lod`: the zoom from which every node's 'name' face still says which node it is (a name cut to three letters
   * does not). The stage opens no further out. Default LOD_ZOOM; at most FULL_ZOOM.
   */
  lodZoom?: number;
  /**
   * The smallest text the nodes draw at 100%, in px. Without levels of detail the stage never opens further out than
   * the zoom that keeps it at 10 px on screen. Default 12. (Edge labels and group labels grow when zoomed out, so they
   * do not count: a diagram with edge labels opens no further out than LABEL_FLOOR.)
   */
  minText?: number;
  /** Draws one node in a box of its size with the origin at the top-left corner. Must be a stable function. */
  renderNode: (node: DiagramNode<T>, flags: NodeFlags) => ReactNode;
  /**
   * With `lod`: the width a node needs to show its whole name at `zoom` (below FULL_ZOOM, its 'name' face). A drawing
   * held back by the plate's height, with width to spare, is laid out again with nodes that wide (up to WIDEN_MAX), so
   * the names are not cut while most of the plate is empty. Must be a stable function.
   */
  widen?: (node: DiagramNode<T>, zoom: number) => number;
  onDrill?: (node: DiagramNode<T>) => void;
  onDrillGroup?: (group: DiagramGroup) => void;
  /** Called on a plain click before it selects; return true when the click was used up. */
  onNodeClick?: (node: DiagramNode<T>, target: Element) => boolean;
  /** Between nodes of one layer, and between layers. */
  nodeGap?: number;
  layerGap?: number;
}

const MAX_ZOOM = 2.5;
/** As far out as the zoom controls go, unless everything only fits further out. */
const MIN_ZOOM = 0.2;
/** Edge labels longer than this wrap onto a second line. */
const LABEL_WRAP = 112;
const LABEL_MAX_WIDTH = 168;
const DOUBLE_CLICK_MS = 400;
const NUDGE = 16;
const PAN_STEP = 48;
/** Above this many nodes only what is in view is in the DOM (the 150-node cap stays well under 100 ms of main thread). */
const VISIBLE_ONLY_FROM = 80;
/** A stage narrower than this says "n/m" instead of "n of m in view" beside the controls. */
const IN_VIEW_MIN_WIDTH = 520;
/** Above this many edges a diagram is laid out dense (graph.ts: shared first and last stretches, closer lanes). */
const DENSE_EDGES = 40;
/** Height of the frame while the first layout is computed. */
const PENDING_HEIGHT = 200;
/**
 * A diagram with edge labels opens no further out than this: below FULL_ZOOM a label grows so it stays 10 px on screen
 * (parts.tsx), and further out it would outgrow the band ELK kept for it.
 */
export const LABEL_FLOOR = 0.55;
/** The widest a node is made to say its name whole (widen). */
const WIDEN_MAX = 360;

/** A shape (width over height) in steps of a quarter octave, so a plate resized a little is not laid out again. */
const step = (ratio: number) => Math.round(2 ** (Math.round(Math.log2(Math.max(0.05, ratio)) * 4) / 4) * 100) / 100;

interface Refinement {
  kind: 'wrap' | 'widen';
  /** The layouts to try: the best of them is kept when it reads better than the first one. */
  specs: LayoutSpec[];
  /** With 'widen': the new width of each node made wider. */
  widths?: Map<string, number>;
}

/**
 * The second layout a diagram asks for, if any (see Diagram): 'wrap' when it opens in part because the flow itself is
 * too long for the plate (four nodes or more); 'widen' when it opens whole with width to spare at its zoom and some
 * name (or second line) would gain from wider nodes.
 */
function refinement<T>(
  laid: Laid, spec: LayoutSpec,
  o: {width: number; cap: number; floor: number; room: number; nodes: ReadonlyArray<DiagramNode<T>>; widen?: (node: DiagramNode<T>, zoom: number) => number},
): Refinement | undefined {
  if (spec.wrap !== undefined) return undefined;
  const {bounds} = laid;
  const sized = sizeDiagram({bounds, width: o.width, cap: o.cap, floor: o.floor, readable: o.floor, dir: laid.dir});
  const across = isAcross(laid.dir);
  const byWidth = (o.width - PAD * 2) / Math.max(1, bounds.w);
  const byHeight = (Math.max(MIN_HEIGHT, o.cap) - CONTROLS - PAD * 2) / Math.max(1, bounds.h);
  const flowBinds = across ? byWidth < byHeight : byHeight < byWidth;
  if (sized.mode === 'readable' && flowBinds && o.nodes.length >= 4) {
    // Cut between layers one edge joins; without cycles, also wherever the flow is crossed (several edges).
    const wrapped = {...spec, wrap: step(o.room)};
    return {kind: 'wrap', specs: hasCycle(spec) ? [wrapped] : [wrapped, {...wrapped, wrapAny: true}]};
  }
  if (!o.widen || sized.mode !== 'fit') return undefined;
  const zoom = sized.view.zoom;
  // The width the drawing may grow to and still open at this zoom.
  const spare = Math.max(0, (o.width - PAD * 2) / zoom - bounds.w - 8);
  if (spare < 4) return undefined;
  const placed = o.nodes.flatMap(node => {
    const box = laid.boxes.get(node.id);
    return box ? [{node, box, want: Math.max(0, Math.min(WIDEN_MAX, Math.ceil(o.widen!(node, zoom >= FULL_ZOOM ? zoom : zoomStep(zoom)))) - box.w)}] : [];
  });
  // What the drawing grows by: across the plate (left to right) the layers are columns, each as wide as its widest
  // node; down the plate the layers are rows, as wide as their nodes together, and the widest row counts.
  const key = (box: Box): [number, number] => (across ? [box.x, box.x + box.w] : [box.y, box.y + box.h]);
  placed.sort((a, b) => key(a.box)[0] - key(b.box)[0]);
  let grow = 0;
  let layerEnd = -Infinity;
  let layerGain = 0;
  for (const {box, want} of placed) {
    const [from, to] = key(box);
    if (from >= layerEnd - 0.5) {
      grow = across ? grow + layerGain : Math.max(grow, layerGain);
      layerGain = 0;
    }
    layerEnd = Math.max(layerEnd, to);
    layerGain = across ? Math.max(layerGain, want) : layerGain + want;
  }
  grow = across ? grow + layerGain : Math.max(grow, layerGain);
  if (grow <= 0) return undefined;
  // As much as the width to spare allows: the drawing still opens at the same zoom.
  const share = Math.min(1, spare / grow);
  const widths = new Map<string, number>();
  for (const {node, box, want} of placed) {
    // Whole pixels, even: all a node wants when there is room for all of it (a name a pixel too long is still cut).
    const extra = share >= 1 ? Math.ceil(want / 2) * 2 : Math.floor((want * share) / 2) * 2;
    if (extra > 0) widths.set(node.id, box.w + extra);
  }
  if (widths.size === 0) return undefined;
  return {kind: 'widen', specs: [{...spec, nodes: spec.nodes.map(node => (widths.has(node.id) ? {...node, w: widths.get(node.id)!} : node))}], widths};
}
const ARROWS: Record<string, readonly [number, number]> = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * A function that keeps its identity and always calls the latest `fn`: React Flow re-renders every node when a handler
 * it is given changes, and the handlers here close over state that changes on every drag frame.
 */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}

/** A label plate: one line, or two when the label is long, each cut to fit. */
export function labelPlate(label: string): Plate {
  const lines = textWidth(label, MONO_11) <= LABEL_WRAP ? [fitText(label, LABEL_MAX_WIDTH, MONO_11)] : wrapText(label, LABEL_WRAP, 2, MONO_11);
  const w = Math.max(...lines.map(line => textWidth(line, MONO_11)));
  return {lines, w: Math.ceil(w) + 10, h: 16 + (lines.length - 1) * LABEL_LINE};
}

/** The width a group's frame needs for its label (10.5 px mono, upper case, a little tracking). */
const groupLabelWidth = (label: string) => Math.ceil(textWidth(label.toUpperCase(), {size: 10.5, mono: true}) * 1.05) + 24;

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
 * Lays the diagram out and draws it. While the first layout is computed it shows the drafting frame; a layout that
 * cannot be computed is a redline.
 */
export function Diagram<T>(p: DiagramProps<T>): ReactNode {
  const {nodes, edges, groups} = p;
  const cap = useSizeCap();
  const rootRef = useRef<HTMLDivElement>(null);
  const size = useSize(rootRef);
  // A plate that is hidden (a closed tab) measures 0: keep the last real width, so the canvas stays and keeps the
  // reader's pan and zoom.
  const lastWidth = useRef(0);
  if (size.width > 0) lastWidth.current = size.width;
  const width = lastWidth.current;
  const store = useNodePositions(p.id);

  const plates = useMemo(() => {
    const out = new Map<string, Plate>();
    for (const edge of edges) if (edge.label) out.set(edge.key, labelPlate(edge.label));
    return out;
  }, [edges]);

  // ---- what reads: the zoom below which the smallest text is under 10 px on screen. Edge labels and group labels
  // grow when zoomed out (parts.tsx), and with levels of detail so do node names: then only their own floors count.
  const textFloor = readableZoom(p.minText ?? 12);
  const nameFloor = p.lod ? clamp(p.lodZoom ?? LOD_ZOOM, LOD_ZOOM, FULL_ZOOM) : 0;
  const floor = Math.max(p.lod ? 0 : textFloor, nameFloor, plates.size > 0 ? LABEL_FLOOR : 0);
  const readable = Math.max(READABLE_ZOOM, floor);
  // The shape of the room the plate offers: the width over the most height it may take.
  const room = width > 0 ? (width - PAD * 2) / Math.max(1, Math.max(MIN_HEIGHT, cap) - CONTROLS - PAD * 2) : undefined;

  // ---- the layout, one per direction to consider
  const input = useMemo(() => {
    const groupList = groups?.map(group => ({id: group.id, parent: group.parent, minWidth: groupLabelWidth(group.label)}));
    const layoutNodes = nodes.map(node => ({id: node.id, w: node.w, h: node.h, shape: node.shape, group: node.group}));
    const layoutEdges = edges.map(edge => {
      const plate = plates.get(edge.key);
      return {key: edge.key, from: edge.from, to: edge.to, label: plate ? {w: plate.w, h: plate.h} : undefined, fromPort: edge.fromPort, toPort: edge.toPort};
    });
    const partial = {dir: 'LR' as Dir, nodes: layoutNodes, edges: layoutEdges, groups: groupList};
    return {...partial, parts: partCount(partial)};
  }, [nodes, edges, groups, plates]);
  // Parts with no edge between them are packed to the plate's shape (in steps, so a resize rarely lays out again).
  const packTo = input.parts > 1 && room !== undefined ? step(room) : undefined;
  const specs = useMemo<LayoutSpec[]>(() => {
    const dirs: Dir[] = p.dir ? [p.dir] : ['LR', 'TB'];
    const dense = input.edges.length > DENSE_EDGES;
    return dirs.map(dir => ({
      dir, nodes: input.nodes, edges: input.edges, groups: input.groups, nodeGap: p.nodeGap, layerGap: p.layerGap, dense,
      ...(packTo !== undefined ? {aspect: packTo} : {}),
    }));
  }, [input, p.dir, p.nodeGap, p.layerGap, packTo]);
  const layout = useLayouts(specs);

  // The direction that shows the diagram larger at this width; the first one (left to right) on a near tie.
  const chosen = useMemo(() => {
    if (layout.status !== 'ready' || layout.laid.length === 0) return undefined;
    let best = 0;
    if (width > 0) {
      let bestScore = scoreLayout(layout.laid[0]!.bounds, width, cap, floor);
      layout.laid.forEach((other, i) => {
        const score = scoreLayout(other.bounds, width, cap, floor);
        if (i > 0 && score > bestScore + 0.02) {
          best = i;
          bestScore = score;
        }
      });
    }
    return {laid: layout.laid[best]!, spec: specs[best]!};
  }, [layout, specs, width, cap, floor]);

  // ---- a second layout when the first does not use the plate well: a flow too long for it is wrapped into rows (or
  // columns) of the plate's shape; a drawing the plate's height holds back, with width to spare, gets nodes wide
  // enough to say their names whole at the zoom it opens at.
  const widen = p.widen;
  const refine = useMemo(() => {
    if (!chosen || room === undefined || width <= 0) return undefined;
    return refinement(chosen.laid, chosen.spec, {width, cap, floor, room, nodes, widen});
  }, [chosen, room, width, cap, floor, nodes, widen]);
  const refineSpecs = refine?.specs;
  const refined = useLayouts(refineSpecs);
  const settled = useMemo(() => {
    if (!chosen) return undefined;
    if (!refine) return {laid: chosen.laid, widths: undefined};
    if (refined.status === 'pending') return undefined;
    // A wrapped flow must read larger (of two wraps, the one cut only where one edge crosses on a near tie); wider
    // nodes must not cost the zoom.
    let better: Laid | undefined;
    let bestScore = scoreLayout(chosen.laid.bounds, width, cap, floor) + (refine.kind === 'wrap' ? 0.02 : -0.02);
    if (refined.status === 'ready') {
      for (const candidate of refined.laid) {
        const score = scoreLayout(candidate.bounds, width, cap, floor);
        if (score >= bestScore) {
          better = candidate;
          bestScore = score + 0.02;
        }
      }
    }
    return better ? {laid: better, widths: refine.widths} : {laid: chosen.laid, widths: undefined};
  }, [chosen, refine, refined, width, cap, floor]);
  const drawnNodes = useMemo(
    () => (settled?.widths ? nodes.map(node => (settled.widths!.has(node.id) ? {...node, w: settled.widths!.get(node.id)!} : node)) : nodes),
    [settled, nodes],
  );

  // While a new layout is computed (new data, a table unfolded), the last one stays on screen with the data it was made
  // for: the canvas stays, keeps the reader's place, and nothing flashes. Only the first layout shows the drafting frame.
  const failed = layout.status === 'error';
  const current = settled ? {laid: settled.laid, nodes: drawnNodes, edges, groups, plates} : undefined;
  const last = useRef(current);
  if (current) last.current = current;
  const shown = current ?? (!failed ? last.current : undefined);
  const laid = shown?.laid;

  // The arrangement the diagram opens with: the positions stored when its layout arrived (a reload, new data), so the
  // plate's height and the opening view hold a node dragged outside the automatic drawing. A drag after that resizes
  // nothing and moves no view (the reader pans to the node); Re-layout opens the automatic drawing again.
  const [opened, setOpened] = useState(() => ({laid, key: store.key, positions: store.positions}));
  if (opened.laid !== laid || opened.key !== store.key) setOpened({laid, key: store.key, positions: store.positions});
  const openPositions = opened.laid === laid && opened.key === store.key ? opened.positions : store.positions;
  const shownNodes = shown?.nodes;
  const shownGroups = shown?.groups;
  const opening = useMemo(() => {
    if (!laid || !shownNodes) return undefined;
    const {boxes, moved} = placeNodes(laid, openPositions);
    const groupById = new Map((shownGroups ?? []).map(group => [group.id, group]));
    const frames = framesAround(laid.frames, moved, boxes, groupChains(shownNodes, laid, groupById));
    return {boxes, bounds: drawnBounds(laid, moved, boxes, frames)};
  }, [laid, openPositions, shownNodes, shownGroups]);
  const relayout = useCallback(() => {
    store.clear();
    setOpened({laid, key: store.key, positions: {}});
  }, [store, laid]);

  const focusId = p.focus !== undefined && laid?.boxes.has(p.focus) ? p.focus : undefined;
  const anchorPoint = useMemo((): Point | undefined => {
    if (!laid || !opening) return undefined;
    const pick = focusId ?? (p.anchor !== undefined && laid.boxes.has(p.anchor) ? p.anchor : undefined) ?? firstInFlow(laid);
    const box = pick !== undefined ? opening.boxes.get(pick) : undefined;
    return box ? centerOf(box) : undefined;
  }, [laid, opening, focusId, p.anchor]);
  const sizing = useMemo(
    () => (laid && opening && width > 0 ? sizeDiagram({bounds: opening.bounds, width, cap, floor, readable, dir: laid.dir, anchor: anchorPoint, boxes: opening.boxes.values()}) : undefined),
    [laid, opening, width, cap, floor, readable, anchorPoint],
  );

  const height = sizing?.height ?? Math.min(cap, PENDING_HEIGHT);
  return (
    <div className={css.shell}>
      <Aside note={p.note}>
        {Object.keys(store.positions).some(nodeId => laid?.boxes.has(nodeId)) ? (
          <button type="button" className={css.relayout} onClick={relayout} title="Forget the positions you dragged nodes to">
            <Icon name="refresh" /> Re-layout
          </button>
        ) : null}
      </Aside>
      <div
        ref={rootRef}
        className={css.root}
        data-pending={!settled && !failed ? '' : undefined}
        data-stale={!settled && !failed && shown ? '' : undefined}
        data-failed={failed ? '' : undefined}
        data-mode={sizing?.mode}
        style={failed ? undefined : {height}}
      >
        {!settled && !failed && !shown ? <Drafting label={`laying out ${nodes.length} ${nodes.length === 1 ? 'node' : 'nodes'}`} /> : null}
        {layout.status === 'error' ? <Redline code="E_LAYOUT" id={`${p.name}#${p.id}`} message={`the diagram could not be laid out: ${layout.message}`} /> : null}
        {shown && laid && sizing ? (
          <ReactFlowProvider>
            <Canvas
              {...p}
              nodes={shown.nodes}
              edges={shown.edges}
              groups={shown.groups}
              plates={shown.plates}
              laid={laid}
              sizing={sizing}
              width={width}
              store={store}
              focusId={focusId}
              anchorPoint={anchorPoint}
            />
          </ReactFlowProvider>
        ) : null}
      </div>
    </div>
  );
}

/** How far a dropped node is kept from the node or the foreign frame it was dropped on. */
const DROP_GAP = 20;

/** True when group `inner` is nested (at any depth) in group `outer`. */
function isNested(inner: string, outer: string, groupById: ReadonlyMap<string, DiagramGroup>): boolean {
  const seen = new Set<string>();
  for (let at = groupById.get(inner)?.parent; at !== undefined && !seen.has(at); at = groupById.get(at)?.parent) {
    if (at === outer) return true;
    seen.add(at);
  }
  return false;
}

/** A node's box with the room its group keeps round it. */
const padded = (box: Box): Box => ({x: box.x - GROUP_PAD.side, y: box.y - GROUP_PAD.top, w: box.w + GROUP_PAD.side * 2, h: box.h + GROUP_PAD.top + GROUP_PAD.bottom});

/**
 * The group frames with some nodes moved: every frame that holds a moved node (directly or through a nested group) is
 * drawn round where its members and nested frames are now, never narrower than ELK made it (its label's room); the
 * others are ELK's.
 */
export function framesAround(
  auto: ReadonlyMap<string, Box>, moved: ReadonlySet<string>, boxes: ReadonlyMap<string, Box>, chains: ReadonlyMap<string, readonly string[]>,
): Map<string, Box> {
  if (moved.size === 0) return auto as Map<string, Box>;
  const touched = new Set<string>();
  for (const nodeId of moved) for (const group of chains.get(nodeId) ?? []) touched.add(group);
  if (touched.size === 0) return auto as Map<string, Box>;
  const out = new Map(auto);
  // Innermost first: a group's frame holds the new frames of the groups nested in it.
  const depth = new Map<string, number>();
  for (const chain of chains.values()) for (const [i, group] of chain.entries()) depth.set(group, Math.max(depth.get(group) ?? 0, chain.length - i));
  const order = [...touched].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
  for (const group of order) {
    const parts: Box[] = [];
    for (const [nodeId, chain] of chains) {
      const at = chain.indexOf(group);
      if (at < 0) continue;
      const box = boxes.get(nodeId);
      // A direct member with its padding; a member of a nested group through that group's frame, padded.
      if (box) parts.push(padded(at === 0 ? box : (out.get(chain[at - 1]!) ?? box)));
    }
    const around = boundsOf(parts);
    const before = auto.get(group);
    if (around && before) out.set(group, {...around, w: Math.max(around.w, before.w)});
  }
  return out;
}

/** The automatic layout's boxes with the person's positions (node centres) on top, and the nodes they moved. */
function placeNodes(laid: Laid, positions: Positions): {boxes: Map<string, Box>; moved: Set<string>} {
  let boxes: Map<string, Box> = laid.boxes;
  const moved = new Set<string>();
  for (const [nodeId, centre] of Object.entries(positions)) {
    const auto = laid.boxes.get(nodeId);
    if (!auto) continue;
    if (boxes === laid.boxes) boxes = new Map(laid.boxes);
    boxes.set(nodeId, {x: centre.x - auto.w / 2, y: centre.y - auto.h / 2, w: auto.w, h: auto.h});
    moved.add(nodeId);
  }
  return {boxes, moved};
}

/** The groups each node is drawn in, innermost first (only groups that have a frame). */
function groupChains<T>(nodes: ReadonlyArray<DiagramNode<T>>, laid: Laid, groupById: ReadonlyMap<string, DiagramGroup>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    const chain: string[] = [];
    for (let at = node.group; at !== undefined && laid.frames.has(at) && !chain.includes(at); at = groupById.get(at)?.parent) chain.push(at);
    out.set(node.id, chain);
  }
  return out;
}

/** What is drawn: the automatic layout's bounds grown round the moved nodes and the frames drawn round them. */
function drawnBounds(laid: Laid, moved: ReadonlySet<string>, boxes: ReadonlyMap<string, Box>, frames: ReadonlyMap<string, Box>): Box {
  if (moved.size === 0) return laid.bounds;
  return boundsOf([laid.bounds, ...[...moved].map(nodeId => boxes.get(nodeId)!), ...frames.values()]) ?? laid.bounds;
}

/** The node where the flow starts: the first node in reading order along the flow of the automatic layout. */
function firstInFlow(laid: Laid): string | undefined {
  const key = (box: Box) => {
    switch (laid.dir) {
      case 'LR': return [box.x, box.y];
      case 'RL': return [-(box.x + box.w), box.y];
      case 'TB': return [box.y, box.x];
      default: return [-(box.y + box.h), box.x];
    }
  };
  let best: [string, Box] | undefined;
  for (const [nodeId, box] of laid.boxes) {
    if (!best) best = [nodeId, box];
    else {
      const [a, b] = key(box);
      const [c, d] = key(best[1]);
      if (a! < c! - 0.5 || (Math.abs(a! - c!) <= 0.5 && b! < d!)) best = [nodeId, box];
    }
  }
  return best?.[0];
}

interface CanvasProps<T> extends DiagramProps<T> {
  laid: Laid;
  sizing: Sizing;
  width: number;
  plates: ReadonlyMap<string, Plate>;
  store: NodePositions;
  focusId: string | undefined;
  anchorPoint: Point | undefined;
}

function Canvas<T>(p: CanvasProps<T>): ReactNode {
  const {nodes, edges, groups, laid, sizing, width, store, plates} = p;
  // The canvas: the diagram less the controls bar under it.
  const height = sizing.canvas;
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const tooltip = useTooltip();
  const {selected, select} = useSelection(p.id);
  const host = useHostActions(p.id);
  const stageRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const edgeByKey = useMemo(() => new Map(edges.map(edge => [edge.key, edge])), [edges]);
  const groupById = useMemo(() => new Map((groups ?? []).map(group => [group.id, group])), [groups]);
  // A tooltip belongs to a node or an edge of this data: when the data is replaced (a drill, a refresh) it goes.
  const shownNodes = useRef(nodes);
  useEffect(() => {
    if (shownNodes.current !== nodes) tooltip.hide();
    shownNodes.current = nodes;
  }, [nodes, tooltip]);

  // ---- geometry: the automatic layout, then the person's positions on top (stored as node centres)
  const {boxes, moved} = useMemo(() => placeNodes(laid, store.positions), [laid, store.positions]);
  // The groups each node is drawn in, innermost first (only groups that have a frame).
  const chains = useMemo(() => groupChains(nodes, laid, groupById), [nodes, laid, groupById]);
  // A frame keeps its members: the frames of a dragged node are drawn round where their members are now.
  const frames = useMemo(() => framesAround(laid.frames, moved, boxes, chains), [laid, moved, boxes, chains]);
  const bounds = useMemo(() => drawnBounds(laid, moved, boxes, frames), [laid, moved, boxes, frames]);

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

  const [activeId, setActiveId] = useState<string>();
  const active = activeId !== undefined ? byId.get(activeId) : undefined;

  const shapes = useMemo(() => new Map(nodes.map(node => [node.id, node.shape])), [nodes]);
  const ctx = useMemo<DiagramContextValue>(() => ({
    renderNode: p.renderNode as DiagramContextValue['renderNode'],
    lod: p.lod === true,
    dir: laid.dir,
    selected: selectedIds,
    lit,
    active: activeId,
    focus: p.focusId,
    plates,
    shapes,
    drillGroups: p.onDrillGroup !== undefined,
  }), [p.renderNode, p.lod, laid.dir, selectedIds, lit, activeId, p.focusId, plates, shapes, p.onDrillGroup]);

  // ---- React Flow's nodes and edges. A node object is kept while nothing about it changes, so a drag or a new
  // selection does not make React Flow rebuild the others.
  const ports = useMemo(() => {
    const out = new Map<string, {source: number[]; target: number[]}>();
    const of = (nodeId: string) => {
      const known = out.get(nodeId);
      if (known) return known;
      const entry = {source: [] as number[], target: [] as number[]};
      out.set(nodeId, entry);
      return entry;
    };
    for (const edge of edges) {
      if (edge.fromPort !== undefined) of(edge.from).source.push(edge.fromPort);
      if (edge.toPort !== undefined) of(edge.to).target.push(edge.toPort);
    }
    return out;
  }, [edges]);
  const kept = useRef(new Map<string, {box: Box; node: unknown; flow: FlowNode}>());
  const flowNodes = useMemo(() => {
    const previous = kept.current;
    const next = new Map<string, {box: Box; node: unknown; flow: FlowNode}>();
    const out: FlowNode[] = [];
    const same = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    for (const [groupId, box] of frames) {
      const group = groupById.get(groupId);
      if (!group) continue;
      const key = `frame:${groupId}`;
      const old = previous.get(key);
      const flow: FrameFlowNode = old && old.node === group && same(old.box, box) ? (old.flow as FrameFlowNode) : {
        id: groupId, type: 'frame', position: {x: box.x, y: box.y}, width: box.w, height: box.h, zIndex: -1,
        draggable: false, selectable: false, focusable: false, className: css.frameNode, ariaLabel: `group ${group.label}`,
        data: {group, label: group.label},
      };
      next.set(key, {box, node: group, flow});
      out.push(flow);
    }
    for (const node of nodes) {
      const box = boxes.get(node.id);
      if (!box) continue;
      const old = previous.get(node.id);
      let flow: BoxFlowNode;
      if (old && old.node === node && same(old.box, box)) flow = old.flow as BoxFlowNode;
      else {
        const handles = handlesOf(box.w, box.h, laid.dir, ports.get(node.id) ?? {source: [], target: []});
        flow = {
          id: node.id, type: 'box', position: {x: box.x, y: box.y}, width: box.w, height: box.h, ariaLabel: node.label,
          handles: handles.map(h => ({id: h.id, type: h.type, position: h.position, x: h.x - 0.5, y: h.y - 0.5, width: 1, height: 1})),
          data: {node, handles},
        };
      }
      next.set(node.id, {box, node, flow});
      out.push(flow);
    }
    kept.current = next;
    return out;
  }, [frames, groupById, nodes, boxes, laid.dir, ports]);

  // ---- routes: ELK's, moved with their ends; an edge with one end dragged elsewhere goes round what is in the way
  // (the other nodes, and the frames of groups neither end is in), its label on its longest stretch.
  const routes = useMemo(() => {
    const out = new Map<string, {points: readonly Point[]; labelAt?: Point}>();
    for (const edge of edges) {
      const route = laid.routes.get(edge.key);
      const fromAuto = laid.boxes.get(edge.from);
      const toAuto = laid.boxes.get(edge.to);
      const a = boxes.get(edge.from);
      const b = boxes.get(edge.to);
      if (!route || route.points.length < 2 || !fromAuto || !toAuto || !a || !b) continue;
      const ds = {x: a.x - fromAuto.x, y: a.y - fromAuto.y};
      const dt = {x: b.x - toAuto.x, y: b.y - toAuto.y};
      const label = route.label ? {x: route.label.x + route.label.w / 2, y: route.label.y + route.label.h / 2} : undefined;
      if (Math.abs(ds.x - dt.x) < 0.5 && Math.abs(ds.y - dt.y) < 0.5) {
        const shift = (p: Point) => ({x: p.x + ds.x, y: p.y + ds.y});
        out.set(edge.key, ds.x === 0 && ds.y === 0 ? {points: route.points, labelAt: label} : {points: route.points.map(shift), labelAt: label && shift(label)});
        continue;
      }
      const own = new Set([...(chains.get(edge.from) ?? []), ...(chains.get(edge.to) ?? [])]);
      const others: Box[] = [];
      for (const [nodeId, box] of boxes) if (nodeId !== edge.from && nodeId !== edge.to) others.push(box);
      const foreign: Box[] = [];
      for (const [groupId, box] of frames) if (!own.has(groupId)) foreign.push(box);
      const points = routeAround(a, b, {nodes: others, frames: foreign}, {fromPort: edge.fromPort, toPort: edge.toPort});
      out.set(edge.key, {points, labelAt: edge.label ? longestStretchMiddle(points) : undefined});
    }
    return out;
  }, [edges, laid, boxes, frames, chains]);

  // Edges ELK ran along a group's frame are drawn light, so they do not read as a second frame.
  const alongFrames = useMemo(() => {
    const out = new Set<string>();
    if (laid.frames.size === 0) return out;
    for (const [key, route] of laid.routes) if (runsAlongFrame(route.points, laid.frames.values())) out.add(key);
    return out;
  }, [laid]);

  const flowEdges = useMemo(() => {
    const out: FlowEdge[] = [];
    for (const edge of edges) {
      const route = routes.get(edge.key);
      if (!route) continue;
      const hot = selectedIds.has(edge.from) || selectedIds.has(edge.to);
      out.push({
        id: edge.key, type: 'elk', source: edge.from, target: edge.to,
        sourceHandle: edge.fromPort !== undefined ? portHandle('source', edge.fromPort) : null,
        targetHandle: edge.toPort !== undefined ? portHandle('target', edge.toPort) : null,
        focusable: false, selectable: false, zIndex: hot ? 1 : 0,
        data: {edge, points: route.points, labelAt: route.labelAt, faint: edge.faint === true || (alongFrames.has(edge.key) && !edge.cycle)},
      });
    }
    // Light edges first, highlighted edges last, on top of the ones they cross.
    return out.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0) || Number(b.data!.faint) - Number(a.data!.faint));
  }, [edges, routes, selectedIds, alongFrames]);

  // ---- the view
  const fitAll = fitZoom(bounds, width, height);
  const minZoom = Math.min(MIN_ZOOM, fitAll);
  // null: follow the opening view (and the size of the plate). A pan, a zoom or a control pins the view.
  const pinnedFor = useRef<Laid | null>(null);
  const pin = useCallback(() => {
    pinnedFor.current = laid;
  }, [laid]);
  useEffect(() => {
    if (pinnedFor.current !== laid) void rf.setViewport(sizing.view);
  }, [rf, sizing, laid]);
  const onMoveStart = useCallback<OnMoveStart>(event => {
    // Only what the reader does pins the view; the view set from here comes without an event.
    if (event) pin();
  }, [pin]);

  const view = useCallback((): Viewport => {
    const v = rf.getViewport();
    return {x: v.x, y: v.y, zoom: v.zoom};
  }, [rf]);
  const setView = useCallback((next: Viewport) => {
    pin();
    void rf.setViewport(next);
  }, [rf, pin]);

  /** Moves the view as little as it takes to show the node whole, 8 px in from the edges. */
  const reveal = useCallback((nodeId: string) => {
    const box = boxes.get(nodeId);
    if (!box) return;
    const v = view();
    const left = box.x * v.zoom + v.x;
    const top = box.y * v.zoom + v.y;
    const right = left + box.w * v.zoom;
    const bottom = top + box.h * v.zoom;
    const dx = left < 8 ? 8 - left : right > width - 8 ? width - 8 - right : 0;
    const dy = top < 8 ? 8 - top : bottom > height - 8 ? height - 8 - bottom : 0;
    if (dx !== 0 || dy !== 0) setView({zoom: v.zoom, x: v.x + dx, y: v.y + dy});
  }, [boxes, view, width, height, setView]);
  const activate = useCallback((nodeId: string) => {
    setActiveId(nodeId);
    reveal(nodeId);
  }, [reveal]);

  /**
   * Where a zoom from the buttons or the keyboard holds still: the selected node, else the node the keyboard is on,
   * when it is on the stage; else the middle of the stage, pulled onto the diagram when the middle is empty.
   */
  const pivot = useCallback((): Point => {
    const v = view();
    const onStage = (nodeId: string | undefined): Point | undefined => {
      const box = nodeId !== undefined ? boxes.get(nodeId) : undefined;
      if (!box) return undefined;
      const c = centerOf(box);
      const at = {x: c.x * v.zoom + v.x, y: c.y * v.zoom + v.y};
      return at.x >= 0 && at.x <= width && at.y >= 0 && at.y <= height ? at : undefined;
    };
    const chosen = onStage(selectedIds.values().next().value) ?? onStage(activeId);
    if (chosen) return chosen;
    return {
      x: clamp(width / 2, bounds.x * v.zoom + v.x, (bounds.x + bounds.w) * v.zoom + v.x),
      y: clamp(height / 2, bounds.y * v.zoom + v.y, (bounds.y + bounds.h) * v.zoom + v.y),
    };
  }, [view, boxes, width, height, selectedIds, activeId, bounds]);
  const zoomBy = useCallback((factor: number) => {
    const at = pivot();
    const from = view();
    const zoom = clamp(from.zoom * factor, Math.min(minZoom, from.zoom), MAX_ZOOM);
    const ratio = zoom / from.zoom;
    setView({zoom, x: at.x - (at.x - from.x) * ratio, y: at.y - (at.y - from.y) * ratio});
  }, [pivot, view, minZoom, setView]);
  const fit = useCallback(() => {
    // With nothing moved and everything in the opening view, "fit" is that view again and follows the plate.
    if (moved.size === 0 && sizing.mode === 'fit') {
      pinnedFor.current = null;
      void rf.setViewport(sizing.view);
    } else setView(centred(bounds, width, height, Math.min(1, fitZoom(bounds, width, height))));
  }, [moved, sizing, rf, setView, bounds, width, height]);
  const reset = useCallback(() => {
    const at = pivot();
    const from = view();
    setView({zoom: 1, x: at.x - (at.x - from.x) / from.zoom, y: at.y - (at.y - from.y) / from.zoom});
  }, [pivot, view, setView]);

  const reading = useCallback(() => {
    const across = laid.dir === 'LR' || laid.dir === 'RL';
    const sign = laid.dir === 'RL' || laid.dir === 'BT' ? -1 : 1;
    const main = (box: Box) => sign * (across ? box.x : box.y);
    const cross = (box: Box) => (across ? box.y : box.x);
    return [...boxes.entries()].sort((a, b) => main(a[1]) - main(b[1]) || cross(a[1]) - cross(b[1])).map(([nodeId]) => nodeId);
  }, [boxes, laid.dir]);

  const openNode = useCallback((node: DiagramNode<T>) => {
    const {path, line, endLine} = node.entity;
    if (path) host.open(formatFileLoc({path, line, endLine}));
  }, [host]);

  // ---- pointer: click selects, Cmd/Ctrl-click opens, a second click on a drillable node drills
  const lastClick = useRef<{id: string; at: number} | null>(null);
  const again = (key: string, now: number): boolean => lastClick.current !== null && lastClick.current.id === key && now - lastClick.current.at < DOUBLE_CLICK_MS;
  const onNodeClick = useStable<Parameters<NodeMouseHandler<FlowNode>>, void>((event, flowNode) => {
    const now = performance.now();
    if (flowNode.type === 'frame') {
      const group = groupById.get(flowNode.id);
      if (!group || !(event.target as Element).closest?.('[data-group-handle]')) return;
      if (again(`group:${group.id}`, now) && group.drillable && p.onDrillGroup) {
        lastClick.current = null;
        tooltip.hide();
        // The view that opens is the group's inside: nothing in it is selected, so nothing in it is dimmed.
        if (selected) select(null);
        p.onDrillGroup(group);
      } else lastClick.current = {id: `group:${group.id}`, at: now};
      return;
    }
    const node = byId.get(flowNode.id);
    if (!node) return;
    setActiveId(node.id);
    // Cmd/Ctrl-click opens the file; it is never half of a double-click.
    if ((event.metaKey || event.ctrlKey) && node.entity.path) {
      lastClick.current = null;
      openNode(node);
      return;
    }
    if (p.onNodeClick?.(node, event.target as Element)) return;
    if (again(node.id, now) && node.drillable && p.onDrill) {
      lastClick.current = null;
      tooltip.hide();
      // The first click of the double-click selected the node; the drilled view (its inside) opens with nothing
      // selected, so none of it is dimmed.
      if (selected) select(null);
      p.onDrill(node);
      return;
    }
    lastClick.current = {id: node.id, at: now};
    select(node.entity);
  });
  const onNodeHover = useStable<Parameters<NodeMouseHandler<FlowNode>>, void>((event, flowNode) => {
    if (flowNode.type === 'frame') {
      const group = groupById.get(flowNode.id);
      if (group && (event.target as Element).closest?.('[data-group-handle]')) {
        tooltip.show(<Tip title={group.label} detail={group.drillable && p.onDrillGroup ? 'double-click to open' : undefined} />, event.clientX, event.clientY);
      } else tooltip.hide();
      return;
    }
    const node = byId.get(flowNode.id);
    if (node) tooltip.show(<Tip title={node.label} detail={node.detail} />, event.clientX, event.clientY);
  });
  const onEdgeHover = useStable<Parameters<EdgeMouseHandler<FlowEdge>>, void>((event, flowEdge) => {
    const edge = edgeByKey.get(flowEdge.id);
    if (!edge) return;
    tooltip.show(<Tip title={`${byId.get(edge.from)?.label ?? edge.from} → ${byId.get(edge.to)?.label ?? edge.to}`} detail={edge.detail ?? edge.label} />, event.clientX, event.clientY);
  });
  const hideTip = useStable(() => tooltip.hide());

  // ---- dragging: React Flow moves the node, the position store keeps it (as the node's centre)
  const onNodesChange = useStable<Parameters<OnNodesChange<FlowNode>>, void>(changes => {
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue;
      const box = boxes.get(change.id);
      if (box) store.move(change.id, {x: Math.round(change.position.x + box.w / 2), y: Math.round(change.position.y + box.h / 2)});
    }
  });
  const onNodeDragStart = useStable<Parameters<OnNodeDrag<FlowNode>>, void>(() => tooltip.hide());
  // A node dropped on another, or into a group it is not in, moves to the nearest place beside it; so does one whose
  // frame would grow over another group or a node outside it.
  const onNodeDragStop = useStable<Parameters<OnNodeDrag<FlowNode>>, void>((_event, _node, dragged) => {
    for (const flowNode of dragged) {
      if (flowNode.type !== 'box') continue;
      const size = boxes.get(flowNode.id);
      if (!size) continue;
      // Where React Flow dropped it (the store may not have drawn the last move yet).
      const box = {x: flowNode.position.x, y: flowNode.position.y, w: size.w, h: size.h};
      const own = chains.get(flowNode.id) ?? [];
      const nodeBlockers: Box[] = [];
      for (const [nodeId, other] of boxes) if (nodeId !== flowNode.id) nodeBlockers.push(other);
      const frameBlockers: Box[] = [];
      for (const [groupId, frame] of frames) if (!own.includes(groupId)) frameBlockers.push(frame);
      const fits = (at: Box) => {
        if (own.length === 0) return true;
        const trial = new Map(boxes).set(flowNode.id, at);
        const grown = framesAround(laid.frames, new Set([...moved, flowNode.id]), trial, chains);
        for (const group of own) {
          const frame = grown.get(group);
          if (!frame) continue;
          for (const [groupId, other] of grown) {
            // Its own frames and the frames nested in this one hold it; any other may not be overlapped.
            if (own.includes(groupId) || isNested(groupId, group, groupById)) continue;
            if (overlaps(frame, other, 1)) return false;
          }
          for (const [nodeId, other] of trial) if (!(chains.get(nodeId) ?? []).includes(group) && overlaps(frame, other, 1)) return false;
        }
        return true;
      };
      const spot = freeSpot(box, [...nodeBlockers, ...frameBlockers], DROP_GAP, fits) ?? freeSpot(box, nodeBlockers, DROP_GAP) ?? box;
      if (spot !== box) store.move(flowNode.id, {x: Math.round(spot.x + spot.w / 2), y: Math.round(spot.y + spot.h / 2)});
    }
    store.commit();
  });

  // ---- keyboard: the stage is one tab stop; the arrows walk its nodes
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey) return;
    const arrow = ARROWS[event.key];
    let handled = true;
    if (arrow) {
      const [dx, dy] = arrow;
      if (event.shiftKey) {
        const v = view();
        setView({zoom: v.zoom, x: v.x - dx * PAN_STEP, y: v.y - dy * PAN_STEP});
      } else if (event.altKey) {
        const box = active ? boxes.get(active.id) : undefined;
        if (active && box) {
          const centre = centerOf(box);
          store.move(active.id, {x: centre.x + dx * NUDGE, y: centre.y + dy * NUDGE});
          store.commit();
        }
      } else if (!active) {
        const start = p.focusId ?? selectedIds.values().next().value ?? reading()[0];
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
      else if (event.shiftKey && active.drillable && p.onDrill) {
        if (selected) select(null);
        p.onDrill(active);
      }
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

  // Where the minimap goes: a corner of the canvas that covers no node and no label of the opening view, else a strip
  // in the controls bar. Chosen once per layout and plate, so it does not jump while the reader pans.
  const spot = useMemo(() => {
    const occupied: Box[] = [...boxes.values()];
    for (const [key, route] of routes) {
      const plate = plates.get(key);
      if (plate && route.labelAt) occupied.push({x: route.labelAt.x - plate.w / 2, y: route.labelAt.y - plate.h / 2, w: plate.w, h: plate.h});
    }
    return minimapSpot(bounds, sizing.view, occupied, width, height);
  }, [boxes, routes, plates, bounds, sizing, width, height]);

  const many = nodes.length > VISIBLE_ONLY_FROM;
  // The reader can pan the drawing up to its edge, with the paper a fitted drawing keeps; never into the void.
  const extent: [[number, number], [number, number]] = [[bounds.x - PAD, bounds.y - PAD], [bounds.x + bounds.w + PAD, bounds.y + bounds.h + PAD]];
  return (
    <DiagramContext.Provider value={ctx}>
      <div
        ref={stageRef}
        className={css.stage}
        role="img"
        aria-label={p.ariaLabel}
        tabIndex={0}
        data-dir={laid.dir}
        onKeyDown={onKeyDown}
        onPointerLeave={hideTip}
      >
        <ReactFlow<FlowNode, FlowEdge>
          className={css.flow}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeHover}
          onNodeMouseMove={onNodeHover}
          onNodeMouseLeave={hideTip}
          onEdgeMouseEnter={onEdgeHover}
          onEdgeMouseMove={onEdgeHover}
          onEdgeMouseLeave={hideTip}
          onMoveStart={onMoveStart}
          defaultViewport={sizing.view}
          minZoom={minZoom}
          maxZoom={MAX_ZOOM}
          translateExtent={extent}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          selectNodesOnDrag={false}
          nodeDragThreshold={4}
          disableKeyboardA11y
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panActivationKeyCode={null}
          zoomActivationKeyCode={null}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
          zoomOnPinch
          panOnScroll={false}
          preventScrolling={false}
          onlyRenderVisibleElements={many}
          proOptions={{hideAttribution: true}}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} className={css.grid} />
        </ReactFlow>
      </div>
      <Overview bounds={bounds} boxes={boxes} total={nodes.length} width={width} height={height} spot={spot} onZoomOut={() => zoomBy(0.8)} onZoomIn={() => zoomBy(1.25)} onFit={fit} onReset={reset} />
      <div className={css.live} aria-live="polite">{active ? [active.label, active.detail].filter(Boolean).join(', ') : ''}</div>
    </DiagramContext.Provider>
  );
}

/** True when the stage shows `box` whole, or as much of it as the stage can hold: not cut off at an edge. */
export function seen(view: Viewport, box: Box, width: number, height: number): boolean {
  const left = box.x * view.zoom + view.x;
  const top = box.y * view.zoom + view.y;
  const w = box.w * view.zoom;
  const h = box.h * view.zoom;
  return Math.min(left + w, width) - Math.max(left, 0) >= Math.min(w, width) - 1 && Math.min(top + h, height) - Math.max(top, 0) >= Math.min(h, height) - 1;
}

/** Where the minimap is drawn: a corner of the canvas, or a strip in the controls bar, and its size. */
export type MinimapSpot =
  | {kind: 'corner'; corner: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left'; w: number; h: number}
  | {kind: 'strip'; w: number; h: number};

/** Room the controls bar keeps on its right for the count, the zoom readout and the four buttons. */
const BAR_CONTROLS = {wide: 300, narrow: 220};
const MAP_MARGIN = 8;

/**
 * Where the minimap goes for a drawing of `bounds` opened at `view` on a canvas of `width` x `canvas`: shaped like the
 * drawing (at most 140 x 96, and a quarter of the canvas), in the first corner (bottom right, top right, bottom left,
 * top left) where it covers none of `occupied` (nodes and label plates, diagram coordinates) with 8 px to spare; else
 * a strip 22 px tall in the controls bar, left of the controls. Undefined when the bar has no room either.
 */
export function minimapSpot(bounds: Box, view: Viewport, occupied: readonly Box[], width: number, canvas: number): MinimapSpot | undefined {
  const aspect = Math.max(0.05, bounds.w / Math.max(1, bounds.h));
  if (width >= 360 && canvas >= 150) {
    let w = Math.min(140, Math.round(width * 0.24));
    let h = Math.round(w / aspect);
    const most = Math.min(96, Math.round(canvas * 0.4));
    if (h > most) {
      h = most;
      w = Math.max(48, Math.round(h * aspect));
    }
    h = Math.max(24, h);
    const onScreen = occupied.map(b => ({x: b.x * view.zoom + view.x, y: b.y * view.zoom + view.y, w: b.w * view.zoom, h: b.h * view.zoom}));
    const right = width - MAP_MARGIN - w;
    const bottom = canvas - MAP_MARGIN - h;
    const corners = [['bottom-right', right, bottom], ['top-right', right, MAP_MARGIN], ['bottom-left', MAP_MARGIN, bottom], ['top-left', MAP_MARGIN, MAP_MARGIN]] as const;
    for (const [corner, x, y] of corners) {
      const keep = {x: x - MAP_MARGIN, y: y - MAP_MARGIN, w: w + MAP_MARGIN * 2, h: h + MAP_MARGIN * 2};
      if (!onScreen.some(b => overlaps(b, keep))) return {kind: 'corner', corner, w, h};
    }
  }
  const room = width - (width >= IN_VIEW_MIN_WIDTH ? BAR_CONTROLS.wide : BAR_CONTROLS.narrow) - 12;
  if (room < 40) return undefined;
  return {kind: 'strip', w: Math.max(40, Math.min(160, room, Math.round(22 * aspect))), h: 22};
}

/**
 * The zoom controls, the zoom readout and, while the stage shows a part of the diagram, how many nodes it shows and
 * the minimap of the whole. Follows the viewport; nothing else re-renders on a pan.
 */
function Overview(p: {
  bounds: Box; boxes: ReadonlyMap<string, Box>; total: number; width: number; height: number; spot: MinimapSpot | undefined;
  onZoomOut: () => void; onZoomIn: () => void; onFit: () => void; onReset: () => void;
}) {
  const v = useViewport();
  const {bounds, width, height, spot} = p;
  const whole = bounds.x * v.zoom + v.x >= -1 && (bounds.x + bounds.w) * v.zoom + v.x <= width + 1
    && bounds.y * v.zoom + v.y >= -1 && (bounds.y + bounds.h) * v.zoom + v.y <= height + 1;
  let inView = 0;
  // A node counts when the stage shows it whole (or as much of it as fits): one cut off at the edge is not in view.
  if (!whole) for (const box of p.boxes.values()) if (seen(v, box, width, height)) inView++;
  const stop = (event: ReactMouseEvent) => event.stopPropagation();
  const strip = spot?.kind === 'strip';
  return (
    <>
      {!whole && spot ? (
        <MiniMap
          className={strip ? css.minimapStrip : `${css.minimap} ${spot.kind === 'corner' && spot.corner.startsWith('top') ? '' : css.minimapBottom}`}
          position={spot.kind === 'corner' ? spot.corner : 'bottom-left'}
          pannable
          zoomable
          ariaLabel={null}
          offsetScale={strip ? 2 : 5}
          style={{width: spot.w, height: spot.h}}
          nodeClassName={node => (node.type === 'frame' ? css.minimapFrame! : css.minimapNode!)}
        />
      ) : null}
      <Controls
        className={css.controls}
        position="bottom-right"
        orientation="horizontal"
        showZoom={false}
        showFitView={false}
        showInteractive={false}
        aria-label="Zoom"
      >
        {!whole ? (
          <span className={css.inView} data-in-view="" title={`${inView} of ${p.total} nodes in view. Drag to pan; Fit to view shows everything`}>
            {width >= IN_VIEW_MIN_WIDTH ? `${inView} of ${p.total} in view` : `${inView}/${p.total}`}
          </span>
        ) : null}
        <span className={css.zoom} data-zoom="">{Math.round(v.zoom * 100)}%</span>
        <ControlButton className={css.control} tabIndex={-1} aria-label="Zoom out" title="Zoom out (−)" onClick={p.onZoomOut} onDoubleClick={stop}><Icon name="zoom-out" /></ControlButton>
        <ControlButton className={css.control} tabIndex={-1} aria-label="Zoom in" title="Zoom in (+)" onClick={p.onZoomIn} onDoubleClick={stop}><Icon name="zoom-in" /></ControlButton>
        <ControlButton className={css.control} tabIndex={-1} aria-label="Fit to view" title="Fit to view (0)" onClick={p.onFit} onDoubleClick={stop}><Icon name="fit" /></ControlButton>
        <ControlButton className={css.control} tabIndex={-1} aria-label="Actual size" title="Actual size (1)" onClick={p.onReset} onDoubleClick={stop}><Icon name="reset" /></ControlButton>
      </Controls>
    </>
  );
}
