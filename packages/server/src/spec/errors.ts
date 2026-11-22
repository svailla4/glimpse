// Error vocabulary of the spec pipeline (design 6.6): one Problem per line the model reads, and the mapping from
// the Express compiler's messages to Glimpse codes. All contact with @a2ui/agent message texts is here; the patterns
// are pinned by test/spec/errors.test.ts, so an SDK upgrade that rewords a message fails there, not in production.
import {COMPONENT_BY_NAME, COMPONENTS, signatureOf} from '@glimpse/catalog';

export type ErrorCode =
  | 'E_SYNTAX' | 'E_UNKNOWN' | 'E_PROP' | 'E_ENUM' | 'E_REQUIRED' | 'E_TYPE' | 'E_REF' | 'E_PARENT'
  | 'E_SOURCE' | 'E_ARGS' | 'E_SHAPE' | 'E_PATH' | 'E_VIEW' | 'E_ID' | 'E_SPEC'
  // raised by a source at run time (contracts.ts, SourceError)
  | 'E_NO_GIT' | 'E_TARGET' | 'E_SHALLOW' | 'E_INTERNAL';

const SOURCE_CODES: ReadonlySet<string> = new Set(['E_NO_GIT', 'E_ARGS', 'E_TARGET', 'E_SHALLOW', 'E_INTERNAL', 'E_SOURCE']);
/** The code of a failed dataset as an ErrorCode; anything unexpected reads as E_INTERNAL. */
export const sourceCode = (code: string): ErrorCode => (SOURCE_CODES.has(code) ? (code as ErrorCode) : 'E_INTERNAL');

/** What a bounded auto-repair may try for a problem (spec/repair.ts). */
export type RepairHint =
  | {kind: 'component'; name: string}
  | {kind: 'prop'; component: string; name: string}
  /** An enum value that is not allowed: a synonym or a near miss is replaced by the value it meant. */
  | {kind: 'enum'; component: string; prop: string; value: string}
  /** A number where the prop takes a string (Grid cols=4): the number is quoted. */
  | {kind: 'quote'; component: string; prop: string}
  /** A named part no parent refers to: on a patch it is appended to root's children. */
  | {kind: 'orphan'; id: string}
  | {kind: 'eof'};

export interface Problem {
  code: ErrorCode;
  message: string;
  /** Catalog component the problem is about; its signature is printed after the problem lines. */
  component?: string;
  repair?: RepairHint;
}

export const NOTHING_RENDERED = 'Nothing was rendered; the previous view is unchanged.';
const MAX_PROBLEM_LINES = 5;

/** A rejected call. `problems` is never empty. */
export class SpecError extends Error {
  problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map(p => `${p.code} ${p.message}`).join('\n'));
    this.name = 'SpecError';
    this.problems = problems;
  }
}

export const problem = (code: ErrorCode, message: string, extra: Pick<Problem, 'component' | 'repair'> = {}): Problem => ({code, message, ...extra});

/** Code points that end a line for some reader or cannot be seen: DEL, NEL, zero-width space, the two Unicode separators, BOM. */
const BREAKS: ReadonlySet<number> = new Set([0x7f, 0x85, 0x200b, 0x2028, 0x2029, 0xfeff]);

/** `text` with every control character and line separator replaced by a space; `\n` is kept on request. */
export function flattenBreaks(text: string, keepNewlines = false): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += (code < 0x20 && code !== 0x09 && !(keepNewlines && code === 0x0a)) || BREAKS.has(code) ? ' ' : text[i];
  }
  return out;
}

/**
 * Code points a reader cannot see that can hide what a line starts with, or reorder it: every format character (Cf:
 * soft hyphen, zero-width joiners, the bidi marks, embeddings, overrides and isolates, word joiner, tags) and the
 * blank fillers that render as nothing (finding V016). Written as escapes so this source shows what it matches.
 */
const INVISIBLE_CLASS = '\\p{Cf}\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u2800\\u3164\\uffa0';
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'gu');
/** Anything a reader could take for a line break, or that cannot be seen: control characters, separators, INVISIBLE. */
export const UNSAFE_CHAR = new RegExp(`[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029${INVISIBLE_CLASS}]`, 'u');
const PICTOGRAPH_BEFORE = /(?:\p{Extended_Pictographic}|️|[\u{1f3fb}-\u{1f3ff}])$/u;
const PICTOGRAPH_AFTER = /^\p{Extended_Pictographic}/u;
const ZWJ = String.fromCharCode(0x200d);
const SEPARATORS = /[\u2028\u2029]/g;

/** The JSON escape of each UTF-16 unit of `text` (one per unit, so a code point above the BMP is a surrogate pair). */
const jsonEscape = (text: string): string => Array.from({length: text.length}, (_, i) => `\\u${text.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

/**
 * Each invisible code point written out (`\u{200D}`, or its JSON escape with `json`), so it is seen and cannot take
 * effect. A joiner between two pictographs only builds one emoji and stays.
 */
export function escapeInvisible(text: string, json = false): string {
  return text.replace(INVISIBLE, (ch: string, offset: number) => {
    if (ch === ZWJ && PICTOGRAPH_BEFORE.test(text.slice(Math.max(0, offset - 2), offset)) && PICTOGRAPH_AFTER.test(text.slice(offset + 1, offset + 3))) return ch;
    return json ? jsonEscape(ch) : `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`;
  });
}

/** U+2028 and U+2029, which JSON.stringify leaves as they are, as JSON escapes. */
export const escapeSeparators = (json: string): string => json.replace(SEPARATORS, jsonEscape);

/** A string as JSON in which nothing is invisible and nothing breaks a line: invisible code points and U+2028/9 are escaped. */
export function jsonQuote(text: string): string {
  return escapeSeparators(escapeInvisible(JSON.stringify(text), true));
}

/**
 * `text` with every control character, line separator and zero-width space replaced by a space, and every other
 * invisible code point written out, so nothing in it can start a new line, hide the start of one or reorder it.
 * Tabs are kept (they separate cells); `\n` is kept on request.
 */
export function flatten(text: string, keepNewlines = false): string {
  return escapeInvisible(flattenBreaks(text, keepNewlines));
}

/** Letters of other scripts drawn like Latin ones, and colons and signs that look like `:`, `=` or `_`. */
const CONFUSABLES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic and Latin small capitals
  'аa', 'Аa', 'вb', 'Вb', 'сc', 'Сc', 'ԁd', 'еe', 'Еe', 'һh', 'Нh', 'іi', 'Іi', 'ӏl', 'јj', 'Јj', 'кk', 'Кk', 'мm', 'Мm', 'оo', 'Оo',
  'рp', 'Рp', 'ԛq', 'ѕs', 'Ѕs', 'тt', 'Тt', 'уy', 'Уy', 'үy', 'Үy', 'хx', 'Хx', 'ԝw', 'Ԝw', 'ѵv', 'Ѵv', 'ьb', 'ɡg', 'ıi', 'ᴠv', 'ᴡw', 'ᴇe',
  'ʀr', 'ꜱs', 'ᴏo',
  // Greek
  'αa', 'Αa', 'βb', 'Βb', 'εe', 'Εe', 'ζz', 'Ζz', 'ηn', 'Ηh', 'ιi', 'Ιi', 'κk', 'Κk', 'μm', 'Μm', 'νv', 'Νn', 'οo', 'Οo', 'ρp', 'Ρp',
  'τt', 'Τt', 'υu', 'Υy', 'χx', 'Χx', 'ωw', 'ϲc', 'ϳj',
  // Armenian
  'օo', 'Օo', 'սu', 'հh', 'ոn', 'ցg', 'աw',
  // colons, equals signs
  '∶:', 'ː:', '꞉:', '˸:', '։:', '׃:', '᛬:', '፡:', '᐀=', '゠=', '⹀=', '꓿=',
].map(pair => [[...pair][0]!, [...pair][1]!]));

/**
 * The text as a reader takes it in: compatibility forms folded (fullwidth letters, ligatures, small colons), invisible
 * code points and combining marks dropped, look-alike letters read as the Latin letter they imitate, in lower case.
 * What a line of repository text is tested against before it may stand alone in a result.
 */
export function skeleton(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKD').replace(INVISIBLE, '').replace(/\p{M}/gu, '')) out += CONFUSABLES[ch] ?? ch;
  return out.toLowerCase();
}

/** ASCII characters drawn like a letter of `viewer`. */
const ASCII_LOOKALIKE: Readonly<Record<string, string>> = {'1': 'i', 'l': 'i', '|': 'i', '!': 'i', '3': 'e'};
const VIEWER = 'viewer';
const NON_ASCII = (ch: string) => ch.codePointAt(0)! > 0x7f;

/**
 * How many edits `word` is from "viewer" when every character outside ASCII may stand for any letter (finding V016:
 * no table of look-alikes is ever complete; ɪ, ɩ, ʋ, ɛ and Cherokee Ꮩ got past one) and the ASCII look-alikes (1, l,
 * |, !, 3) stand for the letter they imitate. A swap of two neighbours (veiwer) is one edit.
 */
function viewerDistance(word: readonly string[]): number {
  const same = (ch: string, letter: string) => ch === letter || ASCII_LOOKALIKE[ch] === letter || NON_ASCII(ch);
  const d: number[][] = Array.from({length: word.length + 1}, (_, i) => Array.from({length: VIEWER.length + 1}, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= word.length; i++) {
    for (let j = 1; j <= VIEWER.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (same(word[i - 1]!, VIEWER[j - 1]!) ? 0 : 1));
      if (i > 1 && j > 1 && same(word[i - 1]!, VIEWER[j - 2]!) && same(word[i - 2]!, VIEWER[j - 1]!)) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[word.length]![VIEWER.length]!;
}

/**
 * What may stand for the colon of `viewer:`: a colon or semicolon, or any character outside ASCII that is not a plain
 * letter or digit (U+205A two dot punctuation, modifier colons, a spacing mark such as the visarga). A letter of
 * another script (CJK, Cyrillic) does not, so a long file name in such a script reads as what it is.
 */
const COLON_LIKE = (ch: string) => ch === ':' || ch === ';' || (NON_ASCII(ch) && !/[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}\s]/u.test(ch));

/**
 * True for text that a reader would take for the start of a genuine `viewer:` line. The text is seen as a reader sees
 * it (compatibility forms folded, invisible characters and stacking marks dropped, known look-alikes mapped, lower
 * case); then its first word, within one edit of "viewer" with any non-ASCII character as a wildcard, followed by
 * something that may pass for a colon, is enough. Quoting a line that only resembles one costs nothing.
 */
export function readsAsViewerLine(text: string): boolean {
  let seen = '';
  for (const ch of flattenBreaks(text).normalize('NFKD').replace(INVISIBLE, '').replace(/[\p{Mn}\p{Me}]/gu, '')) seen += CONFUSABLES[ch] ?? ch;
  const chars = [...seen.toLowerCase().replace(/^\s+/u, '').replace(/vv/g, 'w').slice(0, 24)];
  for (let end = VIEWER.length - 1; end <= VIEWER.length + 1 && end < chars.length; end++) {
    const word = chars.slice(0, end);
    // A word: ASCII letters, digits and the look-alikes, or anything outside ASCII but a space. A line that opens with
    // a quotation mark (one shield() quoted) or a path is not a word.
    if (word.some(ch => (NON_ASCII(ch) ? /\s/u.test(ch) : !/[a-z0-9|!]/.test(ch)))) break;
    let at = end;
    while (at < chars.length && /\s/u.test(chars[at]!)) at++;
    if (at < chars.length && COLON_LIKE(chars[at]!) && viewerDistance(word) <= 1) return true;
  }
  return false;
}

/** One line, no control characters, at most `max` characters. */
export function oneLine(text: string, max = 240): string {
  const flat = flatten(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * At most five problem lines, the signature of the first offending component, then the fixed last line (null: none,
 * for tools that render nothing).
 */
export function formatProblems(problems: readonly Problem[], lastLine: string | null = NOTHING_RENDERED): string {
  const lines = problems.slice(0, MAX_PROBLEM_LINES).map(p => oneLine(`${p.code} ${p.message}`, 400));
  if (problems.length > MAX_PROBLEM_LINES) lines[MAX_PROBLEM_LINES - 1] += ` (+${problems.length - MAX_PROBLEM_LINES} more)`;
  const def = problems.map(p => (p.component ? COMPONENT_BY_NAME.get(p.component) : undefined)).find(d => d !== undefined);
  if (def) lines.push(`sig ${signatureOf(def)}`);
  if (lastLine !== null) lines.push(lastLine);
  return lines.join('\n');
}

// ---------------------------------------------------------------- nearest names
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Case-insensitive distance; a candidate that merely extends or shortens the name by a prefix ranks close. */
function looseDistance(name: string, candidate: string): number {
  const a = name.toLowerCase();
  const b = candidate.toLowerCase();
  const d = editDistance(a, b);
  return a.length >= 3 && (b.startsWith(a) || a.startsWith(b)) ? Math.min(d, 2.5) : d;
}

/** The `n` candidates closest to `name`, best first (ties keep candidate order). */
export function nearest(name: string, candidates: Iterable<string>, n = 3): string[] {
  return [...candidates]
    .map((candidate, index) => ({candidate, index, d: looseDistance(name, candidate)}))
    .sort((x, y) => x.d - y.d || x.index - y.index)
    .slice(0, n)
    .map(x => x.candidate);
}

/**
 * The single candidate a typo most plausibly meant, or undefined: within edit distance 2 (1 for names of up to four
 * characters), closer than every other candidate.
 */
export function closeMatch(name: string, candidates: Iterable<string>): string | undefined {
  const limit = name.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  let tie = false;
  for (const candidate of candidates) {
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) { best = candidate; bestDistance = d; tie = false; }
    else if (d === bestDistance) tie = true;
  }
  return best !== undefined && bestDistance <= limit && bestDistance < name.length && !tie ? best : undefined;
}

/** Case-insensitive edit distance that counts a swap of two neighbours as one edit (Tabel / Table). */
export function typoDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 0;
  const d: number[][] = Array.from({length: x.length + 1}, (_, i) => Array.from({length: y.length + 1}, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[x.length]![y.length]!;
}

/**
 * How far a written name is from a component: from the whole name, or (half a step further) from one of its words,
 * so 'Tabel' and 'Table' are near DataTable and not Tabs (finding V041). A name that a component extends or shortens
 * by a prefix ranks close, as in nearest().
 */
function componentDistance(name: string, component: string): number {
  const whole = typoDistance(name, component);
  const prefix = name.length >= 3 && (component.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(component.toLowerCase())) ? 2.5 : Infinity;
  const words = component.split(/(?=[A-Z])/).filter(word => word.length >= 4 && word.length < component.length);
  const word = words.length > 0 ? Math.min(...words.map(part => typoDistance(name, part))) + 0.5 : Infinity;
  return Math.min(whole, prefix, word);
}

const COMPONENT_NAMES = COMPONENTS.map(c => c.name);

/** The `n` components closest to a name that is not one, best first. */
export function componentNearest(name: string, n = 3): string[] {
  return COMPONENT_NAMES.map((candidate, index) => ({candidate, index, d: componentDistance(name, candidate)}))
    .sort((x, y) => x.d - y.d || x.index - y.index).slice(0, n).map(x => x.candidate);
}

/**
 * Components that were removed, the one that now draws what they drew, and what the rename does not carry over.
 * Decision no-markdown-component: Markdown became Text, so a spec written from habit or from an older skill still draws.
 */
export const REMOVED_COMPONENTS: Readonly<Record<string, {to: string; note: string}>> = {
  Markdown: {to: 'Text', note: 'headings, tables and code fences show as written: use Section, DataTable, CodeBlock'},
};

/** The single component a misspelt or removed name most plausibly meant (same limits as closeMatch), or undefined. */
export function componentMatch(name: string): string | undefined {
  if (Object.hasOwn(REMOVED_COMPONENTS, name)) return REMOVED_COMPONENTS[name]!.to;
  const limit = name.length <= 4 ? 1 : 2;
  const ranked = COMPONENT_NAMES.map(candidate => ({candidate, d: componentDistance(name, candidate)})).sort((x, y) => x.d - y.d);
  const [best, second] = ranked;
  if (!best || best.d > limit || best.d >= name.length || (second && second.d === best.d)) return undefined;
  return best.candidate;
}

// ---------------------------------------------------------------- compiler messages -> problems
/** Props of a component in positional order, as the model may write them. */
function propsOf(component: string): string {
  const def = COMPONENT_BY_NAME.get(component);
  return def ? Object.keys(def.props).join(' ') : '';
}

/** The compiler's own sentence: its `detail` when it has one, else the message without the trailing "- Help: ..." text. */
export function compilerText(error: unknown): string {
  const e = error as {detail?: unknown; message?: unknown};
  const text = typeof e?.detail === 'string' ? e.detail : typeof e?.message === 'string' ? e.message : String(error);
  return text.replace(/\s+-\s+(?:Line \d+, Col \d+\s+-\s+)?Help:[\s\S]*$/, '').trim();
}

export interface ClassifyContext {
  surfaceId: string;
  /** True when the call patches a surface that already exists. */
  exists: boolean;
  /** Ids of the views that exist, for the "nothing to patch" message. */
  surfaces: readonly string[];
  /** Maps a 1-based line of the compiled text (header line removed) to the line the author wrote. */
  lineOf?: (line: number) => number;
  /** The statement that would add an unreachable part to the root, for the E_REF message. */
  rootLine?: string;
}

/** ` cols: Column count '3' or ratio '2:1'.`: what the prop accepts, in the catalog's own words. */
function propHint(component: string, prop: string | undefined): string {
  const doc = prop ? (COMPONENT_BY_NAME.get(component)?.props as Record<string, {doc?: string}> | undefined)?.[prop]?.doc : undefined;
  return doc ? ` Expects: ${oneLine(doc, 120)}` : '';
}

/** Maps one thrown compiler error to a Problem. Unrecognised messages pass through as E_SPEC. */
export function classifyCompileError(error: unknown, ctx: ClassifyContext): Problem {
  const text = compilerText(error);

  const syntax = /Syntax error at line (\d+):(\d+):?\s*([\s\S]*?)(?:\s*\(line \d+\))?$/.exec(text);
  if (syntax) {
    const line = Math.max(1, Number(syntax[1]) - 1);
    const what = oneLine(syntax[3] || 'unexpected input', 160);
    return problem('E_SYNTAX', `line ${ctx.lineOf ? ctx.lineOf(line) : line} col ${syntax[2]}: ${what}`, /<EOF>/.test(what) ? {repair: {kind: 'eof'}} : {});
  }

  const unknown = /^(?:Function|Component) '([^']+)' is not defined in the catalog/.exec(text);
  if (unknown) {
    const name = unknown[1]!;
    return problem('E_UNKNOWN', `"${name}" is not a component. Nearest: ${componentNearest(name).join(' ')}`, {repair: {kind: 'component', name}});
  }

  const badProp = /^Property '([^']+)' is not a valid property of component '([^']+)'/.exec(text);
  if (badProp) {
    const prop = badProp[1]!;
    const component = badProp[2]!;
    return problem('E_PROP', `${component}: unknown prop "${prop}". Props: ${propsOf(component)}`, {component, repair: {kind: 'prop', component, name: prop}});
  }

  const badEnum = /^Value '([\s\S]*)' is not a valid enum choice for property '([^']+)' of component '([^']+)'/.exec(text);
  if (badEnum) {
    const prop = badEnum[2]!;
    const component = badEnum[3]!;
    const values = (COMPONENT_BY_NAME.get(component)?.props as Record<string, {values?: readonly string[]}> | undefined)?.[prop]?.values;
    const allowed = values ? values.join(' ') : oneLine(text.replace(/^[\s\S]*Allowed values are:\s*/, '').replace(/[[\]',]/g, ' '));
    return problem('E_ENUM', `${component}.${prop}: "${oneLine(badEnum[1]!, 60)}" is not allowed. Use: ${allowed}`, {component, repair: {kind: 'enum', component, prop, value: badEnum[1]!}});
  }

  const missing = /^Component '([^']+)' is missing required property '([^']+)'/.exec(text);
  if (missing) return problem('E_REQUIRED', `${missing[1]}: missing required prop "${missing[2]}".`, {component: missing[1]!});

  const invalid = /^Validation failed for component '([^']+)' \(([^)]*)\): ([\s\S]*)$/.exec(text);
  if (invalid) {
    const component = invalid[1]!;
    const first = (invalid[3] ?? '').split(/;\s/)[0] ?? '';
    const prop = /^([A-Za-z_]\w*): /.exec(first)?.[1];
    const quotable = prop !== undefined && /Expected string, received number/.test(first);
    return problem('E_TYPE', `${component}#${invalid[2]} ${oneLine(first, 200)}${prop ? '.' : ''}${propHint(component, prop)}`, {component, ...(quotable ? {repair: {kind: 'quote' as const, component, prop}} : {})});
  }

  const positional = /^Positional argument (\d+) for component '([^']+)' is an? ([\w ]+?), which is not valid for (?:optional |required )?property '([^']+)'/.exec(text);
  if (positional) {
    const component = positional[2]!;
    const prop = positional[4]!;
    return problem('E_TYPE', `${component}: argument ${positional[1]} (${prop}) cannot be a ${positional[3]}.${propHint(component, prop)}`,
      {component, ...(positional[3] === 'number' ? {repair: {kind: 'quote' as const, component, prop}} : {})});
  }

  const code = (error as {code?: unknown; details?: Array<{code?: unknown}>})?.details?.[0]?.code ?? (error as {code?: unknown})?.code;
  if (code === 'UNALLOWED_PARENT' || code === 'UNALLOWED_CHILD') {
    const where = /^Component '([^']+)' \(([^)]+)\) cannot be placed under parent '([^']+)' \(([^)]+)\)\. Allowed parents: (.*?)\.?$/.exec(text);
    if (!where) return problem('E_PARENT', oneLine(text));
    const allowed = where[5]!.replace(/[[\]"]/g, '').replace(/,\s*/g, ' ');
    const hint = where[2] === 'Page' ? ' Page is the root: use it once, as root=Page(...).' : '';
    return problem('E_PARENT', `${where[2]} (${where[1]}) cannot sit inside ${where[4]} (${where[3]}). Allowed parents: ${allowed}.${hint}`, {component: where[2]!});
  }

  const dangling = /^Component '([^']+)' references non-existent component '([^']+)' in field '([^']+)'/.exec(text);
  if (dangling) {
    return problem('E_REF', `"${dangling[2]}" is used by ${dangling[1]} (${dangling[3]}) but never defined. Add ${dangling[2]}=Comp(...) or fix the name.`);
  }

  const orphan = /^Component '([^']+)' is not reachable from 'root'/.exec(text);
  if (orphan) {
    return problem('E_REF', `"${orphan[1]}" is not reachable from root: resend its parent with the new child${ctx.rootLine ? `: ${ctx.rootLine}` : ''}.`, {repair: {kind: 'orphan', id: orphan[1]!}});
  }

  if (/^Root target 'root' is not defined|^Surface not found for message|^Missing root component/.test(text)) {
    const others = ctx.surfaces.length > 0 ? ` Existing views: ${ctx.surfaces.join(' ')}.` : '';
    return problem('E_REF', ctx.exists
      ? 'the spec defines nothing to render. Use name=Comp(...), $/path=value or root=Page(...).'
      : `there is no view "${ctx.surfaceId}" to patch, and the spec defines no root. Start with root=Page(...) or pass the id of an existing view.${others}`);
  }

  const named = /component '([^']+)'|^([A-Z][A-Za-z]+) takes at most/.exec(text);
  const component = named?.[1] ?? named?.[2];
  return problem('E_SPEC', oneLine(text, 300), component && COMPONENT_BY_NAME.has(component) ? {component} : {});
}
