// Token lines as the server sends them (design 5.7): [text, class] pairs, never markup. Everything here treats that
// JSON as untrusted: a line that is not an array of pairs becomes plain text, an unknown class becomes class 0.
import {TOKEN_CLASSES, type TokenLine} from '@glimpse/catalog';
import {memo, type CSSProperties, type ReactNode} from 'react';
import {DirText, useSizeCap} from '../../../kit/index.ts';
import s from './lines.module.css';

/**
 * The style that gives a code view (`.code[data-fit='cap']`) its maximum height (decision D20): the cell's size step,
 * or the family default without one. The view is as tall as its lines and scrolls only past that, sized or not.
 */
export function useCapStyle(extra?: Record<`--${string}`, string | number>): CSSProperties {
  return {'--gl-cap': `${useSizeCap()}px`, ...extra} as CSSProperties;
}

/** Character ranges [from, to) inside one line (word-level diff marks). */
export type CharMarks = ReadonlyArray<readonly [number, number]>;

/** Lines longer than this are cut in the DOM; the rest is counted, not drawn. */
export const MAX_LINE_CHARS = 2000;
const TAB_COLS = 4;

export const cx = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');

export function coerceLine(line: unknown): TokenLine {
  if (typeof line === 'string') return line === '' ? [] : [[line, 0]];
  if (!Array.isArray(line)) return [];
  const out: TokenLine = [];
  for (const token of line) {
    if (typeof token === 'string') out.push([token, 0]);
    else if (Array.isArray(token) && typeof token[0] === 'string') {
      const cls = token[1];
      out.push([token[0], Number.isInteger(cls) && cls > 0 && cls < TOKEN_CLASSES.length ? cls : 0]);
    }
  }
  return out;
}

export const coerceLines = (lines: unknown): TokenLine[] => (Array.isArray(lines) ? lines.map(coerceLine) : []);

export function lineText(line: TokenLine): string {
  let text = '';
  for (const token of line) text += token[0];
  return text;
}

/** Source text as unhighlighted lines. One trailing newline does not make an extra empty line. */
export function plainLines(code: string): string[] {
  const lines = code.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Display columns of a line, tabs counted at the tab size the stylesheet sets. */
export function textCols(text: string): number {
  let cols = text.length;
  for (let i = text.indexOf('\t'); i >= 0; i = text.indexOf('\t', i + 1)) cols += TAB_COLS - 1;
  return cols;
}

export function maxCols(lines: Iterable<TokenLine | undefined>): number {
  let max = 0;
  for (const line of lines) {
    if (!line) continue;
    let cols = 0;
    for (const token of line) cols += textCols(token[0]);
    if (cols > max) max = cols;
  }
  return Math.min(max, MAX_LINE_CHARS + 16);
}

/** A path as the title of a code view: the directory gives way first when space is short. */
export function Crumbs(p: {path: string}): ReactNode {
  const slash = p.path.lastIndexOf('/');
  return (
    <span className={s.crumbs} title={p.path} data-gl-path={p.path}>
      {/* Decision D17: whole leading directories give way before one is cut ('…/processing/', not 'web_…'). */}
      {slash >= 0 ? <DirText dir={p.path.slice(0, slash + 1)} /> : null}
      <span className={s.base}>{p.path.slice(slash + 1)}</span>
    </span>
  );
}

export type LineRanges = ReadonlyArray<readonly [number, number]>;

/**
 * The `mark` prop as line ranges: '3,7-9'. Lines may be written the way file locations are everywhere else
 * ('L1-60', '#L10-L20', '12:18'), since that is what a writer who has just typed 'path#L10-20' reaches for.
 * Segments that name no line are left out and returned in `ignored`, so the view can say so instead of
 * silently marking nothing.
 */
export function parseMarks(spec: unknown): {ranges: Array<[number, number]>; ignored: string[]} {
  const ranges: Array<[number, number]> = [];
  const ignored: string[] = [];
  if (typeof spec === 'number' && Number.isInteger(spec) && spec > 0) return {ranges: [[spec, spec]], ignored};
  if (typeof spec !== 'string') return {ranges, ignored};
  for (const part of spec.split(/[,;]/)) {
    const text = part.trim();
    if (text === '') continue;
    const match = /^#?L?(\d+)(?:\s*(?:-|–|:|\.\.)\s*#?L?(\d+))?$/i.exec(text);
    const from = match ? Number(match[1]) : 0;
    if (!match || from < 1) {
      ignored.push(text);
      continue;
    }
    const to = match[2] ? Number(match[2]) : from;
    ranges.push([Math.min(from, to), Math.max(from, to)]);
  }
  return {ranges, ignored};
}

/** 'mark: "abc" is not a line range' — the note a view shows for segments parseMarks could not read. */
export function ignoredMarksText(ignored: readonly string[]): string {
  const shown = ignored.slice(0, 3).map(text => `"${text.length > 16 ? `${text.slice(0, 15)}…` : text}"`).join(', ');
  return `mark: ${shown}${ignored.length > 3 ? ` and ${ignored.length - 3} more` : ''} ${ignored.length === 1 ? 'is not a line range' : 'are not line ranges'}`;
}

export function inRanges(ranges: LineRanges, line: number): boolean {
  for (const [from, to] of ranges) if (line >= from && line <= to) return true;
  return false;
}

function piece(text: string, cls: number, marked: boolean, key: number): ReactNode {
  const name = TOKEN_CLASSES[cls];
  const body = name ? <span key={key} className={`gl-tok-${name}`}>{text}</span> : text;
  if (!marked) return body;
  return <mark key={key} className={s.word}>{body}</mark>;
}

/**
 * One line of tokens as spans. `marks` are character ranges drawn as <mark>; they may cut through a token.
 * Text is always a text node, so repository content can never become markup.
 */
export const TokenSpans = memo(function TokenSpans(p: {tokens: TokenLine; marks?: CharMarks}) {
  const marks = (p.marks ?? []).filter(m => Array.isArray(m) && m[0] < m[1]);
  const out: ReactNode[] = [];
  let offset = 0;
  let key = 0;
  for (const [text, cls] of p.tokens) {
    if (offset >= MAX_LINE_CHARS) {
      offset += text.length;
      continue;
    }
    const visible = offset + text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS - offset) : text;
    if (marks.length === 0) out.push(piece(visible, cls, false, key++));
    else {
      // Cut the token at every mark boundary that falls inside it.
      const cuts = new Set<number>([0, visible.length]);
      for (const [from, to] of marks) {
        if (from > offset && from < offset + visible.length) cuts.add(from - offset);
        if (to > offset && to < offset + visible.length) cuts.add(to - offset);
      }
      const points = [...cuts].sort((a, b) => a - b);
      for (let i = 0; i + 1 < points.length; i++) {
        const start = points[i]!;
        const at = offset + start;
        out.push(piece(visible.slice(start, points[i + 1]), cls, marks.some(([from, to]) => at >= from && at < to), key++));
      }
    }
    offset += text.length;
  }
  if (offset > MAX_LINE_CHARS) {
    out.push(<span key="cut" className={s.cut} data-gl-cut="">{` … +${(offset - MAX_LINE_CHARS).toLocaleString('en-US')} chars`}</span>);
  }
  return <>{out}</>;
});
