// Scales and ticks shared by the charts: nice linear and log value axes, time axes, and the bar outline.
import {scaleLinear, scaleLog, scaleUtc, type ScaleContinuousNumeric} from 'd3-scale';

export type ValueScale = ScaleContinuousNumeric<number, number>;
export interface ValueAxis {
  scale: ValueScale;
  ticks: number[];
  /** True when the axis could not be log although it was asked to (no positive values). */
  log: boolean;
}

/**
 * A linear value axis with about `count` nice ticks. With `zero` the domain always includes the zero baseline.
 * A flat domain (one datum, all zeros) is widened so the scale never divides by zero.
 */
export function linearAxis(values: Iterable<number>, range: [number, number], opts: {zero?: boolean; count?: number} = {}): ValueAxis {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (lo > hi) {
    lo = 0;
    hi = 1;
  }
  if (opts.zero !== false) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    lo = opts.zero !== false && lo >= 0 ? lo : lo - pad;
    hi += pad;
  }
  const count = opts.count ?? 5;
  const scale = scaleLinear().domain([lo, hi]).nice(count).range(range);
  return {scale, ticks: scale.ticks(count), log: false};
}

/** A log axis over the positive values; falls back to linear when there are none. */
export function logAxis(values: Iterable<number>, range: [number, number], count = 5): ValueAxis {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value <= 0) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (lo > hi) return linearAxis([], range, {count});
  if (lo === hi) {
    lo /= 2;
    hi *= 2;
  }
  const scale = scaleLog().domain([lo, hi]).nice().range(range).clamp(true);
  let ticks = scale.ticks(count);
  if (ticks.length > count + 2) {
    const decades = ticks.filter(tick => Number.isInteger(Math.round(Math.log10(tick) * 1e9) / 1e9));
    if (decades.length >= 2) ticks = decades;
  }
  return {scale, ticks, log: true};
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** '12 Nov 2026' (UTC). */
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** '12 Nov' (UTC): a tick on a date axis that stays within a year. */
export function fmtShortDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export interface TimeAxis {
  scale: (ms: number) => number;
  ticks: Array<{value: number; label: string}>;
}

/** A UTC time axis whose ticks adapt to the span: hours, days, weeks, months or years. */
export function timeAxis(domain: [number, number], range: [number, number], count: number): TimeAxis {
  let [lo, hi] = domain;
  if (lo === hi) {
    lo -= DAY / 2;
    hi += DAY / 2;
  }
  const scale = scaleUtc().domain([lo, hi]).range(range);
  const dates = scale.ticks(Math.max(2, count)).map(date => date.getTime());
  const step = dates.length > 1 ? dates[1]! - dates[0]! : hi - lo;
  let lastYear: number | undefined;
  const ticks = dates.map(value => {
    const d = new Date(value);
    const year = d.getUTCFullYear();
    let text: string;
    if (step >= 360 * DAY) text = String(year);
    else if (step >= 27 * DAY) text = lastYear === year ? MONTHS[d.getUTCMonth()]! : `${MONTHS[d.getUTCMonth()]} ${year}`;
    else if (step >= DAY) text = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    else text = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    lastYear = year;
    return {value, label: text};
  });
  return {scale: ms => scale(ms), ticks};
}

/**
 * Outline of a bar that is square at the baseline and rounded at the data end. `end` names the side the data end
 * is on. Sizes below one pixel still draw, so a zero keeps a hairline stub.
 */
export function barPath(x: number, y: number, w: number, h: number, end: 'left' | 'right' | 'top' | 'bottom', radius = 2): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2, end === 'left' || end === 'right' ? w : h));
  const x1 = x + w;
  const y1 = y + h;
  switch (end) {
    case 'right': return `M${x},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y1 - r}Q${x1},${y1} ${x1 - r},${y1}H${x}Z`;
    case 'left': return `M${x1},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x1}Z`;
    case 'top': return `M${x},${y1}V${y + r}Q${x},${y} ${x + r},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y1}Z`;
    default: return `M${x},${y}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x1 - r}Q${x1},${y1} ${x1},${y1 - r}V${y}Z`;
  }
}
