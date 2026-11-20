// ScatterPlot: two measures per row, optional radius and colour. The most extreme points are labelled; above
// 3,000 points the marks move to a canvas and hover goes through a grid index.
import type {EntityRef, Field, Roles, Rows, SurfaceMeta} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {median} from 'd3-array';
import {useEffect, useMemo, useRef, type JSX} from 'react';
import {Empty, catVar, fmtNum, type DataState, type GlView} from '../../kit/index.ts';
import css from './ScatterPlot.module.css';
import {
  CanvasLayer, DEFAULT_HEIGHT, Figure, Legend, Note, OTHER, RowsGate, ValueGrid, assignSlots, clip, clipPath, count, entityOf, fmtValue,
  foldSeries, formatOf, inspect, kit, label, linearAxis, logAxis, notes, num, pick, prepareCanvas, roleY, say, slotKind, spatialStep,
  textWidth, tickFormat, useChartBox, useDrawIn, useInks, useMarkNav, useSlots, widest, type FieldInfo, type Mark, type ValueAxis,
} from './chartkit/index.ts';

const CANVAS_ABOVE = 3000;
const LABELLED = 8;
const CELL = 24;

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

function buildModel(rows: Rows, fieldList: Field[] | undefined, roles: Roles | undefined, opts: {x?: string; y?: string; r?: string; color?: string; label?: string}, slots: SurfaceMeta['slots'] | undefined): Model | string {
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
  const slotOf = assignSlots(names, kind ? slots?.[kind] : undefined);
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
  labels: Array<{dot: number; x: number; y: number; anchor: 'start' | 'end'; dir: string; base: string}>;
  medians?: {x: number; y: number; xValue: number; yValue: number};
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
  return linearAxis(values, range, {zero: lo >= 0 && lo <= hi * 0.5, count});
}

function layoutPoints(model: Model, scale: string, quadrants: boolean, width: number, height: number): Layout {
  const logX = scale === 'logx' || scale === 'loglog';
  const logY = scale === 'logy' || scale === 'loglog';
  const usable = model.points.filter(point => !(logX && point.x <= 0) && !(logY && point.y <= 0));
  const offScale = model.points.length - usable.length;
  const top = 24;
  const bottom = height - 40;
  const right = width - 16;
  const yCount = Math.max(2, Math.min(5, Math.floor((bottom - top) / 44)));
  const yProbe = measureAxis(usable.map(point => point.y), [bottom, top], logY, yCount);
  const yTick = tickFormat(yProbe.ticks, formatOf(model.yInfo));
  const left = Math.min(width * 0.3, widest(yProbe.ticks.map(yTick)) + 14);
  const xAxis = measureAxis(usable.map(point => point.x), [left, Math.max(left + 24, right)], logX, Math.max(2, Math.min(6, Math.floor((right - left) / 90))));
  let maxR = 0;
  if (model.rInfo) for (const point of usable) maxR = Math.max(maxR, point.r ?? 0);
  const radius = (point: Point) => (model.rInfo ? 3 + 15 * Math.sqrt(maxR > 0 ? Math.max(0, point.r ?? 0) / maxR : 0) : 3.5);

  // large circles first, so small ones stay on top and reachable
  const dots: Dot[] = usable.map(point => ({cx: xAxis.scale(point.x), cy: yProbe.scale(point.y), r: radius(point), point})).sort((a, b) => b.r - a.r);
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

  const medX = median(usable, point => point.x) ?? 0;
  const medY = median(usable, point => point.y) ?? 0;
  const mx = xAxis.scale(medX);
  const my = yProbe.scale(medY);
  const spanX = Math.max(1, right - left);
  const spanY = Math.max(1, bottom - top);
  const ranked = dots
    .map((dot, i) => ({i, far: dot.point.text ? Math.hypot((dot.cx - mx) / spanX, (dot.cy - my) / spanY) : -1}))
    .filter(entry => entry.far >= 0)
    .sort((a, b) => b.far - a.far)
    .slice(0, LABELLED);
  const labels: Layout['labels'] = [];
  const boxes: Array<[number, number, number, number]> = [];
  for (const {i} of ranked) {
    const dot = dots[i]!;
    const room = Math.min(180, spanX * 0.45);
    const parts = dot.point.path ? clipPath(dot.point.text!, room) : {dir: '', base: clip(dot.point.text!, room)};
    const w = textWidth(parts.dir + parts.base);
    const flip = dot.cx + dot.r + 5 + w > right + 12;
    const x0 = flip ? dot.cx - dot.r - 5 - w : dot.cx + dot.r + 5;
    const box: [number, number, number, number] = [x0, dot.cy - 7, x0 + w, dot.cy + 7];
    if (boxes.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
    boxes.push(box);
    labels.push({dot: i, x: flip ? dot.cx - dot.r - 5 : dot.cx + dot.r + 5, y: dot.cy, anchor: flip ? 'end' : 'start', ...parts});
  }
  return {
    width, height, left, right, top, bottom, xAxis, yAxis: yProbe, dots, marks, labels,
    medians: quadrants && usable.length > 0 ? {x: mx, y: my, xValue: medX, yValue: medY} : undefined,
    offScale,
  };
}

const INKS = [...Array.from({length: 9}, (_, slot) => catVar(slot)), 'var(--gl-surface)'];

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.ScatterPlot>}): JSX.Element {
  const {id, rows, state, props} = p;
  const slots = useSlots();
  const model = useMemo(
    () => buildModel(rows, state.fields, state.roles, {x: props.x, y: props.y, r: props.r, color: props.color, label: props.label}, slots),
    [rows, state.fields, state.roles, props.x, props.y, props.r, props.color, props.label, slots],
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
      context.globalAlpha = 0.7 * fade;
      context.fillStyle = ink;
      context.fill();
      context.globalAlpha = fade;
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
      <Note>{notes(p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.skipped > 0 && `${count(model.skipped, 'row')} without numbers`, layout && layout.offScale > 0 && `${fmtNum(layout.offScale)} off the log scale`)}</Note>
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
            <ValueGrid axis={layout.yAxis} dir="y" from={layout.left} to={layout.right} fmt={tickFormat(layout.yAxis.ticks, formatOf(model.yInfo))} title={say(model.yInfo.label, 32)} />
            <ValueGrid axis={layout.xAxis} dir="x" from={layout.top} to={layout.bottom} fmt={tickFormat(layout.xAxis.ticks, formatOf(model.xInfo))} title={say(model.xInfo.label, 32)} />
            {layout.medians ? (
              <g data-quadrants="">
                <line className={kit.guide} x1={Math.round(layout.medians.x) + 0.5} x2={Math.round(layout.medians.x) + 0.5} y1={layout.top} y2={layout.bottom} />
                <line className={kit.guide} x1={layout.left} x2={layout.right} y1={Math.round(layout.medians.y) + 0.5} y2={Math.round(layout.medians.y) + 0.5} />
                <text className={`${kit.tag} ${kit.halo}`} x={layout.medians.x + 4} y={layout.top + 8}>{`median ${fmtValue(layout.medians.xValue, model.xInfo)}`}</text>
                <text className={`${kit.tag} ${kit.halo}`} x={layout.right} y={layout.medians.y - 5} textAnchor="end">{`median ${fmtValue(layout.medians.yValue, model.yInfo)}`}</text>
              </g>
            ) : null}
            {onCanvas ? <CanvasLayer canvasRef={canvas} width={layout.width} height={layout.height} /> : circles}
            {layout.labels.map(lab => (
              <text key={lab.dot} className={`${kit.halo} ${kit.fade}`} x={lab.x} y={lab.y} dy="0.32em" textAnchor={lab.anchor} data-i={lab.dot} data-entity={layout.dots[lab.dot]!.point.entity ? '' : undefined} data-dim={picked && !picked[lab.dot] ? '' : undefined} data-point-label="">
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
  <RowsGate name="ScatterPlot" id={id} input={props.data}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
