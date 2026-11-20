// One KPI (design 5.3 Stat): mono label, hero numeral in Newsreader with tabular figures, unit, 72 x 20 sparkline and
// a signed delta with a triangle glyph. Stat renders one; Stats renders a hairline-separated strip of them.
import type {Format} from '@glimpse/catalog';
import {useMemo, type JSX} from 'react';
import {DASH, fmtNum, toNumber} from '../../../kit/index.ts';
import {cellText, toneMark} from './data.ts';
import {Spark, sparkValues} from './Spark.tsx';
import styles from './StatCell.module.css';

export interface StatCellProps {
  value: unknown;
  label?: string;
  unit?: string;
  delta?: unknown;
  spark?: unknown;
  format?: Format;
  tone?: unknown;
}

const FORMATS: ReadonlySet<string> = new Set(['num', 'compact', 'bytes', 'pct', 'duration']);
export const asFormat = (value: unknown): Format | undefined => (typeof value === 'string' && FORMATS.has(value) ? (value as Format) : undefined);

interface Shown { main: string; suffix: string; numeral: boolean }

/** '4.2k' -> numeral '4.2' + suffix 'k'; '131 kB' -> '131' + 'kB'; a word stays whole. */
function split(text: string): Shown {
  const match = /^([−-]?[\d.,]+)\s*(\D.*)?$/.exec(text);
  return match ? {main: match[1]!, suffix: match[2] ?? '', numeral: true} : {main: text, suffix: '', numeral: false};
}

/**
 * Numbers are formatted (compact unless told otherwise). A numeric string is reformatted only when a format is given:
 * '8080' or '2026' written as text is an identifier, not a quantity. Missing values are a dash.
 */
export function showValue(value: unknown, format: Format | undefined): Shown {
  if (typeof value === 'number') return Number.isFinite(value) ? split(fmtNum(value, format ?? 'compact')) : {main: DASH, suffix: '', numeral: true};
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return {main: DASH, suffix: '', numeral: true};
    if (format && toNumber(text) !== undefined) return split(fmtNum(text, format));
    return {main: text, suffix: '', numeral: /^[−+-]?[\d.,]+%?$/.test(text)};
  }
  if (value === null || value === undefined) return {main: DASH, suffix: '', numeral: true};
  if (typeof value === 'boolean') return {main: value ? 'yes' : 'no', suffix: '', numeral: false};
  return {main: cellText(value, 40), suffix: '', numeral: false};
}

function Delta(p: {value: number; format: Format | undefined}): JSX.Element {
  const {value} = p;
  const format: Format = p.format === 'bytes' || p.format === 'pct' || p.format === 'duration' ? p.format : 'compact';
  const size = fmtNum(Math.abs(value), format);
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return (
    <span className={styles.delta} data-direction={direction}>
      <svg className={styles.glyph} width="7" height="7" viewBox="0 0 7 7" aria-hidden="true">
        {direction === 'up' ? <path d="M3.5 0.5L6.5 6H0.5Z" /> : direction === 'down' ? <path d="M3.5 6.5L0.5 1H6.5Z" /> : <path d="M0.5 3.5H6.5" className={styles.flat} />}
      </svg>
      <span aria-hidden="true">{sign}{size}</span>
      <span className={styles.spoken}>{direction === 'flat' ? 'no change' : `${direction} ${size}`}</span>
    </span>
  );
}

export function StatCell(p: StatCellProps): JSX.Element {
  const shown = showValue(p.value, p.format);
  const unit = [shown.suffix, p.unit].filter(Boolean).join(' ');
  const delta = toNumber(p.delta);
  const series = useMemo(() => sparkValues(p.spark), [p.spark]);
  const hasSpark = series.filter(v => v !== undefined).length >= 2;
  const tone = toneMark(p.tone);
  return (
    <div className={styles.stat} data-gl-stat="">
      {p.label || tone ? (
        <div className={styles.label}>
          {tone ? <span className={styles.tone} style={{background: tone.color}} role="img" aria-label={tone.word} title={tone.word} /> : null}
          {p.label}
        </div>
      ) : null}
      <div className={styles.value} title={shown.numeral ? undefined : shown.main}>
        <span className={shown.numeral ? styles.numeral : styles.word} data-gl-stat-value="">{shown.main}</span>
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </div>
      {hasSpark || delta !== undefined ? (
        <div className={styles.foot}>
          {hasSpark ? <Spark values={series} label={`Trend${p.label ? ` of ${p.label}` : ''}`} /> : null}
          {delta !== undefined ? <Delta value={delta} format={p.format} /> : null}
        </div>
      ) : null}
    </div>
  );
}
