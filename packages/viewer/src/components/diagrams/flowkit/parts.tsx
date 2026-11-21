// The React Flow pieces of a diagram (decision D19), drawn in the Linework style: a node is the diagram's own SVG
// drawing in a box of its size (Graph's spine and status glyph, a Flowchart shape, an ER table); a frame is a group's
// dashed outline with its label; an edge is ELK's orthogonal route with 6 px elbows, its end marks and its label.
// Selection, the keyboard's node and the zoom-dependent level of detail come from DiagramContext, so a change to
// them never rebuilds React Flow's node list.
import type {EntityRef} from '@glimpse/catalog';
import type {SelectionRef} from '../../../kit/index.ts';
import {
  EdgeLabelRenderer, Handle, Position, useViewportStore,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import {createContext, memo, useContext, type CSSProperties, type ReactNode} from 'react';
import css from './flowkit.module.css';
import {markPath, roundedPath, type Dir, type Mark, type Point, type Shape} from './geometry.ts';

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
   * the innermost lights up. Its `nodes` link it to the diagram nodes it stands for (decision D24).
   */
  match?: SelectionRef;
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
  /** Where the edge attaches, from the top of its node (a column row of a table): a fixed port on the node's side. */
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

/** From here up a node with levels of detail draws its own faces (an 11 px second line is 10 px on screen). */
export const FULL_ZOOM = 0.91;
/** With levels of detail a node still holds a 10 px name (of eight letters or more) down to here. */
export const LOD_ZOOM = 0.4;
/** Group labels (10.5 px) keep their own size down to here, and are drawn larger below. */
const GROUP_FULL_ZOOM = 0.96;
/** Edge labels longer than this wrap onto a second line. */
export const LABEL_LINE = 13;

/** `k` rounded down to a step of 5% (0.7 stays 0.7, which a plain floor of 0.7 * 20 does not). */
export const zoomStep = (k: number) => Math.max(0.1, Math.floor(k * 20 + 1e-6) / 20);

/** What nodes draw at zoom `k`, and the zoom their larger labels are sized for (steps of 5%, so a pinch is not a redraw per frame). */
export function detailAt(k: number, lod: boolean): {lod: Detail; k: number} {
  if (!lod || k >= FULL_ZOOM) return {lod: 'full', k: 1};
  return {lod: k >= LOD_ZOOM ? 'name' : 'box', k: zoomStep(k)};
}

export interface Plate { lines: string[]; w: number; h: number }

export interface DiagramContextValue {
  renderNode: (node: DiagramNode<any>, flags: NodeFlags) => ReactNode;
  lod: boolean;
  dir: Dir;
  selected: ReadonlySet<string>;
  /** Everything at full strength while something is selected (the selection and its neighbours); null: nothing selected. */
  lit: ReadonlySet<string> | null;
  /** The keys of the edges drawn highlighted (decision D24: round a selected node, or the legs of a selected path). */
  hot: ReadonlySet<string>;
  active: string | undefined;
  focus: string | undefined;
  plates: ReadonlyMap<string, Plate>;
  shapes: ReadonlyMap<string, Shape | undefined>;
  /** True when a group frame's label can be double-clicked to drill. */
  drillGroups: boolean;
}
export const DiagramContext = createContext<DiagramContextValue | null>(null);

/**
 * Decision D24: a selection that is not itself a node and names two or more nodes in order (a message: its sender's
 * node, the nodes it passes, its receiver's node) is a path. Its legs are the consecutive pairs, both ways, keyed
 * JSON.stringify([from, to]); a diagram heats only the edges between lit nodes that are legs. Empty for anything else.
 * (Here rather than in kit/select.ts: only the node-link diagrams use it, and the kit is in the eager script.)
 */
export function legsOf(selected: EntityRef | null | undefined): ReadonlySet<string> {
  const legs = new Set<string>();
  const ids = selected && selected.type !== 'node' ? (selected.nodes ?? []) : [];
  for (let i = 1; i < ids.length; i++) {
    legs.add(JSON.stringify([ids[i - 1], ids[i]]));
    legs.add(JSON.stringify([ids[i], ids[i - 1]]));
  }
  return legs;
}
const useDiagram = (): DiagramContextValue => {
  const value = useContext(DiagramContext);
  if (!value) throw new Error('a diagram part outside its diagram');
  return value;
};

// ---------------------------------------------------------------- nodes
export interface HandleSpec { id: string | null; type: 'source' | 'target'; position: Position; x: number; y: number }
export type BoxNodeData = {node: DiagramNode<any>; handles: readonly HandleSpec[]};
export type FrameNodeData = {group: DiagramGroup; label: string};
export type BoxFlowNode = Node<BoxNodeData, 'box'>;
export type FrameFlowNode = Node<FrameNodeData, 'frame'>;
export type FlowNode = BoxFlowNode | FrameFlowNode;

const SIDE: Record<Dir, readonly [Position, Position]> = {
  LR: [Position.Left, Position.Right],
  RL: [Position.Right, Position.Left],
  TB: [Position.Top, Position.Bottom],
  BT: [Position.Bottom, Position.Top],
};

/** Id of the handle a port at `y` uses, for the edges that attach there. */
export const portHandle = (type: 'source' | 'target', y: number) => `${type === 'source' ? 's' : 't'}${Math.round(y * 10) / 10}`;

/**
 * The handles of a node, where React Flow can find them without measuring (jsdom, the first frame): one in and one out
 * on the sides the flow enters and leaves by, and one per port row on the sides ports sit on.
 */
export function handlesOf(w: number, h: number, dir: Dir, ports: {source: readonly number[]; target: readonly number[]}): HandleSpec[] {
  const [into, out] = SIDE[dir];
  const at = (position: Position, y?: number): {x: number; y: number} => {
    if (y !== undefined) return {x: position === Position.Left ? 0 : w, y};
    switch (position) {
      case Position.Left: return {x: 0, y: h / 2};
      case Position.Right: return {x: w, y: h / 2};
      case Position.Top: return {x: w / 2, y: 0};
      default: return {x: w / 2, y: h};
    }
  };
  const forward = dir === 'LR' || dir === 'TB';
  const portSide = (type: 'source' | 'target') => ((type === 'source') === forward ? Position.Right : Position.Left);
  const out1: HandleSpec[] = [
    {id: null, type: 'target', position: into, ...at(into)},
    {id: null, type: 'source', position: out, ...at(out)},
  ];
  for (const y of new Set(ports.source)) out1.push({id: portHandle('source', y), type: 'source', position: portSide('source'), ...at(portSide('source'), y)});
  for (const y of new Set(ports.target)) out1.push({id: portHandle('target', y), type: 'target', position: portSide('target'), ...at(portSide('target'), y)});
  return out1;
}

function handleStyle(spec: HandleSpec): CSSProperties | undefined {
  // Side handles of a row sit at its centre; the plain ones where the stylesheet puts them (the middle of the side).
  return spec.id !== null && (spec.position === Position.Left || spec.position === Position.Right) ? {top: spec.y} : undefined;
}

/** The detail a node draws at the current zoom; a primitive selector, so a pan does not redraw nodes. */
function useDetail(lod: boolean): {lod: Detail; k: number} {
  const key = useViewportStore(s => {
    const d = detailAt(s.transform[2], lod);
    return `${d.lod}:${d.k}`;
  });
  const [kind, k] = key.split(':');
  return {lod: kind as Detail, k: Number(k)};
}

export const BoxNodeView = memo(function BoxNodeView({id, data}: NodeProps<BoxFlowNode>) {
  const ctx = useDiagram();
  const detail = useDetail(ctx.lod);
  const {node} = data;
  const selected = ctx.selected.has(id);
  const focus = ctx.focus === id;
  return (
    <>
      {data.handles.map(spec => (
        <Handle key={`${spec.type}:${spec.id ?? ''}`} id={spec.id} type={spec.type} position={spec.position} isConnectable={false} className={css.handle} style={handleStyle(spec)} />
      ))}
      <svg className={css.nodeSvg} width={node.w} height={node.h} aria-hidden="true">
        <g
          className={css.node}
          data-node={id}
          data-selected={selected || undefined}
          data-dim={(ctx.lit !== null && !ctx.lit.has(id)) || undefined}
          data-active={ctx.active === id || undefined}
          data-focus={focus || undefined}
        >
          {ctx.renderNode(node, {selected, focus, lod: detail.lod, k: detail.k})}
          <rect className={css.ring} x={-4} y={-4} width={node.w + 8} height={node.h + 8} />
        </g>
      </svg>
    </>
  );
});

/** The zoom group labels are sized for when zoomed out (1 from GROUP_FULL_ZOOM up), in 5% steps. */
function useFar(): number {
  return useViewportStore(s => (s.transform[2] < GROUP_FULL_ZOOM ? zoomStep(s.transform[2]) : 1));
}

export const FrameNodeView = memo(function FrameNodeView({id, data}: NodeProps<FrameFlowNode>) {
  const ctx = useDiagram();
  const far = useFar();
  const handle = data.group.drillable === true && ctx.drillGroups;
  // Larger when zoomed out, so the label stays 10.5 px on screen; it grows up out of the band ELK kept for it.
  const size = far < 1 ? Math.ceil((10.5 / far) * 100) / 100 : undefined;
  return (
    <div className={css.frame} data-group={id} data-drillable={handle || undefined}>
      {handle ? (
        <svg className={css.frameSvg} aria-hidden="true">
          <rect className={css.frameHit} data-group-handle={id} width="100%" height="100%" />
        </svg>
      ) : null}
      <span className={css.frameLabel} data-group-handle={handle ? id : undefined} style={size !== undefined ? {fontSize: size} : undefined}>{data.label}</span>
    </div>
  );
});

export const nodeTypes = {box: BoxNodeView, frame: FrameNodeView};

// ---------------------------------------------------------------- edges
export type ElkEdgeData = {
  edge: DiagramEdge;
  /** The route to draw: ELK's, moved with its ends, or one around what is in the way after a node was dragged. */
  points: readonly Point[];
  /** Where the label plate is centred, when the edge has a label. */
  labelAt?: Point;
  /** Drawn in the rule colour: DiagramEdge.faint, or an edge ELK ran along a group's frame. */
  faint: boolean;
};
export type FlowEdge = Edge<ElkEdgeData, 'elk'>;

/**
 * The zoom edge labels are sized for: 1 from FULL_ZOOM up (11 px text is 10 px on screen at 91%); further out the
 * zoom in 5% steps, and a label grows so its text stays 10 px on screen (D18), like group labels and Graph's names.
 */
function useLabelZoom(): number {
  return useViewportStore(s => (s.transform[2] < FULL_ZOOM ? zoomStep(s.transform[2]) : 1));
}

/** How much larger than drawn at 100% an edge label is at label zoom `k`: 11 px at 1, `10 / k` px below FULL_ZOOM. */
export const labelGrowth = (k: number) => (k >= FULL_ZOOM ? 1 : Math.max(1, 10 / (11 * k)));

export const ElkEdgeView = memo(function ElkEdgeView(p: EdgeProps<FlowEdge>) {
  const ctx = useDiagram();
  const grow = labelGrowth(useLabelZoom());
  const data = p.data;
  if (!data) return null;
  const {edge, points, labelAt: labelCentre} = data;
  const hot = ctx.hot.has(edge.key);
  const dim = ctx.lit !== null && !hot;
  const width = hot ? Math.max(1.5, edge.width ?? 1) : (edge.width ?? 1);
  const d = roundedPath(points);
  const marks = markPath(edge.startMark ?? 'none', points[0], points[1]) + markPath(edge.endMark ?? 'arrow', points.at(-1), points.at(-2));
  const plate = edge.label ? ctx.plates.get(edge.key) : undefined;
  return (
    <>
      <g
        className={css.edge}
        data-edge={`${edge.from}->${edge.to}`}
        data-edge-key={edge.key}
        data-hot={hot || undefined}
        data-dim={dim || undefined}
        data-cycle={edge.cycle || undefined}
        data-dashed={edge.dashed || undefined}
        data-faint={(data.faint && !hot) || undefined}
      >
        <path className={css.hit} d={d} />
        <path className={css.line} d={d} strokeWidth={width} />
        {marks ? <path className={css.mark} d={marks} /> : null}
      </g>
      {plate && labelCentre ? (
        <EdgeLabelRenderer>
          <div
            className={css.label}
            data-edge-label={edge.key}
            data-hot={hot || undefined}
            data-dim={dim || undefined}
            // Grown about its centre when zoomed out, so it stays on its edge.
            style={{
              width: plate.w * grow, height: plate.h * grow,
              transform: `translate(${Math.round(labelCentre.x - (plate.w * grow) / 2)}px, ${Math.round(labelCentre.y - (plate.h * grow) / 2)}px)`,
              ...(grow > 1 ? {fontSize: `${Math.ceil(11 * grow * 100) / 100}px`, lineHeight: `${Math.round(LABEL_LINE * grow * 100) / 100}px`} : {}),
            }}
          >
            {plate.lines.map((line, i) => <span key={i} className={css.labelLine}>{line}</span>)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

export const edgeTypes = {elk: ElkEdgeView};
