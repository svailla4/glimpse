// Text sizing without a DOM. SVG text neither wraps nor clips, and node sizes must be known before layout, so widths
// are estimated from character classes of the two faces diagrams use (IBM Plex Sans and IBM Plex Mono). The
// estimates err on the wide side: checked against the browser's own measurement of both faces, they run from equal
// to about 8% over for labels as they occur (names, paths, counts), so a fitted label never leaves its box.

export interface Face { size: number; mono?: boolean }
export const UI_12: Face = {size: 12};
export const MONO_11: Face = {size: 11, mono: true};
export const MONO_12: Face = {size: 12, mono: true};

const NARROW = new Set("iljI.,:;|!'`()[]{} /\\-");
/** Narrower than a letter, wider than an `i`: measured at 0.36 to 0.39 em in Plex Sans 500. */
const SLIM = new Set('rtf');
const WIDE = new Set('mwMW@%&—…');

function charWidth(ch: string, face: Face): number {
  // CJK and other full-width glyphs take a whole em in either face (the mono face falls back for them too).
  if (ch.charCodeAt(0) > 0x2e7f) return 1;
  if (face.mono) return 0.6;
  if (NARROW.has(ch)) return 0.34;
  if (SLIM.has(ch)) return 0.4;
  if (WIDE.has(ch)) return 0.9;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.57;
}

/** Estimated advance width in px. */
export function textWidth(text: string, face: Face): number {
  let em = 0;
  for (const ch of text) em += charWidth(ch, face);
  return em * face.size;
}

/** The text cut to `maxWidth` with an ellipsis; unchanged when it fits. */
export function fitText(text: string, maxWidth: number, face: Face): string {
  // The length test keeps this linear on very long labels: nothing over maxWidth / (narrowest glyph) can fit.
  if (text.length <= maxWidth / (0.34 * face.size) && textWidth(text, face) <= maxWidth) return text;
  const room = maxWidth - charWidth('…', face) * face.size;
  let width = 0;
  let out = '';
  for (const ch of text) {
    width += charWidth(ch, face) * face.size;
    if (width > room) break;
    out += ch;
  }
  return out.trimEnd() + '…';
}

/** Greedy word wrap into at most `maxLines` lines of `maxWidth`; the last line is cut with an ellipsis. */
export function wrapText(text: string, maxWidth: number, maxLines: number, face: Face): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, face) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      lines.push(fitText(`${candidate} ${words.slice(i + 1).join(' ')}`.trim(), maxWidth, face));
      return lines;
    }
    if (line) lines.push(line);
    line = textWidth(word, face) <= maxWidth ? word : fitText(word, maxWidth, face);
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}
