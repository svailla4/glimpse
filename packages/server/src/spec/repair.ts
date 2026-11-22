// Bounded auto-repair (design 2.2 step 3): what the author plainly meant is accepted and reported, never silently.
// A misspelt component or prop within edit distance 2 is renamed; an enum value that is a synonym or a near miss of
// an allowed one is replaced (Callout kind 'warning' -> warn); a number where the prop takes a string is quoted
// (Grid cols=4); an unexpected end of input closes the open brackets. Everything else stays an error. A repair
// edits the normalized Express text and is reported to the model as `fixed A -> B`, so it learns the right spelling.
import {COMPONENT_BY_NAME, enumValue, type Prop} from '@glimpse/catalog';
import {closeMatch, componentMatch, REMOVED_COMPONENTS, type RepairHint} from './errors.ts';
import {stringValue, tokenize, type SpecToken} from './guard.ts';

export interface Repair {
  text: string;
  /** The text after `fixed `, e.g. `DataTabel -> DataTable`. */
  note: string;
}

const CLOSER: Record<string, string> = {'(': ')', '[': ']', '{': '}'};
const isOpen = (token: SpecToken) => token.kind === 'punct' && token.text in CLOSER;
const isClose = (token: SpecToken) => token.kind === 'punct' && (token.text === ')' || token.text === ']' || token.text === '}');

function replaceAt(src: string, edits: Array<{start: number; end: number; text: string}>): string {
  let out = src;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function renameComponent(src: string, name: string): Repair | undefined {
  if (COMPONENT_BY_NAME.has(name)) return undefined;
  const target = componentMatch(name);
  if (!target) return undefined;
  const {tokens} = tokenize(src);
  const edits = tokens.filter((t, i) => t.kind === 'ident' && t.text === name && tokens[i + 1]?.text === '(').map(t => ({start: t.start, end: t.end, text: target}));
  const removed = Object.hasOwn(REMOVED_COMPONENTS, name) ? `: ${REMOVED_COMPONENTS[name]!.note}` : '';
  return edits.length > 0 ? {text: replaceAt(src, edits), note: `${name} -> ${target}${removed}`} : undefined;
}

/** One argument written directly inside a call: `value` is its first token. */
interface Argument { callee: string; index: number; keyword: string | undefined; value: SpecToken; keywordToken: SpecToken | undefined }

/** Every argument of every call in the text, positional index and keyword included. Nested brackets are skipped over. */
function callArguments(tokens: SpecToken[]): Argument[] {
  const out: Argument[] = [];
  interface Frame { callee: string | undefined; index: number; keyword: SpecToken | undefined; fresh: boolean }
  const stack: Frame[] = [];
  tokens.forEach((token, i) => {
    const top = stack.at(-1);
    if (top?.callee !== undefined && top.fresh && !isClose(token)) {
      // `name = value` (but not `==`) is a keyword argument; anything else is the positional value itself.
      if (token.kind === 'ident' && tokens[i + 1]?.text === '=' && tokens[i + 2]?.text !== '=') { top.keyword = token; return; }
      if (token.text === '=' && top.keyword && tokens[i - 1] === top.keyword) return;
      out.push({callee: top.callee, index: top.index, keyword: top.keyword?.text, value: token, keywordToken: top.keyword});
      top.fresh = false;
    }
    if (isOpen(token)) {
      const prev = tokens[i - 1];
      stack.push({callee: token.text === '(' && prev?.kind === 'ident' ? prev.text : undefined, index: 0, keyword: undefined, fresh: true});
    } else if (isClose(token)) {
      stack.pop();
    } else if (token.text === ',' && top) {
      top.index++;
      top.keyword = undefined;
      top.fresh = true;
    }
  });
  return out;
}

/** The arguments that set `prop` of `component`: by keyword, or by position in signature order. */
function argumentsOf(src: string, component: string, prop: string): Argument[] {
  const def = COMPONENT_BY_NAME.get(component);
  if (!def) return [];
  const position = Object.keys(def.props).indexOf(prop);
  return callArguments(tokenize(src).tokens).filter(arg => arg.callee === component && (arg.keyword === prop || (arg.keyword === undefined && arg.index === position)));
}

/** Renames `name=` only as a keyword argument written directly inside a call of `component`. */
function renameProp(src: string, component: string, name: string): Repair | undefined {
  const def = COMPONENT_BY_NAME.get(component);
  if (!def || name in def.props) return undefined;
  const target = closeMatch(name, Object.keys(def.props));
  if (!target) return undefined;
  const edits = callArguments(tokenize(src).tokens)
    .filter(arg => arg.callee === component && arg.keyword === name && arg.keywordToken)
    .map(arg => ({start: arg.keywordToken!.start, end: arg.keywordToken!.end, text: target}));
  return edits.length > 0 ? {text: replaceAt(src, edits), note: `${name} -> ${target}`} : undefined;
}

/**
 * What people write for an enum value, and the catalog words it may stand for (the first one the prop allows wins).
 * Keys are lower case.
 */
const SYNONYMS: Record<string, readonly string[]> = {
  warning: ['warn'], caution: ['warn'], alert: ['warn', 'risk'],
  danger: ['risk', 'bad'], error: ['risk', 'bad'], critical: ['risk', 'bad'], failure: ['risk', 'bad'],
  info: ['note', 'info'], information: ['note', 'info'], hint: ['tip'],
  success: ['tip', 'good'], ok: ['good', 'tip'], positive: ['good'], negative: ['bad'],
  small: ['s'], sm: ['s'], medium: ['m'], md: ['m'], large: ['l'], lg: ['l'], xlarge: ['xl'], full: ['fill'], auto: ['fill'],
  horizontal: ['row', 'h', 'LR'], vertical: ['col', 'v', 'TB'], column: ['col', 'v'], rows: ['row'], columns: ['col'],
  lr: ['LR'], tb: ['TB'], 'left-right': ['LR'], 'top-bottom': ['TB'], 'top-down': ['TB'],
  stack: ['stacked'], percent: ['pct'], percentage: ['pct'], '%': ['pct'], group: ['grouped'],
  centre: ['center'], middle: ['center'], left: ['start'], right: ['end'], top: ['start'], bottom: ['end'],
  side: ['split'], 'side-by-side': ['split'], inline: ['unified'],
  secondary: ['quiet'], ghost: ['quiet'], subtle: ['quiet', 'dim'], muted: ['dim'], code: ['mono'], monospace: ['mono'],
  number: ['num'], size: ['bytes', 'loc'], lines: ['loc'], language: ['lang'], log10: ['log'],
};

/** The allowed value a rejected one most plausibly meant: same word in another case, a synonym, or a near miss. */
export function enumMeant(value: string, allowed: readonly string[]): string | undefined {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return undefined;
  return allowed.find(option => option.toLowerCase() === wanted)
    ?? (Object.hasOwn(SYNONYMS, wanted) ? SYNONYMS[wanted]!.find(option => allowed.includes(option)) : undefined)
    ?? closeMatch(value, allowed);
}

function replaceEnum(src: string, component: string, prop: string, value: string): Repair | undefined {
  const def = (COMPONENT_BY_NAME.get(component)?.props as Record<string, Prop> | undefined)?.[prop];
  // The catalog's own aliases for this prop come first; the general table and near misses cover the rest.
  const target = def?.values ? enumValue(def, value) ?? enumMeant(value, def.values) : undefined;
  if (!target) return undefined;
  const edits = argumentsOf(src, component, prop)
    .filter(arg => arg.value.kind === 'string' && stringValue(arg.value) === value)
    .map(arg => ({start: arg.value.start, end: arg.value.end, text: JSON.stringify(target)}));
  return edits.length > 0 ? {text: replaceAt(src, edits), note: `${component}.${prop} ${value} -> ${target}`} : undefined;
}

function quoteNumber(src: string, component: string, prop: string): Repair | undefined {
  const args = argumentsOf(src, component, prop).filter(arg => arg.value.kind === 'number');
  if (args.length === 0) return undefined;
  const edits = args.map(arg => ({start: arg.value.start, end: arg.value.end, text: JSON.stringify(arg.value.text)}));
  return {text: replaceAt(src, edits), note: `${component}.${prop} ${args[0]!.value.text} -> '${args[0]!.value.text}'`};
}

function closeBrackets(src: string): Repair | undefined {
  const {tokens, endsInComment} = tokenize(src);
  const stack: string[] = [];
  for (const token of tokens) {
    if (isOpen(token)) stack.push(CLOSER[token.text]!);
    else if (isClose(token) && stack.pop() !== token.text) return undefined; // mismatched, not merely unfinished
  }
  if (stack.length === 0) return undefined;
  const closers = stack.reverse().join('');
  return {text: src.replace(/\s+$/, '') + (endsInComment ? '\n' : '') + closers, note: `end of input -> ${closers}`};
}

// ---------------------------------------------------------------- deterministic rewrites before the first compile
export interface Rewrite {
  text: string;
  /** Notes for `fixed ...` lines; rewrites that change nothing the author would notice have none. */
  fixes: string[];
}

/**
 * `my-part` (no spaces) read as `my_part` everywhere outside strings. The Express lexer has no minus between names,
 * so a hyphenated name is always an error there (finding V043); surface ids take hyphens, so models write them here
 * too. Left alone when the underscored name is already used for something else.
 */
function hyphenatedNames(src: string): Rewrite {
  const {tokens} = tokenize(src);
  const names = new Set(tokens.filter(t => t.kind === 'ident').map(t => t.text));
  const edits: Array<{start: number; end: number; text: string}> = [];
  const notes = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    let j = i;
    while (tokens[j]?.kind === 'ident' && tokens[j + 1]?.text === '-' && tokens[j + 1]!.start === tokens[j]!.end
      && tokens[j + 2]?.kind === 'ident' && tokens[j + 2]!.start === tokens[j + 1]!.end) j += 2;
    if (j === i) continue;
    // Not the tail of a path (`$/a-b` is a path, then text) or of a name glued to something before it.
    const before = tokens[i - 1];
    if (before && before.end === tokens[i]!.start && (before.kind === 'path' || before.kind === 'ident' || before.kind === 'number')) { i = j; continue; }
    const written = src.slice(tokens[i]!.start, tokens[j]!.end);
    const meant = written.replace(/-/g, '_');
    if (names.has(meant)) { i = j; continue; }
    edits.push({start: tokens[i]!.start, end: tokens[j]!.end, text: meant});
    notes.set(written, meant);
    i = j;
  }
  return {text: replaceAt(src, edits), fixes: [...notes].slice(0, 3).map(([written, meant]) => `${written} -> ${meant} (part names use letters, digits and _)`)};
}

/** The plain strings of a list literal that opens at `open` (`['a','b']`), with its extent; undefined for anything else. */
function stringList(src: string, open: SpecToken): {start: number; end: number; values: string[]} | undefined {
  const {tokens} = tokenize(src.slice(open.start));
  if (tokens[0]?.text !== '[') return undefined;
  const values: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === ']') return values.length > 0 ? {start: open.start, end: open.start + token.end, values} : undefined;
    if (token.kind === 'string' && /^[\w.:=-]+$/.test(stringValue(token))) values.push(stringValue(token));
    else if (token.text !== ',') return undefined;
  }
  return undefined;
}

/**
 * Rewrites what the author plainly meant, in one pass over every call, before anything is compiled (decision D15:
 * deterministic, and not limited by the number of repair passes):
 * - an enum value given as one of the catalog's aliases, a synonym or a near miss becomes the value it stands for
 *   (`Callout.kind warning -> warn`), however many there are (finding V069);
 * - a number where the prop takes a string is quoted, silently: its meaning is unchanged (finding V015);
 * - a plain string where the prop takes an action becomes Event('that name') (finding V042);
 * - hyphenated part names take underscores (finding V043).
 */
export function rewrite(src: string): Rewrite {
  const named = hyphenatedNames(src);
  const fixes = [...named.fixes];
  const text = named.text;
  const edits: Array<{start: number; end: number; text: string}> = [];
  for (const arg of callArguments(tokenize(text).tokens)) {
    const def = COMPONENT_BY_NAME.get(arg.callee);
    if (!def) continue;
    const props = def.props as Record<string, Prop>;
    const key = arg.keyword ?? Object.keys(props)[arg.index];
    const prop = key !== undefined && Object.hasOwn(props, key) ? props[key]! : undefined;
    if (!prop) continue;
    // Only a value that is one token: a string or a number, not the first token of a call or a list. A list of plain
    // strings for a prop that takes several fields in one string ('commits authors') is that string. DataTable's
    // columns take a list as it is (notation.ts readColumns).
    const next = arg.value;
    const list = next.text === '[' && prop.kind === 'str' && /space separated/i.test(prop.doc) ? stringList(text, next) : undefined;
    if (list) {
      edits.push({start: list.start, end: list.end, text: JSON.stringify(list.values.join(' '))});
      fixes.push(`${def.name}.${key} [${list.values.map(value => `'${value}'`).join(',')}] -> '${list.values.join(' ')}'`);
      continue;
    }
    if (prop.kind === 'enum' && prop.values && next.kind === 'string') {
      const value = stringValue(next);
      if (prop.values.includes(value)) continue;
      const target = enumValue(prop, value) ?? enumMeant(value, prop.values);
      if (!target) continue;
      edits.push({start: next.start, end: next.end, text: JSON.stringify(target)});
      // What models write for a value (Callout 'info') is taken as it: a line on every such page taught nothing.
      if (!prop.quiet?.includes(value.trim().toLowerCase())) fixes.push(`${def.name}.${key} ${value} -> ${target}`);
    } else if ((prop.kind === 'str' || prop.kind === 'text') && next.kind === 'number' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:%)?$/.test(next.text)) {
      edits.push({start: next.start, end: next.end, text: JSON.stringify(next.text)});
    } else if (prop.kind === 'action' && next.kind === 'string') {
      const value = stringValue(next);
      if (!/^[A-Za-z_][\w.-]{0,63}$/.test(value)) continue;
      edits.push({start: next.start, end: next.end, text: `Event(${JSON.stringify(value)})`});
      fixes.push(`${def.name}.${key} '${value}' -> Event('${value}')`);
    }
  }
  return {text: replaceAt(text, edits), fixes};
}

/** The repaired text for a problem, or undefined when the problem is not one Glimpse repairs here. */
export function repair(text: string, hint: RepairHint): Repair | undefined {
  if (hint.kind === 'component') return renameComponent(text, hint.name);
  if (hint.kind === 'prop') return renameProp(text, hint.component, hint.name);
  if (hint.kind === 'enum') return replaceEnum(text, hint.component, hint.prop, hint.value);
  if (hint.kind === 'quote') return quoteNumber(text, hint.component, hint.prop);
  if (hint.kind === 'eof') return closeBrackets(text);
  return undefined;
}
