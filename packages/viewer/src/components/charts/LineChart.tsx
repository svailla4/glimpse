// LineChart: change over time or along an ordered x. Lines with direct labels at their ends while those sit beside
// the ends, else a keyed legend column; stacked layers with `other` as a light base; a crosshair snaps to the
// nearest x and the tooltip lists every series.
import type {EntityRef, Field, Roles, Rows, SurfaceMeta} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {bisectLeft} from 'd3-array';
import {area, line} from 'd3-shape';
import {useId, useMemo, useState, type JSX} from 'react';
import {Empty, catVar, fmtNum, useSelection, type DataState, type GlView} from '../../kit/index.ts';
import css from './LineChart.module.css';
import {
  DEFAULT_HEIGHT, Figure, Legend, Note, OTHER, RowsGate, ValueGrid, clip, clipName, count, entityOf, fillVar, fmtDay, fmtShortDay,
  fmtValue, foldSeries, formatOf, inspect, isOtherKey, kit, label, linearAxis, logAxis, matches, notes, num, pick, roleY, say, slotKind, textWidth,
  tickFormat, time, timeAxis, useChartBox, useDrawIn, useMarkNav, useSlots, useSlotter, widest, words, type ArrowKey, type FieldInfo,
  type LegendItem, type Mark, type Slotter, type ValueAxis,
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

function buildModel(
  rows: Rows,
  fieldList: Field[] | undefined,
  roles: Roles | undefined,
  opts: {x?: string; y?: string; series?: string; stacked: boolean},
  slots: SurfaceMeta['slots'] | undefined,
  assign: Slotter,
): Model | string {
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
  const slotOf = assign(names, kind ? slots?.[kind] : undefined);
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
  // The remainder (folded here, or already a row of the data) is the base of a stack: there it carries the named
  // layers instead of sitting on them as the largest shape.
  const rest = series.findIndex(s => isOtherKey(s.name));
  if (opts.stacked && rest > 0) series.unshift(...series.splice(rest, 1));
  return {xType, xs, xLabels, series, valueInfo: fields.get(yKeys[0]!), xInfo, bad};
}

/**
 * True when the last x of a regular time series is a period that has not ended yet (this week, today): its value
 * is still growing, so the chart must not draw it as a collapse.
 */
export function lastIsOpen(xs: readonly number[], now: number): boolean {
  if (xs.length < 3) return false;
  const steps: number[] = [];
  for (let i = 1; i < xs.length; i++) steps.push(xs[i]! - xs[i - 1]!);
  steps.sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)]!;
  const last = xs[xs.length - 1]!;
  return step > 0 && last <= now && last + step > now;
}

interface Drawn {
  series: number;
  /** Line through the defined points (line, area). */
  path?: string;
  /** The last segment of a line when it leads into a period that is still open: drawn dashed. */
  tail?: string;
  /** Filled shape: the area under a line, or a stacked layer. */
  fill?: string;
  /** Stacked segments of a series when there are too few x values for an area. */
  bars?: Array<{x: number; y: number; w: number; h: number}>;
  dots: Array<[number, number]>;
  end?: [number, number];
}
interface EndLabel {
  series: number;
  dir: string;
  base: string;
  x: number;
  y: number;
  anchorY: number;
}
/** Where series names go: at the line ends, in a keyed column right of the plot, or in the legend above it. */
type LabelMode = 'direct' | 'side' | 'top' | 'none';
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
  labelMode: LabelMode;
  /** Series indices in reading order: top of the stack first, or highest line end first. */
  order: number[];
  /** Stacks with one or two x values are bars. */
  bars: boolean;
  /** Pixel x where a period that is still open begins. */
  openFrom?: number;
  marks: Mark[];
  offScale: number;
}

const ROW = 16;
const NUDGE = 14;

function layoutLines(model: Model, mode: Mode, log: boolean, width: number, height: number, now: number): Layout {
  const {series, xs} = model;
  const k = series.length;
  const stacked = mode === 'stacked' || mode === 'pct';
  const bars = stacked && xs.length < 3;
  const top = 24;
  const bottom = height - 26;
  const open = model.xType === 'time' && !bars && lastIsOpen(xs, now);

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
  const probe = log && !stacked ? logAxis(domain, [bottom, top], count) : linearAxis(mode === 'pct' ? [0, 100] : domain, [bottom, top], {count, whole: mode !== 'pct'});
  const fmtTick = tickFormat(probe.ticks, mode === 'pct' ? 'pct' : formatOf(model.valueInfo));
  const left = Math.min(width * 0.3, widest(probe.ticks.map(fmtTick)) + 14);

  // names keep their last segment (design D12): 'typescript/core/web_core' gives way in the middle, not at the end
  const names = series.map(s => clipName(s.label, Math.min(220, Math.max(96, width * 0.3))));
  const labelW = widest(names.map(name => name.dir + name.base));
  const column = k > 1 && width >= 360 && k * ROW <= bottom - top + 8;
  const right = column ? Math.max(left + 24, width - labelW - 30) : width - 10;

  const span = Math.max(1, right - left);
  let px: number[];
  let xTicks: Layout['xTicks'];
  let barW = 0;
  if (bars) {
    // one or two periods are not a trend: each is a stacked bar in its own band
    const band = span / xs.length;
    barW = Math.min(56, band * 0.5);
    px = xs.map((_, i) => left + band * (i + 0.5));
    xTicks = px.map((x, i) => ({x, label: model.xType === 'time' ? fmtShortDay(xs[i]!) : clip(model.xLabels[i]!, Math.max(24, band - 8))}));
  } else if (model.xType === 'point') {
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
    // whole x values (a count, a year, a build number) are not ticked in between
    const whole = xs.every(Number.isInteger);
    xTicks = scale.ticks(Math.max(2, Math.floor(span / 84))).filter(tick => !whole || Number.isInteger(tick)).map(tick => ({x: scale(tick), label: fmtNum(tick)}));
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
  const last = xs.length - 1;
  const drawn: Drawn[] = series.map((_, j) => {
    const ys = py[j]!;
    const index = xs.map((_, i) => i);
    const defined = (i: number) => !Number.isNaN(ys[i]!);
    let end: [number, number] | undefined;
    for (let i = last; i >= 0 && !end; i--) if (defined(i)) end = [px[i]!, ys[i]!];
    if (stacked) {
      const base = bases[j]!.map(value => probe.scale(value));
      if (bars) {
        return {
          series: j,
          bars: xs.flatMap((_, i) => (base[i]! - ys[i]! > 0 ? [{x: px[i]! - barW / 2, y: ys[i]!, w: barW, h: base[i]! - ys[i]!}] : [])),
          dots: [],
          end,
        };
      }
      return {series: j, fill: area<number>().x(i => px[i]!).y0(i => base[i]!).y1(i => ys[i]!)(index) ?? undefined, dots: [], end};
    }
    const dots: Array<[number, number]> = [];
    for (let i = 0; i < xs.length; i++) if (defined(i) && !(i > 0 && defined(i - 1)) && !(i < xs.length - 1 && defined(i + 1))) dots.push([px[i]!, ys[i]!]);
    // the segment into an open period is drawn apart from the line, dashed
    const closed = (i: number) => defined(i) && !(open && i === last);
    const tail = open && defined(last) && defined(last - 1) ? `M${px[last - 1]},${ys[last - 1]}L${px[last]},${ys[last]}` : undefined;
    return {
      series: j,
      path: line<number>().defined(closed).x(i => px[i]!).y(i => ys[i]!)(index) ?? undefined,
      tail,
      fill: mode === 'area' ? (area<number>().defined(defined).x(i => px[i]!).y0(floor).y1(i => ys[i]!)(index) ?? undefined) : undefined,
      dots,
      end,
    };
  });

  // reading order: the stack from its top layer down, lines from the highest end down
  const order = series.map((_, j) => j);
  if (stacked) order.reverse();
  else order.sort((a, b) => (drawn[a]!.end?.[1] ?? Infinity) - (drawn[b]!.end?.[1] ?? Infinity) || a - b);

  // Direct labels sit at the line ends (the middle of the last band when stacked), nudged to 14 px apart. They are
  // only direct while a reader can follow each one to its mark: up to four series, none moved further than one
  // row. Otherwise the names go in a keyed column in reading order, with no leaders.
  let labels: EndLabel[] = [];
  let labelMode: LabelMode = k <= 1 ? 'none' : column ? 'side' : 'top';
  if (column && k <= 4 && !bars) {
    const ends: EndLabel[] = [];
    drawn.forEach((d, j) => {
      if (!d.end) return;
      const anchorY = stacked ? (probe.scale(bases[j]![last]!) + d.end[1]) / 2 : d.end[1];
      ends.push({series: j, ...names[j]!, x: right + (stacked ? 24 : 12), y: anchorY, anchorY});
    });
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i]!.y = Math.max(ends[i]!.y, ends[i - 1]!.y + NUDGE);
    const over = ends.length > 0 ? ends[ends.length - 1]!.y - bottom : 0;
    if (over > 0) {
      ends[ends.length - 1]!.y -= over;
      for (let i = ends.length - 2; i >= 0; i--) ends[i]!.y = Math.min(ends[i]!.y, ends[i + 1]!.y - NUDGE);
    }
    if (ends.length === k && ends.every(lab => Math.abs(lab.y - lab.anchorY) <= NUDGE)) {
      labels = ends;
      labelMode = 'direct';
    }
  }
  if (labelMode === 'side') {
    labels = order.map((j, row) => {
      const y = top + 6 + row * ROW;
      return {series: j, ...names[j]!, x: right + 28, y, anchorY: y};
    });
  }

  const marks: Mark[] = xs.map((_, i) => {
    let lo = Infinity;
    let hi = -Infinity;
    let total = 0;
    const rows = order.map(j => {
      const s = series[j]!;
      const y = py[j]![i]!;
      if (!Number.isNaN(y)) {
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      total += s.values[i] ?? 0;
      return {label: s.label, value: fmtValue(s.values[i] ?? undefined, s.info ?? model.valueInfo), color: stacked ? fillVar(s.slot) : catVar(s.slot)};
    });
    if (lo > hi) {
      lo = top;
      hi = bottom;
    }
    if (bars) hi = Math.max(hi, floor);
    const first = series.find(s => s.values[i] !== null);
    const half = bars ? barW / 2 : 5;
    const foot = [stacked && k > 1 && `total ${fmtValue(total, model.valueInfo)}`, open && i === last && 'period still open'].filter(Boolean).join(' · ');
    return {
      x: px[i]! - half, y: bars ? lo : lo - 5, w: half * 2, h: bars ? hi - lo : hi - lo + 10,
      title: model.xLabels[i]!,
      rows,
      foot: foot || undefined,
      say: `${say(model.xLabels[i]!)}${first ? `, ${k > 1 ? `${say(first.label, 40)} ` : ''}${fmtValue(first.values[i] ?? undefined, first.info ?? model.valueInfo)}` : ''}${k > 1 ? `, ${k} series` : ''}`,
    };
  });
  return {
    width, height, left, right, top, bottom, axis: probe, px, py, xTicks, drawn, labels, labelMode, order, bars,
    openFrom: open && last > 0 ? px[last - 1] : undefined, marks, offScale,
  };
}

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.LineChart>}): JSX.Element {
  const {id, rows, state, props} = p;
  const slots = useSlots();
  const assign = useSlotter();
  const stacked = props.mode === 'stacked' || props.mode === 'pct';
  const model = useMemo(
    () => buildModel(rows, state.fields, state.roles, {x: props.x, y: props.y, series: props.series, stacked}, slots, assign),
    [rows, state.fields, state.roles, props.x, props.y, props.series, stacked, slots, assign],
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
    () => (width <= 0 ? undefined : layoutLines(model, mode, props.scale === 'log', width, height, Date.now())),
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
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
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
  const aria = `${stacked ? (layout?.bars ? 'Stacked bar' : 'Stacked area') : mode === 'area' ? 'Area' : 'Line'} chart, ${series.length} series over ${count(model.xs.length, 'point')}, ${say(first, 40)} to ${say(last, 40)}${series.length > 1 ? `, largest ${say(largest.label, 40)}` : ''}`;
  // fills wear the light neutral for `other`; lines keep an ink that holds on its own
  const ink = (s: Series) => (stacked ? fillVar(s.slot) : catVar(s.slot));
  const legend: LegendItem[] = (layout?.order ?? series.map((_, j) => j)).map(j => {
    const s = series[j]!;
    return {key: s.name, label: s.label, color: ink(s), entity: s.entity, dim: dim(j) !== undefined, selected: Boolean(pickedSeries[j])};
  });
  const fmtTick = layout ? tickFormat(layout.axis.ticks, mode === 'pct' ? 'pct' : formatOf(model.valueInfo)) : String;
  const active = nav.active;
  const title = mode === 'pct' ? undefined : series.length === 1 ? series[0]!.label : series.some(s => s.info) ? undefined : model.valueInfo?.label;
  const openFrom = layout?.openFrom;

  // a stacked layer over a period that is still open is cut there and drawn again, faded
  const closedClip = openFrom !== undefined && stacked ? `url(#${uid}-closed)` : undefined;

  return (
    <>
      <Note>{notes(p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.bad > 0 && `${count(model.bad, 'value')} skipped`, layout && layout.offScale > 0 && `${fmtNum(layout.offScale)} off the log scale`, openFrom !== undefined && 'last period still open')}</Note>
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
        hover={layout?.bars === true}
        header={layout && layout.labelMode === 'top' ? <Legend items={legend} onPick={item => select(item.entity ?? null)} /> : undefined}
      >
        {layout ? (
          <g data-label-mode={layout.labelMode} data-bars={layout.bars || undefined}>
            {openFrom !== undefined ? (
              <defs>
                <clipPath id={`${uid}-closed`}><rect x={0} y={0} width={Math.max(0, openFrom)} height={layout.height} /></clipPath>
                <clipPath id={`${uid}-open`}><rect x={openFrom} y={0} width={Math.max(0, layout.width - openFrom)} height={layout.height} /></clipPath>
              </defs>
            ) : null}
            <ValueGrid axis={layout.axis} dir="y" from={layout.left} to={layout.right} fmt={fmtTick} title={title ? say(title, 32) : undefined} />
            {layout.xTicks.map((tick, i) => <text key={i} className={kit.tick} x={tick.x} y={layout.bottom + 16} textAnchor={layout.bars ? 'middle' : tick.x - layout.left < 16 ? 'start' : layout.right - tick.x < 16 ? 'end' : 'middle'}>{tick.label}</text>)}
            {layout.drawn.map(d => {
              const s = series[d.series]!;
              return (
                <g key={s.name} data-series={s.name} data-dim={dim(d.series)} data-entity={s.entity ? '' : undefined} onClick={s.entity ? () => select(s.entity!) : undefined}>
                  {d.fill ? <g clipPath={closedClip}><path className={`${stacked ? css.layer : css.area} ${kit.wipe}`} d={d.fill} style={{fill: ink(s)}} /></g> : null}
                  {d.fill && closedClip ? <g className={css.open} clipPath={`url(#${uid}-open)`} data-open=""><path className={`${css.layer} ${kit.wipe}`} d={d.fill} style={{fill: ink(s)}} /></g> : null}
                  {d.bars?.map((bar, i) => <rect key={i} className={`${css.layer} ${kit.growY}`} x={bar.x} y={bar.y} width={bar.w} height={bar.h} style={{fill: ink(s)}} data-bar="" />)}
                  {d.path ?<path className={`${css.line} ${kit.drawLine}`} d={d.path} pathLength={1} style={{stroke: catVar(s.slot)}} data-focus={focused === d.series || undefined} /> : null}
                  {d.tail ? <path className={`${css.line} ${css.tail} ${kit.fade}`} d={d.tail} style={{stroke: catVar(s.slot)}} data-open="" /> : null}
                  {d.path && s.entity ? <path className={css.hit} d={d.path} /> : null}
                  {d.dots.map(([x, y], i) => <circle key={i} className={css.dot} cx={x} cy={y} r={2.5} style={{fill: catVar(s.slot)}} />)}
                  {d.end && !stacked ? <circle className={`${css.end} ${kit.fade}`} cx={d.end[0]} cy={d.end[1]} r={3.5} style={{fill: catVar(s.slot)}} /> : null}
                </g>
              );
            })}
            {layout.labels.map(lab => {
              const s = series[lab.series]!;
              const direct = layout.labelMode === 'direct';
              return (
                <g key={s.name} className={kit.fade} data-dim={dim(lab.series)} data-entity={s.entity ? '' : undefined} data-end-label={s.name} onClick={s.entity ? () => select(s.entity!) : undefined}>
                  {direct ? <path className={css.leader} d={`M${layout.right + (stacked ? 1 : 5)},${lab.anchorY}L${lab.x - (stacked ? 15 : 3)},${lab.y}`} /> : null}
                  {/* the colour key sits beside the name it belongs to; a direct line label has its end dot and leader */}
                  {stacked ? <rect className={css.key} x={lab.x - 12} y={lab.y - 4} width={8} height={8} style={{fill: ink(s)}} data-key="" /> : null}
                  {!stacked && !direct ? <rect className={css.key} x={lab.x - 14} y={lab.y - 1.25} width={10} height={2.5} style={{fill: ink(s)}} data-key="" /> : null}
                  <text x={lab.x} y={lab.y} dy="0.32em" data-focus={focused === lab.series || undefined}>
                    {lab.dir ? <tspan className={kit.labelDim}>{lab.dir}</tspan> : null}
                    <tspan className={kit.label}>{lab.base}</tspan>
                  </text>
                </g>
              );
            })}
            {active >= 0 && !layout.bars ? (
              <g className={css.cross}>
                <line className={kit.guide} x1={Math.round(layout.px[active]!) + 0.5} x2={Math.round(layout.px[active]!) + 0.5} y1={layout.top} y2={layout.bottom} />
                {series.map((s, j) => {
                  const y = layout.py[j]![active]!;
                  return Number.isNaN(y) ? null : <circle key={s.name} className={css.end} cx={layout.px[active]} cy={y} r={3} style={{fill: ink(s)}} />;
                })}
              </g>
            ) : null}
          </g>
        ) : null}
      </Figure>
    </>
  );
}

export const LineChartView: GlView<typeof C.LineChart> = ({id, props}) => (
  <RowsGate name="LineChart" id={id} input={props.data} size={props.size}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
