// Histogram: the distribution of one numeric field (or a bare array of numbers), with the median as a dashed line
// and a tick at the 90th percentile. Their tags sit in a band above the bars, so no tag ever touches a bar.
import type {Field, Roles, Rows} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {bin, quantileSorted, thresholdFreedmanDiaconis, thresholdSturges} from 'd3-array';
import {scaleLinear} from 'd3-scale';
import {useMemo, type JSX} from 'react';
import {DataGate, fmtNum, useDataset, type DataState, type GlView} from '../../kit/index.ts';
import css from './Histogram.module.css';
import {
  DEFAULT_HEIGHT, Figure, MissReport, Note, ShapeError, Unable, ValueGrid, asWhole, checkField, count, fmtValue, formatOf, inspect, kit, linearAxis,
  logAxis, missNote, notes, num, pick, reserve, say, textWidth, tickFormat, unfit, useChartBox, useDrawIn, useMarkNav, widest, type FieldInfo,
  type FieldMiss, type FieldSet, type Mark, type Unfit, type ValueAxis,
} from './chartkit/index.ts';

const MAX_BINS = 40;

interface Model {
  /** Sorted ascending. */
  values: number[];
  info?: FieldInfo;
  bad: number;
  median: number;
  p90: number;
  /** A value field the spec named that the data does not have (counted with the default field instead). */
  misses: FieldMiss[];
  fields?: FieldSet;
}

function buildModel(data: unknown[], fieldList: Field[] | undefined, roles: Roles | undefined, valueKey: string | undefined, source?: string): Model | Unfit {
  const rows = data.filter((item): item is Rows[number] => typeof item === 'object' && item !== null && !Array.isArray(item));
  let info: FieldInfo | undefined;
  let raw: unknown[];
  const misses: FieldMiss[] = [];
  let fields: FieldSet | undefined;
  if (rows.length > 0) {
    fields = inspect(rows, fieldList);
    const key = pick(checkField(fields, 'value', valueKey, misses), roles?.value, fields.first('num')?.key);
    if (!key) return unfit('no numeric field to count', misses, fields, source);
    info = fields.get(key);
    raw = rows.map(row => row[key]);
  } else raw = data;
  const numbers: number[] = [];
  let bad = data.length - (rows.length > 0 ? rows.length : data.length);
  for (const item of raw) {
    const value = num(item);
    if (value === undefined) bad++;
    else numbers.push(value);
  }
  if (numbers.length === 0) {
    const why = info ? `no numeric values in "${say(info.key, 40)}"` : 'no numbers to count';
    return fields ? unfit(why, misses, fields, source) : {code: 'W_SHAPE', message: source ? `${why} (${source})` : why};
  }
  const values = numbers.sort((a, b) => a - b);
  // the median of line counts is a whole number of lines
  return {values, info, bad, median: asWhole(quantileSorted(values, 0.5)!, values), p90: asWhole(quantileSorted(values, 0.9)!, values), misses, fields};
}

interface Bin {
  x0: number;
  x1: number;
  count: number;
}
interface Tag {
  x: number;
  y: number;
  anchor: 'start' | 'end';
  text: string;
}
interface Layout {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  axis: ValueAxis;
  bins: Array<Bin & {x: number; y: number; w: number; h: number}>;
  xTicks: Array<{x: number; label: string}>;
  medianX: number;
  p90X: number;
  /** Where the dashed median line starts: under its tag, and under the p90 tag when that one sits across it. */
  medianFrom: number;
  medianTag: Tag;
  p90Tag: Tag;
  /** The p90 tick runs from under its tag down to just above the bars. */
  p90From: number;
  marks: Mark[];
}

/** Tag rows above the plot: baselines of the median and p90 tags, and the top of the bars. */
const TAG_ROW_1 = 14;
const TAG_ROW_2 = 29;
const PLOT_TOP = 40;
/** Advance of one tag glyph: mono 10.5 px with 0.04 em letter spacing (chartkit `.tag`). */
const TAG_PX = 10.5 * 0.6 + 0.42;

/**
 * Places a tag beside its line: right of it when it fits before `right`, else left of it. `x` is the line.
 */
function tagBeside(x: number, text: string, y: number, right: number): Tag {
  const w = text.length * TAG_PX;
  return x + 5 + w <= right ? {x: x + 5, y, anchor: 'start', text} : {x: x - 5, y, anchor: 'end', text};
}

const span = (tag: Tag): [number, number] => {
  const w = tag.text.length * TAG_PX;
  return tag.anchor === 'start' ? [tag.x, tag.x + w] : [tag.x - w, tag.x];
};

function binValues(model: Model, wanted: number | undefined): Bin[] {
  const {values} = model;
  const lo = values[0]!;
  const hi = values[values.length - 1]!;
  if (lo === hi) return [{x0: lo, x1: hi, count: values.length}];
  let count = wanted;
  if (count === undefined) {
    count = thresholdFreedmanDiaconis(values, lo, hi);
    if (!Number.isFinite(count) || count <= 1) count = thresholdSturges(values);
    count = Math.max(1, Math.min(MAX_BINS, count));
  }
  // nice, evenly spaced thresholds: every bar has the same width and edges land on round numbers
  const nice = scaleLinear().domain([lo, hi]).nice(count);
  const [from, to] = nice.domain() as [number, number];
  const thresholds = nice.ticks(count).filter(tick => tick > from && tick < to);
  return bin().domain([from, to]).thresholds(thresholds)(values).map(b => ({x0: b.x0 ?? from, x1: b.x1 ?? to, count: b.length}));
}

function layoutBins(model: Model, wanted: number | undefined, log: boolean, width: number, height: number): Layout {
  const bins = binValues(model, wanted);
  const top = PLOT_TOP;
  const bottom = height - 40;
  const right = width - 8;
  const counts = bins.map(b => b.count);
  const count = Math.max(2, Math.min(5, Math.floor((bottom - top) / 44)));
  const axis = log ? logAxis([0.5, ...counts], [bottom, top], count) : linearAxis(counts, [bottom, top], {count});
  // counts are whole numbers: no ticks at 0.5
  axis.ticks = axis.ticks.filter(tick => Number.isInteger(tick) && (!axis.log || tick >= 1));
  const tick = tickFormat(axis.ticks, 'num');
  const left = Math.min(width * 0.3, widest(axis.ticks.map(tick)) + 14);
  const single = bins.length === 1 && bins[0]!.x0 === bins[0]!.x1;
  const domain: [number, number] = single ? [bins[0]!.x0 - 1, bins[0]!.x0 + 1] : [bins[0]!.x0, bins[bins.length - 1]!.x1];
  const x = scaleLinear().domain(domain).range([left, Math.max(left + 24, right)]);
  const floor = axis.scale(axis.scale.domain()[0]!);
  const fmt = tickFormat([domain[0], domain[1]], formatOf(model.info));
  const laid = bins.map(b => {
    const a = single ? x(b.x0 - 0.5) : x(b.x0);
    const z = single ? x(b.x0 + 0.5) : x(b.x1);
    const y = b.count > 0 ? Math.min(axis.scale(b.count), floor - 1) : floor;
    return {...b, x: a + 0.5, y, w: Math.max(1, z - a - 1), h: floor - y};
  });
  const total = model.values.length;
  const marks: Mark[] = [];
  const kept: Layout['bins'] = [];
  for (const b of laid) {
    if (b.count === 0) continue;
    const range = single ? fmt(b.x0) : `${fmt(b.x0)} – ${fmt(b.x1)}`;
    kept.push(b);
    marks.push({
      x: b.x, y: b.y, w: b.w, h: Math.max(1, b.h),
      title: range,
      rows: [{label: 'count', value: fmtNum(b.count)}, {label: 'share', value: fmtNum((b.count / total) * 100, 'pct')}],
      say: `${range}, ${fmtNum(b.count)} ${b.count === 1 ? 'value' : 'values'}`,
    });
  }
  const tickCount = Math.max(2, Math.min(8, Math.floor((right - left) / 80)));
  const xTicks = (single ? [bins[0]!.x0] : x.ticks(tickCount)).map(value => ({x: x(value), label: fmt(value)}));
  // The median tag takes the first row; the p90 tag the second, so the two never collide, and each sits beside its
  // own line. A p90 tag that has to sit left of its tick, across the median line, moves that line's start below it.
  const medianX = x(model.median);
  const p90X = x(model.p90);
  const medianTag = tagBeside(medianX, `median ${fmtValue(model.median, model.info)}`, TAG_ROW_1, right);
  const p90Tag = tagBeside(p90X, `p90 ${fmtValue(model.p90, model.info)}`, TAG_ROW_2, right);
  const [from, to] = span(p90Tag);
  const crossed = medianX >= from - 3 && medianX <= to + 3;
  return {
    width, height, left, right, top, bottom: floor, axis, bins: kept, xTicks, medianX, p90X, marks,
    medianFrom: crossed ? TAG_ROW_2 + 5 : TAG_ROW_1 + 4, medianTag, p90Tag, p90From: TAG_ROW_2 + 4,
  };
}

function Plot(p: {id: string; data: unknown[]; state: DataState<Rows | number[]>; props: C.ViewProps<typeof C.Histogram>}): JSX.Element {
  const {id, data, state, props} = p;
  const source = state.ds?.source;
  const model = useMemo(() => buildModel(data, state.fields, state.roles, props.value, source), [data, state.fields, state.roles, props.value, source]);
  if ('code' in model) return <Unable code={model.code} message={model.message} />;
  return (
    <>
      {model.fields ? <MissReport misses={model.misses} fields={model.fields} source={source} /> : null}
      <Bins id={id} model={model} props={props} />
    </>
  );
}

function Bins(p: {id: string; model: Model; props: C.ViewProps<typeof C.Histogram>}): JSX.Element {
  const {id, model, props} = p;
  const {boxRef, fill, width, height: boxHeight} = useChartBox(props.size);
  const height = fill ? Math.max(140, boxHeight) : DEFAULT_HEIGHT;
  const layout = useMemo(
    () => (width <= 0 ? undefined : layoutBins(model, props.bins, props.log === true, width, height)),
    [model, props.bins, props.log, width, height],
  );
  const nav = useMarkNav({id, marks: layout?.marks ?? [], selectable: false});
  const drawing = useDrawIn();
  const name = model.info?.label;
  const median = fmtValue(model.median, model.info);
  const p90 = fmtValue(model.p90, model.info);
  const aria = `Histogram${name ? ` of ${say(name, 40)}` : ''}, ${fmtNum(model.values.length)} ${model.values.length === 1 ? 'value' : 'values'} in ${layout?.bins.length ?? 1} ${(layout?.bins.length ?? 1) === 1 ? 'bin' : 'bins'}, median ${median}, 90th percentile ${p90}`;

  return (
    <>
      <Note>{notes(missNote(model.misses), model.bad > 0 && `${count(model.bad, 'value')} not numeric`)}</Note>
      <Figure
        name="Histogram"
        label={aria}
        nav={nav}
        boxRef={boxRef}
        fill={fill}
        width={layout?.width ?? 0}
        height={layout?.height ?? (fill ? 0 : DEFAULT_HEIGHT)}
        drawing={drawing}
      >
        {layout ? (
          <>
            <ValueGrid axis={layout.axis} dir="y" from={layout.left} to={layout.right} fmt={tickFormat(layout.axis.ticks, 'num')} />
            {layout.xTicks.map((tick, i) => <text key={i} className={kit.tick} x={tick.x} y={layout.bottom + 16} textAnchor={layout.right - tick.x < textWidth(tick.label) / 2 ? 'end' : 'middle'}>{tick.label}</text>)}
            {name ? <text className={kit.axisTitle} x={layout.right} y={layout.bottom + 30} textAnchor="end">{say(name, 32)}</text> : null}
            {layout.bins.map((b, i) => <rect key={i} className={`${css.bin} ${kit.growY}`} x={b.x} y={b.y} width={b.w} height={Math.max(1, b.h)} data-i={i} />)}
            <g data-median="">
              <line className={kit.guide} x1={Math.round(layout.medianX) + 0.5} x2={Math.round(layout.medianX) + 0.5} y1={layout.medianFrom} y2={layout.bottom} />
              <text className={kit.tag} x={layout.medianTag.x} y={layout.medianTag.y} textAnchor={layout.medianTag.anchor}>{layout.medianTag.text}</text>
            </g>
            <g data-p90="">
              <line className={css.p90} x1={Math.round(layout.p90X) + 0.5} x2={Math.round(layout.p90X) + 0.5} y1={layout.p90From} y2={layout.top - 3} />
              <text className={kit.tag} x={layout.p90Tag.x} y={layout.p90Tag.y} textAnchor={layout.p90Tag.anchor}>{layout.p90Tag.text}</text>
            </g>
          </>
        ) : null}
      </Figure>
    </>
  );
}

export const HistogramView: GlView<typeof C.Histogram> = ({id, props}) => {
  const state = useDataset<Rows | number[]>(props.data);
  return reserve(state, props.size, (
    <DataGate state={state} id={`Histogram#${id}`}>
      {(data, ready) => (Array.isArray(data)
        ? <Plot id={id} data={data} state={ready} props={props} />
        : <ShapeError name="Histogram" id={id} expected="rows or an array of numbers" value={data} />)}
    </DataGate>
  ));
};
