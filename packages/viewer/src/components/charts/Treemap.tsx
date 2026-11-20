// Treemap: squarified nested rectangles sized by a metric. Click selects, double-click or Enter zooms into a
// directory, Backspace zooms out; rollup cells ("(N more)") drill the dataset. A small toolbar switches the size
// metric and the fill locally. Zoom is local and has its breadcrumb here; a drill re-scopes the dataset on the
// server, and its way back is the scope crumb the kit shows for every bound component (design D1): this view only
// dispatches gl_drill (a rollup, or Backspace at the top of a drilled tree).
import type {DirNode} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {treemap, treemapSquarify, type HierarchyNode} from 'd3-hierarchy';
import {useId, useLayoutEffect, useMemo, useRef, useState, type JSX} from 'react';
import {Empty, PlateAside, fmtNum, useHostActions, useMeta, type DataState, type GlView} from '../../kit/index.ts';
import css from './Treemap.module.css';
import {
  COLOR_MODES, Crumbs, DEFAULT_HEIGHT, Figure, METRIC_FORMAT, METRICS, Note, TreeGate, clip, count, createPainter, cycle, kit,
  nodeEntity, nodeMatches, notes, rootLabel, say, spatialStep, useChartBox, useDrawIn, useMarkNav, useSlots, useSlotter, viewTree, type CleanTree,
  type ColorMode, type Mark, type Metric, type TreeNode,
} from './chartkit/index.ts';

const HEADER = 18;

interface Cell {
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  /** A directory drawn with its children inside: its header band is the mark. */
  open: boolean;
  value: number;
}
interface Layout {
  width: number;
  height: number;
  cells: Cell[];
  marks: Mark[];
}

function layoutTree(view: HierarchyNode<TreeNode>, metric: Metric, width: number, height: number): Layout {
  const roomy = (w: number, h: number) => h >= HEADER + 14 && w >= 36;
  const laid = treemap<TreeNode>()
    .tile(treemapSquarify)
    .size([width, height])
    .round(true)
    .paddingInner(2)
    .paddingTop(node => (node.depth > 0 && roomy(node.x1 - node.x0, node.y1 - node.y0) ? HEADER : 0))(view);
  const cells: Cell[] = [];
  const marks: Mark[] = [];
  const format = METRIC_FORMAT[metric];
  const total = laid.value ?? 0;
  laid.each(item => {
    const w = item.x1 - item.x0;
    const h = item.y1 - item.y0;
    const open = Boolean(item.children);
    if (w < 1 || h < 1 || (open && (item.depth === 0 || !roomy(w, h)))) return;
    const node = item.data;
    const value = item.value ?? 0;
    cells.push({node, x: item.x0, y: item.y0, w, h, depth: item.depth, open, value});
    const where = node.path || node.name || 'root';
    marks.push({
      x: item.x0, y: item.y0, w, h: open ? HEADER - 2 : h,
      title: node.rollup ? `${where} ${node.name}` : where,
      rows: [
        {label: metric, value: `${fmtNum(value, format)}${total > 0 ? ` (${fmtNum((value / total) * 100, 'pct')})` : ''}`},
        ...(node.dir ? [{label: 'files', value: fmtNum(node.files)}] : []),
        ...(node.lang && !node.rollup ? [{label: 'lang', value: node.lang}] : []),
        ...(node.commits !== undefined ? [{label: 'commits', value: fmtNum(node.commits)}] : []),
      ],
      foot: node.rollup ? 'Enter drills into this directory' : node.dir && node.children.length > 0 ? 'Enter zooms in' : undefined,
      entity: nodeEntity(node),
      say: `${say(node.rollup ? `${node.name} in ${where}` : where)}, ${fmtNum(value, format)} ${metric}${node.dir ? ', directory' : ''}`,
    });
  });
  return {width, height, cells, marks};
}

function Plot(p: {id: string; tree: CleanTree; state: DataState<DirNode>; props: C.ViewProps<typeof C.Treemap>}): JSX.Element {
  const {id, tree, state, props} = p;
  const [zoomPath, setZoomPath] = useState('');
  const [localMetric, setMetric] = useState<Metric | undefined>();
  const [localColor, setColor] = useState<ColorMode | undefined>();
  const metric = localMetric ?? props.value ?? 'loc';
  const color = localColor ?? props.color ?? 'lang';
  const levels = props.depth ?? 2;
  const zoomed = tree.byPath.get(zoomPath);
  const root = zoomed && zoomed.children.length > 0 ? zoomed : tree.root;
  const view = useMemo(() => viewTree(root, metric, levels), [root, metric, levels]);
  const nextMetric = () => setMetric(cycle(METRICS, metric));
  const nextColor = () => setColor(cycle(COLOR_MODES, color));
  return (
    <>
      <Note>{notes(tree.dropped > 0 && `${count(tree.dropped, 'node')} dropped`)}</Note>
      <PlateAside>
        <span className={kit.tools} data-chart-tools="">
          <button type="button" tabIndex={-1} className={kit.tool} title="Size metric (v)" data-tool="value" onClick={nextMetric}>
            <span className={kit.toolKey}>size</span>{metric}
          </button>
          <button type="button" tabIndex={-1} className={kit.tool} title="Fill (f)" data-tool="color" onClick={nextColor}>
            <span className={kit.toolKey}>fill</span>{color}
          </button>
        </span>
      </PlateAside>
      {(view.value ?? 0) > 0 ? (
        <Cells id={id} tree={tree} root={root} view={view} metric={metric} color={color} state={state} size={props.size} onZoom={setZoomPath} onMetric={nextMetric} onColor={nextColor} />
      ) : (
        <Empty message={`no ${metric} to size the tree by${state.ds ? ` (${state.ds.source})` : ''}`} />
      )}
    </>
  );
}

function Cells(p: {
  id: string;
  tree: CleanTree;
  root: TreeNode;
  view: HierarchyNode<TreeNode>;
  metric: Metric;
  color: ColorMode;
  state: DataState<DirNode>;
  size: string | undefined;
  onZoom: (path: string) => void;
  onMetric: () => void;
  onColor: () => void;
}): JSX.Element {
  const {id, tree, root, view, metric, color, state} = p;
  const slots = useSlots();
  const assign = useSlotter();
  const meta = useMeta();
  const host = useHostActions(id);
  const total = view.value ?? 0;
  const {boxRef, fill, width, height: boxHeight} = useChartBox(p.size);
  const height = fill ? Math.max(120, boxHeight) : DEFAULT_HEIGHT;
  const layout = useMemo(() => (width <= 0 ? undefined : layoutTree(view, metric, width, height)), [view, metric, width, height]);
  const painter = useMemo(
    () => createPainter(color, (layout?.cells ?? []).filter(cell => !cell.open).map(cell => ({node: cell.node, weight: cell.value})), slots, tree.langs, assign),
    [color, layout, slots, tree.langs, assign],
  );

  const zoom = (path: string) => {
    const target = tree.byPath.get(path);
    p.onZoom(target && target.children.length > 0 ? path : (target?.parent?.path ?? ''));
  };
  const nav = useMarkNav({
    id,
    marks: layout?.marks ?? [],
    move: (from, key) => (layout ? spatialStep(layout.marks, from, key) : from),
    matcher: (selected, _mark, index) => {
      const cell = layout?.cells[index];
      return cell !== undefined && nodeMatches(selected, cell.node);
    },
    activate: index => {
      const node = layout?.cells[index]?.node;
      if (!node) return false;
      if (node.rollup) {
        if (state.ds) host.drill(state.ds.$ds, node.path);
        return true;
      }
      if (!node.dir || node.children.length === 0) return false;
      zoom(node.path);
      return true;
    },
    key: event => {
      if (event.key === 'Backspace') {
        // at the top of the tree Backspace steps out of a drill, else it zooms out one level
        if (!root.parent && state.ds?.drill) host.drill(state.ds.$ds, state.ds.drill.up);
        else p.onZoom(root.parent?.path ?? '');
      } else if (event.key === 'v') p.onMetric();
      else if (event.key === 'f') p.onColor();
      else return false;
      return true;
    },
  });
  const drawing = useDrawIn();

  // Zoom moves the map instead of swapping it: the new layout starts where the zoomed cell was (zooming in), or
  // with the old root filling the frame (zooming out), and settles over the layout duration.
  const stage = useRef<SVGGElement | null>(null);
  const previous = useRef<{path: string; layout: Layout | undefined}>({path: root.path, layout});
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = {path: root.path, layout};
    const group = stage.current;
    if (!group || !layout || !before.layout || before.path === root.path) return;
    if (typeof group.animate !== 'function' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const into = before.layout.cells.find(cell => cell.node.path === root.path && !cell.node.rollup);
    const outOf = layout.cells.find(cell => cell.node.path === before.path && !cell.node.rollup);
    let from: string | undefined;
    if (into) from = `translate(${into.x}px, ${into.y}px) scale(${into.w / layout.width}, ${into.h / layout.height})`;
    else if (outOf) {
      const sx = layout.width / outOf.w;
      const sy = layout.height / outOf.h;
      from = `translate(${-outOf.x * sx}px, ${-outOf.y * sy}px) scale(${sx}, ${sy})`;
    }
    if (from) group.animate([{transform: from}, {transform: 'none'}], {duration: 280, easing: 'cubic-bezier(.2, 0, 0, 1)'});
  }, [root.path, layout]);

  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const picked = nav.picked;
  const drawn = useMemo(() => {
    if (!layout) return null;
    const format = METRIC_FORMAT[metric];
    return layout.cells.map((cell, i) => {
      const {node} = cell;
      const dim = picked && !picked[i] ? '' : undefined;
      if (cell.open) {
        return (
          <g key={`${node.path}/`} data-i={i} data-entity="" data-dir={node.path} data-dim={dim}>
            <rect className={css.band} x={cell.x} y={cell.y} width={cell.w} height={HEADER - 2} />
            <text className={kit.label} x={cell.x + 5} y={cell.y + 12}>{clip(node.name, cell.w - 10)}</text>
          </g>
        );
      }
      const paint = painter.fill(node, cell.depth);
      const labelled = cell.w >= 48 && cell.h >= 18;
      return (
        <g key={node.rollup ? `${node.path}/+` : node.path} data-i={i} data-entity="" data-cell={node.path} data-rollup={node.rollup ? '' : undefined} data-dim={dim}>
          <rect x={cell.x} y={cell.y} width={cell.w} height={cell.h} style={{fill: paint.color}} />
          {node.rollup ? <rect x={cell.x} y={cell.y} width={cell.w} height={cell.h} fill={`url(#${uid}-hatch)`} /> : null}
          {labelled ? <text className={paint.strong ? css.onStrong : css.onLight} x={cell.x + 5} y={cell.y + 13}>{clip(node.name, cell.w - 10)}</text> : null}
          {labelled && cell.h >= 34 ? <text className={paint.strong ? css.onStrongDim : css.onLightDim} x={cell.x + 5} y={cell.y + 27}>{clip(fmtNum(cell.value, format === 'num' ? 'compact' : format), cell.w - 10)}</text> : null}
        </g>
      );
    });
  }, [layout, metric, painter, picked, uid]);

  const selection = nav.selected;
  const outline = layout && selection ? layout.cells.find(cell => {
    const entity = nodeEntity(cell.node);
    return entity.type === selection.type && entity.id === selection.id && !cell.node.rollup;
  }) : undefined;
  const leaves = layout?.cells.filter(cell => !cell.open) ?? [];
  const largest = leaves.reduce<Cell | undefined>((best, cell) => (!best || cell.value > best.value ? cell : best), undefined);
  const format = METRIC_FORMAT[metric];
  const aria = `Treemap of ${metric}${root.path ? ` in ${say(root.path, 60)}` : ''}, ${fmtNum(leaves.length)} ${leaves.length === 1 ? 'cell' : 'cells'}, total ${fmtNum(total, format)}${largest ? `, largest ${say(largest.node.path || largest.node.name, 60)} ${fmtNum(largest.value, format)}` : ''}`;

  return (
    <Figure
        name="Treemap"
        label={aria}
        nav={nav}
        boxRef={boxRef}
        fill={fill}
        width={layout?.width ?? 0}
        height={layout?.height ?? (fill ? 0 : DEFAULT_HEIGHT)}
        drawing={drawing}
        rings={false}
        header={<Crumbs root={rootLabel(tree, meta?.repo.name, state.ds?.drill !== undefined)} node={root} onZoom={zoom} />}
        footer={painter.legend()}
      >
        {layout ? (
          <>
            <defs>
              <pattern id={`${uid}-hatch`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line className={css.hatch} x1={0} y1={0} x2={0} y2={5} />
              </pattern>
              <clipPath id={`${uid}-clip`}><rect width={layout.width} height={layout.height} /></clipPath>
            </defs>
            <g clipPath={`url(#${uid}-clip)`}>
              <g ref={stage} className={kit.fade}>{drawn}</g>
            </g>
            {outline ? <rect className={kit.sel} x={outline.x + 0.75} y={outline.y + 0.75} width={Math.max(0, outline.w - 1.5)} height={Math.max(0, outline.h - 1.5)} data-selected-cell="" /> : null}
          </>
        ) : null}
      </Figure>
  );
}

export const TreemapView: GlView<typeof C.Treemap> = ({id, props}) => (
  <TreeGate name="Treemap" id={id} input={props.data} size={props.size} height={DEFAULT_HEIGHT + 48}>
    {(tree, state) => <Plot id={id} tree={tree} state={state} props={props} />}
  </TreeGate>
);
