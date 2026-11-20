// packages/viewer/src/kit/format.ts  (first version by WP0; owned by WP4; exported signatures are frozen)
// Number, date and cell formatting. Everything returns plain text; '—' stands for "no value".
import type {Field, Format} from '@glimpse/catalog';

export const DASH = '—';
const MINUS = '−';
const plain = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
const trim = (text: string) => text.replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');

/** Numbers and numeric strings; anything else (null, '', NaN, objects) is undefined. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function scaled(n: number, units: ReadonlyArray<readonly [number, string]>, sep: string): string | undefined {
  const abs = Math.abs(n);
  for (const [size, unit] of units) {
    if (abs >= size) {
      const v = n / size;
      return trim(v.toFixed(Math.abs(v) >= 100 ? 0 : 1)) + sep + unit;
    }
  }
  return undefined;
}
const COMPACT = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const;
const BYTES = [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'kB']] as const;
const DURATION = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'min'], [1000, 's']] as const;

/**
 * Tabular number text. `num` 12,840 · `compact` 12.8k · `bytes` 131 kB · `pct` 60.1% (the value is already a
 * percentage) · `duration` 1.5 s (the value is milliseconds). '—' for null, NaN and non-numbers.
 */
export function fmtNum(v: unknown, format: Format = 'num'): string {
  const n = toNumber(v);
  if (n === undefined) return DASH;
  const sign = n < 0 ? MINUS : '';
  const abs = Math.abs(n);
  switch (format) {
    case 'compact': return sign + (scaled(abs, COMPACT, '') ?? plain.format(abs));
    case 'bytes': return sign + (scaled(abs, BYTES, ' ') ?? `${plain.format(abs)} B`);
    case 'pct': return `${sign}${trim(abs.toFixed(1))}%`;
    case 'duration': return sign + (scaled(abs, DURATION, ' ') ?? `${plain.format(Math.round(abs))} ms`);
    default: return sign + plain.format(abs);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AGES = [[31_536_000_000, 'y'], [2_592_000_000, 'mo'], [604_800_000, 'wk'], [86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'min']] as const;

/** `rel`: age as '3 d', '5 wk', '2 y' ('now' under a minute). `abs`: '12 Nov 2026' (UTC). '—' when the date is invalid. */
export function fmtDate(iso: string, style: 'rel' | 'abs'): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return DASH;
  if (style === 'abs') {
    const d = new Date(time);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const age = Math.abs(Date.now() - time);
  for (const [size, unit] of AGES) if (age >= size) return `${Math.floor(age / size)} ${unit}`;
  return 'now';
}

/** Text of one table cell for its field kind (the visual treatment of bars, chips and so on is the table's job). */
export function fmtCell(value: unknown, field: Field): string {
  if (value === null || value === undefined || value === '') return DASH;
  const unit = field.unit ? ` ${field.unit}` : '';
  switch (field.kind) {
    case 'num': case 'bar': case 'heat': return fmtNum(value) === DASH ? String(value) : fmtNum(value) + unit;
    case 'bytes': return fmtNum(value, 'bytes');
    case 'pct': return fmtNum(value, 'pct');
    case 'duration': return fmtNum(value, 'duration');
    case 'date': return typeof value === 'string' ? fmtDate(value, 'rel') : DASH;
    case 'bool': return value === true || value === 'true' ? '✓' : DASH;
    case 'commit': return String(value).slice(0, 7);
    case 'delta': {
      const delta = value as {add?: unknown; del?: unknown};
      return typeof value === 'object' ? `+${fmtNum(delta.add ?? 0)} ${MINUS}${fmtNum(delta.del ?? 0)}` : String(value);
    }
    case 'spark': return Array.isArray(value) ? value.map(v => fmtNum(v, 'compact')).join(' ') : String(value);
    default:
      if (typeof value === 'number') return fmtNum(value) + unit;
      if (Array.isArray(value)) return value.map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(', ');
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value) + unit;
  }
}
