// ScatterPlot: two measures per row, optional radius and colour. The most extreme points are labelled; above
// 3,000 points the marks move to a canvas and hover goes through a grid index.
import type {EntityRef, Field, Roles, Rows, SurfaceMeta} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {median} from 'd3-array';
import {useEffect, useMemo, useRef, type JSX} from 'react';
import {Empty, catVar, fmtNum, type DataState, type GlView} from '../../kit/index.ts';
import css from './ScatterPlot.module.css';
import {
  CanvasLayer, DEFAULT_HEIGHT, Figure, Legend, Note, OTHER, RowsGate, ValueGrid, clip, clipPath, count, entityOf, fmtValue,
  foldSeries, formatOf, inspect, kit, label, linearAxis, logAxis, notes, num, pick, prepareCanvas, roleY, say, slotKind, spatialStep,
  textWidth, tickFormat, useChartBox, useDrawIn, useInks, useMarkNav, useSlots, useSlotter, widest, type FieldInfo, type Mark, type Slotter, type ValueAxis,
} from './chartkit/index.ts';

const CANVAS_ABOVE = 3000;
const LABELLED = 8;
const CELL = 24;
/** Above this many points the circles are drawn lighter, so a crowd reads as density and not as one solid shape. */
const DENSE = 150;
const fillAlpha = (count: number) => (count > 1000 ? 0.22 : count > DENSE ? 0.35 : 0.7);

interface Point {
  x: number;
  y: number;
  r?: number;
  group: number;
  text?: string;
  entity?: EntityRef;
  path: boolean;
}
interface Model {
  points: Point[];
  groups: Array<{name: string; slot: number}>;
  xInfo: FieldInfo;
  yInfo: FieldInfo;
  rInfo?: FieldInfo;
  colorInfo?: FieldInfo;
  skipped: number;
}

function buildModel(rows: Rows, fieldList: Field[] | undefined, roles: Roles | undefined, opts: {x?: string; y?: string; r?: string; color?: string; label?: string}, slots: SurfaceMeta['slots'] | undefined, assign: Slotter): Model | string {
  const fields = inspect(rows, fieldList);
  const isNum = (key: string | undefined) => (key && fields.get(key).cls === 'num' ? key : undefined);
  const xKey = pick(opts.x, isNum(roles?.x), fields.first('num', [opts.y])?.key);
  const yKey = pick(opts.y, roleY(roles).find(key => key !== xKey && isNum(key)), isNum(roles?.value !== xKey ? roles?.value : undefined), fields.first('num', [xKey])?.key);
  if (!xKey || !yKey) return 'two numeric fields are needed';
  const rKey = pick(opts.r, roles?.size);
  const colorKey = pick(opts.color, roles?.color);
  const labelKey = pick(opts.label, roles?.label, fields.list.find(info => info.kind === 'path' || info.key === 'path')?.key, fields.first('cat', [colorKey])?.key);
  const labelInfo = labelKey ? fields.get(labelKey) : undefined;

  const counts = new Map<string, number>();
  const raw: Array<Point & {category: string}> = [];
  let skipped = 0;
  for (const row of rows) {
    const x = num(row[xKey]);
    const y = num(row[yKey]);
    if (x === undefined || y === undefined) {
      skipped++;
      continue;
    }
    const category = colorKey ? label(row[colorKey]) : '';
    counts.set(category, (counts.get(category) ?? 0) + 1);
    const entity = entityOf(labelInfo, labelKey ? row[labelKey] : undefined, row);
    raw.push({x, y, r: rKey ? num(row[rKey]) : undefined, group: 0, category, text: labelKey && row[labelKey] != null && row[labelKey] !== '' ? label(row[labelKey]) : undefined, entity, path: entity?.type === 'file'});
  }
  if (raw.length === 0) return `no rows with numbers in "${say(xKey, 40)}" and "${say(yKey, 40)}"`;
  const {keep, folded} = foldSeries(counts);
  const names = folded.size > 0 ? [...keep, OTHER] : keep;
  const colorInfo = colorKey ? fields.get(colorKey) : undefined;
  const kind = slotKind(colorInfo);
  const slotOf = assign(names, kind ? slots?.[kind] : undefined);
  const groupOf = new Map(names.map((name, i) => [name, i]));
  const other = groupOf.get(OTHER) ?? 0;
  const points: Point[] = raw.map(({category, ...point}) => ({...point, group: groupOf.get(category) ?? other}));
  return {
    points,
    groups: names.map(name => ({name, slot: colorKey ? (slotOf.get(name) ?? 0) : 1})),
    xInfo: fields.get(xKey),
    yInfo: fields.get(yKey),
    rInfo: rKey ? fields.get(rKey) : undefined,
    colorInfo,
    skipped,
  };
}

interface Dot {
  cx: number;
  cy: number;
  r: number;
  point: Point;
}
interface Tag {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  text: string;
}
interface Layout {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  xAxis: ValueAxis;
  yAxis: ValueAxis;
  dots: Dot[];
  marks: Mark[];
  labels: Array<{dot: number; x: number; y: number; anchor: 'start' | 'middle' | 'end'; dir: string; base: string}>;
  medians?: {x: number; y: number; xTag: Tag; yTag: Tag};
  /** Axes whose equal values were spread apart so the points can be told from each other. */
  spread: string[];
  offScale: number;
}

/** A linear axis that starts at zero when the data sits near it, else hugs the data; or a log axis. */
function measureAxis(values: number[], range: [number, number], log: boolean, count: number): ValueAxis {
  if (log) return logAxis(values, range, count);
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return linearAxis(values, range, {zero: lo >= 0 && lo <= hi * 0.5, count, whole: true});
}

/**
 * How far to spread the points of an axis that only takes a few whole values (commit counts of a young repository):
 * a share of the smallest gap between two values, or 0 for an axis that needs none. Without it every point of a
 * value sits on one line and the plot is a column of overlapping circles.
 */
export function spreadOf(values: readonly number[]): number {
  const distinct = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value)) return 0;
    distinct.add(value);
    if (distinct.size > 12) return 0;
  }
  if (values.length < distinct.size * 4) return 0;
  const sorted = [...distinct].sort((a, b) => a - b);
  let gap = 1;
  for (let i = 1; i < sorted.length; i++) gap = i === 1 ? sorted[i]! - sorted[i - 1]! : Math.min(gap, sorted[i]! - sorted[i - 1]!);
  return gap * 0.3;
}

/** A repeatable offset in -1..1 for the i-th point: the same data always draws the same picture. */
function jitter(i: number, salt: number): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const TAG_PX = 10.5 * 0.6 + 0.42;
type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const touches = (box: Box, dot: Dot) => {
  const dx = dot.cx - Math.max(box[0], Math.min(dot.cx, box[2]));
  const dy = dot.cy - Math.max(box[1], Math.min(dot.cy, box[3]));
  return dx * dx + dy * dy < dot.r * dot.r;
};

function layoutPoints(model: Model, scale: string, quadrants: boolean, width: number, height: number): Layout {
  const logX = scale === 'logx' || scale === 'loglog';
  const logY = scale === 'logy' || scale === 'loglog';
  const usable = model.points.filter(point => !(logX && point.x <= 0) && !(logY && point.y <= 0));
  const offScale = model.points.length - usable.length;
  const medX = median(usable, point => point.x) ?? 0;
  const medY = median(usable, point => point.y) ?? 0;
  // the median tags live in the margins, outside the plot: the right margin is as wide as the y tag
  const yTagText = `${width < 420 ? 'med' : 'median'} ${fmtValue(medY, model.yInfo)}`;
  const xTagText = `${width < 420 ? 'med' : 'median'} ${fmtValue(medX, model.xInfo)}`;
  const top = 24;
  const bottom = height - 40;
  const right = width - (quadrants && usable.length > 0 ? Math.min(width * 0.25, yTagText.length * TAG_PX + 12) : 16);
  const yCount = Math.max(2, Math.min(5, Math.floor((bottom - top) / 44)));
  const xs = usable.map(point => point.x);
  const ys = usable.map(point => point.y);
  const yTicks = measureAxis(ys, [bottom, top], logY, yCount).ticks;
  const left = Math.min(width * 0.3, widest(yTicks.map(tickFormat(yTicks, formatOf(model.yInfo)))) + 14);
  let maxR = 0;
  if (model.rInfo) for (const point of usable) maxR = Math.max(maxR, point.r ?? 0);
  const radius = (point: Point) => (model.rInfo ? 3 + 15 * Math.sqrt(maxR > 0 ? Math.max(0, point.r ?? 0) / maxR : 0) : 3.5);
  const spreadX = logX ? 0 : spreadOf(xs);
  const spreadY = logY ? 0 : spreadOf(ys);

  // The scales are inset until no circle hangs over the edge of the plot: a circle on the baseline would cover the
  // tick labels, one at the far end would be cut. Two rounds settle it, since insetting moves the circles.
  const pad = {left: 0, right: 0, top: 0, bottom: 0};
  let xAxis!: ValueAxis;
  let yProbe!: ValueAxis;
  let dots: Dot[] = [];
  const xCount = Math.max(2, Math.min(6, Math.floor((right - left) / 90)));
  for (let round = 0; round < 3; round++) {
    const x0 = left + pad.left;
    xAxis = measureAxis(xs, [x0, Math.max(x0 + 24, right - pad.right)], logX, xCount);
    yProbe = measureAxis(ys, [bottom - pad.bottom, Math.min(bottom - pad.bottom - 24, top + pad.top)], logY, yCount);
    dots = usable.map((point, i) => ({
      cx: xAxis.scale(spreadX > 0 ? point.x + jitter(i, 1) * spreadX : point.x),
      cy: yProbe.scale(spreadY > 0 ? point.y + jitter(i, 2) * spreadY : point.y),
      r: radius(point),
      point,
    }));
    const over = {left: 0, right: 0, top: 0, bottom: 0};
    for (const dot of dots) {
      over.left = Math.max(over.left, left - (dot.cx - dot.r));
      over.right = Math.max(over.right, dot.cx + dot.r - right);
      over.top = Math.max(over.top, top - (dot.cy - dot.r));
      over.bottom = Math.max(over.bottom, dot.cy + dot.r - bottom);
    }
    if (round === 2 || Math.max(over.left, over.right, over.top, over.bottom) <= 0.5) break;
    const limitX = (right - left) * 0.2;
    const limitY = (bottom - top) * 0.2;
    pad.left = Math.min(limitX, pad.left + Math.ceil(over.left));
    pad.right = Math.min(limitX, pad.right + Math.ceil(over.right));
    pad.top = Math.min(limitY, pad.top + Math.ceil(over.top));
    pad.bottom = Math.min(limitY, pad.bottom + Math.ceil(over.bottom));
  }

  // large circles first, so small ones stay on top and reachable
  dots.sort((a, b) => b.r - a.r);
  const marks: Mark[] = dots.map(dot => {
    const {point} = dot;
    const x = fmtValue(point.x, model.xInfo);
    const y = fmtValue(point.y, model.yInfo);
    const group = model.colorInfo ? model.groups[point.group] : undefined;
    return {
      x: dot.cx - dot.r, y: dot.cy - dot.r, w: dot.r * 2, h: dot.r * 2, round: true,
      title: point.text ?? `${x}, ${y}`,
      rows: [
        {label: model.xInfo.label, value: x},
        {label: model.yInfo.label, value: y},
        ...(model.rInfo ? [{label: model.rInfo.label, value: fmtValue(point.r, model.rInfo)}] : []),
        ...(group && model.colorInfo ? [{label: model.colorInfo.label, value: say(group.name, 32), color: catVar(group.slot)}] : []),
      ],
      entity: point.entity,
      say: `${point.text ? `${say(point.text)}, ` : ''}${model.xInfo.label} ${x}, ${model.yInfo.label} ${y}`,
    };
  });

  const mx = xAxis.scale(medX);
  const my = yProbe.scale(medY);
  const spanX = Math.max(1, right - left);
  const spanY = Math.max(1, bottom - top);
  const withMedians = quadrants && usable.length > 0;

  // Labels go to the most extreme points. Each is tried right, left, above and below its circle and takes the
  // first place where it stays inside the plot and touches no other label, no circle and no median line; a label
  // with no such place is left out (the tooltip still names the point).
  const ranked = dots
    .map((dot, i) => ({i, far: dot.point.text ? Math.hypot((dot.cx - mx) / spanX, (dot.cy - my) / spanY) : -1}))
    .filter(entry => entry.far >= 0)
    .sort((a, b) => b.far - a.far)
    .slice(0, LABELLED * 2);
  const labels: Layout['labels'] = [];
  const taken: Box[] = withMedians ? [[mx - 1.5, top, mx + 1.5, bottom], [left, my - 1.5, right, my + 1.5]] : [];
  const room = Math.min(180, spanX * 0.45);
  for (const {i} of ranked) {
    if (labels.length >= LABELLED) break;
    const dot = dots[i]!;
    const parts = dot.point.path ? clipPath(dot.point.text!, room) : {dir: '', base: clip(dot.point.text!, room)};
    const w = textWidth(parts.dir + parts.base);
    if (w === 0) continue;
    const gap = dot.r + 5;
    const places: Array<{x: number; y: number; anchor: 'start' | 'middle' | 'end'; box: Box}> = [
      {x: dot.cx + gap, y: dot.cy, anchor: 'start', box: [dot.cx + gap, dot.cy - 7, dot.cx + gap + w, dot.cy + 7]},
      {x: dot.cx - gap, y: dot.cy, anchor: 'end', box: [dot.cx - gap - w, dot.cy - 7, dot.cx - gap, dot.cy + 7]},
      {x: dot.cx, y: dot.cy - gap - 5, anchor: 'middle', box: [dot.cx - w / 2, dot.cy - gap - 12, dot.cx + w / 2, dot.cy - gap + 2]},
      {x: dot.cx, y: dot.cy + gap + 5, anchor: 'middle', box: [dot.cx - w / 2, dot.cy + gap - 2, dot.cx + w / 2, dot.cy + gap + 12]},
    ];
    const place = places.find(({box}) =>
      box[0] >= left + 2 && box[2] <= right - 2 && box[1] >= top - 2 && box[3] <= bottom - 2
      && !taken.some(other => overlaps(box, other))
      && !dots.some((other, at) => at !== i && touches(box, other)));
    if (!place) continue;
    taken.push(place.box);
    labels.push({dot: i, x: place.x, y: place.y, anchor: place.anchor, ...parts});
  }

  // Each tag sits at the end of its line, outside the plot: the y tag right of it, the x tag under the tick labels
  // on the row of the x-axis title, which it steps aside for (the title is at the right end of that row).
  const xTagW = xTagText.length * TAG_PX;
  const titleStart = right - say(model.xInfo.label, 32).length * TAG_PX - 12;
  const xTagAt = Math.max(left + xTagW / 2, Math.min(mx, titleStart - xTagW / 2));
  const xTag: Tag = {x: xTagAt, y: bottom + 30, anchor: 'middle', text: xTagText};
  return {
    width, height, left, right, top, bottom, xAxis, yAxis: yProbe, dots, marks, labels,
    medians: withMedians ? {x: mx, y: my, xTag, yTag: {x: right + 6, y: my, anchor: 'start', text: yTagText}} : undefined,
    spread: [...(spreadX > 0 ? [model.xInfo.label] : []), ...(spreadY > 0 ? [model.yInfo.label] : [])],
    offScale,
  };
}

const INKS = [...Array.from({length: 9}, (_, slot) => catVar(slot)), 'var(--gl-surface)'];

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.ScatterPlot>}): JSX.Element {
  const {id, rows, state, props} = p;
  const slots = useSlots();
  const assign = useSlotter();
  const model = useMemo(
    () => buildModel(rows, state.fields, state.roles, {x: props.x, y: props.y, r: props.r, color: props.color, label: props.label}, slots, assign),
    [rows, state.fields, state.roles, props.x, props.y, props.r, props.color, props.label, slots, assign],
  );
  if (typeof model === 'string') return <Empty message={`${model}${state.ds ? ` (${state.ds.source})` : ''}`} />;
  return <Points id={id} model={model} skipped={p.skipped} props={props} />;
}

function Points(p: {id: string; model: Model; skipped: number; props: C.ViewProps<typeof C.ScatterPlot>}): JSX.Element {
  const {id, model, props} = p;
  const {boxRef, fill, width, height: boxHeight} = useChartBox(props.size);
  const height = fill ? Math.max(140, boxHeight) : DEFAULT_HEIGHT;
  const layout = useMemo(
    () => (width <= 0 ? undefined : layoutPoints(model, props.scale ?? 'linear', props.quadrants === true, width, height)),
    [model, props.scale, props.quadrants, width, height],
  );
  const onCanvas = (layout?.dots.length ?? 0) > CANVAS_ABOVE;
  const grid = useMemo(() => {
    if (!layout || !onCanvas) return undefined;
    const cells = new Map<number, number[]>();
    layout.dots.forEach((dot, i) => {
      const key = Math.floor(dot.cx / CELL) * 4096 + Math.floor(dot.cy / CELL);
      const list = cells.get(key);
      if (list) list.push(i);
      else cells.set(key, [i]);
    });
    return cells;
  }, [layout, onCanvas]);
  const nav = useMarkNav({
    id,
    marks: layout?.marks ?? [],
    move: (from, key) => (layout ? spatialStep(layout.marks, from, key) : from),
    hit: (x, y) => {
      if (!layout || !grid) return -1;
      let best = -1;
      let bestDistance = Infinity;
      for (let gx = Math.floor(x / CELL) - 1; gx <= Math.floor(x / CELL) + 1; gx++) {
        for (let gy = Math.floor(y / CELL) - 1; gy <= Math.floor(y / CELL) + 1; gy++) {
          for (const i of grid.get(gx * 4096 + gy) ?? []) {
            const dot = layout.dots[i]!;
            const distance = Math.hypot(dot.cx - x, dot.cy - y);
            if (distance <= dot.r + 3 && distance <= bestDistance) {
              best = i;
              bestDistance = distance;
            }
          }
        }
      }
      return best;
    },
  });
  const drawing = useDrawIn();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const inks = useInks(boxRef, INKS);
  const picked = nav.picked;

  useEffect(() => {
    if (!layout || !onCanvas || !inks) return;
    const context = prepareCanvas(canvas.current, layout.width, layout.height);
    if (!context) return;
    context.lineWidth = 1;
    layout.dots.forEach((dot, i) => {
      const ink = inks[model.groups[dot.point.group]?.slot ?? 0] ?? inks[0]!;
      const fade = picked && !picked[i] ? 0.35 : 1;
      context.beginPath();
      context.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2);
      context.globalAlpha = fillAlpha(layout.dots.length) * fade;
      context.fillStyle = ink;
      context.fill();
      context.globalAlpha = (layout.dots.length > DENSE ? 0.6 : 1) * fade;
      context.strokeStyle = ink;
      context.stroke();
    });
  }, [layout, onCanvas, inks, picked, model]);

  const circles = useMemo(() => {
    if (!layout || onCanvas) return null;
    return layout.dots.map((dot, i) => (
      <circle
        key={i}
        className={`${css.dot} ${kit.fade}`}
        cx={dot.cx}
        cy={dot.cy}
        r={dot.r}
        style={{fill: catVar(model.groups[dot.point.group]?.slot ?? 0), stroke: catVar(model.groups[dot.point.group]?.slot ?? 0)}}
        data-i={i}
        data-entity={dot.point.entity ? '' : undefined}
        data-dim={picked && !picked[i] ? '' : undefined}
      />
    ));
  }, [layout, onCanvas, model, picked]);

  const aria = `Scatter plot, ${count(layout?.dots.length ?? model.points.length, 'point')}, ${say(model.xInfo.label, 40)} against ${say(model.yInfo.label, 40)}${model.rInfo ? `, sized by ${say(model.rInfo.label, 40)}` : ''}`;

  return (
    <>
      <Note>{notes(p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.skipped > 0 && `${count(model.skipped, 'row')} without numbers`, layout && layout.offScale > 0 && `${fmtNum(layout.offScale)} off the log scale`, layout && layout.spread.length > 0 && `equal ${layout.spread.map(name => say(name, 16)).join(', ')} spread apart`)}</Note>
      <Figure
        name="ScatterPlot"
        label={aria}
        nav={nav}
        boxRef={boxRef}
        fill={fill}
        width={layout?.width ?? 0}
        height={layout?.height ?? (fill ? 0 : DEFAULT_HEIGHT)}
        drawing={drawing}
        header={model.colorInfo && model.groups.length > 1 ? <Legend items={model.groups.map(group => ({key: group.name, label: group.name, color: catVar(group.slot)}))} /> : undefined}
      >
        {layout ? (
          <>
            <ValueGrid axis={layout.yAxis} dir="y" from={layout.left} to={layout.right} fmt={tickFormat(layout.yAxis.ticks, formatOf(model.yInfo))} title={say(model.yInfo.label, 32)} end={layout.top} />
            <ValueGrid axis={layout.xAxis} dir="x" from={layout.top} to={layout.bottom} fmt={tickFormat(layout.xAxis.ticks, formatOf(model.xInfo))} title={say(model.xInfo.label, 32)} end={layout.right} />
            {layout.medians ? (
              <g data-quadrants="">
                <line className={kit.guide} x1={Math.round(layout.medians.x) + 0.5} x2={Math.round(layout.medians.x) + 0.5} y1={layout.top} y2={layout.bottom} />
                <line className={kit.guide} x1={layout.left} x2={layout.right} y1={Math.round(layout.medians.y) + 0.5} y2={Math.round(layout.medians.y) + 0.5} />
                <text className={kit.tag} x={layout.medians.xTag.x} y={layout.medians.xTag.y} textAnchor={layout.medians.xTag.anchor} data-median="x">{layout.medians.xTag.text}</text>
                <text className={kit.tag} x={layout.medians.yTag.x} y={layout.medians.yTag.y} dy="0.32em" textAnchor={layout.medians.yTag.anchor} data-median="y">{layout.medians.yTag.text}</text>
              </g>
            ) : null}
            {onCanvas ? <CanvasLayer canvasRef={canvas} width={layout.width} height={layout.height} /> : <g className={css.dots} data-dense={layout.dots.length > 1000 ? 'very' : layout.dots.length > DENSE ? '' : undefined}>{circles}</g>}
            {layout.labels.map(lab => (
              <text key={lab.dot} className={`${kit.halo} ${kit.fade}`} x={lab.x} y={lab.y} dy="0.32em" textAnchor={lab.anchor} data-place={lab.anchor} data-i={lab.dot} data-entity={layout.dots[lab.dot]!.point.entity ? '' : undefined} data-dim={picked && !picked[lab.dot] ? '' : undefined} data-point-label="">
                {lab.dir ? <tspan className={kit.labelDim}>{lab.dir}</tspan> : null}
                <tspan className={kit.label}>{lab.base}</tspan>
              </text>
            ))}
          </>
        ) : null}
      </Figure>
    </>
  );
}

export const ScatterPlotView: GlView<typeof C.ScatterPlot> = ({id, props}) => (
  <RowsGate name="ScatterPlot" id={id} input={props.data} size={props.size}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
