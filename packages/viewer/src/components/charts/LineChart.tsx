// LineChart: change over time or along an ordered x. Lines with direct labels at their ends, or stacked layers;
// a crosshair snaps to the nearest x and the tooltip lists every series.
import type {EntityRef, Field, Roles, Rows, SurfaceMeta} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {bisectLeft} from 'd3-array';
import {area, line} from 'd3-shape';
import {useMemo, useState, type JSX} from 'react';
import {Empty, catVar, fmtNum, useSelection, type DataState, type GlView} from '../../kit/index.ts';
import css from './LineChart.module.css';
import {
  DEFAULT_HEIGHT, Figure, Legend, Note, OTHER, RowsGate, ValueGrid, assignSlots, clip, count, entityOf, fmtDay, fmtShortDay, fmtValue,
  foldSeries, formatOf, inspect, kit, label, linearAxis, logAxis, matches, notes, num, pick, roleY, say, slotKind, textWidth, tickFormat,
  time, timeAxis, useChartBox, useDrawIn, useMarkNav, useSlots, widest, words, type ArrowKey, type FieldInfo, type LegendItem, type Mark,
  type ValueAxis,
} from './chartkit/index.ts';

type Mode = 'line' | 'area' | 'stacked' | 'pct';
interface Series {
  name: string;
  label: string;
  slot: number;
  entity?: EntityRef;
  info?: FieldInfo;
  /** One value per x position; null where the series has no number. */
  values: Array<number | null>;
}
interface Model {
  xType: 'time' | 'linear' | 'point';
  /** Sorted x values (time, linear) or 0..n-1 (point). */
  xs: number[];
  xLabels: string[];
  series: Series[];
  valueInfo?: FieldInfo;
  xInfo?: FieldInfo;
  bad: number;
}

function buildModel(rows: Rows, fieldList: Field[] | undefined, roles: Roles | undefined, opts: {x?: string; y?: string; series?: string}, slots: SurfaceMeta['slots'] | undefined): Model | string {
  const fields = inspect(rows, fieldList);
  const yKeys = words(opts.y);
  if (yKeys.length === 0) yKeys.push(...roleY(roles));
  const xKey = pick(opts.x, roles?.x, roles?.date, fields.first('date', yKeys)?.key, fields.first('cat', yKeys)?.key, fields.first('num', yKeys)?.key);
  if (yKeys.length === 0) {
    const fallback = pick(roles?.value, fields.first('num', [xKey])?.key);
    if (fallback) yKeys.push(fallback);
  }
  if (!xKey || yKeys.length === 0) return 'no x and numeric field to draw';
  const roleSeries = roles?.series && roles.series !== xKey ? roles.series : undefined;
  let seriesKey = pick(opts.series, yKeys.length === 1 ? roleSeries : undefined);
  if (!seriesKey && yKeys.length === 1 && !roles) {
    // rows that repeat an x are one row per series: the first categorical field tells the series apart
    const candidate = fields.first('cat', [xKey, ...yKeys])?.key;
    if (candidate && new Set(rows.map(row => row[xKey])).size < rows.length) seriesKey = candidate;
  }
  const xInfo = fields.get(xKey);
  const xType: Model['xType'] = xInfo.cls === 'date' ? 'time' : xInfo.cls === 'num' ? 'linear' : 'point';

  let bad = 0;
  const xIndex = new Map<number | string, number>();
  const points: Array<{x: number | string; series: string; value: number}> = [];
  for (const row of rows) {
    const raw = row[xKey];
    const x = xType === 'time' ? time(raw, true) : xType === 'linear' ? num(raw) : raw == null || raw === '' ? undefined : label(raw);
    if (x === undefined) {
      bad++;
      continue;
    }
    if (!xIndex.has(x)) xIndex.set(x, xIndex.size);
    const add = (series: string, cell: unknown) => {
      const value = num(cell);
      if (value === undefined) {
        if (cell != null && cell !== '') bad++;
        return;
      }
      points.push({x, series, value});
    };
    if (seriesKey) add(label(row[seriesKey]), row[yKeys[0]!]);
    else for (const key of yKeys) add(key, row[key]);
  }
  if (points.length === 0) return `no numeric values in ${yKeys.map(key => `"${say(key, 40)}"`).join(', ')}`;

  const keys = [...xIndex.keys()];
  if (xType !== 'point') {
    (keys as number[]).sort((a, b) => a - b);
    keys.forEach((key, i) => void xIndex.set(key, i));
  }
  const xs = xType === 'point' ? keys.map((_, i) => i) : (keys as number[]);
  const xLabels = keys.map(key => (xType === 'time' ? fmtDay(key as number) : xType === 'linear' ? fmtNum(key) : String(key)));

  const cells = new Map<string, Array<number | null>>();
  const totals = new Map<string, number>();
  if (!seriesKey) for (const key of yKeys) totals.set(key, 0);
  for (const point of points) {
    let values = cells.get(point.series);
    if (!values) {
      values = new Array<number | null>(xs.length).fill(null);
      cells.set(point.series, values);
    }
    const i = xIndex.get(point.x)!;
    values[i] = (values[i] ?? 0) + point.value;
    totals.set(point.series, (totals.get(point.series) ?? 0) + Math.abs(point.value));
  }
  const {keep, folded} = foldSeries(totals);
  const names = folded.size > 0 ? [...keep, OTHER] : keep;
  const seriesInfo = seriesKey ? fields.get(seriesKey) : undefined;
  const kind = slotKind(seriesInfo);
  const slotOf = assignSlots(names, kind ? slots?.[kind] : undefined);
  const empty = () => new Array<number | null>(xs.length).fill(null);
  const series: Series[] = keep.map(name => ({
    name,
    label: seriesKey ? name : fields.get(name).label,
    slot: slotOf.get(name) ?? 0,
    entity: seriesKey ? entityOf(seriesInfo, name) : undefined,
    info: seriesKey ? undefined : fields.get(name),
    values: cells.get(name) ?? empty(),
  }));
  if (folded.size > 0) {
    const rest = empty();
    for (const name of folded) {
      cells.get(name)?.forEach((value, i) => {
        if (value !== null) rest[i] = (rest[i] ?? 0) + value;
      });
    }
    series.push({name: OTHER, label: OTHER, slot: 0, values: rest});
  }
  return {xType, xs, xLabels, series, valueInfo: fields.get(yKeys[0]!), xInfo, bad};
}

interface Drawn {
  series: number;
  /** Line through the defined points (line, area). */
  path?: string;
  /** Filled shape: the area under a line, or a stacked layer. */
  fill?: string;
  dots: Array<[number, number]>;
  end?: [number, number];
}
interface EndLabel {
  series: number;
  text: string;
  x: number;
  y: number;
  anchorY: number;
}
interface Layout {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  axis: ValueAxis;
  px: number[];
  /** Pixel y per series per x (NaN where there is no value); the top of the layer when stacked. */
  py: number[][];
  xTicks: Array<{x: number; label: string}>;
  drawn: Drawn[];
  labels: EndLabel[];
  direct: boolean;
  marks: Mark[];
  offScale: number;
}

function layoutLines(model: Model, mode: Mode, log: boolean, width: number, height: number): Layout {
  const {series, xs} = model;
  const k = series.length;
  const stacked = mode === 'stacked' || mode === 'pct';
  const top = 24;
  const bottom = height - 26;

  // values on the scale: raw for lines, cumulative tops for stacks
  const tops: Array<Array<number | null>> = series.map(s => [...s.values]);
  const bases: number[][] = series.map(() => new Array<number>(xs.length).fill(0));
  if (stacked) {
    for (let i = 0; i < xs.length; i++) {
      let total = 0;
      for (const s of series) total += Math.max(0, s.values[i] ?? 0);
      let acc = 0;
      for (let j = 0; j < k; j++) {
        const value = Math.max(0, series[j]!.values[i] ?? 0);
        const share = mode === 'pct' ? (total > 0 ? (value / total) * 100 : 0) : value;
        bases[j]![i] = acc;
        acc += share;
        tops[j]![i] = acc;
      }
    }
  }
  let offScale = 0;
  const domain: number[] = [];
  for (const row of tops) for (const value of row) {
    if (value === null) continue;
    if (log && !stacked && value <= 0) offScale++;
    else domain.push(value);
  }
  const count = Math.max(2, Math.min(5, Math.floor((bottom - top) / 44)));
  const probe = log && !stacked ? logAxis(domain, [bottom, top], count) : linearAxis(mode === 'pct' ? [0, 100] : domain, [bottom, top], {count});
  const fmtTick = tickFormat(probe.ticks, mode === 'pct' ? 'pct' : formatOf(model.valueInfo));
  const left = Math.min(width * 0.3, widest(probe.ticks.map(fmtTick)) + 14);

  const texts = series.map(s => clip(s.label, Math.min(140, width * 0.25)));
  const labelW = widest(texts);
  const direct = k > 1 && width >= 320 && k * 14 <= bottom - top + 14;
  const right = direct ? Math.max(24, width - labelW - 18) : width - 10;

  const span = Math.max(1, right - left);
  let px: number[];
  let xTicks: Layout['xTicks'];
  if (model.xType === 'point') {
    px = xs.map((_, i) => (xs.length === 1 ? left + span / 2 : left + (i / (xs.length - 1)) * span));
    const room = Math.min(96, widest(model.xLabels.slice(0, 200)));
    const every = Math.max(1, Math.ceil((xs.length * (room + 12)) / span));
    xTicks = px.flatMap((x, i) => (i % every === 0 ? [{x, label: clip(model.xLabels[i]!, 96)}] : []));
  } else if (model.xType === 'time') {
    const axis = timeAxis([xs[0]!, xs[xs.length - 1]!], [left, right], Math.floor(span / 110));
    px = xs.map(x => axis.scale(x));
    // a short series within a year is ticked at its own dates, so ticks and points line up
    const own = xs.length <= Math.floor(span / 72) && xs[xs.length - 1]! - xs[0]! < 360 * 86_400_000;
    xTicks = own ? xs.map((x, i) => ({x: px[i]!, label: fmtShortDay(x)})) : axis.ticks.map(tick => ({x: axis.scale(tick.value), label: tick.label}));
  } else {
    const axis = linearAxis(xs, [left, right], {zero: false, count: Math.max(2, Math.floor(span / 84))});
    const lo = xs[0]!;
    const hi = xs[xs.length - 1]!;
    const scale = axis.scale.copy().domain(lo === hi ? axis.scale.domain() : [lo, hi]);
    px = xs.map(x => scale(x));
    xTicks = scale.ticks(Math.max(2, Math.floor(span / 84))).map(tick => ({x: scale(tick), label: fmtNum(tick)}));
  }

  // labels that would run into the one before them are left out
  let edge = -Infinity;
  xTicks = xTicks.filter(tick => {
    const w = textWidth(tick.label);
    const start = tick.x - left < 16 ? tick.x : right - tick.x < 16 ? tick.x - w : tick.x - w / 2;
    if (start < edge + 10) return false;
    edge = start + w;
    return true;
  });

  const onScale = (value: number | null): value is number => value !== null && !(probe.log && value <= 0);
  const py = tops.map(row => row.map(value => (onScale(value) ? probe.scale(value) : Number.NaN)));
  const floor = probe.scale(probe.log ? probe.scale.domain()[0]! : Math.max(0, probe.scale.domain()[0]!));
  const drawn: Drawn[] = series.map((_, j) => {
    const ys = py[j]!;
    const index = xs.map((_, i) => i);
    const defined = (i: number) => !Number.isNaN(ys[i]!);
    let end: [number, number] | undefined;
    for (let i = xs.length - 1; i >= 0 && !end; i--) if (defined(i)) end = [px[i]!, ys[i]!];
    if (stacked) {
      const base = bases[j]!.map(value => probe.scale(value));
      return {series: j, fill: area<number>().x(i => px[i]!).y0(i => base[i]!).y1(i => ys[i]!)(index) ?? undefined, dots: xs.length === 1 && end ? [end] : [], end};
    }
    const dots: Array<[number, number]> = [];
    for (let i = 0; i < xs.length; i++) if (defined(i) && !(i > 0 && defined(i - 1)) && !(i < xs.length - 1 && defined(i + 1))) dots.push([px[i]!, ys[i]!]);
    return {
      series: j,
      path: line<number>().defined(defined).x(i => px[i]!).y(i => ys[i]!)(index) ?? undefined,
      fill: mode === 'area' ? (area<number>().defined(defined).x(i => px[i]!).y0(floor).y1(i => ys[i]!)(index) ?? undefined) : undefined,
      dots,
      end,
    };
  });

  // direct labels sit at the line ends (the middle of the last band when stacked), nudged to 14 px apart
  const labels: EndLabel[] = [];
  if (direct) {
    drawn.forEach((d, j) => {
      if (!d.end) return;
      const last = xs.length - 1;
      const anchorY = stacked ? (probe.scale(bases[j]![last]!) + d.end[1]) / 2 : d.end[1];
      labels.push({series: j, text: texts[j]!, x: right + 12, y: anchorY, anchorY});
    });
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i]!.y = Math.max(labels[i]!.y, labels[i - 1]!.y + 14);
    const over = labels.length > 0 ? labels[labels.length - 1]!.y - bottom : 0;
    if (over > 0) {
      labels[labels.length - 1]!.y -= over;
      for (let i = labels.length - 2; i >= 0; i--) labels[i]!.y = Math.min(labels[i]!.y, labels[i + 1]!.y - 14);
    }
  }

  const marks: Mark[] = xs.map((_, i) => {
    let lo = Infinity;
    let hi = -Infinity;
    let total = 0;
    const rows = series.map((s, j) => {
      const y = py[j]![i]!;
      if (!Number.isNaN(y)) {
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      total += s.values[i] ?? 0;
      return {label: s.label, value: fmtValue(s.values[i] ?? undefined, s.info ?? model.valueInfo), color: catVar(s.slot)};
    });
    if (lo > hi) {
      lo = top;
      hi = bottom;
    }
    const first = series.find(s => s.values[i] !== null);
    return {
      x: px[i]! - 5, y: lo - 5, w: 10, h: hi - lo + 10,
      title: model.xLabels[i]!,
      rows,
      foot: stacked && k > 1 ? `total ${fmtValue(total, model.valueInfo)}` : undefined,
      say: `${say(model.xLabels[i]!)}${first ? `, ${k > 1 ? `${say(first.label, 40)} ` : ''}${fmtValue(first.values[i] ?? undefined, first.info ?? model.valueInfo)}` : ''}${k > 1 ? `, ${k} series` : ''}`,
    };
  });
  return {width, height, left, right, top, bottom, axis: probe, px, py, xTicks, drawn, labels, direct, marks, offScale};
}

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.LineChart>}): JSX.Element {
  const {id, rows, state, props} = p;
  const slots = useSlots();
  const model = useMemo(
    () => buildModel(rows, state.fields, state.roles, {x: props.x, y: props.y, series: props.series}, slots),
    [rows, state.fields, state.roles, props.x, props.y, props.series, slots],
  );
  if (typeof model === 'string') return <Empty message={`${model}${state.ds ? ` (${state.ds.source})` : ''}`} />;
  return <Lines id={id} model={model} skipped={p.skipped} props={props} />;
}

function Lines(p: {id: string; model: Model; skipped: number; props: C.ViewProps<typeof C.LineChart>}): JSX.Element {
  const {id, model, props} = p;
  const {boxRef, fill, width, height: boxHeight} = useChartBox(props.size);
  const mode: Mode = props.mode ?? 'line';
  const height = fill ? Math.max(120, boxHeight) : DEFAULT_HEIGHT;
  const layout = useMemo(
    () => (width <= 0 ? undefined : layoutLines(model, mode, props.scale === 'log', width, height)),
    [model, mode, props.scale, width, height],
  );
  const [focusSeries, setFocusSeries] = useState(0);
  const {select} = useSelection(id);
  const seriesCount = model.series.length;
  const nav = useMarkNav({
    id,
    marks: layout?.marks ?? [],
    hit: (x, y) => {
      if (!layout || x < layout.left - 8 || x > layout.right + 8 || y < layout.top - 8 || y > layout.bottom + 8) return -1;
      const at = bisectLeft(layout.px, x);
      return at > 0 && (at >= layout.px.length || x - layout.px[at - 1]! < layout.px[at]! - x) ? at - 1 : at;
    },
    move: (from: number, key: ArrowKey) => {
      const last = (layout?.marks.length ?? 1) - 1;
      if (key === 'ArrowLeft') return Math.max(0, from - 1);
      if (key === 'ArrowRight') return Math.min(last, from + 1);
      if (seriesCount > 0) setFocusSeries(current => (current + (key === 'ArrowDown' ? 1 : seriesCount - 1)) % seriesCount);
      return from;
    },
    activate: () => {
      const entity = model.series[focusSeries % seriesCount]?.entity;
      if (entity) select(entity);
      return true;
    },
  });
  const drawing = useDrawIn();
  const {series} = model;
  const stacked = mode === 'stacked' || mode === 'pct';
  const pickedSeries = nav.selected ? series.map(s => matches(nav.selected, s.entity)) : [];
  const anyPicked = pickedSeries.some(Boolean);
  const dim = (j: number) => (anyPicked && !pickedSeries[j] ? '' : undefined);
  const focused = nav.keyboard && series.length > 1 ? focusSeries % series.length : -1;
  const first = model.xLabels[0]!;
  const last = model.xLabels[model.xLabels.length - 1]!;
  const largest = series.reduce((best, s) => {
    const total = s.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    return total > best.total ? {label: s.label, total} : best;
  }, {label: '', total: -Infinity});
  const aria = `${stacked ? 'Stacked area' : mode === 'area' ? 'Area' : 'Line'} chart, ${series.length} series over ${count(model.xs.length, 'point')}, ${say(first, 40)} to ${say(last, 40)}${series.length > 1 ? `, largest ${say(largest.label, 40)}` : ''}`;
  const legend: LegendItem[] = series.map((s, j) => ({key: s.name, label: s.label, color: catVar(s.slot), entity: s.entity, dim: dim(j) !== undefined, selected: Boolean(pickedSeries[j])}));
  const fmtTick = layout ? tickFormat(layout.axis.ticks, mode === 'pct' ? 'pct' : formatOf(model.valueInfo)) : String;
  const active = nav.active;
  const title = mode === 'pct' ? undefined : series.length === 1 ? series[0]!.label : series[0]!.info ? undefined : model.valueInfo?.label;

  return (
    <>
      <Note>{notes(p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.bad > 0 && `${count(model.bad, 'value')} skipped`, layout && layout.offScale > 0 && `${fmtNum(layout.offScale)} off the log scale`)}</Note>
      <Figure
        name="LineChart"
        label={aria}
        nav={nav}
        boxRef={boxRef}
        fill={fill}
        width={layout?.width ?? 0}
        height={layout?.height ?? (fill ? 0 : DEFAULT_HEIGHT)}
        drawing={drawing}
        rings={false}
        hover={false}
        header={layout && !layout.direct && series.length > 1 ? <Legend items={legend} onPick={item => select(item.entity ?? null)} /> : undefined}
      >
        {layout ? (
          <>
            <ValueGrid axis={layout.axis} dir="y" from={layout.left} to={layout.right} fmt={fmtTick} title={title ? say(title, 32) : undefined} />
            {layout.xTicks.map((tick, i) => <text key={i} className={kit.tick} x={tick.x} y={layout.bottom + 16} textAnchor={tick.x - layout.left < 16 ? 'start' : layout.right - tick.x < 16 ? 'end' : 'middle'}>{tick.label}</text>)}
            {layout.drawn.map(d => {
              const s = series[d.series]!;
              const ink = catVar(s.slot);
              return (
                <g key={s.name} data-series={s.name} data-dim={dim(d.series)} data-entity={s.entity ? '' : undefined} onClick={s.entity ? () => select(s.entity!) : undefined}>
                  {d.fill ? <path className={`${stacked ? css.layer : css.area} ${kit.wipe}`} d={d.fill} style={{fill: ink}} /> : null}
                  {d.path ? <path className={`${css.line} ${kit.drawLine}`} d={d.path} pathLength={1} style={{stroke: ink}} data-focus={focused === d.series || undefined} /> : null}
                  {d.path && s.entity ? <path className={css.hit} d={d.path} /> : null}
                  {d.dots.map(([x, y], i) => <circle key={i} className={css.dot} cx={x} cy={y} r={2.5} style={{fill: ink}} />)}
                  {d.end && !stacked ? <circle className={`${css.end} ${kit.fade}`} cx={d.end[0]} cy={d.end[1]} r={3.5} style={{fill: ink}} /> : null}
                </g>
              );
            })}
            {layout.labels.map(lab => {
              const s = series[lab.series]!;
              return (
                <g key={s.name} className={kit.fade} data-dim={dim(lab.series)} data-entity={s.entity ? '' : undefined} data-end-label={s.name} onClick={s.entity ? () => select(s.entity!) : undefined}>
                  <path className={css.leader} d={`M${layout.right + (stacked ? 1 : 5)},${lab.anchorY}L${lab.x - 3},${lab.y}`} />
                  {stacked ? <rect x={lab.x - 12} y={lab.anchorY - 3} width={6} height={6} style={{fill: catVar(s.slot)}} /> : null}
                  <text className={kit.label} x={lab.x} y={lab.y} dy="0.32em" data-focus={focused === lab.series || undefined}>{lab.text}</text>
                </g>
              );
            })}
            {active >= 0 ? (
              <g className={css.cross}>
                <line className={kit.guide} x1={Math.round(layout.px[active]!) + 0.5} x2={Math.round(layout.px[active]!) + 0.5} y1={layout.top} y2={layout.bottom} />
                {series.map((s, j) => {
                  const y = layout.py[j]![active]!;
                  return Number.isNaN(y) ? null : <circle key={s.name} className={css.end} cx={layout.px[active]} cy={y} r={3} style={{fill: catVar(s.slot)}} />;
                })}
              </g>
            ) : null}
          </>
        ) : null}
      </Figure>
    </>
  );
}

export const LineChartView: GlView<typeof C.LineChart> = ({id, props}) => (
  <RowsGate name="LineChart" id={id} input={props.data}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
