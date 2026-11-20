// CalendarHeatmap: daily activity as week columns of day cells, five steps with zero in the grid ink. When the
// range does not fit, the oldest weeks are dropped rather than shrinking the cells below 9 px.
import type {Field, Roles, Rows} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {quantileSorted} from 'd3-array';
import {useMemo, type JSX} from 'react';
import {Empty, fmtNum, seqVar, type DataState, type GlView} from '../../kit/index.ts';
import css from './CalendarHeatmap.module.css';
import {
  Figure, Legend, Note, Ramp, RowsGate, count, fmtDay, fmtValue, inspect, kit, notes, num, pick, roleY, say, textWidth, time, useChartBox,
  useDrawIn, useMarkNav, type ArrowKey, type FieldInfo, type Mark,
} from './chartkit/index.ts';

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STEPS = ['var(--gl-grid)', seqVar(2), seqVar(4), seqVar(6), seqVar(7)];
/** 1 January 1970 was a Thursday. */
const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;

interface Model {
  /** Value per day number (days since the epoch, UTC). */
  days: Map<number, number>;
  first: number;
  last: number;
  cuts: number[];
  max: number;
  total: number;
  active: number;
  busiest: number;
  info?: FieldInfo;
  bad: number;
}

function buildModel(rows: Rows, fieldList: Field[] | undefined, roles: Roles | undefined, opts: {date?: string; value?: string}): Model | string {
  const fields = inspect(rows, fieldList);
  const dateKey = pick(opts.date, roles?.date, fields.first('date')?.key, roles?.x);
  if (!dateKey) return 'no date field to place days by';
  const valueKey = pick(opts.value, roles?.value, roleY(roles)[0], fields.first('num', [dateKey])?.key);
  const days = new Map<number, number>();
  let bad = 0;
  for (const row of rows) {
    const at = time(row[dateKey], true);
    // without a value field every row counts once, so a list of commits becomes commits per day
    const value = valueKey ? num(row[valueKey]) : 1;
    if (at === undefined || value === undefined) {
      bad++;
      continue;
    }
    const day = Math.floor(at / DAY);
    days.set(day, (days.get(day) ?? 0) + value);
  }
  if (days.size === 0) return `no dated values in "${say(dateKey, 40)}"`;
  let first = Infinity;
  let last = -Infinity;
  let max = 0;
  let total = 0;
  let busiest = 0;
  const positive: number[] = [];
  for (const [day, value] of days) {
    first = Math.min(first, day);
    last = Math.max(last, day);
    total += value;
    if (value > 0) positive.push(value);
    if (value > max) {
      max = value;
      busiest = day;
    }
  }
  positive.sort((a, b) => a - b);
  const cuts = positive.length > 0 ? [0.25, 0.5, 0.75].map(q => quantileSorted(positive, q)!) : [];
  return {days, first, last, cuts, max, total, active: positive.length, busiest: max > 0 ? busiest : first, info: valueKey ? fields.get(valueKey) : undefined, bad};
}

/** 0 for nothing, 1..4 by quartile of the active days; the busiest day is always the top step. */
function stepOf(value: number, model: Model): number {
  if (!(value > 0)) return 0;
  if (value >= model.max) return 4;
  let step = 1;
  for (const cut of model.cuts) if (value > cut) step++;
  return step;
}

interface Cell {
  day: number;
  x: number;
  y: number;
  step: number;
}
interface Layout {
  width: number;
  height: number;
  size: number;
  left: number;
  top: number;
  cells: Cell[];
  months: Array<{x: number; label: string}>;
  dropped: number;
  marks: Mark[];
}

function layoutDays(model: Model, width: number): Layout {
  const left = 22;
  const top = 18;
  const start = model.first - weekday(model.first);
  const end = model.last + (6 - weekday(model.last));
  const weeks = (end - start + 1) / 7;
  const room = Math.max(11, width - left);
  const pitch = Math.max(11, Math.min(13, Math.floor(room / weeks)));
  const shown = Math.max(1, Math.min(weeks, Math.floor(room / pitch)));
  const dropped = weeks - shown;
  const from = Math.max(model.first, start + dropped * 7);
  const origin = start + dropped * 7;
  const unit = model.info?.label ?? 'rows';

  const cells: Cell[] = [];
  const marks: Mark[] = [];
  for (let day = from; day <= model.last; day++) {
    const value = model.days.get(day) ?? 0;
    const x = left + Math.floor((day - origin) / 7) * pitch;
    const y = top + weekday(day) * pitch;
    cells.push({day, x, y, step: stepOf(value, model)});
    const date = fmtDay(day * DAY);
    const text = fmtValue(value, model.info);
    marks.push({
      x, y, w: pitch - 2, h: pitch - 2,
      title: `${WEEKDAYS[weekday(day)]!.slice(0, 3)} ${date}`,
      rows: [{label: unit, value: text}],
      say: `${WEEKDAYS[weekday(day)]} ${date}, ${text} ${say(unit, 24)}`,
    });
  }
  const months: Layout['months'] = [];
  let lastMonth = -1;
  let lastX = -Infinity;
  for (let week = 0; week < shown; week++) {
    const date = new Date(Math.max(from, origin + week * 7) * DAY);
    const month = date.getUTCMonth();
    if (month === lastMonth) continue;
    lastMonth = month;
    const x = left + week * pitch;
    // January carries the year instead of its name, so the label stays as short as the others
    const text = month === 0 ? String(date.getUTCFullYear()) : MONTHS[month]!;
    // a label that would run into the one before it is left out (a first week that ends a month)
    if (x < lastX + 8) continue;
    lastX = x + textWidth(text);
    months.push({x, label: text});
  }
  return {width, height: top + 7 * pitch, size: pitch - 2, left, top, cells, months, dropped, marks};
}

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.CalendarHeatmap>}): JSX.Element {
  const {id, rows, state, props} = p;
  const model = useMemo(() => buildModel(rows, state.fields, state.roles, {date: props.date, value: props.value}), [rows, state.fields, state.roles, props.date, props.value]);
  if (typeof model === 'string') return <Empty message={`${model}${state.ds ? ` (${state.ds.source})` : ''}`} />;
  return <Days id={id} model={model} skipped={p.skipped} props={props} />;
}

function Days(p: {id: string; model: Model; skipped: number; props: C.ViewProps<typeof C.CalendarHeatmap>}): JSX.Element {
  const {id, model, props} = p;
  const {boxRef, fill, width} = useChartBox(props.size);
  const layout = useMemo(() => (width <= 0 ? undefined : layoutDays(model, width)), [model, width]);
  const nav = useMarkNav({
    id,
    marks: layout?.marks ?? [],
    selectable: false,
    move: (from: number, key: ArrowKey) => {
      const count = layout?.marks.length ?? 0;
      const next = from + (key === 'ArrowLeft' ? -7 : key === 'ArrowRight' ? 7 : key === 'ArrowUp' ? -1 : 1);
      return next < 0 || next >= count ? from : next;
    },
  });
  const drawing = useDrawIn();
  const cells = useMemo(() => layout?.cells.map((cell, i) => (
    <rect key={cell.day} className={css.day} x={cell.x} y={cell.y} width={layout.size} height={layout.size} style={{fill: STEPS[cell.step]}} data-i={i} data-step={cell.step} />
  )), [layout]);

  const unit = model.info?.label ?? 'rows';
  const span = model.last - model.first + 1;
  const aria = `Calendar heatmap, ${fmtNum(model.active)} active ${model.active === 1 ? 'day' : 'days'} of ${fmtNum(span)} from ${fmtDay(model.first * DAY)} to ${fmtDay(model.last * DAY)}, ${fmtValue(model.total, model.info)} ${say(unit, 24)}, busiest ${fmtDay(model.busiest * DAY)} with ${fmtValue(model.max, model.info)}`;

  return (
    <>
      <Note>{notes(p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.bad > 0 && `${count(model.bad, 'row')} without a date or value`, layout && layout.dropped > 0 && `${count(layout.dropped, 'earlier week')} not shown`)}</Note>
      <Figure
        name="CalendarHeatmap"
        label={aria}
        nav={nav}
        boxRef={boxRef}
        fill={fill}
        width={layout?.width ?? 0}
        height={layout?.height ?? 109}
        drawing={drawing}
        compact
        footer={(
          <Legend
            items={[]}
            end={<Ramp steps={STEPS} low="0" high={fmtValue(model.max, model.info)} />}
          />
        )}
      >
        {layout ? (
          <>
            {layout.months.map(month => <text key={month.x} className={kit.tag} x={month.x} y={layout.top - 7}>{month.label}</text>)}
            {[1, 3, 5].map(day => <text key={day} className={kit.tag} x={0} y={layout.top + day * (layout.size + 2) + layout.size / 2} dy="0.32em">{WEEKDAYS[day]!.charAt(0)}</text>)}
            <g className={kit.fade}>{cells}</g>
          </>
        ) : null}
      </Figure>
    </>
  );
}

export const CalendarHeatmapView: GlView<typeof C.CalendarHeatmap> = ({id, props}) => (
  <RowsGate name="CalendarHeatmap" id={id} input={props.data}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
