// Icicle: the hierarchy as stacked rows (20 px, up to 32 px in a sized cell that has the room), width by a metric.
// Clicking a directory zooms its subtree to full width; the top row (or Backspace) zooms back out. A rollup cell
// drills the dataset; the way back out of a drill is the scope crumb the kit shows (and Backspace at the top).
import type {DirNode} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {partition, type HierarchyNode} from 'd3-hierarchy';
import {useId, useMemo, useRef, useState, type JSX} from 'react';
import {Empty, fmtNum, useHostActions, useMeta, type DataState, type GlView} from '../../kit/index.ts';
import css from './Icicle.module.css';
import {
  Crumbs, Figure, METRIC_FORMAT, Note, TreeGate, clip, clipTail, count, createPainter, kit, nodeEntity, nodeMatches, notes, rootLabel, say, spatialStep,
  useChartBox, useDrawIn, useMarkNav, useSlots, useSlotter, viewTree, type CleanTree, type ColorMode, type Mark, type Metric, type TreeNode,
} from './chartkit/index.ts';

const ROW = 20;
const PITCH = ROW + 1;
/** In a sized cell the rows grow to use the height, up to this pitch. */
const MAX_PITCH = 33;
/** Height kept for the legend under the rows of a sized cell. */
const LEGEND_ROOM = 30;

interface Cell {
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  depth: number;
  value: number;
}
interface Layout {
  width: number;
  height: number;
  /** Height of a row. */
  row: number;
  cells: Cell[];
  marks: Mark[];
}

function layoutRows(view: HierarchyNode<TreeNode>, metric: Metric, width: number, pitch: number): Layout {
  const levels = view.height + 1;
  const row = pitch - 1;
  const laid = partition<TreeNode>().size([width, levels * pitch])(view);
  const cells: Cell[] = [];
  const marks: Mark[] = [];
  const format = METRIC_FORMAT[metric];
  const total = laid.value ?? 0;
  laid.each(item => {
    const w = item.x1 - item.x0 - 1;
    if (w < 1) return;
    const node = item.data;
    const value = item.value ?? 0;
    const y = item.depth * pitch;
    cells.push({node, x: item.x0, y, w, depth: item.depth, value});
    const where = node.path || node.name || 'root';
    marks.push({
      x: item.x0, y, w, h: row,
      title: node.rollup ? `${where} ${node.name}` : where,
      rows: [{label: metric, value: `${fmtNum(value, format)}${total > 0 ? ` (${fmtNum((value / total) * 100, 'pct')})` : ''}`}, ...(node.lang && !node.rollup ? [{label: 'lang', value: node.lang}] : [])],
      foot: node.rollup ? 'Enter drills into this directory' : item.depth === 0 ? (node.parent ? 'Enter zooms out' : undefined) : node.children.length > 0 ? 'Enter zooms in' : undefined,
      entity: nodeEntity(node),
      say: `${say(node.rollup ? `${node.name} in ${where}` : where)}, ${fmtNum(value, format)} ${metric}${node.dir ? ', directory' : ''}`,
    });
  });
  return {width, height: levels * pitch - 1, row, cells, marks};
}

function Plot(p: {id: string; tree: CleanTree; state: DataState<DirNode>; props: C.ViewProps<typeof C.Icicle>}): JSX.Element {
  const {id, tree, state, props} = p;
  const [zoomPath, setZoomPath] = useState('');
  const metric: Metric = props.value ?? 'loc';
  const zoomed = tree.byPath.get(zoomPath);
  const root = zoomed && zoomed.children.length > 0 ? zoomed : tree.root;
  const view = useMemo(() => viewTree(root, metric, Infinity), [root, metric]);
  return (
    <>
      <Note>{notes(tree.dropped > 0 && `${count(tree.dropped, 'node')} dropped`)}</Note>
      {(view.value ?? 0) > 0
        ? <Rows id={id} tree={tree} root={root} view={view} metric={metric} color={props.color ?? 'lang'} state={state} size={props.size} onZoom={setZoomPath} />
        : <Empty message={`no ${metric} to size the tree by${state.ds ? ` (${state.ds.source})` : ''}`} />}
    </>
  );
}

function Rows(p: {
  id: string;
  tree: CleanTree;
  root: TreeNode;
  view: HierarchyNode<TreeNode>;
  metric: Metric;
  color: ColorMode;
  state: DataState<DirNode>;
  size: string | undefined;
  onZoom: (path: string) => void;
}): JSX.Element {
  const {id, tree, root, view, metric, state} = p;
  const slots = useSlots();
  const assign = useSlotter();
  const meta = useMeta();
  const host = useHostActions(id);
  const {boxRef, fill, width, height: boxHeight} = useChartBox(p.size);
  // a sized cell is given to the rows: they grow from 20 px up to 32 px before any of it is left blank
  const levels = view.height + 1;
  const pitch = fill ? Math.max(PITCH, Math.min(MAX_PITCH, Math.floor((boxHeight - LEGEND_ROOM) / levels))) : PITCH;
  const layout = useMemo(() => (width <= 0 ? undefined : layoutRows(view, metric, width, pitch)), [view, metric, width, pitch]);
  const painter = useMemo(
    () => createPainter(p.color, (layout?.cells ?? []).filter(cell => cell.node.children.length === 0).map(cell => ({node: cell.node, weight: cell.value})), slots, tree.langs, assign),
    [p.color, layout, slots, tree.langs, assign],
  );
  const zoom = (path: string) => {
    const target = tree.byPath.get(path);
    p.onZoom(target && target.children.length > 0 ? path : (target?.parent?.path ?? ''));
  };
  const activate = (index: number): boolean => {
    const cell = layout?.cells[index];
    if (!cell) return false;
    if (cell.node.rollup) {
      if (state.ds) host.drill(state.ds.$ds, cell.node.path);
      return true;
    }
    if (cell.depth === 0) {
      if (!root.parent) return false;
      p.onZoom(root.parent.path);
      return true;
    }
    if (cell.node.children.length === 0) return false;
    zoom(cell.node.path);
    return true;
  };
  const nav = useMarkNav({
    id,
    marks: layout?.marks ?? [],
    box: boxRef,
    move: (from, key) => (layout ? spatialStep(layout.marks, from, key) : from),
    matcher: (selected, _mark, index) => {
      const cell = layout?.cells[index];
      return cell !== undefined && nodeMatches(selected, cell.node);
    },
    activate,
    key: event => {
      if (event.key !== 'Backspace') return false;
      // at the top of the tree Backspace steps out of a drill (design D1), else it zooms out one level
      if (!root.parent && state.ds?.drill) host.drill(state.ds.$ds, state.ds.drill.up);
      else p.onZoom(root.parent?.path ?? '');
      return true;
    },
  });
  // a click on a directory zooms it (and selects it, like any mark); rollups drill on Enter or double-click only
  const zoomCell = useRef(activate);
  zoomCell.current = activate;
  const drawing = useDrawIn();
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const picked = nav.picked;
  const rootName = rootLabel(tree, meta?.repo.name, state.ds?.drill !== undefined);
  const drawn = useMemo(() => layout?.cells.map((cell, i) => {
    const {node} = cell;
    const row = layout.row;
    const paint = node.children.length > 0 ? undefined : painter.fill(node, cell.depth);
    return (
      <g
        key={node.rollup ? `${node.path}/+` : node.path}
        data-i={i}
        data-entity=""
        data-cell={node.path}
        data-rollup={node.rollup ? '' : undefined}
        data-dim={picked && !picked[i] ? '' : undefined}
        onClick={paint ? undefined : event => {
          if (!event.metaKey && !event.ctrlKey) zoomCell.current(i);
        }}
      >
        <rect className={paint ? undefined : css.dir} x={cell.x} y={cell.y} width={cell.w} height={row} style={paint ? {fill: paint.color} : undefined} />
        {node.rollup ? <rect x={cell.x} y={cell.y} width={cell.w} height={row} fill={`url(#${uid}-hatch)`} /> : null}
        {cell.w >= 28 ? <text className={paint?.strong ? css.onStrong : css.onLight} x={cell.x + 5} y={cell.y + row / 2} dy="0.36em">{clip(node === tree.root ? clipTail(rootName, cell.w - 10) : node.name, cell.w - 10)}</text> : null}
      </g>
    );
  }), [layout, painter, picked, uid, rootName, tree.root]);

  const selection = nav.selected;
  const outline = layout && selection ? layout.cells.find(cell => {
    const entity = nodeEntity(cell.node);
    return entity.type === selection.type && entity.id === selection.id && !cell.node.rollup;
  }) : undefined;
  const leaves = layout?.cells.filter(cell => cell.node.children.length === 0).length ?? 0;
  const aria = `Icicle of ${metric}${root.path ? ` in ${say(root.path, 60)}` : ''}, ${levels} ${levels === 1 ? 'level' : 'levels'}, ${fmtNum(leaves)} ${leaves === 1 ? 'leaf' : 'leaves'}, total ${fmtNum(view.value ?? 0, METRIC_FORMAT[metric])}`;

  return (
    <Figure
      name="Icicle"
      label={aria}
      nav={nav}
      boxRef={boxRef}
      fill={fill}
      width={layout?.width ?? 0}
      height={layout?.height ?? (fill ? 0 : PITCH * 3)}
      drawing={drawing}
      compact={!fill}
      rings={false}
      header={<Crumbs root={rootName} node={root} onZoom={zoom} />}
      under={fill ? painter.legend() : undefined}
      footer={fill ? undefined : painter.legend()}
    >
      {layout ? (
        <>
          <defs>
            <pattern id={`${uid}-hatch`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className={css.hatch} x1={0} y1={0} x2={0} y2={5} />
            </pattern>
          </defs>
          <g className={kit.fade}>{drawn}</g>
          {outline ? <rect className={kit.sel} x={outline.x + 0.75} y={outline.y + 0.75} width={Math.max(0, outline.w - 1.5)} height={layout.row - 1.5} data-selected-cell="" /> : null}
        </>
      ) : null}
    </Figure>
  );
}

export const IcicleView: GlView<typeof C.Icicle> = ({id, props}) => (
  <TreeGate name="Icicle" id={id} input={props.data} size={props.size} height={150}>
    {(tree, state) => <Plot id={id} tree={tree} state={state} props={props} />}
  </TreeGate>
);
