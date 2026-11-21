// Inline micro-markup for Text, Callout and Ask (design 4.6): `code`, *em*, **strong** and [[path#L10-20]] file refs.
// Nothing else is markup; the text never reaches innerHTML.
import {CODE_SPAN, FILE_REF} from '@glimpse/catalog';
import {memo, type JSX, type ReactNode} from 'react';
import {FileLink} from './FileLink.tsx';
import styles from './inline.module.css';

// Alternatives in priority order: code span, file ref, strong, em. A marker with no partner stays literal text.
// Spans are bounded (400 characters) so a text full of unmatched markers still scans in linear time. The code span
// and the file ref are the catalog's, so the server checks exactly the refs drawn here as links.
const STRONG = /\*\*(?!\s)((?:[^*\n]|\*(?!\*)){1,400}?)(?<!\s)\*\*/;
const EM = /\*(?!\s|\*)([^*\n]{1,400}?)(?<!\s)\*/;
const TOKEN = new RegExp([CODE_SPAN, FILE_REF, STRONG, EM].map(part => part.source).join('|'), 'g');
/** Emphasis nests at most this deep; deeper text is left literal. */
const MAX_DEPTH = 3;

function parse(text: string, componentId: string, depth: number, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, code, ref, strong, em] = match;
    const key = `${keyPrefix}${n++}`;
    let node: ReactNode;
    if (code !== undefined) node = <code key={key} className={styles.code}>{code}</code>;
    else if (ref !== undefined) node = <FileLink key={key} file={ref} componentId={componentId} />;
    else if (depth >= MAX_DEPTH) continue;
    else if (strong !== undefined) node = <strong key={key} className={styles.strong}>{parse(strong, componentId, depth + 1, `${key}.`)}</strong>;
    else node = <em key={key} className={styles.em}>{parse(em ?? '', componentId, depth + 1, `${key}.`)}</em>;
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(node);
    last = match.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** `text` with its micro-markup rendered. `componentId` is the A2UI id of the view: file refs select through it. */
export const Inline = memo(function Inline(p: {text: string; componentId: string}): JSX.Element {
  return <>{parse(p.text, p.componentId, 0, '')}</>;
});

/** A text prop as a string: bindings can resolve to numbers, null or nothing at all. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
