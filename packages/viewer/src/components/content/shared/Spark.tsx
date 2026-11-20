// The sparkline mark (design 5.3 Sparkline): a 1.25 px line in cat-1 with a 3 px end dot on a surface ring, no axes.
// Pure SVG at a given pixel size; Stat cells use it at 72 x 20 and the Sparkline view at its measured width.
import {useMemo, type JSX} from 'react';
import {fmtNum, toNumber} from '../../../kit/index.ts';
import styles from './Spark.module.css';

export type SparkKind = 'line' | 'bar' | 'area';

/** Numbers and numeric strings in order; everything else is a gap. */
export function sparkValues(input: unknown): Array<number | undefined> {
  return Array.isArray(input) ? input.map(toNumber) : [];
}

/** At most 2 * buckets points: each bucket keeps its minimum and maximum in order of occurrence, so spikes survive. */
function downsample(values: Array<number | undefined>, buckets: number): Array<number | undefined> {
  if (values.length <= buckets * 2) return values;
  const out: Array<number | undefined> = [];
  const size = values.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let lo: number | undefined;
    let hi: number | undefined;
    let loAt = -1;
    let hiAt = -1;
    const end = Math.min(values.length, Math.floor((b + 1) * size));
    for (let i = Math.floor(b * size); i < end; i++) {
      const v = values[i];
      if (v === undefined) continue;
      if (lo === undefined || v < lo) { lo = v; loAt = i; }
      if (hi === undefined || v > hi) { hi = v; hiAt = i; }
    }
    if (lo === undefined || hi === undefined) out.push(undefined);
    else if (loAt === hiAt) out.push(lo);
    else if (loAt < hiAt) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}

interface Geometry {
  line: string;
  area: string;
  bars: Array<{x: number; y: number; w: number; h: number}>;
  end?: {x: number; y: number};
}

const PAD_X = 3;
const PAD_Y = 3;
const round = (n: number) => Math.round(n * 100) / 100;

function layout(values: Array<number | undefined>, kind: SparkKind, width: number, height: number): Geometry {
  const points = downsample(values, Math.max(8, Math.floor(width)));
  const defined = points.filter((v): v is number => v !== undefined);
  const empty: Geometry = {line: '', area: '', bars: []};
  if (defined.length === 0 || width <= PAD_X * 2 || height <= PAD_Y * 2) return empty;
  let lo = defined[0]!;
  let hi = defined[0]!;
  for (const v of defined) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Bars and areas are read against zero; a line shows its own range.
  if (kind !== 'line') {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const innerW = width - PAD_X * 2;
  const innerH = height - PAD_Y * 2;
  const y = (v: number) => (hi === lo ? PAD_Y + innerH / 2 : PAD_Y + innerH - ((v - lo) / (hi - lo)) * innerH);

  if (kind === 'bar') {
    const step = innerW / points.length;
    const w = Math.max(1, step - 1);
    const zero = y(0);
    const bars = points.flatMap((v, i) => {
      if (v === undefined) return [];
      const top = Math.min(y(v), zero);
      return [{x: round(PAD_X + i * step), y: round(top), w: round(w), h: round(Math.max(1, Math.abs(y(v) - zero)))}];
    });
    return {line: '', area: '', bars};
  }

  const x = (i: number) => (points.length === 1 ? PAD_X + innerW : PAD_X + (i / (points.length - 1)) * innerW);
  const base = round(y(Math.max(lo, Math.min(hi, 0))));
  let line = '';
  let area = '';
  let runStart = -1;
  let end: Geometry['end'];
  const closeRun = (lastIndex: number) => {
    if (runStart >= 0) area += `L${round(x(lastIndex))} ${base}L${round(x(runStart))} ${base}Z`;
    runStart = -1;
  };
  points.forEach((v, i) => {
    if (v === undefined) {
      closeRun(i - 1);
      return;
    }
    const at = `${round(x(i))} ${round(y(v))}`;
    line += `${runStart < 0 ? 'M' : 'L'}${at}`;
    area += `${runStart < 0 ? 'M' : 'L'}${at}`;
    if (runStart < 0) runStart = i;
    end = {x: round(x(i)), y: round(y(v))};
  });
  closeRun(points.length - 1);
  return {line, area: kind === 'area' ? area : '', bars: [], end};
}

/** "6 points, 3 to 12, last 7": the part of an aria-label that describes the series. */
export function describeSpark(values: Array<number | undefined>): string {
  const defined = values.filter((v): v is number => v !== undefined);
  if (defined.length === 0) return 'no values';
  let lo = defined[0]!;
  let hi = defined[0]!;
  for (const v of defined) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return `${fmtNum(defined.length)} ${defined.length === 1 ? 'point' : 'points'}, ${fmtNum(lo, 'compact')} to ${fmtNum(hi, 'compact')}, last ${fmtNum(defined.at(-1), 'compact')}`;
}

export function Spark(p: {values: Array<number | undefined>; kind?: SparkKind; width?: number; height?: number; label?: string}): JSX.Element {
  const {values, kind = 'line', width = 72, height = 20} = p;
  const shape = useMemo(() => layout(values, kind, width, height), [values, kind, width, height]);
  const label = p.label ?? `Sparkline, ${describeSpark(values)}`;
  return (
    <svg className={styles.spark} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} data-kind={kind}>
      {shape.area ? <path className={styles.area} d={shape.area} /> : null}
      {shape.bars.map(bar => <rect key={bar.x} className={styles.bar} x={bar.x} y={bar.y} width={bar.w} height={bar.h} />)}
      {shape.line ? <path className={styles.line} d={shape.line} pathLength={1} /> : null}
      {shape.end ? <circle className={styles.dot} cx={shape.end.x} cy={shape.end.y} r={1.5} /> : null}
    </svg>
  );
}
