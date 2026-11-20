// BarChart: magnitude by category. Horizontal when there are many bars or long labels; grouped, stacked or
// normalised series; everything beyond `limit` folds into one `other (N)` bar.
import type {EntityRef, Field, Roles, Rows, SurfaceMeta} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo, type JSX} from 'react';
import {Empty, fmtNum, type DataState, type GlView} from '../../kit/index.ts';
import css from './BarChart.module.css';
import {
  DEFAULT_HEIGHT, Figure, Legend, Note, OTHER, RowsGate, ValueGrid, barPath, clipName, clipPath, count, entityOf, fillVar,
  fmtValue, foldSeries, formatOf, inspect, kit, label, linearAxis, notes, num, pick, roleY, say, slotKind, textWidth, tickFormat, useChartBox,
  useDrawIn, useMarkNav, useSlots, useSlotter, widest, words, type FieldInfo, type Mark, type Slotter, type ValueAxis,
} from './chartkit/index.ts';

type Mode = 'grouped' | 'stacked' | 'pct';
interface Category {
  label: string;
  entity?: EntityRef;
  path: boolean;
  /** One value per series; undefined when the cell is missing or not a number. */
  values: Array<number | undefined>;
}
interface Series {
  name: string;
  slot: number;
  info?: FieldInfo;
}
interface Model {
  cats: Category[];
  series: Series[];
  valueInfo?: FieldInfo;
  /** Cells that were present but not numbers. */
  bad: number;
  /** Categories folded into the `other (N)` bar. */
  folded: number;
}

interface Options {
  x?: string;
  y?: string;
  series?: string;
  limit: number;
}

function buildModel(rows: Rows, fieldList: Field[] | undefined, roles: Roles | undefined, opts: Options, slots: SurfaceMeta['slots'] | undefined, assign: Slotter): Model | string {
  const fields = inspect(rows, fieldList);
  const yKeys = words(opts.y);
  if (yKeys.length === 0) yKeys.push(...roleY(roles));
  const xKey = pick(opts.x, roles?.label, roles?.x, fields.first('cat', yKeys)?.key, fields.first('date', yKeys)?.key);
  if (yKeys.length === 0) {
    const fallback = pick(roles?.value, fields.first('num', [xKey])?.key);
    if (fallback) yKeys.push(fallback);
  }
  if (yKeys.length === 0) return 'no numeric field to draw';
  const roleSeries = roles?.series && roles.series !== xKey ? roles.series : undefined;
  const seriesKey = pick(opts.series, yKeys.length === 1 ? roleSeries : undefined);
  const xInfo = xKey ? fields.get(xKey) : undefined;

  const cats = new Map<string, {entity?: EntityRef; cells: Map<string, number>}>();
  const totals = new Map<string, number>();
  if (!seriesKey) for (const key of yKeys) totals.set(key, 0);
  let bad = 0;
  let valid = 0;
  rows.forEach((row, index) => {
    const name = xKey ? label(row[xKey]) : String(index + 1);
    let cat = cats.get(name);
    if (!cat) {
      cat = {entity: entityOf(xInfo, xKey ? row[xKey] : name, row), cells: new Map()};
      cats.set(name, cat);
    }
    const add = (series: string, raw: unknown) => {
      const value = num(raw);
      if (value === undefined) {
        if (raw != null && raw !== '') bad++;
        return;
      }
      valid++;
      cat.cells.set(series, (cat.cells.get(series) ?? 0) + value);
      totals.set(series, (totals.get(series) ?? 0) + Math.abs(value));
    };
    if (seriesKey) add(label(row[seriesKey]), row[yKeys[0]!]);
    else for (const key of yKeys) add(key, row[key]);
  });
  if (valid === 0) return `no numeric values in ${yKeys.map(key => `"${say(key, 40)}"`).join(', ')}`;

  const {keep, folded} = foldSeries(totals);
  const names = folded.size > 0 ? [...keep, OTHER] : keep;
  const seriesInfo = seriesKey ? fields.get(seriesKey) : undefined;
  const kind = slotKind(seriesInfo);
  const slotOf = assign(names, kind ? slots?.[kind] : undefined);
  const series: Series[] = names.map(name => ({name, slot: slotOf.get(name) ?? 0, info: seriesKey ? undefined : fields.get(name)}));

  let list: Category[] = [...cats].map(([name, cat]) => {
    const values: Array<number | undefined> = keep.map(key => cat.cells.get(key));
    if (folded.size > 0) {
      let rest: number | undefined;
      for (const key of folded) {
        const value = cat.cells.get(key);
        if (value !== undefined) rest = (rest ?? 0) + value;
      }
      values.push(rest);
    }
    return {label: name, entity: cat.entity, path: cat.entity?.type === 'file', values};
  });

  let foldedCats = 0;
  if (list.length > opts.limit) {
    const weight = (cat: Category) => cat.values.reduce<number>((sum, value) => sum + Math.abs(value ?? 0), 0);
    const ranked = list.map((cat, index) => ({index, weight: weight(cat)})).sort((a, b) => b.weight - a.weight || a.index - b.index);
    const kept = new Set(ranked.slice(0, opts.limit).map(entry => entry.index));
    const rest = list.filter((_, index) => !kept.has(index));
    foldedCats = rest.length;
    const sums = series.map((_, s) => {
      let sum: number | undefined;
      for (const cat of rest) if (cat.values[s] !== undefined) sum = (sum ?? 0) + cat.values[s]!;
      return sum;
    });
    list = [...list.filter((_, index) => kept.has(index)), {label: `${OTHER} (${fmtNum(rest.length)})`, path: false, values: sums}];
  }
  return {cats: list, series, valueInfo: fields.get(yKeys[0]!), bad, folded: foldedCats};
}

interface Bar {
  cat: number;
  series: number;
  x: number;
  y: number;
  w: number;
  h: number;
  end: 'left' | 'right' | 'top' | 'bottom';
  /** Only the outermost segment of a stack is rounded. */
  round: boolean;
  text?: {x: number; y: number; anchor: 'start' | 'end' | 'middle'; value: string};
}
interface Layout {
  horizontal: boolean;
  width: number;
  height: number;
  axis: ValueAxis;
  from: number;
  to: number;
  bars: Bar[];
  labels: Array<{cat: number; x: number; y: number; width: number; first: number}>;
  marks: Mark[];
}

/** Stack extents of one category: positives grow up from zero, negatives down. In `pct` each is a share of the total. */
function extents(cat: Category, mode: Mode): Array<[number, number] | undefined> {
  if (mode === 'grouped') return cat.values.map(value => (value === undefined ? undefined : [0, value]));
  const total = mode === 'pct' ? cat.values.reduce<number>((sum, value) => sum + Math.max(0, value ?? 0), 0) : 1;
  let up = 0;
  let down = 0;
  return cat.values.map(value => {
    if (value === undefined) return undefined;
    const v = mode === 'pct' ? (total > 0 ? (Math.max(0, value) / total) * 100 : 0) : value;
    if (v >= 0) {
      up += v;
      return [up - v, up];
    }
    down += v;
    return [down - v, down];
  });
}

/**
 * `boxHeight` is the height the chart has to fill (the measured box of a sized cell, else the family default);
 * `stretch` says the box is a sized cell, where horizontal bars may grow into height they would leave blank.
 */
function layoutBars(model: Model, mode: Mode, horizontal: boolean, width: number, boxHeight: number, stretch: boolean): Layout {
  const {cats, series} = model;
  const k = series.length;
  const grouped = mode === 'grouped' && k > 1;
  const stacks = cats.map(cat => extents(cat, mode));
  const ends: number[] = [];
  for (const stack of stacks) for (const extent of stack) if (extent) ends.push(extent[0], extent[1]);
  const fmt = (value: number | undefined, info?: FieldInfo) => (mode === 'pct' ? fmtNum(value, 'pct') : fmtValue(value, info ?? model.valueInfo));
  const totals = stacks.map(stack => {
    let up = 0;
    let down = 0;
    for (const extent of stack) if (extent) {
      up = Math.max(up, extent[0], extent[1]);
      down = Math.min(down, extent[0], extent[1]);
    }
    return {up, down};
  });
  const valueText = (c: number, s: number): string | undefined => {
    if (mode === 'pct') return undefined;
    if (grouped || k === 1) return fmt(cats[c]!.values[s], series[s]!.info);
    return undefined;
  };
  const hasNeg = ends.some(end => end < 0);
  const valueW = mode === 'pct' ? 0 : Math.min(96, widest(cats.flatMap((cat, c) => (grouped || k === 1 ? cat.values.map((_, s) => valueText(c, s) ?? '') : [fmt(totals[c]!.up)]))) + 10);
  const bars: Bar[] = [];
  const labels: Layout['labels'] = [];
  const marks: Mark[] = [];
  const title = (c: number) => cats[c]!.label;
  const push = (bar: Bar) => {
    const cat = cats[bar.cat]!;
    const s = series[bar.series]!;
    const value = fmt(cat.values[bar.series], s.info);
    const share = mode === 'pct' ? ` (${fmt(stacks[bar.cat]![bar.series]![1] - stacks[bar.cat]![bar.series]![0])})` : '';
    bars.push(bar);
    marks.push({
      x: bar.x, y: bar.y, w: Math.max(1, bar.w), h: Math.max(1, bar.h),
      title: title(bar.cat),
      rows: [{label: s.info?.label ?? s.name, value: mode === 'pct' ? fmtValue(cat.values[bar.series], s.info ?? model.valueInfo) + share : value, color: fillVar(s.slot)}],
      foot: mode === 'stacked' && k > 1 ? `total ${fmt(totals[bar.cat]!.up + totals[bar.cat]!.down)}` : undefined,
      entity: cat.entity,
      say: `${say(cat.label)}, ${k > 1 ? `${say(s.name, 40)} ` : ''}${value}`,
    });
  };

  if (horizontal) {
    const top = 4;
    const bottom = 34;
    // 14 px bars on a 20 px band; a sized cell with few bars gives them up to 1.7 times that before it stays blank
    const natural = grouped ? k * 10 + (k - 1) * 2 + 8 : 20;
    const grow = stretch ? Math.max(1, Math.min(1.7, (boxHeight - top - bottom) / (cats.length * natural))) : 1;
    const thick = Math.round((grouped ? 10 : 14) * Math.min(grow, 1.45));
    const band = Math.floor(natural * grow);
    const inset = Math.floor((band - (grouped ? k * thick + (k - 1) * 2 : thick)) / 2);
    const labelW = Math.max(24, Math.min(widest(cats.map(cat => cat.label)), width * 0.4, 260));
    const x0 = Math.min(width - 40, labelW + 10 + (hasNeg ? valueW : 0));
    const x1 = Math.max(x0 + 24, width - valueW - 2);
    const axis = linearAxis(mode === 'pct' ? [0, 100] : ends, [x0, x1], {count: Math.max(2, Math.min(5, Math.floor((x1 - x0) / 72))), whole: mode !== 'pct'});
    cats.forEach((_, c) => {
      const y0 = top + c * band + inset;
      labels.push({cat: c, x: labelW, y: top + c * band + band / 2, width: labelW, first: bars.length});
      const stack = stacks[c]!;
      const outer = stack.reduce((last, extent, s) => (extent && extent[0] !== extent[1] ? s : last), -1);
      stack.forEach((extent, s) => {
        if (!extent) return;
        const a = axis.scale(Math.min(extent[0], extent[1]));
        const b = axis.scale(Math.max(extent[0], extent[1]));
        const negative = extent[1] < extent[0];
        // a 2 px surface gap separates stacked fills; it comes off the side nearer the baseline
        const gap = !grouped && k > 1 && extent[0] !== 0 && b - a > 3 ? 2 : 0;
        const x = negative ? a : a + gap;
        const w = Math.max(0, b - a - gap);
        const y = grouped ? y0 + s * (thick + 2) : y0;
        const text = valueText(c, s);
        push({
          cat: c, series: s, x, y, w, h: thick, end: negative ? 'left' : 'right', round: grouped || s === outer,
          text: text === undefined ? undefined : {x: negative ? a - 6 : b + 6, y: y + thick / 2, anchor: negative ? 'end' : 'start', value: text},
        });
      });
      if (!grouped && k > 1 && mode === 'stacked') {
        const total = totals[c]!;
        if (stack.some(Boolean)) bars[bars.length - 1]!.text = {x: axis.scale(total.up) + 6, y: y0 + thick / 2, anchor: 'start', value: fmt(total.up + total.down)};
      }
      if (stack.every(extent => !extent)) labels[labels.length - 1]!.first = -1;
    });
    return {horizontal, width, height: top + cats.length * band + bottom, axis, from: top, to: top + cats.length * band, bars, labels, marks};
  }

  const height = boxHeight;
  const top = 24;
  const bottom = 24;
  const right = 8;
  const probe = linearAxis(mode === 'pct' ? [0, 100] : ends, [height - bottom, top], {count: Math.max(2, Math.min(5, Math.floor((height - top - bottom) / 44))), whole: mode !== 'pct'});
  const tickText = tickFormat(probe.ticks, mode === 'pct' ? 'pct' : formatOf(model.valueInfo));
  const left = Math.min(width * 0.3, widest(probe.ticks.map(tickText)) + 14);
  const band = Math.max(1, (width - left - right) / cats.length);
  const inner = Math.max(1, band - Math.min(6, band * 0.3));
  // a few bars on a wide plate are drawn wider, so they do not read as sticks
  const thick = grouped ? Math.max(1, Math.min(20, (inner - (k - 1) * 2) / k)) : Math.min(Math.max(28, Math.min(44, band * 0.22)), inner);
  const groupW = grouped ? k * thick + (k - 1) * 2 : thick;
  cats.forEach((_, c) => {
    const x0 = left + c * band + (band - groupW) / 2;
    labels.push({cat: c, x: left + c * band + band / 2, y: height - bottom + 16, width: band - 4, first: bars.length});
    const stack = stacks[c]!;
    const outer = stack.reduce((last, extent, s) => (extent && extent[0] !== extent[1] ? s : last), -1);
    stack.forEach((extent, s) => {
      if (!extent) return;
      const a = probe.scale(Math.max(extent[0], extent[1]));
      const b = probe.scale(Math.min(extent[0], extent[1]));
      const negative = extent[1] < extent[0];
      const gap = !grouped && k > 1 && extent[0] !== 0 && b - a > 3 ? 2 : 0;
      const x = grouped ? x0 + s * (thick + 2) : x0;
      const text = valueText(c, s);
      const fits = text !== undefined && textWidth(text) <= (grouped ? thick + 2 : band) - 2;
      push({
        cat: c, series: s, x, y: negative ? a + gap : a, w: thick, h: Math.max(0, b - a - gap), end: negative ? 'bottom' : 'top', round: grouped || s === outer,
        text: fits ? {x: x + thick / 2, y: negative ? b + 12 : a - 6, anchor: 'middle', value: text} : undefined,
      });
    });
    if (stack.every(extent => !extent)) labels[labels.length - 1]!.first = -1;
  });
  return {horizontal, width, height, axis: probe, from: left, to: width - right, bars, labels, marks};
}

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.BarChart>}): JSX.Element {
  const {id, rows, state, props} = p;
  const slots = useSlots();
  const assign = useSlotter();
  const limit = props.limit ?? 20;
  const model = useMemo(
    () => buildModel(rows, state.fields, state.roles, {x: props.x, y: props.y, series: props.series, limit}, slots, assign),
    [rows, state.fields, state.roles, props.x, props.y, props.series, limit, slots, assign],
  );
  if (typeof model === 'string') return <Empty message={`${model}${state.ds ? ` (${state.ds.source})` : ''}`} />;
  return <Bars id={id} model={model} skipped={p.skipped} props={props} />;
}

function Bars(p: {id: string; model: Model; skipped: number; props: C.ViewProps<typeof C.BarChart>}): JSX.Element {
  const {id, model, props} = p;
  const {boxRef, fill, width, height: boxHeight} = useChartBox(props.size);
  const mode: Mode = props.mode ?? 'grouped';
  const horizontal = props.dir ? props.dir === 'h' : model.cats.length > 8 || model.cats.some(cat => cat.label.length > 12);
  const layout = useMemo(
    () => (width <= 0 ? undefined : layoutBars(model, mode, horizontal, width, fill ? Math.max(120, boxHeight) : DEFAULT_HEIGHT, fill)),
    [model, mode, horizontal, width, fill, boxHeight],
  );
  const nav = useMarkNav({id, marks: layout?.marks ?? [], box: boxRef});
  const drawing = useDrawIn();

  const drawn = useMemo(() => {
    if (!layout) return null;
    const {series, cats} = model;
    return (
      <>
        {layout.bars.map((bar, i) => (
          <path
            key={i}
            className={`${css.bar} ${layout.horizontal ? kit.growX : kit.growY}`}
            d={barPath(bar.x, bar.y, bar.w, bar.h, bar.end, bar.round ? 2 : 0)}
            style={{fill: fillVar(series[bar.series]!.slot)}}
            data-i={i}
            data-entity={cats[bar.cat]!.entity ? '' : undefined}
            data-neg={bar.end === 'left' || bar.end === 'bottom' || undefined}
            data-dim={nav.picked && !nav.picked[i] ? '' : undefined}
          />
        ))}
        {layout.bars.map((bar, i) => (bar.text ? (
          <text key={i} className={`${kit.value} ${kit.fade}`} x={bar.text.x} y={bar.text.y} dy="0.32em" textAnchor={bar.text.anchor} data-dim={nav.picked && !nav.picked[i] ? '' : undefined}>
            {bar.text.value}
          </text>
        ) : null))}
      </>
    );
  }, [layout, model, nav.picked]);

  const {cats, series} = model;
  const largest = cats.reduce<{label: string; value: number} | undefined>((best, cat) => {
    const total = cat.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    return !best || total > best.value ? {label: cat.label, value: total} : best;
  }, undefined);
  const aria = `Bar chart, ${cats.length} ${cats.length === 1 ? 'bar' : 'bars'}${series.length > 1 ? `, ${series.length} series` : ''}${largest ? `, largest ${say(largest.label)} ${fmtValue(largest.value, model.valueInfo)}` : ''}`;
  const tick = layout ? tickFormat(layout.axis.ticks, mode === 'pct' ? 'pct' : formatOf(model.valueInfo)) : String;
  // several value fields share the axis: none of them names it
  const axisTitle = series.length === 1 ? (series[0]!.info?.label ?? model.valueInfo?.label) : series[0]!.info ? undefined : model.valueInfo?.label;

  return (
    <>
      <Note>{notes(p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.bad > 0 && `${count(model.bad, 'value')} not numeric`, model.folded > 0 && `${fmtNum(model.folded)} folded into other`)}</Note>
      <Figure
        name="BarChart"
        label={aria}
        nav={nav}
        boxRef={boxRef}
        fill={fill}
        width={layout?.width ?? 0}
        height={layout ? (fill ? Math.max(layout.height, layout.horizontal ? boxHeight : 0) : layout.height) : fill ? 0 : DEFAULT_HEIGHT}
        drawing={drawing}
        header={series.length > 1 ? <Legend items={series.map(s => ({key: s.name, label: s.info?.label ?? s.name, color: fillVar(s.slot)}))} /> : undefined}
      >
        {layout ? (
          <>
            <ValueGrid axis={layout.axis} dir={layout.horizontal ? 'x' : 'y'} from={layout.from} to={layout.to} fmt={tick} title={mode === 'pct' ? undefined : axisTitle ? say(axisTitle, 32) : undefined} />
            {drawn}
            {layout.labels.map(lab => {
              const cat = cats[lab.cat]!;
              // a file keeps its name and the nearest directories; any other name with slashes keeps its last segment
              const parts = cat.path ? clipPath(cat.label, lab.width) : clipName(cat.label, lab.width);
              const dim = lab.first >= 0 && nav.picked && !nav.picked[lab.first];
              return (
                <text
                  key={lab.cat}
                  x={lab.x}
                  y={lab.y}
                  dy={layout.horizontal ? '0.32em' : undefined}
                  textAnchor={layout.horizontal ? 'end' : 'middle'}
                  data-i={lab.first >= 0 ? lab.first : undefined}
                  data-entity={cat.entity && lab.first >= 0 ? '' : undefined}
                  data-dim={dim ? '' : undefined}
                  data-bar-label=""
                >
                  {parts.dir ? <tspan className={kit.labelDim}>{parts.dir}</tspan> : null}
                  <tspan className={kit.label}>{parts.base}</tspan>
                </text>
              );
            })}
          </>
        ) : null}
      </Figure>
    </>
  );
}

export const BarChartView: GlView<typeof C.BarChart> = ({id, props}) => (
  <RowsGate name="BarChart" id={id} input={props.data} size={props.size}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
