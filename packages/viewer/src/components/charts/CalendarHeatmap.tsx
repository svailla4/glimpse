// CalendarHeatmap: daily activity as week columns of day cells, five steps with zero in the grid ink. Cells grow
// from 9 to 24 px with the width; when the range does not fit, the oldest weeks are dropped rather than shrinking
// the cells further. A short history is drawn on at least a quarter of calendar, and on as much of the year before
// it as the plate has room for, the days before it as outlines. The key names the period the totals cover.
import type {Field, Roles, Rows} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {quantileSorted} from 'd3-array';
import {useMemo, type JSX} from 'react';
import {fmtNum, seqVar, type DataState, type GlView} from '../../kit/index.ts';
import css from './CalendarHeatmap.module.css';
import {
  Figure, Legend, MissReport, Note, Ramp, RowsGate, Unable, checkField, count, fmtDay, fmtValue, inspect, kit, missNote, notes, num, pick, roleY, say,
  textWidth, time, unfit, useChartBox, useDrawIn, useMarkNav, type ArrowKey, type FieldInfo, type FieldMiss, type FieldSet, type Mark, type Unfit,
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
  /** Field names of the spec that the data does not have (drawn with the defaults instead). */
  misses: FieldMiss[];
  fields: FieldSet;
}

function buildModel(rows: Rows, fieldList: Field[] | undefined, roles: Roles | undefined, opts: {date?: string; value?: string; source?: string}): Model | Unfit {
  const fields = inspect(rows, fieldList);
  const misses: FieldMiss[] = [];
  const dateWanted = checkField(fields, 'date', opts.date, misses);
  const valueWanted = checkField(fields, 'value', opts.value, misses);
  const dateKey = pick(dateWanted, roles?.date, fields.first('date')?.key, roles?.x);
  if (!dateKey) return unfit('no date field to place days by', misses, fields, opts.source);
  const valueKey = pick(valueWanted, roles?.value, roleY(roles)[0], fields.first('num', [dateKey])?.key);
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
  if (days.size === 0) return unfit(`no dated values in "${say(dateKey, 40)}"`, misses, fields, opts.source);
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
  return {days, first, last, cuts, max, total, active: positive.length, busiest: max > 0 ? busiest : first, info: valueKey ? fields.get(valueKey) : undefined, bad, misses, fields};
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
  /** Right edge of the last week column: the legend ends there. */
  gridRight: number;
  cells: Cell[];
  /** Outline of the days before the data starts, when the calendar is padded to its minimum width. */
  before: string;
  months: Array<{x: number; label: string}>;
  dropped: number;
  marks: Mark[];
}

/** A history shorter than this is still drawn as a calendar of this many weeks, not as a lone square. */
const MIN_WEEKS = 13;
/** Pitch (cell and gap) bounds: cells from 9 to 24 px. */
const MIN_PITCH = 11;
const MAX_PITCH = 26;
/**
 * A plate too wide for the history at the largest cells shows more of the year before it at this pitch, up to a
 * year, instead of leaving half the plate blank.
 */
const FILL_PITCH = 20;
const YEAR_WEEKS = 53;

/** The months the data spans, for the key: 'Nov 2026', 'Mar – Nov 2026', 'Nov 2025 – Nov 2026'. */
export function periodText(first: number, last: number): string {
  const a = new Date(first * DAY);
  const b = new Date(last * DAY);
  const from = MONTHS[a.getUTCMonth()]!;
  const to = `${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${from} ${a.getUTCFullYear()} – ${to}`;
  return a.getUTCMonth() === b.getUTCMonth() ? to : `${from} – ${to}`;
}

function layoutDays(model: Model, width: number): Layout {
  const left = 22;
  const top = 18;
  const end = model.last + (6 - weekday(model.last));
  const dataWeeks = (end - (model.first - weekday(model.first)) + 1) / 7;
  const room = Math.max(MIN_PITCH, width - left);
  let weeks = Math.max(dataWeeks, MIN_WEEKS);
  if (room / weeks > MAX_PITCH) weeks = Math.max(weeks, Math.min(YEAR_WEEKS, Math.floor(room / FILL_PITCH)));
  const start = end - weeks * 7 + 1;
  // cells grow with the plate, up to 24 px, so a year fills a wide plate instead of its left half
  const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.floor(room / weeks)));
  const shown = Math.max(1, Math.min(weeks, Math.floor(room / pitch)));
  const dropped = Math.max(0, dataWeeks - shown);
  const origin = start + (weeks - shown) * 7;
  const from = Math.max(model.first, origin);
  const unit = model.info?.label ?? 'rows';
  let before = '';
  for (let day = origin; day < from; day++) {
    before += `M${left + Math.floor((day - origin) / 7) * pitch + 0.5},${top + weekday(day) * pitch + 0.5}h${pitch - 3}v${pitch - 3}h${-(pitch - 3)}z`;
  }

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
    const date = new Date(Math.max(before ? origin : from, origin + week * 7) * DAY);
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
  return {width, height: top + 7 * pitch, size: pitch - 2, left, top, gridRight: left + shown * pitch - 2, cells, before, months, dropped, marks};
}

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.CalendarHeatmap>}): JSX.Element {
  const {id, rows, state, props} = p;
  const source = state.ds?.source;
  const model = useMemo(
    () => buildModel(rows, state.fields, state.roles, {date: props.date, value: props.value, source}),
    [rows, state.fields, state.roles, props.date, props.value, source],
  );
  if ('code' in model) return <Unable code={model.code} message={model.message} />;
  return (
    <>
      <MissReport misses={model.misses} fields={model.fields} source={source} />
      <Days id={id} model={model} skipped={p.skipped} props={props} />
    </>
  );
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
      <Note>{notes(missNote(model.misses), p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.bad > 0 && `${count(model.bad, 'row')} without a date or value`, layout && layout.dropped > 0 && `${count(layout.dropped, 'earlier week')} not shown`)}</Note>
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
          // the key stays with the grid: it ends under the last week, with the totals at its left
          <div style={layout ? {maxWidth: Math.max(340, layout.gridRight)} : undefined} data-chart-key="">
            <Legend
              items={[]}
              start={`${fmtValue(model.total, model.info)} ${say(unit, 24)} · ${fmtNum(model.active)} active ${model.active === 1 ? 'day' : 'days'} · ${periodText(model.first, model.last)}`}
              end={<Ramp steps={STEPS} low="0" high={fmtValue(model.max, model.info)} />}
            />
          </div>
        )}
      >
        {layout ? (
          <>
            {layout.months.map(month => <text key={month.x} className={kit.tag} x={month.x} y={layout.top - 7}>{month.label}</text>)}
            {[1, 3, 5].map(day => <text key={day} className={kit.tag} x={0} y={layout.top + day * (layout.size + 2) + layout.size / 2} dy="0.32em">{WEEKDAYS[day]!.charAt(0)}</text>)}
            {layout.before ? <path className={css.before} d={layout.before} data-before="" /> : null}
            <g className={kit.fade}>{cells}</g>
          </>
        ) : null}
      </Figure>
    </>
  );
}

export const CalendarHeatmapView: GlView<typeof C.CalendarHeatmap> = ({id, props}) => (
  <RowsGate name="CalendarHeatmap" id={id} input={props.data} size={props.size} height={182}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
