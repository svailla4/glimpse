// Flowchart: nodes, edges and groups written as data, drawn as shapes on the dot grid (design 5.6, decision diagrams-are-data).
import type * as C from '@glimpse/catalog';
import {cleanFlow, type FlowAst, type FlowShape} from '@glimpse/catalog';
import {useMemo, type ReactNode} from 'react';
import {DataGate, Empty, Redline, fmtNum, useDataset, useReportState, type GlView} from '../../kit/index.ts';
import {Diagram, UI_12, textWidth, wrapText, type DiagramEdge, type DiagramGroup, type DiagramNode, type Dir, type NodeFlags} from './flowkit/index.ts';
import css from './Flowchart.module.css';

const LINE = 16;
/** Width labels wrap at: the pointed and round shapes hold less text than their box. */
const WRAP_AT: Record<FlowShape, number> = {box: 168, pill: 168, store: 148, diamond: 120, circle: 96};
const MAX_LINES = 3;
/** Beyond this a flowchart is no longer a picture; the layout would also hold the page up. */
export const MAX_NODES = 150;

interface NodeDraw { shape: FlowShape; lines: string[] }

const even = (v: number) => Math.ceil(v / 2) * 2;

/** The box a shape needs around its (already wrapped) label. */
function sizeOf(shape: FlowShape, lines: readonly string[]): {w: number; h: number} {
  const tw = Math.max(0, ...lines.map(line => textWidth(line, UI_12)));
  const th = lines.length * LINE;
  switch (shape) {
    case 'diamond': {
      // The label sits in the middle of the diamond, where only part of the width is available.
      const h = Math.max(56, th + 36);
      return {w: even(Math.max(96, tw / (1 - th / h) + 8)), h: even(h)};
    }
    case 'pill': return {w: even(Math.max(72, tw + 36)), h: even(Math.max(32, th + 16))};
    case 'store': return {w: even(Math.max(84, tw + 32)), h: even(Math.max(46, th + 30))};
    case 'circle': {
      const d = even(Math.max(52, Math.hypot(tw, th) + 16));
      return {w: d, h: d};
    }
    default: return {w: even(Math.max(72, tw + 28)), h: even(Math.max(36, th + 20))};
  }
}

function outline(shape: FlowShape, w: number, h: number): ReactNode {
  switch (shape) {
    case 'diamond': return <polygon className={css.shape} points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />;
    case 'pill': return <rect className={css.shape} width={w} height={h} rx={h / 2} />;
    case 'circle': return <ellipse className={css.shape} cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />;
    case 'store': {
      const ry = 6;
      return (
        <>
          <path className={css.shape} d={`M0 ${ry}A${w / 2} ${ry} 0 0 1 ${w} ${ry}V${h - ry}A${w / 2} ${ry} 0 0 1 0 ${h - ry}Z`} />
          <path className={css.lid} d={`M0 ${ry}A${w / 2} ${ry} 0 0 0 ${w} ${ry}`} />
        </>
      );
    }
    default: return <rect className={css.shape} width={w} height={h} />;
  }
}

function drawNode(node: DiagramNode<NodeDraw>, flags: NodeFlags): ReactNode {
  const {shape, lines} = node.data;
  // A cylinder's lid takes the top of the box: its label sits a little lower.
  const cy = node.h / 2 + (shape === 'store' ? 4 : 0);
  return (
    <g className={css.body} data-shape={shape} data-selected={flags.selected || undefined}>
      {outline(shape, node.w, node.h)}
      <text className={css.text}>
        {lines.map((line, i) => <tspan key={i} x={node.w / 2} y={cy + (i - (lines.length - 1) / 2) * LINE}>{line}</tspan>)}
      </text>
    </g>
  );
}

function toDiagram(ast: FlowAst): {nodes: Array<DiagramNode<NodeDraw>>; edges: DiagramEdge[]; groups: DiagramGroup[]} {
  const nodes = ast.nodes.map(node => {
    const lines = wrapText(node.label, WRAP_AT[node.shape] ?? WRAP_AT.box, MAX_LINES, UI_12);
    return {
      id: node.id,
      ...sizeOf(node.shape, lines),
      shape: node.shape === 'box' ? ('rect' as const) : node.shape,
      ...(node.group !== undefined ? {group: node.group} : {}),
      entity: {type: 'node' as const, id: node.id, label: node.label},
      label: node.label,
      data: {shape: node.shape, lines},
    };
  });
  const edges = ast.edges.map((edge, i) => ({key: String(i), from: edge.from, to: edge.to, label: edge.label, dashed: edge.dashed === true}));
  const groups = ast.groups.map(group => ({id: group.id, label: group.label, ...(group.parent !== undefined ? {parent: group.parent} : {})}));
  return {nodes, edges, groups};
}

function FlowBody(p: {id: string; data: unknown; dir: Dir | undefined}) {
  const {id, dir} = p;
  const cleaned = useMemo(() => cleanFlow(p.data), [p.data]);
  const model = useMemo(() => (cleaned.ok ? toDiagram(cleaned.ast) : undefined), [cleaned]);
  // What the data asked for but is not drawn is told to the model: data written by a patch was never checked by the server.
  const dropped = cleaned.ok ? cleaned.dropped : [];
  useReportState(dropped.length > 0 ? 'W_DROPPED' : undefined, `not drawn: ${dropped.join('; ')}`);

  if (!cleaned.ok) return <Redline code="E_SHAPE" id={`Flowchart#${id}`} message={cleaned.error} />;
  if (!model || model.nodes.length === 0) return <Empty message="no nodes to draw: Flowchart takes {nodes, edges, groups?}" />;
  if (model.nodes.length > MAX_NODES) {
    return <Redline code="E_TOO_LARGE" id={`Flowchart#${id}`} message={`${fmtNum(model.nodes.length)} nodes is more than a flowchart can show (${MAX_NODES}). Split it into several charts.`} />;
  }
  const names = model.nodes.slice(0, 6).map(node => node.label.slice(0, 40)).join(', ');
  const ariaLabel = `Flowchart, ${model.nodes.length} ${model.nodes.length === 1 ? 'step' : 'steps'}, ${model.edges.length} ${model.edges.length === 1 ? 'connection' : 'connections'}: ${names}${model.nodes.length > 6 ? ' and more' : ''}`;
  return (
    <Diagram
      id={id}
      name="Flowchart"
      nodes={model.nodes}
      edges={model.edges}
      groups={model.groups}
      dir={dir}
      ariaLabel={ariaLabel}
      note={dropped.length > 0 ? `${fmtNum(dropped.length)} not drawn` : undefined}
      renderNode={drawNode}
      // Shapes hold 12 px text: the stage opens no further out than keeps it at 10 px. (Edge labels grow when zoomed out.)
      minText={12}
      nodeGap={32}
      layerGap={44}
    />
  );
}

export const FlowchartView: GlView<typeof C.Flowchart> = ({id, props}) => {
  const state = useDataset<unknown>(props.data);
  // Without dir= the chart is laid out both ways and drawn the way that reads larger in its plate (a 14-step chart in
  // a full-width plate was drawn top to bottom at 60% with two thirds of the plate empty).
  const dir: Dir | undefined = props.dir === 'LR' || props.dir === 'TB' ? props.dir : undefined;
  return <DataGate state={state} id={`Flowchart#${id}`}>{data => <FlowBody id={id} data={data} dir={dir} />}</DataGate>;
};
