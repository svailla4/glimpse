// The sparkline mark (design 5.3 Sparkline): a 1.25 px line in cat-1 with a 3 px end dot on a surface ring, no axes.
// Pure SVG at a given pixel size; Stat cells use it at 72 x 20 and the Sparkline view at its measured width.
import {useMemo, useState, type JSX, type PointerEvent} from 'react';
import {fmtNum, toNumber, useTooltip} from '../../../kit/index.ts';
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

/** The point of `values` nearest to a horizontal position (0..1 across the plot); undefined when no point has a value. */
export function nearestPoint(values: Array<number | undefined>, at: number): number | undefined {
  if (values.length === 0) return undefined;
  const target = Math.round(Math.min(1, Math.max(0, at)) * (values.length - 1));
  for (let step = 0; step < values.length; step++) {
    if (values[target - step] !== undefined) return target - step;
    if (values[target + step] !== undefined) return target + step;
  }
  return undefined;
}

/**
 * `name` and `unit` say what the numbers are in the tooltip ('Commits · 41 · point 12 of 30'). The tooltip follows the
 * pointer and reads the nearest point; a hairline marks which one.
 */
export function Spark(p: {values: Array<number | undefined>; kind?: SparkKind; width?: number; height?: number; label?: string; name?: string; unit?: string}): JSX.Element {
  const {values, kind = 'line', width = 72, height = 20} = p;
  const shape = useMemo(() => layout(values, kind, width, height), [values, kind, width, height]);
  const label = p.label ?? `Sparkline, ${describeSpark(values)}`;
  const tooltip = useTooltip();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const inner = Math.max(1, width - PAD_X * 2);
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    // The box is `width` wide in CSS pixels unless a parent scales it.
    const scale = box.width > 0 ? width / box.width : 1;
    const index = nearestPoint(values, ((event.clientX - box.left) * scale - PAD_X) / inner);
    if (index === undefined) return;
    setHover(index);
    tooltip.show(
      <span className={styles.tip}>
        {p.name ? <span className={styles.tipName}>{p.name}</span> : null}
        <span className={styles.tipValue}>{fmtNum(values[index])}{p.unit ? ` ${p.unit}` : ''}</span>
        <span className={styles.tipAt}>point {fmtNum(index + 1)} of {fmtNum(values.length)}</span>
      </span>,
      event.clientX,
      event.clientY,
    );
  };
  const onLeave = () => {
    setHover(undefined);
    tooltip.hide();
  };
  const hoverX = hover === undefined ? undefined : round(values.length === 1 ? PAD_X + inner : PAD_X + (hover / (values.length - 1)) * inner);
  return (
    <svg
      className={styles.spark}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      data-kind={kind}
      data-gl-spark=""
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      {shape.area ? <path className={styles.area} d={shape.area} /> : null}
      {shape.bars.map(bar => <rect key={bar.x} className={styles.bar} x={bar.x} y={bar.y} width={bar.w} height={bar.h} />)}
      {shape.line ? <path className={styles.line} d={shape.line} pathLength={1} /> : null}
      {shape.end ? <circle className={styles.dot} cx={shape.end.x} cy={shape.end.y} r={1.5} /> : null}
      {hoverX !== undefined ? <line className={styles.cursor} x1={hoverX} x2={hoverX} y1={0} y2={height} data-gl-spark-cursor="" /> : null}
    </svg>
  );
}
